import * as vscode from 'vscode';
import { VeniceClient, ChatMessage, ToolDefinition } from '../api/venice';
import { ToolRegistry } from '../tools';
import { WorkspaceIndexer, RelevanceRanker } from '../context';
import { IgnoreService } from '../security/ignoreService';
import { getCurrentSelection } from '../utils/context';

const MAX_TOOL_ITERATIONS = 8;
const TOOL_RESULT_CHAR_CAP = 4000;
const CONTEXT_CHAR_BUDGET = 6000;
const CONTEXT_TOP_K = 8;
const EDITOR_CONTEXT_CHAR_BUDGET = 4000;

const AGENT_SYSTEM_PROMPT =
  'You are Venice AI, a coding assistant embedded in VS Code with access to tools for reading ' +
  'and writing files, searching the workspace, running terminal commands, and interacting with ' +
  'git and the debugger. Every turn you are also told which editor tabs the user has open and ' +
  'given the active file\'s current content (or selection, if any) directly — treat that as ' +
  'ground truth about what the user is looking at right now, and prefer it over calling ' +
  'read_file on the same path. Use tools when you need information you do not already have or ' +
  'need to make changes; do not guess about file contents. Prefer the smallest set of tool calls ' +
  'that answers the request, and explain what you did once finished.';

export type AgentEvent =
  | { type: 'toolCall'; id: string; name: string; args: string }
  | { type: 'toolResult'; id: string; name: string; success: boolean };

export interface AgentRunResult {
  reply: string;
  /** New messages to append to persistent history — only meaningful once run() resolves. */
  messages: ChatMessage[];
}

/**
 * Drives the tool-calling loop for a single chat turn: assembles retrieved workspace context,
 * calls Venice with the registered tool schemas, and executes any requested tools (each still
 * gated by PermissionManager inside ToolRegistry) until the model returns a plain text answer.
 *
 * Uses the non-streaming VeniceClient.chat() rather than chatStream() for every round of the
 * loop, since tool_calls need to arrive as a complete, addressable message before they can be
 * executed and answered — there's no benefit to streaming a message the UI can't act on until
 * it's finished anyway.
 */
export class AgentSession {
  constructor(
    private readonly client: VeniceClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly indexer: WorkspaceIndexer,
    private readonly ranker: RelevanceRanker,
    private readonly ignoreService: IgnoreService
  ) {}

