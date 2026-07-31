import * as vscode from 'vscode';
import * as path from 'path';
import { Ignore } from 'ignore';
import ignore from 'ignore';
import { Chunker } from './chunker';
import { EmbeddingStore } from './embeddingStore';
import { CodeChunk, IndexStatus } from './types';

export class WorkspaceIndexer {
  private chunker: Chunker;
  private embeddingStore: EmbeddingStore;
  private ignorer: Ignore;
  private indexStatus: IndexStatus = {
    state: 'idle',
    filesIndexed: 0,
    totalFiles: 0,
    progress: 0,
  };
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private statusBarItem: vscode.StatusBarItem;
  private onDidChangeIndexStatus = new vscode.EventEmitter<IndexStatus>();
  public onIndexStatusChange = this.onDidChangeIndexStatus.event;

  constructor(private context: vscode.ExtensionContext) {
    this.chunker = new Chunker();
    this.embeddingStore = new EmbeddingStore(context.globalStorageUri.fsPath);
    this.ignorer = this.buildIgnorer();
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'venice.rebuildIndex';
    this.updateStatusBar();
  }

  private buildIgnorer(): Ignore {
    const ig = ignore();

    // Add .gitignore patterns
    try {
      const gitignorePath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.gitignore');
      const fs = require('fs');
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
    } catch {
      // .gitignore not found, continue
    }

    // Add .veniceignore patterns
    try {
      const veniceignorePath = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        '.veniceignore'
      );
      const fs = require('fs');
      const content = fs.readFileSync(veniceignorePath, 'utf-8');
      ig.add(content);
    } catch {
      // .veniceignore not found, continue
    }

    // Add common exclusions
    ig.add(['node_modules', '.git', '.vscode', 'dist', 'build', '.next', 'out']);

    return ig;
  }

  async buildInitialIndex(): Promise<void> {
    if (this.indexStatus.state === 'indexing' || this.indexStatus.state === 'error') {
      if (this.indexStatus.state === 'indexing') {
        return; // Already indexing
      }
      // Clear error state and try again
    }

    this.updateIndexStatus({ state: 'indexing', filesIndexed: 0, progress: 0 });

    try {
      // Load embedding model
      await this.embeddingStore.loadModel();

      // Find all files
      const files = await this.findFiles();
      this.updateIndexStatus({ totalFiles: files.length });

      // Index each file
      for (let i = 0; i < files.length; i++) {
        if ((this.indexStatus.state as string) !== 'indexing') {
          break; // Cancelled or error
        }

        try {
          const document = await vscode.workspace.openTextDocument(files[i]);
          const chunks = await this.chunker.chunkDocument(document);

          // Embed and store each chunk
          for (const chunk of chunks) {
            await this.embeddingStore.upsert(chunk);
          }

          this.updateIndexStatus({
            filesIndexed: i + 1,
            progress: Math.round(((i + 1) / files.length) * 100),
          });
        } catch (error) {
          console.warn(`Failed to index ${files[i].fsPath}:`, error);
        }
      }

      this.updateIndexStatus({ state: 'idle', progress: 100 });
    } catch (error) {
      console.error('Indexing error:', error);
      this.updateIndexStatus({
        state: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async reindexFile(uri: vscode.Uri): Promise<void> {
    // Debounce per-file reindexing to avoid hammering during rapid edits
    const uriStr = uri.toString();
    clearTimeout(this.debounceMap.get(uriStr));

    const timeout = setTimeout(async () => {
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const chunks = await this.chunker.chunkDocument(document);

        // Remove old chunks for this file
        await this.embeddingStore.removeByUri(uriStr);

        // Re-embed and store
        for (const chunk of chunks) {
          await this.embeddingStore.upsert(chunk);
        }
      } catch (error) {
        console.warn(`Failed to reindex ${uri.fsPath}:`, error);
      }

      this.debounceMap.delete(uriStr);
    }, 500); // 500ms debounce

    this.debounceMap.set(uriStr, timeout);
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    await this.embeddingStore.removeByUri(uri.toString());
  }

  getStatus(): IndexStatus {
    return { ...this.indexStatus };
  }

  private async findFiles(): Promise<vscode.Uri[]> {
    const exclude = '**/{node_modules,.git,.vscode,dist,build,.next,out}/**';
    const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,cpp,c,h,hpp}', exclude);

    // Filter by ignore rules
    return files.filter(file => {
      const relPath = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', file.fsPath);
      return !this.ignorer.ignores(relPath);
    });
  }

  private updateIndexStatus(partial: Partial<IndexStatus>): void {
    this.indexStatus = { ...this.indexStatus, ...partial };
    this.updateStatusBar();
    this.onDidChangeIndexStatus.fire(this.indexStatus);
  }

  private updateStatusBar(): void {
    const { state, filesIndexed, totalFiles, progress } = this.indexStatus;

    switch (state) {
      case 'indexing':
        this.statusBarItem.text = `$(sync~spin) Indexing ${progress}%`;
        this.statusBarItem.show();
        break;
      case 'idle':
        if (filesIndexed > 0) {
          this.statusBarItem.text = `$(search) Venice Index: ${filesIndexed} files`;
          this.statusBarItem.show();
        } else {
          this.statusBarItem.hide();
        }
        break;
      case 'error':
        this.statusBarItem.text = '$(error) Venice Index: error';
        this.statusBarItem.show();
        break;
    }
  }

  registerFileWatcher(): vscode.Disposable {
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,cpp,c,h,hpp}');

    const onChangeDisposable = this.fileWatcher.onDidChange(uri => {
      this.reindexFile(uri);
    });

    const onCreateDisposable = this.fileWatcher.onDidCreate(uri => {
      this.reindexFile(uri);
    });

    const onDeleteDisposable = this.fileWatcher.onDidDelete(uri => {
      this.removeFile(uri);
    });

    return vscode.Disposable.from(onChangeDisposable, onCreateDisposable, onDeleteDisposable);
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this.statusBarItem.dispose();
    this.embeddingStore.close();
  }
}
