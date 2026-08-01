import * as vscode from 'vscode';
import { VeniceClient, ChatMessage, VeniceCircuitOpenError } from '../api/venice';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'venice.chatView';

    private webviewView?: vscode.WebviewView;
    private history: ChatMessage[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly client: VeniceClient
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'chat':
                    await this.handleChat(message.text);
                    break;
                case 'clear':
                    this.clearHistory();
                    break;
            }
        });
    }

    clearHistory(): void {
        this.history = [];
        this.webviewView?.webview.postMessage({ type: 'cleared' });
    }

    private async handleChat(userMessage: string): Promise<void> {
        if (!this.webviewView) return;

        this.history.push({ role: 'user', content: userMessage });

        this.webviewView.webview.postMessage({
            type: 'userMessage',
            text: userMessage
        });

        try {
            let fullResponse = '';
            this.webviewView.webview.postMessage({ type: 'streamStart' });

            for await (const chunk of this.client.chatStream(this.history)) {
                fullResponse += chunk;
                this.webviewView.webview.postMessage({
                    type: 'streamChunk',
                    text: chunk
                });
            }

            this.history.push({ role: 'assistant', content: fullResponse });
            this.webviewView.webview.postMessage({ type: 'streamEnd' });

        } catch (error) {
            if (error instanceof VeniceCircuitOpenError) {
                // Persistent banner instead of a per-message bubble: the backend is down for
                // everyone right now, not just this one request, so don't make it look like a
                // one-off failure the user should retry immediately.
                this.webviewView.webview.postMessage({
                    type: 'circuitBanner',
                    text: error.message,
                    retryAfterMs: error.retryAfterMs
                });
            } else {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                this.webviewView.webview.postMessage({
                    type: 'error',
                    text: errorMessage
                });
            }
            this.history.pop();
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Venice AI Chat</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        #chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .message {
            padding: 10px 14px;
            border-radius: 8px;
            max-width: 90%;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        .user-message {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            align-self: flex-end;
        }
        .assistant-message {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            align-self: flex-start;
        }
        .error-message {
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-errorForeground);
            align-self: center;
        }
        #circuit-banner {
            display: none;
            padding: 8px 12px;
            background: var(--vscode-inputValidation-warningBackground);
            border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
            color: var(--vscode-foreground);
            font-size: 0.9em;
        }
        #circuit-banner.visible {
            display: block;
        }
        pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
        }
        #input-container {
            padding: 12px;
            border-top: 1px solid var(--vscode-widget-border);
            display: flex;
            gap: 8px;
        }
        #input {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            resize: none;
            min-height: 36px;
            max-height: 120px;
        }
        #input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        #send-btn {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
        }
        #send-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        #send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .typing-indicator {
            display: inline-block;
            padding: 4px 0;
        }
        .typing-indicator::after {
            content: '...';
            animation: dots 1.5s steps(4, end) infinite;
        }
        @keyframes dots {
            0%, 20% { content: ''; }
            40% { content: '.'; }
            60% { content: '..'; }
            80%, 100% { content: '...'; }
        }
    </style>
</head>
<body>
    <div id="circuit-banner"></div>
    <div id="chat-container"></div>
    <div id="input-container">
        <textarea id="input" placeholder="Ask Venice AI..." rows="1"></textarea>
        <button id="send-btn">Send</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chat-container');
        const circuitBanner = document.getElementById('circuit-banner');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');

        let currentAssistantMessage = null;
        let isStreaming = false;

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function formatMessage(text) {
            // Simple code block detection
            return text.replace(/\`\`\`(\\w*)?\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
                return '<pre><code>' + escapeHtml(code.trim()) + '</code></pre>';
            }).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        }

        function addMessage(text, type) {
            const msg = document.createElement('div');
            msg.className = 'message ' + type + '-message';
            if (type === 'assistant') {
                msg.innerHTML = formatMessage(text);
            } else {
                msg.textContent = text;
            }
            chatContainer.appendChild(msg);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return msg;
        }

        function send() {
            const text = input.value.trim();
            if (!text || isStreaming) return;

            input.value = '';
            input.style.height = 'auto';
            vscode.postMessage({ type: 'chat', text: text });
        }

        sendBtn.addEventListener('click', send);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });

        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });

        window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.type) {
                case 'userMessage':
                    addMessage(message.text, 'user');
                    break;

                case 'streamStart':
                    isStreaming = true;
                    sendBtn.disabled = true;
                    circuitBanner.classList.remove('visible');
                    currentAssistantMessage = addMessage('', 'assistant');
                    currentAssistantMessage.innerHTML = '<span class="typing-indicator">Thinking</span>';
                    break;

                case 'streamChunk':
                    if (currentAssistantMessage) {
                        const existingText = currentAssistantMessage.getAttribute('data-raw') || '';
                        const newText = existingText + message.text;
                        currentAssistantMessage.setAttribute('data-raw', newText);
                        currentAssistantMessage.innerHTML = formatMessage(newText);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    break;

                case 'streamEnd':
                    isStreaming = false;
                    sendBtn.disabled = false;
                    currentAssistantMessage = null;
                    break;

                case 'error':
                    isStreaming = false;
                    sendBtn.disabled = false;
                    if (currentAssistantMessage) {
                        currentAssistantMessage.remove();
                        currentAssistantMessage = null;
                    }
                    addMessage(message.text, 'error');
                    break;

                case 'circuitBanner':
                    isStreaming = false;
                    sendBtn.disabled = false;
                    if (currentAssistantMessage) {
                        currentAssistantMessage.remove();
                        currentAssistantMessage = null;
                    }
                    circuitBanner.textContent = '⚠ ' + message.text;
                    circuitBanner.classList.add('visible');
                    break;

                case 'cleared':
                    chatContainer.innerHTML = '';
                    circuitBanner.classList.remove('visible');
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
