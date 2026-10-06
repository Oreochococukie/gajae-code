/** Cursor MCP dispatch may name only tools that already use the mcp__ prefix. */
export function cursorMcpDispatchName(call: { toolName?: string; name?: string }): string | null {
	const toolName = call.toolName || call.name || "";
	if (!toolName.startsWith("mcp__")) return null;
	return toolName;
}
