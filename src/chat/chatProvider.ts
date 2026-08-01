import * as vscode from 'vscode';
import { AgentSession } from '../agent';
import { ChatController } from './chatController';
import { getChatHtmlContent } from './chatHtml';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'venice.chatView';

    private webviewView?: vscode.WebviewView;
    private readonly controller: ChatController;
    // A message requested (e.g. via "Explain Selection") before the sidebar webview has resolved
    // for the first time; flushed as soon as resolveWebviewView runs.
    private pendingMessage?: string;

    constructor(
        private readonly extensionUri: vscode.Uri,
        agentSession: AgentSession
    ) {
        this.controller = new ChatController(agentSession, (message) => {
            this.webviewView?.webview.postMessage(message);
        });
    }

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

        webviewView.webview.html = getChatHtmlContent(this.currentModel());

        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('venice.model')) {
                this.postModel();
            }
        });
        webviewView.onDidDispose(() => configListener.dispose());

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'chat':
                    await this.controller.handleChat(message.text);
                    break;
                case 'clear':
                    this.clearHistory();
                    break;
            }
        });

        if (this.pendingMessage) {
            const text = this.pendingMessage;
            this.pendingMessage = undefined;
            void this.controller.handleChat(text);
        }
    }

    /**
     * Reveals the chat sidebar and runs `text` through it as if the user had typed it — used by
     * the Explain/Fix Selection and Scaffold Project commands so their output lands in the same
     * chat UI (with tool-call visibility) instead of a separate surface.
     */
    async sendMessage(text: string): Promise<void> {
        await vscode.commands.executeCommand('venice.chatView.focus');
        if (this.webviewView) {
            await this.controller.handleChat(text);
        } else {
            // Webview resolution happens asynchronously after the focus command returns;
            // resolveWebviewView() will flush this once it runs.
            this.pendingMessage = text;
        }
    }

    clearHistory(): void {
        this.controller.clearHistory();
    }

    private currentModel(): string {
        return vscode.workspace.getConfiguration('venice').get('model', '');
    }

    private postModel(): void {
        this.webviewView?.webview.postMessage({ type: 'model', text: this.currentModel() });
    }
}
