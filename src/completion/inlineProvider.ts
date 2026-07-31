import * as vscode from 'vscode';
import { VeniceClient } from '../api/venice';
import { getCodeContext } from '../utils/context';
import { IgnoreService } from '../security/ignoreService';
import { isVeniceEnabled } from '../security/workspaceGuard';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private debounceTimer: NodeJS.Timeout | null = null;
    private lastRequestId = 0;

    constructor(
        private readonly client: VeniceClient,
        private readonly ignoreService: IgnoreService
    ) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        const config = vscode.workspace.getConfiguration('venice');

        if (!config.get('completionsEnabled', true)) {
            return [];
        }

        if (!isVeniceEnabled()) {
            return [];
        }

        // Never send content from a file excluded via .gitignore/.veniceignore, even if it's
        // the file currently open and being edited.
        if (this.ignoreService.isDocumentIgnored(document)) {
            return [];
        }

        const apiKey = await this.client.getApiKey();
        if (!apiKey) {
            return [];
        }

        const requestId = ++this.lastRequestId;
        const debounceMs = config.get('completionDebounceMs', 300);

        await new Promise<void>((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(resolve, debounceMs);
        });

        if (token.isCancellationRequested || requestId !== this.lastRequestId) {
            return [];
        }

        try {
            const { prefix, suffix } = getCodeContext(document, position);

            if (prefix.trim().length < 3) {
                return [];
            }

            const completion = await this.client.complete(prefix, suffix);

            if (token.isCancellationRequested || requestId !== this.lastRequestId) {
                return [];
            }

            if (!completion || completion.trim().length === 0) {
                return [];
            }

            const cleanedCompletion = this.cleanCompletion(completion);

            return [{
                insertText: cleanedCompletion,
                range: new vscode.Range(position, position)
            }];

        } catch (error) {
            console.error('Venice completion error:', error);
            return [];
        }
    }

    private cleanCompletion(completion: string): string {
        let cleaned = completion
            .replace(/^```[\w]*\n?/, '')
            .replace(/\n?```$/, '')
            .replace(/^[\s\n]*/, '');

        const lines = cleaned.split('\n');
        if (lines.length > 10) {
            cleaned = lines.slice(0, 10).join('\n');
        }

        return cleaned;
    }
}
