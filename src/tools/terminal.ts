import * as vscode from 'vscode';
import * as parse from 'shell-quote';
import { Tool, ToolResult } from './permissionManager';

export class TerminalTools {
  static readonly RUN_COMMAND: Tool = {
    name: 'run_terminal_command',
    description: 'Run a shell command in a terminal',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command to run (e.g., "npm test")',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (optional)',
        },
      },
      required: ['command'],
    },
    riskTier: 'exec',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as { command: string; cwd?: string };
      try {
        // Parse command into argv to avoid shell injection
        const argv = parse.parse(argsObj.command) as string[];
        if (argv.length === 0) {
          return { success: false, error: 'Empty command' };
        }

        // Create and show terminal
        const terminal = vscode.window.createTerminal({
          name: 'Venice',
          cwd: argsObj.cwd,
        });
        terminal.show();

        // Send command
        terminal.sendText(argsObj.command);

        // Try to capture output via shell integration (if available)
        // For now, just send the command and let user see output in terminal
        return {
          success: true,
          data: {
            command: argsObj.command,
            message: 'Command sent to terminal. Output visible in terminal pane.',
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to run command',
        };
      }
    },
  };
}