  async run(
    userMessage: string,
    history: ChatMessage[],
    onEvent?: (event: AgentEvent) => void
  ): Promise<AgentRunResult> {
    const newMessages: ChatMessage[] = [];

    if (history.length === 0) {
      newMessages.push({ role: 'system', content: AGENT_SYSTEM_PROMPT });
    }
    newMessages.push({ role: 'user', content: userMessage });

    // Context is assembled fresh from the latest user message every turn and inserted just for
    // this call, rather than persisted into history, so it doesn't stack up turn over turn.
    const editorContextMessage = this.buildEditorContext();
    const contextMessage = await this.assembleContext(userMessage);
    const working: ChatMessage[] = [...history, ...newMessages];
    const toInsert = [editorContextMessage, contextMessage].filter(
      (m): m is ChatMessage => m !== null
    );
    if (toInsert.length > 0) {
      working.splice(working.length - 1, 0, ...toInsert);
    }

    const tools: ToolDefinition[] = this.toolRegistry.getSchemas();

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const result = await this.client.chat(working, { tools });

      if (typeof result === 'string') {
        newMessages.push({ role: 'assistant', content: result });
        return { reply: result, messages: newMessages };
      }

      working.push(result);
      newMessages.push(result);

      for (const call of result.tool_calls ?? []) {
        onEvent?.({ type: 'toolCall', id: call.id, name: call.function.name, args: call.function.arguments });
        const toolResult = await this.toolRegistry.execute(call);
        onEvent?.({ type: 'toolResult', id: call.id, name: call.function.name, success: toolResult.success });

        const toolMessage: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: this.stringifyToolResult(toolResult)
        };
        working.push(toolMessage);
        newMessages.push(toolMessage);
      }
    }

    throw new Error(`Venice AI stopped after ${MAX_TOOL_ITERATIONS} tool calls without a final answer.`);
  }

  private stringifyToolResult(result: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(result);
    } catch {
      text = String(result);
    }
    return text.length > TOOL_RESULT_CHAR_CAP
      ? `${text.slice(0, TOOL_RESULT_CHAR_CAP)}... (truncated)`
      : text;
  }

  /**
   * Surfaces what the user actually has open right now — tab list, active file, and either its
   * selection or full content — as ground truth the model gets for free every turn, instead of
   * relying solely on semantic search (which is blind to unsaved edits and can miss the very
   * file the user is looking at).
   */
  private buildEditorContext(): ChatMessage | null {
    const openTabs = [
      ...new Set(
        vscode.window.tabGroups.all
          .flatMap(group => group.tabs)
          .map(tab => tab.input)
          .filter((input): input is vscode.TabInputText => input instanceof vscode.TabInputText)
          .map(input => vscode.workspace.asRelativePath(input.uri))
      )
    ];

    const editor = vscode.window.activeTextEditor;
    const sections: string[] = [];

    if (openTabs.length > 0) {
      sections.push(`Open editor tabs: ${openTabs.join(', ')}`);
    }

    if (editor) {
      const activePath = vscode.workspace.asRelativePath(editor.document.uri);
      const dirtySuffix = editor.document.isDirty ? ' (has unsaved changes)' : '';
      sections.push(`Active file: ${activePath}${dirtySuffix}`);

      const selection = getCurrentSelection(editor);
      if (selection) {
        const truncated = selection.length > EDITOR_CONTEXT_CHAR_BUDGET
          ? `${selection.slice(0, EDITOR_CONTEXT_CHAR_BUDGET)}\n... (truncated)`
          : selection;
        sections.push(
          `Current selection in ${activePath}:\n\`\`\`${editor.document.languageId}\n${truncated}\n\`\`\``
        );
      } else {
        const fullText = editor.document.getText();
        const truncated = fullText.length > EDITOR_CONTEXT_CHAR_BUDGET
          ? `${fullText.slice(0, EDITOR_CONTEXT_CHAR_BUDGET)}\n... (truncated)`
          : fullText;
        sections.push(
          `Active file content (${activePath}):\n\`\`\`${editor.document.languageId}\n${truncated}\n\`\`\``
        );
      }
    }

    if (sections.length === 0) {
      return null;
    }

    return {
      role: 'system',
      content: `Editor state, reflecting exactly what the user has open right now:\n\n${sections.join('\n\n')}`
    };
  }

  private async assembleContext(userMessage: string): Promise<ChatMessage | null> {
    try {
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString() ?? '';
      this.ranker.setCurrentFile(activeUri);

      const scored = await this.indexer.query(userMessage, CONTEXT_TOP_K * 2);
      if (scored.length === 0) {
        return null;
      }

      const ranked = await this.ranker.rank(scored);
      const visible = ranked
        .filter(item => !this.isChunkIgnored(item.chunk.uri))
        .slice(0, CONTEXT_TOP_K);

      if (visible.length === 0) {
        return null;
      }

      let budget = CONTEXT_CHAR_BUDGET;
      const parts: string[] = [];
      for (const item of visible) {
        const label = this.displayPath(item.chunk.uri);
        const snippet = `File: ${label} (lines ${item.chunk.startLine + 1}-${item.chunk.endLine + 1})\n\`\`\`${item.chunk.language}\n${item.chunk.content}\n\`\`\``;
        if (snippet.length > budget) {
          continue; // skip an oversized snippet but keep trying smaller, lower-ranked ones
        }
        parts.push(snippet);
        budget -= snippet.length;
      }

      if (parts.length === 0) {
        return null;
      }

      return {
        role: 'system',
        content: `Relevant workspace context, retrieved automatically and possibly incomplete:\n\n${parts.join('\n\n')}`
      };
    } catch (error) {
      console.warn('Venice: context assembly failed, continuing without it', error);
      return null;
    }
  }

  private isChunkIgnored(uri: string): boolean {
    try {
      return this.ignoreService.isIgnored(vscode.Uri.parse(uri).fsPath);
    } catch {
      return false;
    }
  }

  private displayPath(uri: string): string {
    try {
      return vscode.workspace.asRelativePath(vscode.Uri.parse(uri));
    } catch {
      return uri;
    }
  }
}
