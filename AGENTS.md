# AGENTS.md

This file provides guidance for AI agents working on the `venice-ai-vscode` repository.

## Project Overview

Venice AI is a VS Code extension that integrates [Venice AI](https://venice.ai) into the editor. It provides:

- **Inline code completions** — ghost-text suggestions as the user types (similar to GitHub Copilot)
- **Chat sidebar** — a persistent webview panel for conversational AI assistance

The extension is written in TypeScript and targets the VS Code Extension Host API.

## Repository Structure

```
venice-ai-vscode/
├── src/
│   ├── extension.ts          # Entry point: activate() / deactivate()
│   ├── api/
│   │   └── venice.ts         # VeniceClient: wraps the Venice REST API
│   ├── chat/
│   │   └── chatProvider.ts   # ChatViewProvider: webview sidebar + streaming chat
│   ├── completion/
│   │   └── inlineProvider.ts # InlineCompletionProvider: ghost-text completions
│   └── utils/
│       └── context.ts        # Helpers for extracting code context from documents
├── package.json              # Extension manifest (commands, views, config, scripts)
├── tsconfig.json             # TypeScript compiler config (target ES2022, strict)
└── .github/workflows/
    └── webpack.yml           # CI: npm install + webpack on Node 18/20/22
```

## Tech Stack

| Concern | Tool |
|---|---|
| Language | TypeScript 5 (strict mode) |
| Runtime | VS Code Extension Host (Node.js / CommonJS) |
| API client | Native `fetch` (available in VS Code's Node runtime) |
| Build | `tsc` (TypeScript compiler) |
| Packaging | `vsce` |
| CI | GitHub Actions (Node 18 / 20 / 22 matrix) |

No testing framework is currently configured.

## Build & Compile

```bash
npm install          # install devDependencies
npm run compile      # tsc -p ./ → outputs to ./out/
npm run watch        # incremental watch mode
npm run package      # vsce package → produces a .vsix file
```

The compiled output goes to `out/` (gitignored). The extension entry point declared in `package.json` is `./out/extension.js`.

## Key Source Files

### `src/extension.ts`
- `activate(context)` — registers all commands, the webview provider, and the inline completion provider; prompts for an API key if none is stored.
- `deactivate()` — no-op cleanup hook.

### `src/api/venice.ts` — `VeniceClient`
- `getApiKey() / setApiKey() / deleteApiKey()` — uses VS Code's `SecretStorage` to persist the key under the key `"venice-api-key"`.
- `chat(messages, options)` — non-streaming POST to `https://api.venice.ai/api/v1/chat/completions`.
- `chatStream(messages, options)` — streaming async generator over the same endpoint (SSE / `data:` lines).
- `complete(prefix, suffix, options)` — wraps `chat()` with a fill-in-the-middle prompt for code completions (low temperature, 256 max tokens).

### `src/chat/chatProvider.ts` — `ChatViewProvider`
- Implements `vscode.WebviewViewProvider`; view ID is `"venice.chatView"` (registered in the Explorer sidebar).
- Maintains an in-memory `history: ChatMessage[]` for the session.
- Streams assistant responses chunk-by-chunk to the webview via `postMessage`.
- The entire chat UI (HTML/CSS/JS) is embedded as a template string in `getHtmlContent()`.

### `src/completion/inlineProvider.ts` — `InlineCompletionProvider`
- Implements `vscode.InlineCompletionItemProvider` for all files (`pattern: '**'`).
- Debounces requests (default 300 ms, configurable via `venice.completionDebounceMs`).
- Strips markdown fences and limits completions to 10 lines via `cleanCompletion()`.

### `src/utils/context.ts`
- `getCodeContext(document, position)` — returns `{ prefix, suffix, language, fileName }` using a sliding window of up to `venice.maxContextLines` lines (default 50).
- `getFullFileContext(document)` — returns up to 8 000 characters of file content.
- `getCurrentSelection(editor)` — returns the selected text, or `undefined` if nothing is selected.

## VS Code Configuration

| Key | Default | Description |
|---|---|---|
| `venice.model` | `olafangensan-glm-4.7-flash-heretic` | Venice model identifier |
| `venice.completionsEnabled` | `true` | Enable/disable ghost-text completions |
| `venice.completionDebounceMs` | `300` | Debounce delay (ms) before firing a completion request |
| `venice.maxContextLines` | `50` | Lines of surrounding code sent as context |

## Commands

| Command ID | Title | Keybinding |
|---|---|---|
| `venice.setApiKey` | Venice: Set API Key | — |
| `venice.openChat` | Venice: Open Chat | `Ctrl+Shift+V` / `Cmd+Shift+V` |
| `venice.toggleCompletions` | Venice: Toggle Inline Completions | — |
| `venice.clearChat` | Venice: Clear Chat History | — |

## Development Workflow

1. `npm install` — install dependencies.
2. `npm run compile` (or `npm run watch`) — compile TypeScript.
3. Open the repository in VS Code and press **F5** to launch an Extension Development Host.
4. In the host window, run `Venice: Set API Key` and enter a valid Venice API key.
5. Test inline completions by editing any file; open the chat via `Ctrl+Shift+V`.

## Conventions & Notes

- **Secrets** — the API key is stored exclusively via `vscode.ExtensionContext.secrets` (VS Code's encrypted `SecretStorage`). Never hardcode or log it.
- **No bundler in source** — the project compiles with plain `tsc`; the CI pipeline runs `npx webpack` but there is no `webpack.config.js` checked in yet. Treat build failures in CI as a known gap.
- **Streaming** — `chatStream` uses `ReadableStream` / `getReader()` with a `TextDecoder` buffer. SSE lines are split on `\n`; `[DONE]` signals end-of-stream.
- **Cancellation** — `InlineCompletionProvider` uses a monotonically increasing `lastRequestId` to discard stale responses, in addition to checking `token.isCancellationRequested`.
- **TypeScript strict mode** — all new code must satisfy `"strict": true`. Avoid `any`; prefer explicit return types on public methods.
