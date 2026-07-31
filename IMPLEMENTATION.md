# Phase 1 & 3 Implementation Summary

## Overview

Phase 1 (Foundational Context Indexing) and Phase 3 (Tooling & Permissions) have been successfully implemented for the Venice AI VS Code extension, enabling repository-wide semantic understanding and safe tool execution.

## Phase 1: Context Indexing

### Components Implemented

**1. Core Types** (`src/context/types.ts`)
- `CodeChunk`: representation of code fragments with metadata (URI, line numbers, language, type)
- `EmbeddedChunk`: chunks with embedding vectors and content hashes
- `ScoredChunk`: chunks ranked by relevance signals
- `IndexStatus`: indexing progress tracking

**2. EmbeddingStore** (`src/context/embeddingStore.ts`)
- SQLite database at `context.globalStorageUri/venice-index.db`
- Loads `Xenova/all-MiniLM-L6-v2` local embedding model (ONNX, no network required)
- Implements incremental indexing via content hashing
- Cosine similarity search: `query(text, k=10)` returns top-K similar chunks
- Schema: `chunks(id, uri, startLine, endLine, content, language, type, contentHash, embedding, lastModified)`

**3. Chunker** (`src/context/chunker.ts`)
- **Primary strategy**: LSP symbol provider (function/class/method boundaries)
- **Fallback**: sliding window (512 char window, 256 char overlap)
- Automatically selects best strategy per file
- Supports all languages with LSP; falls back for unsupported

**4. RelevanceRanker** (`src/context/relevanceRanker.ts`)
- Multi-signal ranking:
  - Embedding similarity (0.5 weight)
  - Import distance via file paths (0.2)
  - Path proximity (0.15)
  - Recency of edits (0.15)
- Normalizes signals to 0-1 range
- Returns chunks sorted by composite score

**5. WorkspaceIndexer** (`src/context/workspaceIndexer.ts`)
- Finds all indexable files via `vscode.workspace.findFiles()`
- Filters by `.gitignore` + `.veniceignore` rules (via `ignore` package)
- Debounced per-file reindexing on save (500ms debounce)
- Incremental updates: skips files with unchanged content
- File watcher integration: on create/change/delete events
- Status bar item showing `Venice Index: N files` or `$(sync~spin) Indexing N%`

### Integration

- **extension.ts**: Initializes `WorkspaceIndexer` on activation, registers file watcher, adds `venice.rebuildIndex` command
- **Future (Phase 2)**: Chat provider will call `ranker.rank(embeddingStore.query(userMessage))` before sending to Venice

### Dependencies Added

- `better-sqlite3@^13.0.2` — native SQLite for indexing performance
- `@xenova/transformers@^2.7.0` — local embedding model (ONNX)
- `ignore@^5.3.0` — .gitignore/.veniceignore parsing
- `@types/better-sqlite3` — TypeScript types

---

## Phase 3: Tooling & Permissions

### Components Implemented

**1. PermissionManager** (`src/tools/permissionManager.ts`)
- **Denylist gate**: blocks `rm -rf`, `dd`, `mkfs`, `sudo`, `shutdown`, `reboot`, `chmod -R`, shell composition (`;&|$()`)
- **Path confinement**: rejects `path`/`filePath`/`uri`/`cwd` arguments that resolve outside the
  workspace root, for *every* tool call regardless of risk tier (a readOnly tool can leak files
  just as easily as a write); relative paths are anchored on the workspace root, not the extension
  host's process cwd
- **Approval UI**: `vscode.window.showWarningMessage()` for workspaceWrite/exec/destructive tiers,
  showing the actual command or path being requested (not just the tool name)
