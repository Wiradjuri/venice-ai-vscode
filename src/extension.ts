import * as vscode from 'vscode';
import { VeniceClient } from './api/venice';
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

export function deactivate() {
    console.log('Venice AI extension deactivated');
}
