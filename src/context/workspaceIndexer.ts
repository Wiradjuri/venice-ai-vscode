import * as vscode from 'vscode';
import * as fs from 'fs';
import { Chunker } from './chunker';
import { EmbeddingStore } from './embeddingStore';
import { IgnoreService } from '../security/ignoreService';
import { IndexStatus, ScoredChunk } from './types';

const INDEXABLE_GLOB = '**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,cpp,c,h,hpp}';
const EXCLUDE_GLOB = '**/{node_modules,.git,.vscode,dist,build,.next,out}/**';
// Number of files treated as "recently touched" and indexed before the rest of the sweep,
// on top of any file that's currently open in an editor.
const HOT_SET_SIZE = 200;
// Yield to the extension host event loop after this many files so indexing never blocks typing.
const YIELD_EVERY_N_FILES = 5;
const DEFAULT_MAX_INDEX_SIZE_MB = 200;

export class WorkspaceIndexer {
  private chunker: Chunker;
  private embeddingStore: EmbeddingStore;
  private indexStatus: IndexStatus = {
    state: 'idle',
    filesIndexed: 0,
    totalFiles: 0,
    progress: 0,
  };
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private ignoreFileWatcher: vscode.FileSystemWatcher | null = null;
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private statusBarItem: vscode.StatusBarItem;
  private onDidChangeIndexStatus = new vscode.EventEmitter<IndexStatus>();
  public onIndexStatusChange = this.onDidChangeIndexStatus.event;

  constructor(
    private context: vscode.ExtensionContext,
    private ignoreService: IgnoreService
  ) {
    this.chunker = new Chunker();
    this.embeddingStore = new EmbeddingStore(context.globalStorageUri.fsPath);
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'venice.showIndexStatus';
    this.updateStatusBar();
  }

  private getMaxIndexSizeBytes(): number {
    const config = vscode.workspace.getConfiguration('venice');
    const mb = config.get<number>('maxIndexSizeMB', DEFAULT_MAX_INDEX_SIZE_MB);
    return Math.max(1, mb) * 1024 * 1024;
  }

  async buildInitialIndex(): Promise<void> {
    if (this.indexStatus.state === 'indexing') {
      return; // Already indexing
    }

    this.updateIndexStatus({ state: 'indexing', filesIndexed: 0, progress: 0, sizeCapped: false, error: undefined });

    try {
      // Load embedding model
      await this.embeddingStore.loadModel();

      // Find + prioritize files: open editors and recently-modified files first, so the most
      // relevant part of a large monorepo is searchable long before a full sweep finishes.
      const files = await this.findFiles();
      const ordered = await this.prioritizeFiles(files);
      this.updateIndexStatus({ totalFiles: ordered.length });

      const maxSizeBytes = this.getMaxIndexSizeBytes();

      for (let i = 0; i < ordered.length; i++) {
        if ((this.indexStatus.state as string) !== 'indexing') {
          break; // Cancelled or error
        }

        if (this.embeddingStore.getDatabaseSizeBytes() >= maxSizeBytes) {
          this.updateIndexStatus({ sizeCapped: true });
          console.warn(`Venice index stopped: reached ${maxSizeBytes / (1024 * 1024)}MB cap`);
          break;
        }

        try {
          const document = await vscode.workspace.openTextDocument(ordered[i]);
          const chunks = await this.chunker.chunkDocument(document);

          for (const chunk of chunks) {
            await this.embeddingStore.upsert(chunk);
          }

          this.updateIndexStatus({
            filesIndexed: i + 1,
            progress: Math.round(((i + 1) / ordered.length) * 100),
            sizeBytes: this.embeddingStore.getDatabaseSizeBytes(),
          });
        } catch (error) {
          console.warn(`Failed to index ${ordered[i].fsPath}:`, error);
        }

        // Never hog the event loop: indexing must not block typing/UI responsiveness.
        if (i % YIELD_EVERY_N_FILES === YIELD_EVERY_N_FILES - 1) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }

      this.updateIndexStatus({
        state: 'idle',
        progress: this.indexStatus.sizeCapped ? this.indexStatus.progress : 100,
        sizeBytes: this.embeddingStore.getDatabaseSizeBytes(),
        lastUpdated: Date.now(),
      });
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

        this.updateIndexStatus({ sizeBytes: this.embeddingStore.getDatabaseSizeBytes() });
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
    return { ...this.indexStatus, sizeBytes: this.embeddingStore.getDatabaseSizeBytes() };
  }

  /**
   * Top-K similar chunks for a query, for Phase 2 context assembly. Best-effort: if the
   * embedding model hasn't been loaded yet (e.g. "Venice: Rebuild Index" was never run), this
   * returns an empty result instead of throwing, so a chat turn still proceeds without context.
   */
  async query(text: string, k: number = 10): Promise<ScoredChunk[]> {
    try {
      return await this.embeddingStore.query(text, k);
    } catch (error) {
      console.warn('Venice: index query failed (index may not be built yet)', error);
      return [];
    }
  }

  private async findFiles(): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles(INDEXABLE_GLOB, EXCLUDE_GLOB);

    // Filter by .gitignore/.veniceignore rules
    return files.filter(file => !this.ignoreService.isIgnored(file.fsPath));
  }

