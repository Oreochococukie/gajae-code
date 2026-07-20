import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	classifySource,
	fetchMarketplace,
	parseMarketplaceCatalog,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";

// Fixture lives at test/marketplace/fixtures/valid-marketplace/
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "valid-marketplace");
const MARKETPLACE_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

async function settleWithin<T>(operation: Promise<T>, timeoutMs = 500): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timeoutId = setTimeout(() => timeout.reject(new Error("Test operation did not settle")), timeoutMs);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timeoutId);
	}
}

// ── classifySource ────────────────────────────────────────────────────

describe("classifySource", () => {
	// ── local ─────────────────────────────────────────────────────────

	it("classifies './' prefix as local", () => {
		expect(classifySource("./my-marketplace")).toBe("local");
	});

	it("classifies POSIX absolute path as local", () => {
		expect(classifySource("/abs/path")).toBe("local");
	});

	it("classifies '~/' prefix as local", () => {
		expect(classifySource("~/my-marketplace")).toBe("local");
	});

	it("classifies Windows absolute path as local", () => {
		// C:\Users\me\marketplace — path.isAbsolute returns false on POSIX,
		// so the WIN_ABS_RE fallback must handle this.
		expect(classifySource("C:\\Users\\me\\marketplace")).toBe("local");
	});

	// ── url ───────────────────────────────────────────────────────────

	it("classifies https .json URL as url", () => {
		expect(classifySource("https://example.com/marketplace.json")).toBe("url");
	});

	// ── git ───────────────────────────────────────────────────────────

	it("classifies https non-.json URL as git", () => {
		expect(classifySource("https://github.com/owner/repo.git")).toBe("git");
	});

	it("classifies git@ SCP-style URL as git", () => {
		expect(classifySource("git@github.com:owner/repo.git")).toBe("git");
	});

	it("classifies ssh:// URL as git", () => {
		expect(classifySource("ssh://git@github.com/owner/repo")).toBe("git");
	});

	// ── github ────────────────────────────────────────────────────────

	it("classifies owner/repo shorthand as github", () => {
		expect(classifySource("owner/repo")).toBe("github");
	});

	// ── errors ────────────────────────────────────────────────────────

	it("throws on bare name with suggestion", () => {
		expect(() => classifySource("just-a-name")).toThrow(
			"Unrecognized source format. Did you mean './just-a-name' (local) or 'owner/repo' (GitHub)?",
		);
	});
});

// ── parseMarketplaceCatalog ───────────────────────────────────────────

