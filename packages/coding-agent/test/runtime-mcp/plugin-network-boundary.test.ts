import { afterEach, describe, expect, test, vi } from "bun:test";
import { bindPluginMcpToPublicNetwork, fetchPluginMcpRequest } from "../../src/runtime-mcp/plugin-network-boundary";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";

afterEach(() => vi.restoreAllMocks());

describe("plugin MCP public-network boundary", () => {
	test("pins and revalidates every public redirect hop", async () => {
		const resolved: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input) === "https://93.184.216.34/start") {
				return new Response(null, {
					status: 307,
					headers: { location: "https://second.example/next" },
				});
			}
			return new Response("ok");
		}) as typeof fetch);

		const response = await fetchPluginMcpRequest(
			"https://first.example/start",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					Cookie: "session=secret",
					"Content-Type": "application/json",
					"Mcp-Session-Id": "origin-session",
				},
				body: "{}",
			},
			{
				resolver: async hostname => {
					resolved.push(hostname);
					return hostname === "first.example" ? ["93.184.216.34"] : ["1.1.1.1"];
				},
			},
		);

		expect(await response.text()).toBe("ok");
		expect(resolved).toEqual(["first.example", "second.example"]);
		expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
			"https://93.184.216.34/start",
			"https://1.1.1.1/next",
		]);
		const firstInit = fetchSpy.mock.calls[0]?.[1] as BunFetchRequestInit;
		const secondInit = fetchSpy.mock.calls[1]?.[1] as BunFetchRequestInit;
		expect(firstInit.redirect).toBe("manual");
		expect(firstInit.tls).toMatchObject({ rejectUnauthorized: true, serverName: "first.example" });
		expect(new Headers(firstInit.headers).get("host")).toBe("first.example");
		expect(secondInit.method).toBe("POST");
		expect(secondInit.body).toBe("{}");
		expect(secondInit.tls).toMatchObject({ rejectUnauthorized: true, serverName: "second.example" });
		const redirectedHeaders = new Headers(secondInit.headers);
		expect(redirectedHeaders.get("host")).toBe("second.example");
		expect(redirectedHeaders.get("authorization")).toBeNull();
		expect(redirectedHeaders.get("cookie")).toBeNull();
		expect(redirectedHeaders.get("mcp-session-id")).toBeNull();
	});

	test("blocks DNS rebinding before the redirected connection", async () => {
		let resolutions = 0;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/private" } }));

		await expect(
			fetchPluginMcpRequest(
				"https://rebind.example/start",
				{ method: "POST", body: "{}" },
				{ resolver: async () => [resolutions++ === 0 ? "93.184.216.34" : "127.0.0.1"] },
			),
		).rejects.toThrow("Plugin MCP network request blocked");

		expect(resolutions).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("preserves standard redirect methods and bounds redirect chains", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input).endsWith("/start")) {
				return new Response(null, { status: 302, headers: { location: "/next" } });
			}
			return new Response("ok");
		}) as typeof fetch);

		const response = await fetchPluginMcpRequest("https://8.8.8.8/start", {
			method: "POST",
			headers: { Authorization: "Bearer same-origin", "Content-Type": "application/json" },
			body: "{}",
		});

		expect(await response.text()).toBe("ok");
		const redirectedInit = fetchSpy.mock.calls[1]?.[1] as BunFetchRequestInit;
		expect(redirectedInit.method).toBe("GET");
		expect(redirectedInit.body).toBeUndefined();
		const redirectedHeaders = new Headers(redirectedInit.headers);
		expect(redirectedHeaders.get("authorization")).toBe("Bearer same-origin");
		expect(redirectedHeaders.get("content-type")).toBeNull();

		fetchSpy.mockClear();
		fetchSpy.mockResolvedValue(new Response(null, { status: 307, headers: { location: "/loop" } }));
		await expect(
			fetchPluginMcpRequest("https://8.8.8.8/loop", { method: "GET" }, { maxRedirects: 0 }),
		).rejects.toThrow("redirect limit exceeded");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("wires plugin configs through the boundary and blocks redirect downgrades", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 307,
				headers: { location: "http://127.0.0.1/private" },
			}),
		);
		const transport = new HttpTransport(
			bindPluginMcpToPublicNetwork({
				type: "http",
				url: "https://93.184.216.34/mcp",
				timeout: 500,
			}),
		);
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toThrow("Plugin MCP network request blocked");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
		await transport.close();
	});

	test("leaves ordinary user-configured HTTP transports unchanged", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
			const request = JSON.parse(String(init?.body)) as { id: string | number };
			return Response.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
		}) as typeof fetch);
		const transport = new HttpTransport({ type: "http", url: "http://127.0.0.1/mcp", timeout: 500 });
		await transport.connect();

		await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://127.0.0.1/mcp");
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBeUndefined();
		await transport.close();
	});
});
