// MCP Tool System — entry point

export { toolRegistry, ToolRegistry } from './tool-registry'
export { registerBuiltinTools } from './builtin-tools'
export type { MCPToolDefinition, ToolCategory, PermissionLevel, PermissionMap, MCPServerConfig } from './types'
export { DEFAULT_PERMISSIONS } from './types'

// Initialize: register all built-in tools on import
import { toolRegistry } from './tool-registry'
import { registerBuiltinTools } from './builtin-tools'

registerBuiltinTools(toolRegistry)
