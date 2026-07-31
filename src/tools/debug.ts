import * as vscode from 'vscode';
import { Tool, ToolResult } from './permissionManager';

export class DebugTools {
  static readonly START: Tool = {
    name: 'debug_start',
    description:
      'Start a debug session, either by name of a configuration in launch.json or an inline debug configuration',
    schema: {
      type: 'object',
      properties: {
        configurationName: {
          type: 'string',
          description: 'Name of a launch.json configuration to start',
        },
        configuration: {
          type: 'object',
          description: 'Inline debug configuration (used only if configurationName is omitted)',
        },
      },
      required: [],
    },
    riskTier: 'exec',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as {
        configurationName?: string;
        configuration?: vscode.DebugConfiguration;
      };

      const folder = vscode.workspace.workspaceFolders?.[0];
      let target: string | vscode.DebugConfiguration;

      if (argsObj.configurationName) {
        target = argsObj.configurationName;
      } else if (argsObj.configuration) {
        target = argsObj.configuration;
      } else {
        return { success: false, error: 'Either configurationName or configuration is required' };
      }

      try {
        const started = await vscode.debug.startDebugging(folder, target);
        if (!started) {
          return { success: false, error: 'Failed to start debug session' };
        }
        return {
          success: true,
          data: { started: true, session: vscode.debug.activeDebugSession?.name },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start debugging',
        };
      }
    },
  };

  static readonly SET_BREAKPOINT: Tool = {
    name: 'set_breakpoint',
    description: 'Set a source breakpoint at a file and line, optionally with a condition',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path',
        },
        line: {
          type: 'number',
          description: '1-based line number',
        },
        condition: {
          type: 'string',
          description: 'Optional breakpoint condition expression',
        },
      },
      required: ['path', 'line'],
    },
    riskTier: 'exec',
    execute: async (args: unknown): Promise<ToolResult> => {
      const argsObj = args as { path: string; line: number; condition?: string };
      try {
        const uri = vscode.Uri.file(argsObj.path);
        const position = new vscode.Position(Math.max(0, argsObj.line - 1), 0);
        const location = new vscode.Location(uri, position);
        const breakpoint = new vscode.SourceBreakpoint(location, true, argsObj.condition);

        vscode.debug.addBreakpoints([breakpoint]);

        return { success: true, data: { path: argsObj.path, line: argsObj.line } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set breakpoint',
        };
      }
    },
  };
}
