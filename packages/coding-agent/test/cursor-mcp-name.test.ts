import { describe, expect, it } from "bun:test";
import { cursorMcpDispatchName } from "../src/cursor-mcp-name";

describe("cursorMcpDispatchName", () => {
	it("accepts an mcp__ tool and rejects a session tool name", () => {
		expect(cursorMcpDispatchName({ toolName: "mcp__server_read" })).toBe("mcp__server_read");
		expect(cursorMcpDispatchName({ name: "mcp__server_read" })).toBe("mcp__server_read");
		expect(cursorMcpDispatchName({ toolName: "bash", name: "mcp__server_read" })).toBeNull();
		expect(cursorMcpDispatchName({ toolName: "write" })).toBeNull();
		expect(cursorMcpDispatchName({ name: "delete" })).toBeNull();
		expect(cursorMcpDispatchName({})).toBeNull();
	});
});
