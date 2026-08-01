import * as vscode from 'vscode';
import { VeniceClient } from './api/venice';
import { ChatViewProvider } from './chat/chatProvider';
import { InlineCompletionProvider } from './completion/inlineProvider';
import { WorkspaceIndexer, RelevanceRanker } from './context';
import { ToolRegistry, PermissionManager, FilesystemTools, TerminalTools, GitTools, DebugTools } from './tools';
import { IgnoreService } from './security/ignoreService';
import { toggleVeniceEnabled, isVeniceEnabled } from './security/workspaceGuard';

let indexer: WorkspaceIndexer;
let toolRegistry: ToolRegistry;
let ranker: RelevanceRanker;
let ignoreService: IgnoreService;

export function activate(context: vscode.ExtensionContext) {
    console.log('Venice AI extension activated');

    // Single shared client so the network circuit breaker actually protects the whole
    // extension (chat + completions), not just whichever feature happened to construct its own.
    const client = new VeniceClient(context);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    ignoreService = new IgnoreService(workspaceRoot);

    // Initialize indexer
    indexer = new WorkspaceIndexer(context, ignoreService);
    const watcherDisposable = indexer.registerFileWatcher();
    context.subscriptions.push(indexer);
    context.subscriptions.push(watcherDisposable);

    // Initialize permission manager and tools
    const permissionManager = new PermissionManager(workspaceRoot);
    toolRegistry = new ToolRegistry(permissionManager);

    // Register all tools
    toolRegistry.register(FilesystemTools.READ_FILE);
    toolRegistry.register(FilesystemTools.LIST_DIRECTORY);
    toolRegistry.register(FilesystemTools.SEARCH_WORKSPACE);
    toolRegistry.register(FilesystemTools.WRITE_FILE);
    toolRegistry.register(FilesystemTools.APPLY_PATCH);
    toolRegistry.register(TerminalTools.RUN_COMMAND);
    toolRegistry.register(GitTools.STATUS);
    toolRegistry.register(GitTools.DIFF);
    toolRegistry.register(GitTools.COMMIT);
    toolRegistry.register(GitTools.BRANCH);
    toolRegistry.register(DebugTools.START);
    toolRegistry.register(DebugTools.SET_BREAKPOINT);

    // Initialize relevance ranker
    ranker = new RelevanceRanker(workspaceRoot);

    const chatProvider = new ChatViewProvider(context.extensionUri, client);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider
        )
    );

    const inlineProvider = new InlineCompletionProvider(client, ignoreService);
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
        vscode.commands.registerCommand('venice.toggleWorkspaceEnabled', async () => {
            try {
                const enabled = await toggleVeniceEnabled();
                vscode.window.showInformationMessage(
                    `Venice AI is now ${enabled ? 'enabled' : 'disabled'} for this workspace`
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Could not update workspace setting: ${error instanceof Error ? error.message : 'Unknown error'}`
                );
            }
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

    context.subscriptions.push(
        vscode.commands.registerCommand('venice.showIndexStatus', () => {
            const status = indexer.getStatus();
            const sizeMB = ((status.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1);
            const lines = [
                `State: ${status.state}`,
                `Files indexed: ${status.filesIndexed} / ${status.totalFiles} (${status.progress}%)`,
                `Index size on disk: ${sizeMB} MB`,
            ];
            if (status.sizeCapped) {
                lines.push('Background sweep stopped early: index size cap reached (venice.maxIndexSizeMB).');
            }
            if (status.error) {
                lines.push(`Error: ${status.error}`);
            }
            lines.push(`Venice enabled for this workspace: ${isVeniceEnabled() ? 'yes' : 'no'}`);
            vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
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

export function getIgnoreService(): IgnoreService {
    return ignoreService;
}

export function deactivate() {
    console.log('Venice AI extension deactivated');
}
