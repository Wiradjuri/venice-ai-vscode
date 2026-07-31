import * as vscode from 'vscode';

const BASE_URL = 'https://api.venice.ai/api/v1';

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

    async chat(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('API key not set. Run "Venice: Set API Key" command.');
        }

        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
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
            throw new Error(`Venice API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
            choices: Array<{ message: { content: string } }>;
        };
        return data.choices[0]?.message?.content || '';
    }

    async *chatStream(messages: ChatMessage[], options: CompletionOptions = {}): AsyncGenerator<string> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('API key not set. Run "Venice: Set API Key" command.');
        }

        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
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
            throw new Error(`Venice API error: ${response.status} - ${error}`);
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
