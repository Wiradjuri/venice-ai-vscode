import * as vscode from 'vscode';
import * as parse from 'shell-quote';
import { Tool, ToolResult } from './permissionManager';

const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 20000;

// Strips ANSI escape/control sequences so tool results are plain text for the model.
function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[a-zA-Z]|\x1b[PX^_].*?\x1b\\|\x1b./g, '');
}

function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, SHELL_INTEGRATION_TIMEOUT_MS);
    const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
      if (e.terminal === terminal) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(e.shellIntegration);
      }
    });
  });
}

function waitForExecutionEnd(execution: vscode.TerminalShellExecution): Promise<number | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, COMMAND_TIMEOUT_MS);
    const disposable = vscode.window.onDidEndTerminalShellExecution(e => {
      if (e.execution === execution) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(e.exitCode);
      }
    });
  });
}

export class TerminalTools {
  static readonly RUN_COMMAND: Tool = {
    name: 'run_terminal_command',
    description: 'Run a shell command in a terminal and return its output and exit code',
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
        // Parse into argv purely to inspect/dispatch it — never re-serialized into a shell string.
        const argv = parse.parse(argsObj.command);
        if (argv.length === 0 || argv.some(token => typeof token !== 'string')) {
          return { success: false, error: 'Empty or unsupported command' };
        }
        const [executable, ...cmdArgs] = argv as string[];

        const terminal = vscode.window.createTerminal({
          name: 'Venice',
          cwd: argsObj.cwd,
        });
        terminal.show();

        const shellIntegration = await waitForShellIntegration(terminal);

        if (!shellIntegration) {
          // Shells without integration (or ones that haven't reported in yet) can't give us
          // captured output/exit codes — fall back to typing the command visibly.
          terminal.sendText(argsObj.command);
          return {
            success: true,
            data: {
              command: argsObj.command,
              message: 'Shell integration unavailable; command sent to terminal without output capture.',
            },
          };
        }

        // executeCommand(executable, args) dispatches argv directly — the shell integration
        // layer quotes it for the user's shell, so nothing here re-parses a string.
        const execution = shellIntegration.executeCommand(executable, cmdArgs);
        const exitCodePromise = waitForExecutionEnd(execution);

        let output = '';
        // read() must be called immediately after executeCommand to avoid missing output.
        for await (const chunk of execution.read()) {
          output += chunk;
          if (output.length > MAX_OUTPUT_CHARS) {
            break;
          }
        }

        const exitCode = await exitCodePromise;
        const cleaned = stripAnsi(output).slice(0, MAX_OUTPUT_CHARS);

        return {
          success: exitCode === 0,
          data: { command: argsObj.command, exitCode: exitCode ?? null },
          stdout: cleaned,
          error: exitCode !== undefined && exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined,
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
