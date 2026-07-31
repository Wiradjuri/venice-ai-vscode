import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Ignore } from 'ignore';
import ignore from 'ignore';

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.vscode', 'dist', 'build', '.next', 'out'];

/**
 * Single source of truth for "should Venice ever see this file's content" — shared by the
 * workspace indexer and by inline completions/chat so a file excluded via .veniceignore is
 * never sent even if the user has it open. Anchored on the first workspace folder; files
 * outside it are never sent since they can't be resolved to a workspace-relative path.
 */
export class IgnoreService {
  private ignorer: Ignore;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.ignorer = this.build();
  }

  /** Re-read .gitignore/.veniceignore from disk — call after either file changes. */
  reload(): void {
    this.ignorer = this.build();
  }

  isIgnored(fsPath: string): boolean {
    if (!this.workspaceRoot) {
      return false;
    }
    const resolved = path.resolve(this.workspaceRoot, fsPath);
    const rel = path.relative(this.workspaceRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      // Outside the workspace root — not covered by workspace ignore rules.
      return false;
    }
    return this.ignorer.ignores(rel);
  }

  isDocumentIgnored(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') {
      return false;
    }
    return this.isIgnored(document.uri.fsPath);
  }

  private build(): Ignore {
    const ig = ignore();
    ig.add(this.readIgnoreFile('.gitignore'));
    ig.add(this.readIgnoreFile('.veniceignore'));
    ig.add(DEFAULT_EXCLUDES);
    return ig;
  }

  private readIgnoreFile(fileName: string): string {
    try {
      return fs.readFileSync(path.join(this.workspaceRoot, fileName), 'utf-8');
    } catch {
      return '';
    }
  }
}