  /**
   * Orders files so the "hot set" — currently open editors plus the most recently modified
   * files on disk — is indexed first. The rest of a large repo is swept in the background
   * afterward, so search/context quality for what the user is actively working on is available
   * almost immediately instead of waiting on a full-repo pass.
   */
  private async prioritizeFiles(files: vscode.Uri[]): Promise<vscode.Uri[]> {
    const openUris = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));

    const withMtime = files.map(file => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file.fsPath).mtimeMs;
      } catch {
        // File may have been deleted between findFiles() and here; sorts last.
      }
      return { file, mtimeMs, isOpen: openUris.has(file.toString()) };
    });

    const open = withMtime.filter(f => f.isOpen);
    const rest = withMtime.filter(f => !f.isOpen).sort((a, b) => b.mtimeMs - a.mtimeMs);

    const hotRest = rest.slice(0, Math.max(0, HOT_SET_SIZE - open.length));
    const cold = rest.slice(hotRest.length);

    return [...open, ...hotRest, ...cold].map(f => f.file);
  }

  private updateIndexStatus(partial: Partial<IndexStatus>): void {
    this.indexStatus = { ...this.indexStatus, ...partial };
    this.updateStatusBar();
    this.onDidChangeIndexStatus.fire(this.indexStatus);
  }

  private updateStatusBar(): void {
    const { state, filesIndexed, totalFiles, progress, sizeCapped } = this.indexStatus;

    switch (state) {
      case 'indexing':
        this.statusBarItem.text = `$(sync~spin) Indexing ${progress}%`;
        this.statusBarItem.show();
        break;
      case 'idle':
        if (filesIndexed > 0) {
          this.statusBarItem.text = sizeCapped
            ? `$(warning) Venice Index: ${filesIndexed} files (capped)`
            : `$(search) Venice Index: ${filesIndexed} files`;
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
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(INDEXABLE_GLOB);

    const onChangeDisposable = this.fileWatcher.onDidChange(uri => {
      this.reindexFile(uri);
    });

    const onCreateDisposable = this.fileWatcher.onDidCreate(uri => {
      this.reindexFile(uri);
    });

    const onDeleteDisposable = this.fileWatcher.onDidDelete(uri => {
      this.removeFile(uri);
    });

    // Keep the shared ignore rules in sync with .gitignore/.veniceignore edits, so a newly
    // excluded file stops being sent immediately rather than after the extension reloads.
    this.ignoreFileWatcher = vscode.workspace.createFileSystemWatcher('**/{.gitignore,.veniceignore}');
    const onIgnoreChangeDisposable = vscode.Disposable.from(
      this.ignoreFileWatcher.onDidChange(() => this.ignoreService.reload()),
      this.ignoreFileWatcher.onDidCreate(() => this.ignoreService.reload()),
      this.ignoreFileWatcher.onDidDelete(() => this.ignoreService.reload())
    );

    return vscode.Disposable.from(onChangeDisposable, onCreateDisposable, onDeleteDisposable, onIgnoreChangeDisposable);
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this.ignoreFileWatcher?.dispose();
    this.statusBarItem.dispose();
    this.embeddingStore.close();
  }
}
