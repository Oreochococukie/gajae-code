import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import { handleDocsRs } from "../../../src/web/scrapers/docs-rs";
import { MAX_BYTES } from "../../../src/web/scrapers/types";

const originalAgentDir = getAgentDir();
let agentDir: string;

function rustdocJson(crateName: string, padding = 0): string {
	return JSON.stringify({
		root: 0,
		crate_version: "1.0.0",
		index: {
			0: {
				name: crateName,
				docs: "bounded docs",
				attrs: [],
				inner: { module: { items: [], is_crate: true } },
				visibility: "public",
				deprecation: null,
			},
		},
		paths: {},
		format_version: 37,
		padding: "x".repeat(padding),
	});
}

function mockGzip(body: Uint8Array): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
}

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-docs-rs-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await fs.rm(agentDir, { recursive: true, force: true });
});

describe("docs.rs rustdoc gzip bounds", () => {
	it("rejects concatenated gzip output over MAX_BYTES without caching", async () => {
		const input = Buffer.alloc(1024 * 1024);
		const member = gzipSync(input);
		expect(gunzipSync(Buffer.concat([member, member])).length).toBe(input.length * 2);
		mockGzip(Buffer.concat(Array.from({ length: MAX_BYTES / input.length + 1 }, () => member)));

		expect(await handleDocsRs("https://docs.rs/output_limit/1.0.0/output_limit/", 20)).toBeNull();
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	it("passes MAX_BYTES from the production handler without allocating it", async () => {
		const cancel = vi.fn(async () => {});
		const response = {
			ok: true,
			body: { getReader: () => ({ read: async () => ({ done: false, value: { length: MAX_BYTES + 1 } }), cancel }) },
		} as unknown as Response;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

		expect(await handleDocsRs("https://docs.rs/production_limit/1.0.0/production_limit/", 20)).toBeNull();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	it("renders and caches under-budget rustdoc gzip", async () => {
		mockGzip(gzipSync(rustdocJson("bounded")));

		const result = await handleDocsRs("https://docs.rs/bounded/1.0.0/bounded/", 20);
		expect(result?.content).toContain("bounded docs");
		expect((await fs.readdir(path.join(agentDir, "webcache"))).length).toBe(1);
	});

	it("preserves caller abort errors", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));
		const controller = new AbortController();
		controller.abort();

		await expect(
			handleDocsRs("https://docs.rs/aborted/1.0.0/aborted/", 20, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
	});
});
