import * as vscode from 'vscode';
import { Tool, ToolResult } from './permissionManager';

interface GitExtensionAPI {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
  getStatus(): Promise<RepositoryStatus>;
  diff(path: string): Promise<string>;
  commit(message: string, options?: CommitOptions): Promise<void>;
  createBranch(name: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  checkout(name: string): Promise<void>;
  getBranches(): Promise<Branch[]>;
}

interface RepositoryState {
  HEAD?: Branch;
  remotes: Remote[];
  submodules: Submodule[];
  rebaseCommit?: Commit;
  mergeHeadCommit?: Commit;
}

interface RepositoryStatus {
  workingTreeChanges: Change[];
  indexChanges: Change[];
  mergeChanges: Change[];
  untrackedChanges: string[];
  HEAD?: Branch;
}

interface Change {
  uri: vscode.Uri;
  status: 'M' | 'A' | 'D' | 'R' | 'U';
}

interface Branch {
  name: string;
  commit?: string;
  type: 'Local' | 'Remote';
}

interface Remote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

interface Submodule {
  name: string;
  path: string;
  url: string;
}

interface Commit {
  hash: string;
  message: string;
}

interface CommitOptions {
  all?: boolean;
  amend?: boolean;
}

export class GitTools {
  private static async getRepository(): Promise<Repository | null> {
    try {
      const gitExtension = vscode.extensions.getExtension<GitExtensionAPI>('vscode.git');
      if (!gitExtension) {
        return null;
      }

      const gitAPI = gitExtension.exports.getAPI(1);
      return gitAPI.repositories[0] || null;
    } catch {
      return null;
    }
  }

  static readonly STATUS: Tool = {
    name: 'git_status',
    description: 'Get git repository status',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    riskTier: 'readOnly',
    execute: async (): Promise<ToolResult> => {
      try {
        const repo = await GitTools.getRepository();
        if (!repo) {
          return { success: false, error: 'Git repository not found' };
        }

        const status = await repo.getStatus();
        return {
          success: true,
          data: {
            workingTreeChanges: status.workingTreeChanges.length,
            indexChanges: status.indexChanges.length,
            untrackedChanges: status.untrackedChanges.length,
            head: repo.state.HEAD?.name,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get git status',
        };
      }
    },
  };

  static readonly DIFF: Tool = {
    name: 'git_diff',
    description: 'Get diff for a file or staging area',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (optional, defaults to full diff)',
        },
      },
      required: [],
    },
    riskTier: 'readOnly',
    execute: async (args: unknown): Promise<ToolResult> => {
      try {
        const repo = await GitTools.getRepository();
        if (!repo) {
          return { success: false, error: 'Git repository not found' };
        }

        const argsObj = args as { path?: string };
        const diff = argsObj.path ? await repo.diff(argsObj.path) : await repo.diff('');

        return { success: true, data: diff };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get diff',
        };
      }
    },
  };

  static readonly COMMIT: Tool = {
    name: 'git_commit',
    description: 'Create a git commit',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message',
        },
        all: {
          type: 'boolean',
          description: 'Stage all changes before committing (default: false)',
        },
      },
      required: ['message'],
    },
    riskTier: 'workspaceWrite',
    execute: async (args: unknown): Promise<ToolResult> => {
      try {
        const repo = await GitTools.getRepository();
        if (!repo) {
          return { success: false, error: 'Git repository not found' };
        }

        const argsObj = args as { message: string; all?: boolean };
        await repo.commit(argsObj.message, { all: argsObj.all });

        return { success: true, data: { message: 'Committed successfully' } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to commit',
        };
      }
    },
  };

  static readonly BRANCH: Tool = {
    name: 'git_branch',
    description: 'Manage git branches (list, create, checkout, delete)',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'checkout', 'delete'],
          description: 'Branch action to perform',
        },
        name: {
          type: 'string',
          description: 'Branch name (for create, checkout, delete)',
        },
      },
      required: ['action'],
    },
    riskTier: 'workspaceWrite',
    execute: async (args: unknown): Promise<ToolResult> => {
      try {
        const repo = await GitTools.getRepository();
        if (!repo) {
          return { success: false, error: 'Git repository not found' };
        }

        const argsObj = args as { action: string; name?: string };

        switch (argsObj.action) {
          case 'list': {
            const branches = await repo.getBranches();
            return {
              success: true,
              data: branches.map(b => ({ name: b.name, type: b.type })),
            };
          }
          case 'create':
            if (!argsObj.name) {
              return { success: false, error: 'Branch name required' };
            }
            await repo.createBranch(argsObj.name);
            return { success: true, data: { created: argsObj.name } };

          case 'checkout':
            if (!argsObj.name) {
              return { success: false, error: 'Branch name required' };
            }
            await repo.checkout(argsObj.name);
            return { success: true, data: { checkedOut: argsObj.name } };

          case 'delete':
            if (!argsObj.name) {
              return { success: false, error: 'Branch name required' };
            }
            await repo.deleteBranch(argsObj.name);
            return { success: true, data: { deleted: argsObj.name } };

          default:
            return { success: false, error: `Unknown action: ${argsObj.action}` };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to manage branch',
        };
      }
    },
  };
}
