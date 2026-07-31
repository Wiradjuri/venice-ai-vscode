import * as vscode from 'vscode';
import { Tool, ToolCall, ToolResult, PermissionManager, RiskTier } from './permissionManager';

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private permissionManager: PermissionManager;

  constructor(permissionManager: PermissionManager) {
    this.permissionManager = permissionManager;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Generate OpenAI-compatible tool definitions for API
   */
  getSchemas(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    const schemas: Array<{
      type: 'function';
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }> = [];

    for (const tool of this.tools.values()) {
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      });
    }

    return schemas;
  }

  /**
   * Execute a tool call after permission checks
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}`,
      };
    }

    let args: unknown;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return {
        success: false,
        error: `Invalid tool arguments: ${toolCall.function.arguments}`,
      };
    }

    // Check permissions
    const permission = await this.permissionManager.request(toolName, args, tool.riskTier);
    if (permission === 'denied') {
      return {
        success: false,
        error: `Tool execution denied by user: ${toolName}`,
      };
    }

    try {
      return await tool.execute(args);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Batch execute multiple tool calls
   */
  async executeBatch(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results = [];
    for (const call of toolCalls) {
      results.push(await this.execute(call));
    }
    return results;
  }
}