- **Scoped "Always Allow"**: pins the exact command string for `exec`-tier tools (not the tool
  name — approving `npm test` once doesn't silently approve `npm publish` later) and the tool name
  for `workspaceWrite`-tier tools; never offered at all for `destructive` tier, which always
  requires a fresh per-call decision
- Risk tiers: `readOnly`, `workspaceWrite`, `exec`, `destructive`

**2. ToolRegistry** (`src/tools/toolRegistry.ts`)
- Collects all tool definitions
- Generates OpenAI-compatible `tools` array for Venice API
- `execute(toolCall)`: permission check → tool execution → result
- `executeBatch(toolCalls)`: parallel execution with results array

**3. Filesystem Tools** (`src/tools/filesystem.ts`)
- `read_file`: vscode.workspace.fs + fs.readFile
- `list_directory`: vscode.workspace.fs.readDirectory
- `search_workspace`: ripgrep (`rg --json`) via `child_process.execFile` with an argv array
  (never a shell string); supports literal/regex, case sensitivity, and a capped result count;
  returns a clear error if `rg` isn't on PATH
- `write_file`: vscode.workspace.applyEdit (WorkspaceEdit)
- `apply_patch`: unified diff parsing and application

**4. Terminal Tools** (`src/tools/terminal.ts`)
- `run_terminal_command`: parses the command with `shell-quote` into argv purely for
  inspection/dispatch — never re-serialized into a shell string
- Dispatches via the VS Code Terminal Shell Integration API
  (`terminal.shellIntegration.executeCommand(executable, args)`), which quotes argv for the
  user's actual shell, and captures real stdout (via `execution.read()`, ANSI-stripped) and the
  exit code (via `onDidEndTerminalShellExecution`) — the agent loop gets a real result instead of
  "command sent, go look at the terminal"
- Falls back to `terminal.sendText()` (visible, uncaptured) if shell integration hasn't activated
  within 5s, e.g. shells that don't support it
- Bounded: 5s wait for shell integration, 120s command timeout, 20K char output cap
- Denylist + path confinement (on `cwd`) validation via PermissionManager
- Risk tier: `exec`

**5. Git Tools** (`src/tools/git.ts`)
- `git_status`: repository status
- `git_diff`: staging area or file diff
- `git_commit`: create commit with optional `--all`
- `git_branch`: list/create/checkout/delete branches
- Uses VS Code Git extension API (not git CLI)

**6. Debug Tools** (`src/tools/debug.ts`)
- `debug_start`: starts a session via `vscode.debug.startDebugging`, either by a named
  `launch.json` configuration or an inline configuration object
- `set_breakpoint`: adds a `vscode.SourceBreakpoint` at a file/line, with an optional condition
- Risk tier: `exec` for both (starting a debuggee runs arbitrary program code)

### Integration

- **extension.ts**: Initializes `PermissionManager` + `ToolRegistry`, registers all tools
  (including `search_workspace`, `debug_start`, `set_breakpoint`), exports via
  `getToolRegistry()` for Phase 2
- **VeniceClient** extended to accept `tools` array and parse `tool_calls` in responses
- **ChatMessage** and **CompletionOptions** updated to support tool-calling
- **package.json**: `engines.vscode` / `@types/vscode` bumped to `^1.93.0`, the release that
  finalized the Terminal Shell Integration API `run_terminal_command` depends on

### New API Surfaces

**VeniceClient changes**:
- `ChatMessage`: added `'tool'` role, optional `tool_calls` and `tool_call_id`
- `CompletionOptions`: added `tools[]` and `tool_choice`
- `chat()` return type: now `string | ChatMessage` to support tool calls
- `chatStream()` return type: now yields `string | ChatMessage`

---

## Testing

### Phase 1 Testing
```bash
npm run compile                  # Verify TS compilation
vscode F5                        # Launch Extension Host
# In VS Code:
# 1. Run "Venice: Rebuild Index" command
# 2. Check status bar shows "Venice Index: N files"
# 3. Edit a file, verify incremental update
# 4. Check ~/.vscode-oss/user-data/globalStorage/venice-ai/ for sqlite db
```

### Phase 3 Testing
```bash
# Manually test each tool:
# 1. File tools: read_file / list_directory on a file in the workspace
# 2. search_workspace: query for a known string, confirm rg results and an ENOENT-style
#    error when rg is temporarily removed from PATH
# 3. Terminal: run_terminal_command("echo hello") — confirm the approval dialog shows the
#    literal command, and the result includes captured stdout + exitCode: 0
# 4. Terminal denylist: run_terminal_command("rm -rf /") — confirm it's denied with no prompt
# 5. Path confinement: read_file with path "../../etc/passwd" — confirm denial with no prompt
# 6. Always Allow scoping: approve one run_terminal_command with "Always Allow", then issue a
#    different command — confirm the second one still prompts
# 7. Destructive tier: confirm no "Always Allow" button is ever offered (no destructive-tier
#    tool ships yet, but PermissionManager.request() omits the button for that tier)
# 8. Git: git_status on a repo
# 9. Debug: debug_start with a configurationName from launch.json, set_breakpoint on an open file
```

---

## Files Created/Modified

### New Files
```
src/context/
  ├── types.ts
  ├── embeddingStore.ts
  ├── chunker.ts
  ├── relevanceRanker.ts
  ├── workspaceIndexer.ts
  └── index.ts

src/tools/
  ├── permissionManager.ts
  ├── toolRegistry.ts
  ├── filesystem.ts
  ├── terminal.ts
  ├── git.ts
  ├── debug.ts
  └── index.ts
```

### Modified Files
```
src/extension.ts                 # Initialize indexer, tools, ranker; register search_workspace/debug tools
src/api/venice.ts               # Add tool-calling support
package.json                    # Dependencies: better-sqlite3, transformers, ignore, shell-quote;
                                 # engines.vscode / @types/vscode bumped to ^1.93.0
```

---

## Architecture Highlights

1. **Incremental & efficient**: SQLite + content hashing avoids re-indexing unchanged files
2. **No network indexing**: Xenova transformers runs locally, embeddings never leave the machine
3. **Security first**: denylist + path confinement + human approval gates all dangerous operations
4. **Modular tools**: each tool is independently testable and replaceable
5. **LSP-aware**: leverages existing language servers for precise code understanding
6. **Workspace-scoped**: indexer respects workspace boundaries and ignore rules

---

## Phase 2 Readiness

The extension now has all infrastructure for Phase 2 (Agent Loop):
- `VeniceClient` supports tool-calling
- `ToolRegistry.getSchemas()` provides OpenAI-compatible tool definitions
- `ToolRegistry.execute(toolCall)` handles approval + execution
- `RelevanceRanker` provides multi-signal ranking for context assembly
- `getIndexer()`, `getToolRegistry()`, `getRelevanceRanker()` exported from extension.ts

Phase 2 implementation will create `AgentSession` class that:
1. Calls `indexer.query(userMessage)` → rank → assemble context
2. Calls `veniceClient.chat(messages, {tools: toolRegistry.getSchemas()})`
3. Loops while `finish_reason === 'tool_calls'`, executing tools and appending results
4. Returns final assistant message

---

## Rollback

All changes are reversible:
- Delete `src/context/` and `src/tools/` directories
- Remove dependencies: `npm uninstall better-sqlite3 @xenova/transformers ignore shell-quote @types/better-sqlite3`
- Revert `src/extension.ts` and `src/api/venice.ts` to original
- No database files are committed; `globalStorageUri` is user-local only
