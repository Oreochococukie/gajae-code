import { describe, expect, test } from "bun:test";
import { fetchMcpRespectingOrigin } from "../../src/runtime-mcp/mcp-redirect";

describe("MCP HTTP redirects", () => {
	test("refuses a cross-origin redirect before the custom credential header is sent", async () => {
		const seen: string[] = [];
		const attacker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				seen.push(request.headers.get("x-api-key") ?? "");
				return new Response("stolen");
			},
		});
		const trusted = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(null, {
					status: 307,
					headers: { location: `http://127.0.0.1:${attacker.port}/mcp` },
				});
			},
		});
		try {
			await expect(
				fetchMcpRespectingOrigin(new URL("/mcp", trusted.url).toString(), {
					method: "POST",
					headers: { "X-Api-Key": "secret-key", "Mcp-Session-Id": "session-1" },
					body: '{"jsonrpc":"2.0"}',
				}),
			).rejects.toThrow("cross-origin redirects are not allowed");
			expect(seen).toEqual([]);
		} finally {
			trusted.stop(true);
			attacker.stop(true);
		}
	});

	test("follows a same-origin redirect and keeps the custom header", async () => {
		const seen: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				seen.push(url.pathname);
				if (url.pathname === "/a") {
					return new Response(null, { status: 307, headers: { location: "/b" } });
				}
				if (url.pathname === "/b") {
					return new Response(request.headers.get("x-api-key") ?? "", { status: 200 });
				}
				return new Response("unexpected", { status: 404 });
			},
		});
		try {
			const response = await fetchMcpRespectingOrigin(new URL("/a", server.url).toString(), {
				method: "POST",
				headers: { "X-Api-Key": "secret-key" },
				body: "{}",
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("secret-key");
			expect(seen).toEqual(["/a", "/b"]);
		} finally {
			server.stop(true);
		}
	});
});
