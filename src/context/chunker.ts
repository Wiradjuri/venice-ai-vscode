import * as vscode from 'vscode';
import { CodeChunk } from './types';

export interface DocumentSymbol extends vscode.DocumentSymbol {
  location?: vscode.Location;
}

export class Chunker {
  /**
   * Split a document into chunks using LSP symbol providers, tree-sitter, or sliding window
   */
  async chunkDocument(document: vscode.TextDocument): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const uri = document.uri.toString();
    const language = document.languageId;

    // Try LSP-based symbol chunking first
    const symbols = await this.getLSPSymbols(document);
    if (symbols.length > 0) {
      chunks.push(...this.chunksFromSymbols(uri, document, symbols, language));
      return chunks;
    }

    // Fallback to sliding window chunking
    chunks.push(...this.chunksFromSlidingWindow(uri, document, language));
    return chunks;
  }

  private async getLSPSymbols(document: vscode.TextDocument): Promise<DocumentSymbol[]> {
    try {
      const symbols = (await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      )) as DocumentSymbol[] | undefined;

      return symbols || [];
    } catch {
      return [];
    }
  }

  private chunksFromSymbols(
    uri: string,
    document: vscode.TextDocument,
    symbols: DocumentSymbol[],
    language: string
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    const processSymbol = (symbol: DocumentSymbol, depth: number = 0) => {
      const range = symbol.range || symbol.location?.range;
      if (!range) {
        return;
      }

      const content = document.getText(range);
      if (content.trim().length > 10) {
        // Skip trivial symbols
        chunks.push({
          uri,
          startLine: range.start.line,
          endLine: range.end.line,
          content,
          language,
          type: 'symbol',
        });
      }

      // Process children
      if (symbol.children) {
        for (const child of symbol.children) {
          processSymbol(child, depth + 1);
        }
      }
    };

    for (const symbol of symbols) {
      processSymbol(symbol);
    }

    return chunks;
  }

  private chunksFromSlidingWindow(
    uri: string,
    document: vscode.TextDocument,
    language: string
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const chunkSize = 512; // characters
    const overlap = 256; // characters
    const text = document.getText();

    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      const end = Math.min(i + chunkSize, text.length);
      const content = text.substring(i, end);

      if (content.trim().length > 20) {
        // Convert character positions to line numbers
        const startLine = document.positionAt(i).line;
        const endLine = document.positionAt(end).line;

        chunks.push({
          uri,
          startLine,
          endLine,
          content,
          language,
          type: 'window',
        });
      }

      if (end === text.length) {
        break;
      }
    }

    return chunks;
  }
}
