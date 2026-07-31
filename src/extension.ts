import * as vscode from 'vscode';
import { VeniceClient, PROVIDER_LABELS, Provider } from './api/venice';
import { ChatViewProvider } from './chat/chatProvider';
import { InlineCompletionProvider } from './completion/inlineProvider';

let completionsEnabled = true;

export function activate(context: vscode.ExtensionContext) {
    console.log('Venice AI extension activated');

    const client = new VeniceClient(context);

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
            const providerLabel = PROVIDER_LABELS[client.getProvider()];
            const key = await vscode.window.showInputBox({
                prompt: `Enter your ${providerLabel} API key`,
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'sk-...'
            });

            if (key) {
                await client.setApiKey(key);
                vscode.window.showInformationMessage(`${providerLabel} API key saved securely`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('venice.selectProvider', async () => {
            const providers: Provider[] = ['venice', 'openrouter'];
            const current = client.getProvider();
            const pick = await vscode.window.showQuickPick(
                providers.map(p => ({
                    label: PROVIDER_LABELS[p],
                    description: p === current ? 'current' : undefined,
                    provider: p
                })),
                { placeHolder: 'Select the AI provider to use' }
            );

            if (pick) {
                const config = vscode.workspace.getConfiguration('venice');
                await config.update('provider', pick.provider, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Venice AI provider set to ${pick.label}`);
                checkApiKey(client);
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

    checkApiKey(client);
}

async function checkApiKey(client: VeniceClient) {
    const key = await client.getApiKey();
    if (!key) {
        const providerLabel = PROVIDER_LABELS[client.getProvider()];
        const action = await vscode.window.showWarningMessage(
            `Venice AI: No ${providerLabel} API key configured`,
            'Set API Key'
        );
        if (action === 'Set API Key') {
            vscode.commands.executeCommand('venice.setApiKey');
        }
    }
}

export function deactivate() {
    console.log('Venice AI extension deactivated');
}
