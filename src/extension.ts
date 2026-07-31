import * as vscode from 'vscode';
import { VeniceClient } from './api/venice';
import { ChatViewProvider } from './chat/chatProvider';
import { InlineCompletionProvider } from './completion/inlineProvider';
import { WorkspaceIndexer, RelevanceRanker } from './context';
import { ToolRegistry, PermissionManager, FilesystemTools, TerminalTools, GitTools } from './tools';

let completionsEnabled = true;
let indexer: WorkspaceIndexer;
let toolRegistry: ToolRegistry;
let ranker: RelevanceRanker;

export function activate(context: vscode.ExtensionContext) {
    console.log('Venice AI extension activated');

    const client = new VeniceClient(context);

    // Initialize indexer
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    indexer = new WorkspaceIndexer(context);
    const watcherDisposable = indexer.registerFileWatcher();
    context.subscriptions.push(indexer);
    context.subscriptions.push(watcherDisposable);

    // Initialize permission manager and tools
    const permissionManager = new PermissionManager(workspaceRoot);
    toolRegistry = new ToolRegistry(permissionManager);

    // Register all tools
    toolRegistry.register(FilesystemTools.READ_FILE);
    toolRegistry.register(FilesystemTools.LIST_DIRECTORY);
    toolRegistry.register(FilesystemTools.WRITE_FILE);
    toolRegistry.register(FilesystemTools.APPLY_PATCH);
    toolRegistry.register(TerminalTools.RUN_COMMAND);
    toolRegistry.register(GitTools.STATUS);
    toolRegistry.register(GitTools.DIFF);
    toolRegistry.register(GitTools.COMMIT);
    toolRegistry.register(GitTools.BRANCH);

    // Initialize relevance ranker
    ranker = new RelevanceRanker(workspaceRoot);

    const chatProvider = new ChatViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider
        )
    );

    const inlineProvider = new InlineCompletionProvider(context);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            inlineProvider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('venice.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Venice API key',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'sk-...'
            });

            if (key) {
                await client.setApiKey(key);
                vscode.window.showInformationMessage('Venice API key saved securely');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('venice.openChat', () => {
            vscode.commands.executeCommand('venice.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('venice.toggleCompletions', () => {
            const config = vscode.workspace.getConfiguration('venice');
            const current = config.get('completionsEnabled', true);
            config.update('completionsEnabled', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Venice inline completions ${!current ? 'enabled' : 'disabled'}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('venice.clearChat', () => {
            chatProvider.clearHistory();
            vscode.window.showInformationMessage('Venice chat history cleared');
        })
    );

    // Phase 1 indexer command
    context.subscriptions.push(
        vscode.commands.registerCommand('venice.rebuildIndex', async () => {
            await indexer.buildInitialIndex();
            vscode.window.showInformationMessage('Venice index rebuilt');
        })
    );

    checkApiKey(client);
}

async function checkApiKey(client: VeniceClient) {
    const key = await client.getApiKey();
    if (!key) {
        const action = await vscode.window.showWarningMessage(
            'Venice AI: No API key configured',
            'Set API Key'
        );
        if (action === 'Set API Key') {
            vscode.commands.executeCommand('venice.setApiKey');
        }
    }
}

// Export for use by other modules (e.g., Phase 2 AgentSession)
export function getIndexer(): WorkspaceIndexer {
    return indexer;
}

export function getToolRegistry(): ToolRegistry {
    return toolRegistry;
}

export function getRelevanceRanker(): RelevanceRanker {
    return ranker;
}

export function deactivate() {
    console.log('Venice AI extension deactivated');
}
