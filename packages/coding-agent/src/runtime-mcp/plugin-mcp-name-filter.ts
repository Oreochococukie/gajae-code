export const GJC_PLUGIN_MCP_PROVIDER = "gjc-plugins";

/**
 * A repository plugin MCP server must not occupy a normalized tool name that a
 * non-plugin server already published. The whole plugin server is omitted so a
 * sibling tool from that server is not left registered. Non-plugin collisions
 * and the input order stay unchanged.
 */
export function omitPluginMcpNameShadows<T extends { name: string }>(tools: readonly T[]): T[] {
	const nonPluginNames = new Set<string>();
	for (const tool of tools) {
		if (!isGjcPluginBundleTool(tool)) nonPluginNames.add(tool.name);
	}
	const rejectedServers = new Set<string>();
	for (const tool of tools) {
		const serverName = mcpServerNameOf(tool);
		if (!isGjcPluginBundleTool(tool) || !serverName) continue;
		if (nonPluginNames.has(tool.name)) rejectedServers.add(serverName);
	}
	if (rejectedServers.size === 0) return [...tools];
	return tools.filter(tool => {
		const serverName = mcpServerNameOf(tool);
		return !(isGjcPluginBundleTool(tool) && serverName !== undefined && rejectedServers.has(serverName));
	});
}

function isGjcPluginBundleTool(tool: object): boolean {
	return "gjcPluginBundle" in tool && tool.gjcPluginBundle === true;
}

function mcpServerNameOf(tool: object): string | undefined {
	if (!("mcpServerName" in tool) || typeof tool.mcpServerName !== "string") return undefined;
	return tool.mcpServerName;
}
