import * as vscode from 'vscode';

export interface CodeContext {
    prefix: string;
    suffix: string;
    language: string;
    fileName: string;
}

export function getCodeContext(
    document: vscode.TextDocument,
    position: vscode.Position
): CodeContext {
    const config = vscode.workspace.getConfiguration('venice');
    const maxLines = config.get('maxContextLines', 50);

    const startLine = Math.max(0, position.line - maxLines);
    const endLine = Math.min(document.lineCount - 1, position.line + Math.floor(maxLines / 2));

    const prefixRange = new vscode.Range(
        new vscode.Position(startLine, 0),
        position
    );

    const suffixRange = new vscode.Range(
        position,
        new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );

    return {
        prefix: document.getText(prefixRange),
        suffix: document.getText(suffixRange),
        language: document.languageId,
        fileName: document.fileName
    };
}

export function getFullFileContext(document: vscode.TextDocument): string {
    const maxChars = 8000;
    const text = document.getText();

    if (text.length <= maxChars) {
        return text;
    }

    return text.substring(0, maxChars) + '\n... (truncated)';
}

export function getCurrentSelection(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;
    if (selection.isEmpty) {
        return undefined;
    }
    return editor.document.getText(selection);
}
