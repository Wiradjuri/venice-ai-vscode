import * as vscode from 'vscode';
import { CircuitBreaker } from './circuitBreaker';
import { isVeniceEnabled } from '../security/workspaceGuard';
import { redactSecrets } from '../security/secretScanner';

const BASE_URL = 'https://api.venice.ai/api/v1';
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 300;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30000;

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string;
    tool_calls?: Array<{
        id: string;
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface CompletionOptions {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatResponse {
    choices: Array<{
        message: ChatMessage;
        finish_reason: 'stop' | 'tool_calls' | 'length';
    }>;
}

/** Thrown instead of attempting a request while the circuit breaker is open. */
export class VeniceCircuitOpenError extends Error {
    constructor(public readonly retryAfterMs: number) {
        super(`Venice AI backend is temporarily unavailable (retry in ${Math.ceil(retryAfterMs / 1000)}s)`);
        this.name = 'VeniceCircuitOpenError';
    }
}

/** A response status/network condition worth retrying with backoff. */
function isRetryableError(error: unknown): boolean {
    if (error instanceof VeniceApiError) {
        return error.status === 429 || error.status >= 500;
    }
    // fetch() throws a plain TypeError/DOMException for network-level failures (DNS, TLS, offline).
    return true;
}

export class VeniceApiError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'VeniceApiError';
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function redactMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message =>
        typeof message.content === 'string' ? { ...message, content: redactSecrets(message.content) } : message
    );
}

export class VeniceClient {
    private context: vscode.ExtensionContext;
    private circuitBreaker = new CircuitBreaker(CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS);

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async getApiKey(): Promise<string | undefined> {
        return await this.context.secrets.get('venice-api-key');
    }

    async setApiKey(key: string): Promise<void> {
        await this.context.secrets.store('venice-api-key', key);
    }

    async deleteApiKey(): Promise<void> {
        await this.context.secrets.delete('venice-api-key');
    }

    getCircuitState() {
        return this.circuitBreaker.getState();
    }

    private getModel(): string {
        const config = vscode.workspace.getConfiguration('venice');
        return config.get('model', 'olafangensan-glm-4.7-flash-heretic');
    }

    /** Gate shared by chat/chatStream: workspace toggle, then circuit breaker. */
    private checkGate(): void {
        if (!isVeniceEnabled()) {
            throw new Error('Venice AI is disabled for this workspace. Run "Venice: Toggle Enabled for This Workspace" to re-enable.');
        }
        if (!this.circuitBreaker.canRequest()) {
            throw new VeniceCircuitOpenError(this.circuitBreaker.getRetryAfterMs());
        }
    }

    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch(url, init);
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new VeniceApiError(response.status, `Venice API error: ${response.status} - ${errorText}`);
                }
                this.circuitBreaker.onSuccess();
                return response;
            } catch (error) {
                lastError = error;
                const retryable = isRetryableError(error);
                if (!retryable || attempt === MAX_RETRIES) {
                    this.circuitBreaker.onFailure();
                    throw error;
                }
                await sleep(BACKOFF_BASE_MS * 2 ** attempt + Math.random() * 100);
            }
        }
        // Unreachable, but keeps TS happy about the return type.
        throw lastError;
    }

    async chat(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string | ChatMessage> {
        this.checkGate();

        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('API key not set. Run "Venice: Set API Key" command.');
        }

        const body: Record<string, unknown> = {
            model: options.model || this.getModel(),
            messages: redactMessages(messages),
            max_tokens: options.maxTokens || 2048,
            temperature: options.temperature ?? 0.7,
            stream: false
        };

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            if (options.tool_choice) {
                body.tool_choice = options.tool_choice;
            }
        }

        const response = await this.fetchWithRetry(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json() as ChatResponse;
        const choice = data.choices[0];

        // If tool calls are present, return the full message so caller can handle them
        if (choice?.message?.tool_calls) {
            return choice.message;
        }

        return choice?.message?.content || '';
    }

    async *chatStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string | ChatMessage> {
        this.checkGate();

        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('API key not set. Run "Venice: Set API Key" command.');
        }

        const body: Record<string, unknown> = {
            model: options.model || this.getModel(),
            messages: redactMessages(messages),
            max_tokens: options.maxTokens || 2048,
            temperature: options.temperature ?? 0.7,
            stream: true
        };

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            if (options.tool_choice) {
                body.tool_choice = options.tool_choice;
            }
        }

        // Retries/circuit-breaker only cover establishing the stream; once tokens have started
        // flowing to the UI we can't safely replay a partial response.
        const response = await this.fetchWithRetry(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let currentMessage: ChatMessage = { role: 'assistant' };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;

                const data = trimmed.slice(6);
                if (data === '[DONE]') {
                    if (currentMessage.tool_calls) {
                        yield currentMessage;
                    }
                    return;
                }

                try {
                    const json = JSON.parse(data) as {
                        choices: Array<{
                            delta: {
                                content?: string;
                                tool_calls?: ChatMessage['tool_calls'];
                            };
                        }>;
                    };

                    const delta = json.choices[0]?.delta;
                    if (delta?.content) {
                        if (!currentMessage.content) {
                            currentMessage.content = delta.content;
                        } else {
                            currentMessage.content += delta.content;
                        }
                        yield delta.content;
                    }

                    if (delta?.tool_calls) {
                        currentMessage.tool_calls = delta.tool_calls;
                    }
                } catch {
                    // Skip malformed JSON
                }
            }
        }
    }

    async complete(prefix: string, suffix: string, options: CompletionOptions = {}): Promise<string> {
        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: 'You are a code completion assistant. Complete the code between <prefix> and <suffix>. Only output the completion, no explanations or markdown.'
            },
            {
                role: 'user',
                content: `<prefix>${prefix}</prefix>\n<suffix>${suffix}</suffix>\n\nComplete the code:`
            }
        ];

        const result = await this.chat(messages, {
            ...options,
            maxTokens: options.maxTokens || 256,
            temperature: options.temperature ?? 0.2
        });

        return typeof result === 'string' ? result : '';
    }
}
