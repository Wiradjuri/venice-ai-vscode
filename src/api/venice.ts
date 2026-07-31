import * as vscode from 'vscode';

export type Provider = 'venice' | 'openrouter';

export const PROVIDER_LABELS: Record<Provider, string> = {
    venice: 'Venice',
    openrouter: 'OpenRouter'
};

interface ProviderConfig {
    baseUrl: string;
    secretKey: string;
    defaultModel: string;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
    venice: {
        baseUrl: 'https://api.venice.ai/api/v1',
        secretKey: 'venice-api-key',
        defaultModel: 'olafangensan-glm-4.7-flash-heretic'
    },
    openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        secretKey: 'openrouter-api-key',
        defaultModel: 'openai/gpt-4o-mini'
    }
};

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface CompletionOptions {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
}

export class VeniceClient {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    getProvider(): Provider {
        const config = vscode.workspace.getConfiguration('venice');
        return config.get<Provider>('provider', 'venice');
    }

    async getApiKey(): Promise<string | undefined> {
        return await this.context.secrets.get(PROVIDERS[this.getProvider()].secretKey);
    }

    async setApiKey(key: string): Promise<void> {
        await this.context.secrets.store(PROVIDERS[this.getProvider()].secretKey, key);
    }

    async deleteApiKey(): Promise<void> {
        await this.context.secrets.delete(PROVIDERS[this.getProvider()].secretKey);
    }

    private getBaseUrl(): string {
        return PROVIDERS[this.getProvider()].baseUrl;
    }

    private getModel(): string {
        const provider = this.getProvider();
        const config = vscode.workspace.getConfiguration('venice');
        if (provider === 'openrouter') {
            return config.get('openrouterModel', PROVIDERS.openrouter.defaultModel);
        }
        return config.get('model', PROVIDERS.venice.defaultModel);
    }

    private getHeaders(apiKey: string): Record<string, string> {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };
        if (this.getProvider() === 'openrouter') {
            headers['HTTP-Referer'] = 'https://github.com/Wiradjuri/venice-ai-vscode';
            headers['X-Title'] = 'Venice AI VS Code Extension';
        }
        return headers;
    }

    async chat(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
        const provider = this.getProvider();
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error(`${PROVIDER_LABELS[provider]} API key not set. Run "Venice: Set API Key" command.`);
        }

        const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
            method: 'POST',
            headers: this.getHeaders(apiKey),
            body: JSON.stringify({
                model: options.model || this.getModel(),
                messages: messages,
                max_tokens: options.maxTokens || 2048,
                temperature: options.temperature ?? 0.7,
                stream: false
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`${PROVIDER_LABELS[provider]} API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
            choices: Array<{ message: { content: string } }>;
        };
        return data.choices[0]?.message?.content || '';
    }

    async *chatStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string> {
        const provider = this.getProvider();
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error(`${PROVIDER_LABELS[provider]} API key not set. Run "Venice: Set API Key" command.`);
        }

        const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
            method: 'POST',
            headers: this.getHeaders(apiKey),
            body: JSON.stringify({
                model: options.model || this.getModel(),
                messages: messages,
                max_tokens: options.maxTokens || 2048,
                temperature: options.temperature ?? 0.7,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`${PROVIDER_LABELS[provider]} API error: ${response.status} - ${error}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

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
                if (data === '[DONE]') return;

                try {
                    const json = JSON.parse(data) as {
                        choices: Array<{ delta: { content?: string } }>;
                    };
                    const content = json.choices[0]?.delta?.content;
                    if (content) {
                        yield content;
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

        return this.chat(messages, {
            ...options,
            maxTokens: options.maxTokens || 256,
            temperature: options.temperature ?? 0.2
        });
    }
}
