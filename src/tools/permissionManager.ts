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
  // workspaceWrite tools approved for the rest of the session, pinned by tool name.
  private alwaysAllowedTools = new Set<string>();
  // exec-tier commands approved for the rest of the session, pinned by the exact command
  // string (never by tool name) so "Always Allow" can't silently green-light a different command.
  private alwaysAllowedCommands = new Set<string>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Check if a tool call is permitted
   * Returns 'approved' if allowed, 'denied' if blocked
   */
  async request(toolName: string, args: unknown, riskTier: RiskTier): Promise<'approved' | 'denied'> {
    // Path confinement applies to every tool that carries a path/uri/cwd argument,
    // regardless of risk tier — a readOnly tool can still leak files outside the workspace.
    if (!this.isPathConfined(args)) {
      return 'denied';
    }

    // Always approved for read-only operations
    if (riskTier === 'readOnly') {
      return 'approved';
    }

    // Check denylist for dangerous patterns
    if (riskTier === 'exec' && !this.isCommandSafe(args)) {
      return 'denied';
    }

    const commandKey = riskTier === 'exec' ? this.extractCommand(args) : undefined;

    // If already approved once in this session, approve again
    if (riskTier === 'workspaceWrite' && this.alwaysAllowedTools.has(toolName)) {
      return 'approved';
    }
    if (riskTier === 'exec' && commandKey !== undefined && this.alwaysAllowedCommands.has(commandKey)) {
      return 'approved';
    }

    // Show approval UI for workspaceWrite/exec/destructive operations, with the actual
    // command/args so the user knows exactly what they're approving.
    const buttons: Array<vscode.MessageItem & { id: string }> = [
      { title: 'Approve', id: 'approve' },
      { title: 'Deny', id: 'deny' },
    ];
    // "Always Allow" is never offered for destructive operations — every call requires a
    // fresh, explicit decision.
    if (riskTier !== 'destructive') {
      buttons.push({ title: 'Always Allow', id: 'always' });
    }

    const choice = await vscode.window.showWarningMessage(
      `Venice wants to run "${toolName}"`,
      { modal: true, detail: this.describeToolCall(args) },
      ...buttons
    );

    if (choice?.id === 'always') {
      if (riskTier === 'exec' && commandKey !== undefined) {
        this.alwaysAllowedCommands.add(commandKey);
      } else if (riskTier === 'workspaceWrite') {
        this.alwaysAllowedTools.add(toolName);
      }
      return 'approved';
    }

    return choice?.id === 'approve' ? 'approved' : 'denied';
  }

  isPathConfined(args: unknown): boolean {
    if (!args || typeof args !== 'object') {
      return true;
    }

    const argsObj = args as Record<string, unknown>;
    const paths = [argsObj.path, argsObj.filePath, argsObj.uri, argsObj.cwd];

    for (const p of paths) {
      if (typeof p === 'string') {
        // Anchor relative paths on the workspace root, not the extension host's cwd.
        const resolved = path.resolve(this.workspaceRoot, p);
        const rel = path.relative(this.workspaceRoot, resolved);

        // Outside the workspace if relative path escapes upward or is itself absolute
        // (the latter happens when resolved lands on a different drive on Windows).
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return false;
        }
      }
    }

    return true;
  }

  private extractCommand(args: unknown): string | undefined {
    if (!args || typeof args !== 'object') {
      return undefined;
    }
    const cmd = (args as Record<string, unknown>).command;
    return typeof cmd === 'string' ? cmd : undefined;
  }

  private describeToolCall(args: unknown): string {
    if (!args || typeof args !== 'object') {
      return '';
    }
    const obj = args as Record<string, unknown>;
    if (typeof obj.command === 'string') {
      return obj.command;
    }
    if (typeof obj.path === 'string') {
      return obj.path;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return '';
    }
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
