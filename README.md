# Venice AI for VS Code

AI-powered code completions and chat using Venice AI.

## Features

- **Chat Sidebar**: Have conversations with Venice AI directly in VS Code
- **Inline Completions**: Get ghost text code suggestions as you type (like Copilot)
- **Multiple Models**: Configure your preferred Venice model

## Setup

1. Install the extension
2. Run command: `Venice: Set API Key`
3. Enter your Venice API key

## Commands

- `Venice: Set API Key` - Configure your API key
- `Venice: Open Chat` - Open the chat sidebar (Cmd+Shift+V)
- `Venice: Toggle Inline Completions` - Enable/disable ghost text suggestions
- `Venice: Clear Chat History` - Clear conversation history

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `venice.model` | `olafangensan-glm-4.7-flash-heretic` | Venice model to use |
| `venice.completionsEnabled` | `true` | Enable inline completions |
| `venice.completionDebounceMs` | `300` | Debounce delay for completions |
| `venice.maxContextLines` | `50` | Lines of context for completions |

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Host
```
