import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Tool, ToolResult } from './permissionManager';

const execFileAsync = promisify(execFile);

interface RipgrepMatch {
  path: string;
  line: number;
  text: string;
}

export class FilesystemTools {
  static readonly READ_FILE: Tool = {
    name: 'read_file',
    description: 'Read the contents of a file',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path',
        },
      },
      required: ['path'],
    },
    riskTier: 'readOnly',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as { path: string };
      try {
        const content = await fs.readFile(argsObj.path, 'utf-8');
        return { success: true, data: content };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    },
  };

  static readonly LIST_DIRECTORY: Tool = {
    name: 'list_directory',
    description: 'List contents of a directory',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative directory path',
        },
      },
      required: ['path'],
    },
    riskTier: 'readOnly',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as { path: string };
      try {
        const entries = await fs.readdir(argsObj.path, { withFileTypes: true });
        const files = entries.map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }));
        return { success: true, data: files };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list directory',
        };
      }
    },
  };

  static readonly SEARCH_WORKSPACE: Tool = {
    name: 'search_workspace',
    description: 'Search the workspace for a text or regex pattern using ripgrep',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Directory to search within (optional, defaults to the workspace root)',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a regular expression (default: false, i.e. literal text)',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search (default: false)',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches to return (default: 50, capped at 200)',
        },
      },
      required: ['query'],
    },
    riskTier: 'readOnly',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as {
        query: string;
        path?: string;
        regex?: boolean;
        caseSensitive?: boolean;
        maxResults?: number;
      };

      const searchPath = argsObj.path || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
      const maxResults = Math.min(Math.max(argsObj.maxResults ?? 50, 1), 200);

      // argv passed straight to execFile — never re-serialized into a shell string.
      const rgArgs = ['--json', '--max-count', String(maxResults)];
      if (!argsObj.regex) {
        rgArgs.push('--fixed-strings');
      }
      if (!argsObj.caseSensitive) {
        rgArgs.push('--ignore-case');
      }
      rgArgs.push('--', argsObj.query, searchPath);

      try {
        const { stdout } = await execFileAsync('rg', rgArgs, { maxBuffer: 10 * 1024 * 1024 });
        return { success: true, data: FilesystemTools.parseRipgrepOutput(stdout, maxResults) };
      } catch (error) {
        const err = error as { code?: number | string; stdout?: string; message?: string };
        if (err.code === 'ENOENT') {
          return { success: false, error: 'ripgrep (rg) is not installed or not on PATH' };
        }
        // ripgrep exits with code 1 (no error) when there are simply no matches.
        if (err.code === 1) {
          return { success: true, data: FilesystemTools.parseRipgrepOutput(err.stdout ?? '', maxResults) };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Search failed',
        };
      }
    },
  };

  private static parseRipgrepOutput(stdout: string, maxResults: number): RipgrepMatch[] {
    const matches: RipgrepMatch[] = [];
    for (const line of stdout.split('\n')) {
      if (!line) {
        continue;
      }
      try {
        const event = JSON.parse(line);
        if (event.type === 'match') {
          matches.push({
            path: event.data.path.text,
            line: event.data.line_number,
            text: (event.data.lines.text as string).replace(/\n$/, ''),
          });
          if (matches.length >= maxResults) {
            break;
          }
        }
      } catch {
        // Skip lines that aren't valid ripgrep JSON events.
      }
    }
    return matches;
  }

  static readonly WRITE_FILE: Tool = {
    name: 'write_file',
    description: 'Create or overwrite a file',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path',
        },
        content: {
          type: 'string',
          description: 'File content',
        },
      },
      required: ['path', 'content'],
    },
    riskTier: 'workspaceWrite',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as { path: string; content: string };
      try {
        const uri = vscode.Uri.file(argsObj.path);
        const edit = new vscode.WorkspaceEdit();
        const document = await vscode.workspace.openTextDocument(uri);

        // Replace entire file
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
        edit.replace(uri, fullRange, argsObj.content);

        await vscode.workspace.applyEdit(edit);
        return { success: true, data: { path: argsObj.path } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to write file',
        };
      }
    },
  };

  static readonly APPLY_PATCH: Tool = {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to a file',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to patch',
        },
        patch: {
          type: 'string',
          description: 'Unified diff patch',
        },
      },
      required: ['path', 'patch'],
    },
    riskTier: 'workspaceWrite',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as { path: string; patch: string };
      try {
        const uri = vscode.Uri.file(argsObj.path);
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();

        // Parse and apply unified diff (simplified version)
        const lines = text.split('\n');
        const patchLines = argsObj.patch.split('\n');

        // Find hunk headers and apply changes
        let lineIndex = 0;
        let patchIndex = 0;

        while (patchIndex < patchLines.length) {
          const line = patchLines[patchIndex];

          if (line.startsWith('@@')) {
            // Hunk header: extract starting line number
            const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
            if (match) {
              lineIndex = parseInt(match[2]) - 1;
            }
            patchIndex++;
            continue;
          }

          if (line.startsWith('-')) {
            // Remove line
            if (lineIndex < lines.length && lines[lineIndex] === line.slice(1)) {
              lines.splice(lineIndex, 1);
            } else {
              patchIndex++;
              continue;
            }
          } else if (line.startsWith('+')) {
            // Add line
            lines.splice(lineIndex, 0, line.slice(1));
            lineIndex++;
          } else if (!line.startsWith('\\')) {
            // Context line
            lineIndex++;
          }

          patchIndex++;
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
        edit.replace(uri, fullRange, lines.join('\n'));

        await vscode.workspace.applyEdit(edit);
        return { success: true, data: { path: argsObj.path, linesModified: patchLines.length } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to apply patch',
        };
      }
    },
  };
}
