# Venice AI for VS Code

AI-powered code completions and chat using Venice AI or OpenRouter.

## Features

- **Chat Sidebar**: Have conversations with your AI provider directly in VS Code
- **Inline Completions**: Get ghost text code suggestions as you type (like Copilot)
- **Multiple Providers**: Switch between Venice AI and OpenRouter
- **Multiple Models**: Configure your preferred model per provider

## Setup

1. Install the extension
2. (Optional) Run command: `Venice: Select AI Provider` to choose Venice or OpenRouter
3. Run command: `Venice: Set API Key`
4. Enter the API key for the selected provider

## Commands

- `Venice: Set API Key` - Configure the API key for the currently selected provider
- `Venice: Select AI Provider` - Switch between Venice AI and OpenRouter
- `Venice: Open Chat` - Open the chat sidebar (Cmd+Shift+V)
- `Venice: Toggle Inline Completions` - Enable/disable ghost text suggestions
- `Venice: Clear Chat History` - Clear conversation history

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `venice.provider` | `venice` | AI provider to use: `venice` or `openrouter` |
| `venice.model` | `olafangensan-glm-4.7-flash-heretic` | Model to use when provider is Venice |
| `venice.openrouterModel` | `openai/gpt-4o-mini` | Model to use when provider is OpenRouter |
| `venice.completionsEnabled` | `true` | Enable inline completions |
| `venice.completionDebounceMs` | `300` | Debounce delay for completions |
| `venice.maxContextLines` | `50` | Lines of context for completions |

Each provider stores its own API key separately, so switching providers doesn't require re-entering keys you've already saved.

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Host
```
