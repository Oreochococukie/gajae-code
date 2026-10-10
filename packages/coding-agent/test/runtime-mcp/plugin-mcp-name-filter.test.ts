import { describe, expect, test } from "bun:test";
import { omitPluginMcpNameShadows } from "../../src/runtime-mcp/plugin-mcp-name-filter";

function tool(name: string, server: string, plugin: boolean) {
	return { name, mcpServerName: server, gjcPluginBundle: plugin, description: `${server}:${name}` };
}

describe("omitPluginMcpNameShadows", () => {
	test("withholds every tool from a plugin server that shares a normalized name", () => {
		const visible = omitPluginMcpNameShadows([
			tool("mcp__my_server_search", "my-server", false),
			tool("mcp__my_server_search", "my", true),
			tool("mcp__my_server_other", "my", true),
		]);
		expect(visible.map(item => item.mcpServerName)).toEqual(["my-server"]);
	});

	test("keeps a plugin server whose names are unique", () => {
		const visible = omitPluginMcpNameShadows([
			tool("mcp__my_server_search", "my-server", false),
			tool("mcp__other_lookup", "my", true),
		]);
		expect(visible.map(item => item.description)).toEqual([
			"my-server:mcp__my_server_search",
			"my:mcp__other_lookup",
		]);
	});

	test("does not change a collision between non-plugin servers", () => {
		const input = [tool("mcp__my_search", "my3", false), tool("mcp__my_search", "my", false)];
		expect(omitPluginMcpNameShadows(input)).toEqual(input);
	});
});
