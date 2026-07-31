import * as vscode from 'vscode';

const BASE_URL = 'https://api.venice.ai/api/v1';

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

export class VeniceClient {
    private context: vscode.ExtensionContext;

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

    private getModel(): string {
        const config = vscode.workspace.getConfiguration('venice');
        return config.get('model', 'olafangensan-glm-4.7-flash-heretic');
    }

    async chat(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string | ChatMessage> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('API key not set. Run "Venice: Set API Key" command.');
        }

        const body: Record<string, unknown> = {
            model: options.model || this.getModel(),
            messages: messages,
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

        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Venice API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as ChatResponse;
        const choice = data.choices[0];

        // If tool calls are present, return the full message so caller can handle them
        if (choice?.message?.tool_calls) {
            return choice.message;
        }

        return choice?.message?.content || '';
    }

    async *chatStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string | ChatMessage> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('API key not set. Run "Venice: Set API Key" command.');
        }

        const body: Record<string, unknown> = {
            model: options.model || this.getModel(),
            messages: messages,
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

        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Venice API error: ${response.status} - ${error}`);
        }

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
