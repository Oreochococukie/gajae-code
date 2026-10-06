import { describe, expect, it } from "bun:test";
import { parseCodexError } from "../src/providers/openai-codex/response-handler";

describe("parseCodexError", () => {
	it("does not persist a bearer token reflected in an error body", async () => {
		const response = new Response(JSON.stringify({ error: { message: "nope Bearer sk-live-secret tail" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
		const info = await parseCodexError(response);
		expect(info.raw).not.toContain("sk-live-secret");
		expect(info.message).not.toContain("sk-live-secret");
		expect(info.raw).toContain("Bearer [REDACTED]");
		expect(info.status).toBe(401);
	});

	it("does not persist a bare sk- token in a non-JSON body", async () => {
		const info = await parseCodexError(new Response("upstream said sk-live-secret", { status: 500 }));
		expect(info.raw).not.toContain("sk-live-secret");
		expect(info.message).not.toContain("sk-live-secret");
		expect(info.message).toContain("[REDACTED]");
	});
});
