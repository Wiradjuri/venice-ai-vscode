import { ChatMessage, VeniceCircuitOpenError } from '../api/venice';
import { AgentSession } from '../agent';

export type ChatPost = (message: Record<string, unknown>) => void;

/**
 * Drives one chat conversation's message history and postMessage protocol, independent of which
 * webview (sidebar view vs. full-screen panel) is displaying it.
 */
export class ChatController {
    private history: ChatMessage[] = [];

    constructor(
        private readonly agentSession: AgentSession,
        private readonly post: ChatPost
    ) {}

    clearHistory(): void {
        this.history = [];
        this.post({ type: 'cleared' });
    }

    async handleChat(userMessage: string): Promise<void> {
        this.post({ type: 'userMessage', text: userMessage });

        try {
            this.post({ type: 'streamStart' });

            // The agent loop uses non-streaming calls under the hood (tool_calls need to arrive
            // whole before they can be executed), so progress is surfaced via toolCall/toolResult
            // events instead of token-by-token chunks; the final answer arrives as one chunk.
            const result = await this.agentSession.run(userMessage, this.history, (event) => {
                if (event.type === 'toolCall') {
                    this.post({ type: 'toolCall', name: event.name });
                } else {
                    this.post({ type: 'toolResult', name: event.name, success: event.success });
                }
            });

            // Only append to persistent history once the turn fully succeeds, so a failure
            // partway through a tool-calling round doesn't leave the conversation corrupted.
            this.history.push(...result.messages);

            this.post({ type: 'streamChunk', text: result.reply });
            this.post({ type: 'streamEnd' });

        } catch (error) {
            if (error instanceof VeniceCircuitOpenError) {
                // Persistent banner instead of a per-message bubble: the backend is down for
                // everyone right now, not just this one request, so don't make it look like a
                // one-off failure the user should retry immediately.
                this.post({
                    type: 'circuitBanner',
                    text: error.message,
                    retryAfterMs: error.retryAfterMs
                });
            } else {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                this.post({ type: 'error', text: errorMessage });
            }
        }
    }
}