describe("parseMarketplaceCatalog", () => {
	const VALID = JSON.stringify({
		name: "test-marketplace",
		owner: { name: "Test Author", email: "test@example.com" },
		metadata: { description: "A test marketplace" },
		plugins: [{ name: "hello-plugin", source: "./plugins/hello-plugin", description: "Greets" }],
	});

	it("parses a valid catalog", () => {
		const catalog = parseMarketplaceCatalog(VALID, "/fake/marketplace.json");
		expect(catalog.name).toBe("test-marketplace");
		expect(catalog.owner.name).toBe("Test Author");
		expect(catalog.plugins).toHaveLength(1);
		expect(catalog.plugins[0].name).toBe("hello-plugin");
	});

	it("throws on missing name", () => {
		const bad = JSON.stringify({ owner: { name: "x" }, plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"name"/);
	});

	it("throws when name fails isValidNameSegment", () => {
		const bad = JSON.stringify({ name: "Invalid Name", owner: { name: "x" }, plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"name"/);
	});

	it("throws on missing plugins", () => {
		const bad = JSON.stringify({ name: "valid-name", owner: { name: "x" } });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"plugins"/);
	});

	it("throws on missing owner", () => {
		const bad = JSON.stringify({ name: "valid-name", plugins: [] });
		expect(() => parseMarketplaceCatalog(bad, "/f.json")).toThrow(/"owner"/);
	});

	it("empty plugins array is valid", () => {
		const catalog = parseMarketplaceCatalog(
			JSON.stringify({ name: "valid-name", owner: { name: "x" }, plugins: [] }),
			"/f.json",
		);
		expect(catalog.plugins).toHaveLength(0);
	});

	it("preserves extra fields in output", () => {
		const extra = JSON.stringify({
			name: "my-market",
			owner: { name: "x" },
			plugins: [],
			myCustomField: "preserved",
			anotherExtra: 42,
		});
		const catalog = parseMarketplaceCatalog(extra, "/f.json") as unknown as Record<string, unknown>;
		expect(catalog.myCustomField).toBe("preserved");
		expect(catalog.anotherExtra).toBe(42);
	});

	it("accepts plugin with object source (typed source object)", () => {
		const content = JSON.stringify({
			name: "my-market",
			owner: { name: "x" },
			plugins: [{ name: "p1", source: { source: "github", repo: "owner/repo" } }],
		});
		const catalog = parseMarketplaceCatalog(content, "/f.json");
		expect(catalog.plugins[0].name).toBe("p1");
	});

	it("throws on invalid JSON", () => {
		expect(() => parseMarketplaceCatalog("{not json", "/f.json")).toThrow(
			"Failed to parse marketplace catalog at /f.json",
		);
	});
});

// ── fetchMarketplace ──────────────────────────────────────────────────

describe("fetchMarketplace", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fetcher-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves catalog from fixture directory", async () => {
		const result = await fetchMarketplace(FIXTURE_DIR, tmpDir);
		expect(result.catalog.name).toBe("test-marketplace");
		expect(result.catalog.owner.name).toBe("Test Author");
		expect(result.catalog.plugins).toHaveLength(1);
		expect(result.catalog.plugins[0].name).toBe("hello-plugin");
		// local fetch never returns a clonePath
		expect(result.clonePath).toBeUndefined();
	});

	it("throws a clear error for nonexistent local directory", async () => {
		const missing = path.join(tmpDir, "nonexistent");
		await expect(fetchMarketplace(missing, tmpDir)).rejects.toThrow(/Marketplace catalog not found/);
	});

	it("throws a clear error for relative nonexistent path", async () => {
		// Use a path that resolves within tmpDir but doesn't exist
		const fakeSrc = path.join(tmpDir, "ghost-marketplace");
		await expect(fetchMarketplace(fakeSrc, tmpDir)).rejects.toThrow(/Marketplace catalog not found/);
	});

	it("rejects private URL targets before opening a request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(fetchMarketplace("http://127.0.0.1/marketplace.json", tmpDir)).rejects.toThrow(
			/not public HTTP\(S\)/,
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("rejects redirects to private URL targets before the next request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/marketplace.json" },
			}),
		);

		await expect(fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(
			/not public HTTP\(S\)/,
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("rejects redirect chains beyond the finite cap", async () => {
		const cancel = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			const url = new URL(String(input));
			const step = Number.parseInt(url.searchParams.get("step") ?? "0", 10);
			const cancellation = Promise.withResolvers<void>();
			const body = new ReadableStream<Uint8Array>({
				cancel() {
					cancel();
					return cancellation.promise;
				},
			});
			return new Response(body, {
				status: 302,
				headers: { location: `/marketplace.json?step=${step + 1}` },
			});
		}) as typeof fetch);

		await expect(settleWithin(fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir))).rejects.toThrow(
			/Too many redirects/,
		);

		expect(fetchSpy).toHaveBeenCalledTimes(6);
		expect(cancel).toHaveBeenCalledTimes(6);
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("does not wait for response cleanup before reporting an HTTP error", async () => {
		const cancel = vi.fn();
		const cancellation = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancel();
				return cancellation.promise;
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 503, statusText: "Unavailable" }));

		await expect(settleWithin(fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir))).rejects.toThrow(
			/HTTP 503 Unavailable/,
		);

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("rejects an oversized Content-Length before reading the body", async () => {
		const cancel = vi.fn();
		const cancellation = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("should not be read"));
			},
			cancel() {
				cancel();
				return cancellation.promise;
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { "content-length": String(MARKETPLACE_RESPONSE_MAX_BYTES + 1) },
			}),
		);

		await expect(settleWithin(fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir))).rejects.toThrow(
			/maximum size/,
		);

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("cancels a streamed response at the byte cap plus one", async () => {
		const cancel = vi.fn();
		const cancellation = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MARKETPLACE_RESPONSE_MAX_BYTES + 1));
			},
			cancel() {
				cancel();
				return cancellation.promise;
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

		await expect(settleWithin(fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir))).rejects.toThrow(
			/maximum size/,
		);

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("requests reader cancellation before releasing it when the operation deadline expires", async () => {
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const readStarted = Promise.withResolvers<void>();
		const readResult = Promise.withResolvers<never>();
		const cancellation = Promise.withResolvers<void>();
		const cleanupOrder: string[] = [];
		const reader = {
			read: vi.fn(() => {
				readStarted.resolve();
				return readResult.promise;
			}),
			cancel: vi.fn(() => {
				cleanupOrder.push("cancel");
				return cancellation.promise;
			}),
			releaseLock: vi.fn(() => cleanupOrder.push("release")),
		} as unknown as ReadableStreamDefaultReader<Uint8Array>;
		const response = {
			body: { getReader: () => reader },
			headers: new Headers(),
			ok: true,
			status: 200,
			statusText: "OK",
		} as unknown as Response;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

		const operation = fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir);
		await readStarted.promise;
		deadline.abort(new DOMException("deadline expired", "TimeoutError"));

		await expect(settleWithin(operation)).rejects.toThrow(/Timed out fetching marketplace catalog/);
		expect(reader.cancel).toHaveBeenCalledTimes(1);
		expect(cleanupOrder).toEqual(["cancel", "release"]);
		expect(fs.readdirSync(tmpDir)).toEqual([]);
	});

	it("counts multibyte response content by encoded bytes", async () => {
		const multibyteCatalog = JSON.stringify({
			name: "multibyte-market",
			owner: { name: "x" },
			plugins: [],
			metadata: { description: "💥".repeat(Math.ceil(MARKETPLACE_RESPONSE_MAX_BYTES / 4)) },
		});
		expect(multibyteCatalog.length).toBeLessThan(MARKETPLACE_RESPONSE_MAX_BYTES);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(multibyteCatalog, { status: 200 }));

		await expect(fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir)).rejects.toThrow(/maximum size/);
	});

	it("follows public redirects and caches a catalog at the exact byte limit", async () => {
		const catalogPrefix = JSON.stringify({ name: "remote-market", owner: { name: "x" }, plugins: [] });
		const validCatalog = `${catalogPrefix}${" ".repeat(MARKETPLACE_RESPONSE_MAX_BYTES - catalogPrefix.length)}`;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input) === "https://8.8.8.8/marketplace.json") {
				return new Response(null, { status: 302, headers: { location: "/catalog.json" } });
			}
			return new Response(validCatalog, {
				status: 200,
				headers: { "content-length": String(MARKETPLACE_RESPONSE_MAX_BYTES) },
			});
		}) as typeof fetch);

		const result = await fetchMarketplace("https://8.8.8.8/marketplace.json", tmpDir);

		expect(result.catalog.name).toBe("remote-market");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls.every(call => call[1]?.redirect === "manual")).toBe(true);
		expect(fetchSpy.mock.calls[1]?.[1]?.signal).toBe(fetchSpy.mock.calls[0]?.[1]?.signal);
		expect(fs.readFileSync(path.join(tmpDir, "remote-market", "marketplace.json"), "utf8")).toBe(validCatalog);
	});

	// Network-dependent tests — skip in CI / offline environments.
	// These verify real git clone and HTTP fetch error handling.
	it.skip("github source throws on nonexistent repo", async () => {
		await expect(fetchMarketplace("nonexistent-owner-xyz/nonexistent-repo-xyz", tmpDir)).rejects.toThrow(
			/git clone failed/,
		);
	});

	it.skip("git source throws on nonexistent repo", async () => {
		await expect(
			fetchMarketplace("git@github.com:nonexistent-owner-xyz/nonexistent-repo-xyz.git", tmpDir),
		).rejects.toThrow(/git clone failed/);
	});

	it.skip("url source throws on non-2xx response", async () => {
		await expect(fetchMarketplace("https://example.com/nonexistent-catalog-xyz.json", tmpDir)).rejects.toThrow(
			/HTTP [45]\d\d/,
		);
	});
});
