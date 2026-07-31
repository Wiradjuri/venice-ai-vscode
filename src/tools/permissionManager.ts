import * as path from 'path';
import * as vscode from 'vscode';

export type RiskTier = 'readOnly' | 'workspaceWrite' | 'exec' | 'destructive';

export interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema
  riskTier: RiskTier;
  execute(args: unknown): Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  stderr?: string;
  stdout?: string;
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export class PermissionManager {
  private workspaceRoot: string;
  private approvedOnce = new Set<string>(); // tool names approved for this session

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Check if a tool call is permitted
   * Returns 'approved' if allowed, 'denied' if blocked
   */
  async request(toolName: string, args: unknown, riskTier: RiskTier): Promise<'approved' | 'denied'> {
    // Always approved for read-only operations
    if (riskTier === 'readOnly') {
      return 'approved';
    }

    // Check denylist for dangerous patterns
    if (riskTier === 'exec' && !this.isCommandSafe(args)) {
      return 'denied';
    }

    // Check path confinement for file operations
    if (riskTier === 'workspaceWrite' && !this.isPathConfined(args)) {
      return 'denied';
    }

    // If already approved once in this session, approve again
    if (this.approvedOnce.has(toolName)) {
      return 'approved';
    }

    // Show approval UI for exec/destructive operations
    const choice = await vscode.window.showWarningMessage(
      `Approve tool call: ${toolName}?`,
      { modal: true },
      { title: 'Approve', id: 'approve' },
      { title: 'Deny', id: 'deny' },
      { title: 'Always Allow', id: 'always' }
    );

    if (choice?.id === 'always') {
      this.approvedOnce.add(toolName);
      return 'approved';
    }

    return choice?.id === 'approve' ? 'approved' : 'denied';
  }

  isPathConfined(args: unknown): boolean {
    if (!args || typeof args !== 'object') {
      return true;
    }

    const argsObj = args as Record<string, unknown>;
    const paths = [argsObj.path, argsObj.filePath, argsObj.uri];

    for (const p of paths) {
      if (typeof p === 'string') {
        try {
          const resolved = path.resolve(p);
          const rel = path.relative(this.workspaceRoot, resolved);

          // Check if resolved path is outside workspace
          if (rel.startsWith('..')) {
            return false;
          }
        } catch {
          return false;
        }
      }
    }

    return true;
  }

  private isCommandSafe(args: unknown): boolean {
    if (!args || typeof args !== 'object') {
      return true;
    }

    const argsObj = args as Record<string, unknown>;
    const cmd = (argsObj.command as string) || '';

    // Denylist of dangerous patterns
    const blocked = [
      /\brm\s+-rf\b/,
      /\bdd\b/,
      /\bmkfs/,
      /\bsudo\b/,
      /\bshutdown\b/,
      /\breboot\b/,
      /\bchmod\s+-R\b/,
      /[;&|`$()]/,
    ];

    for (const pattern of blocked) {
      if (pattern.test(cmd)) {
        return false;
      }
    }

    return true;
  }
}
