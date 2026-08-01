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

        webviewView.webview.html = this.getHtmlContent();

        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('venice.model')) {
                this.postModel();
            }
        });
        webviewView.onDidDispose(() => configListener.dispose());

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

    private currentModel(): string {
        return vscode.workspace.getConfiguration('venice').get('model', '');
    }

    private postModel(): void {
        this.webviewView?.webview.postMessage({ type: 'model', text: this.currentModel() });
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

    private getHtmlContent(): string {
        const model = escapeHtml(this.currentModel());

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
            overflow: hidden;
        }
        #app {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        #header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
            flex-shrink: 0;
        }
        #header-left {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            min-width: 0;
        }
        #header-left svg {
            flex-shrink: 0;
            opacity: 0.9;
        }
        #header-left span {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #header-right {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        #model-badge {
            font-size: 0.75em;
            padding: 2px 8px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 150px;
        }
        #clear-btn {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            opacity: 0.7;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            display: flex;
            align-items: center;
        }
        #clear-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
        }
        #chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
        }
        #messages {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        #empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            gap: 6px;
            padding: 24px 16px;
            color: var(--vscode-descriptionForeground);
        }
        #empty-state svg {
            opacity: 0.35;
            margin-bottom: 4px;
        }
        .empty-title {
            font-size: 1em;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .empty-sub {
            font-size: 0.85em;
            max-width: 260px;
        }
        #suggestions {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 14px;
            width: 100%;
            max-width: 260px;
        }
        .suggestion-chip {
            padding: 6px 10px;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            font-size: 0.85em;
            font-family: inherit;
            cursor: pointer;
            text-align: left;
        }
        .suggestion-chip:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .message-row {
            display: flex;
            gap: 8px;
            align-items: flex-start;
            max-width: 100%;
        }
        .message-row.user-row {
            flex-direction: row-reverse;
        }
        .avatar {
            width: 22px;
            height: 22px;
            min-width: 22px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7em;
            font-weight: 700;
        }
        .avatar.assistant {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .avatar.user {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .message {
            padding: 10px 14px;
            border-radius: 8px;
            max-width: 82%;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        .user-message {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .assistant-message {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
        }
        .error-message {
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-errorForeground);
            align-self: center;
            max-width: 90%;
        }
        #circuit-banner {
            display: none;
            padding: 8px 12px;
            background: var(--vscode-inputValidation-warningBackground);
            border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
            color: var(--vscode-foreground);
            font-size: 0.9em;
            flex-shrink: 0;
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
            flex-shrink: 0;
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
            padding: 8px 14px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            display: flex;
            align-items: center;
            justify-content: center;
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
    <div id="app">
        <div id="header">
            <div id="header-left">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V10.5C15 11.3284 14.3284 12 13.5 12H8.70711L5.85355 14.8536C5.53857 15.1685 5 14.9457 5 14.5V12H2.5C1.67157 12 1 11.3284 1 10.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V10.5C2 10.7761 2.22386 11 2.5 11H6V13.2929L8.29289 11H13.5C13.7761 11 14 10.7761 14 10.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5Z"/></svg>
                <span>Venice AI</span>
            </div>
            <div id="header-right">
                <span id="model-badge">${model}</span>
                <button id="clear-btn" title="Clear conversation">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 2h4a1 1 0 0 1 1 1v1h3v1h-1v8.5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5V5H2V4h3V3a1 1 0 0 1 1-1zm-1 3v8.5a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V5H5zm2 2h1v5H7V7zm3 0h-1v5h1V7zM6 3v1h4V3H6z"/></svg>
                </button>
            </div>
        </div>
        <div id="circuit-banner"></div>
        <div id="chat-container">
            <div id="empty-state">
                <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V10.5C15 11.3284 14.3284 12 13.5 12H8.70711L5.85355 14.8536C5.53857 15.1685 5 14.9457 5 14.5V12H2.5C1.67157 12 1 11.3284 1 10.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V10.5C2 10.7761 2.22386 11 2.5 11H6V13.2929L8.29289 11H13.5C13.7761 11 14 10.7761 14 10.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5Z"/></svg>
                <div class="empty-title">Ask Venice AI anything</div>
                <div class="empty-sub">About your code, this workspace, or general programming questions.</div>
                <div id="suggestions">
                    <button class="suggestion-chip" data-text="Explain what this file does">Explain this file</button>
                    <button class="suggestion-chip" data-text="Find potential bugs in the current file">Find potential bugs</button>
                    <button class="suggestion-chip" data-text="Write unit tests for the selected code">Write unit tests</button>
                </div>
            </div>
            <div id="messages"></div>
        </div>
        <div id="input-container">
            <textarea id="input" placeholder="Ask Venice AI..." rows="1"></textarea>
            <button id="send-btn" title="Send message">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5a.5.5 0 0 1 .65-.478l12.5 4.5a.5.5 0 0 1 0 .942l-12.5 4.5A.5.5 0 0 1 1.5 10.5V8.75L7 8 1.5 7.25V1.5z"/></svg>
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chat-container');
        const messagesEl = document.getElementById('messages');
        const emptyState = document.getElementById('empty-state');
        const circuitBanner = document.getElementById('circuit-banner');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');
        const clearBtn = document.getElementById('clear-btn');
        const modelBadge = document.getElementById('model-badge');

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

        function hideEmptyState() {
            emptyState.style.display = 'none';
        }

        function addMessage(text, type) {
            hideEmptyState();

            if (type === 'error') {
                const msg = document.createElement('div');
                msg.className = 'message error-message';
                msg.textContent = text;
                messagesEl.appendChild(msg);
                chatContainer.scrollTop = chatContainer.scrollHeight;
                return msg;
            }

            const row = document.createElement('div');
            row.className = 'message-row ' + type + '-row';

            const avatar = document.createElement('div');
            avatar.className = 'avatar ' + type;
            avatar.textContent = type === 'user' ? 'Y' : 'V';

            const msg = document.createElement('div');
            msg.className = 'message ' + type + '-message';
            if (type === 'assistant') {
                msg.innerHTML = formatMessage(text);
            } else {
                msg.textContent = text;
            }

            row.appendChild(avatar);
            row.appendChild(msg);
            messagesEl.appendChild(row);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return msg;
        }

        function send(overrideText) {
            const text = (overrideText !== undefined ? overrideText : input.value).trim();
            if (!text || isStreaming) return;

            input.value = '';
            input.style.height = 'auto';
            vscode.postMessage({ type: 'chat', text: text });
        }

        sendBtn.addEventListener('click', () => send());

        clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clear' });
        });

        document.querySelectorAll('.suggestion-chip').forEach((chip) => {
            chip.addEventListener('click', () => send(chip.getAttribute('data-text')));
        });

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
                        currentAssistantMessage.closest('.message-row')?.remove();
                        currentAssistantMessage = null;
                    }
                    addMessage(message.text, 'error');
                    break;

                case 'circuitBanner':
                    isStreaming = false;
                    sendBtn.disabled = false;
                    if (currentAssistantMessage) {
                        currentAssistantMessage.closest('.message-row')?.remove();
                        currentAssistantMessage = null;
                    }
                    circuitBanner.textContent = '⚠ ' + message.text;
                    circuitBanner.classList.add('visible');
                    break;

                case 'cleared':
                    messagesEl.innerHTML = '';
                    emptyState.style.display = 'flex';
                    circuitBanner.classList.remove('visible');
                    break;

                case 'model':
                    modelBadge.textContent = message.text;
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
