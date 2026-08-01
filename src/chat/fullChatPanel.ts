import * as vscode from 'vscode';
import { AgentSession } from '../agent';
import { ChatController } from './chatController';
import { getChatHtmlContent } from './chatHtml';

/**
 * Full-screen counterpart to ChatViewProvider: same HTML/protocol via ChatController, opened as
 * an editor-tab panel instead of a sidebar view. Singleton — reopening the command reveals the
 * existing panel (and its in-memory history) rather than starting a second conversation.
 */
export class FullChatPanel {
    private static current?: FullChatPanel;

    private readonly panel: vscode.WebviewPanel;
    private readonly controller: ChatController;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(extensionUri: vscode.Uri, agentSession: AgentSession): void {
        if (FullChatPanel.current) {
            FullChatPanel.current.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'venice.fullChat',
            'Venice AI Chat',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        FullChatPanel.current = new FullChatPanel(panel, agentSession);
    }

    private constructor(panel: vscode.WebviewPanel, agentSession: AgentSession) {
        this.panel = panel;
        this.controller = new ChatController(agentSession, (message) => {
            this.panel.webview.postMessage(message);
        });

        this.panel.webview.html = getChatHtmlContent(this.currentModel());

        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'chat':
                    await this.controller.handleChat(message.text);
                    break;
                case 'clear':
                    this.controller.clearHistory();
                    break;
            }
        }, null, this.disposables);

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('venice.model')) {
                this.panel.webview.postMessage({ type: 'model', text: this.currentModel() });
            }
        }, null, this.disposables);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private currentModel(): string {
        return vscode.workspace.getConfiguration('venice').get('model', '');
    }

    private dispose(): void {
        FullChatPanel.current = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
