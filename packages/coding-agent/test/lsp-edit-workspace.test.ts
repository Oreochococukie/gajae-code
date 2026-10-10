import { describe, expect, it, vi } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LspTool } from "../src/lsp";
import * as lspClient from "../src/lsp/client";
import * as lspConfig from "../src/lsp/config";
import { applyWorkspaceEdit } from "../src/lsp/edits";
import type { LspClient, ServerConfig } from "../src/lsp/types";
import { fileToUri } from "../src/lsp/utils";
import {
	assertDirectoryEntryInsideWorkspace,
	assertInsideWorkspace,
	renameInsideWorkspace,
	splitAbsolute,
} from "../src/lsp/workspace-path";
import type { ToolSession } from "../src/tools";

describe("assertInsideWorkspace", () => {
	it("allows a workspace file and rejects a symlink that leaves it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-edit-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "note.txt");
		const outside = path.join(root, "secret.txt");
		await writeFile(inside, "ok");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(workspace, "leak.txt"));
		await expect(assertInsideWorkspace(workspace, inside)).resolves.toBeUndefined();
		await expect(assertInsideWorkspace(workspace, path.join(workspace, "leak.txt"))).rejects.toThrow(
			/escapes the workspace/,
		);
	});

	it("allows a new file whose parent does not exist yet and rejects one under an outside link", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-edit-new-"));
		const workspace = path.join(root, "repo");
		await mkdir(path.join(workspace, "src"), { recursive: true });
		const created = path.join(workspace, "src", "newdir", "a.ts");
		await expect(assertInsideWorkspace(workspace, created)).resolves.toBeUndefined();

		const outside = path.join(root, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(workspace, "link"));
		await expect(assertInsideWorkspace(workspace, path.join(workspace, "link", "newdir", "a.ts"))).rejects.toThrow(
			/escapes the workspace/,
		);
	});

	it("renames inside the workspace and refuses a destination or symlink that leaves it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-rename-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const source = path.join(workspace, "note.txt");
		const outside = path.join(root, "secret.txt");
		await writeFile(source, "ok");
		await writeFile(outside, "secret");
		await symlink(outside, path.join(workspace, "leak.txt"));

		await expect(
			renameInsideWorkspace(workspace, source, path.join(workspace, "moved.txt")),
		).resolves.toBeUndefined();
		expect(await readFile(path.join(workspace, "moved.txt"), "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });

		await expect(renameInsideWorkspace(workspace, path.join(workspace, "moved.txt"), outside)).rejects.toThrow(
			/escapes the workspace/,
		);
		expect(await readFile(path.join(workspace, "moved.txt"), "utf8")).toBe("ok");
		expect(await readFile(outside, "utf8")).toBe("secret");

		await expect(
			renameInsideWorkspace(workspace, path.join(workspace, "leak.txt"), path.join(workspace, "stolen.txt")),
		).rejects.toThrow(/escapes the workspace/);
		expect(await readFile(outside, "utf8")).toBe("secret");
		await expect(lstat(path.join(workspace, "stolen.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform === "win32")(
		"rename_file refuses a symlink source that leaves the workspace",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-rename-tool-"));
			const workspace = path.join(root, "repo");
			await mkdir(workspace);
			const outside = path.join(root, "secret.txt");
			await writeFile(path.join(workspace, "note.txt"), "ok");
			await writeFile(outside, "secret");
			await symlink(outside, path.join(workspace, "leak.txt"));
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await expect(
				tool.execute("rename-escape", {
					action: "rename_file",
					file: "leak.txt",
					new_name: "stolen.txt",
				}),
			).rejects.toThrow(/escapes the workspace/);
			expect(await readFile(outside, "utf8")).toBe("secret");
			expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("ok");
			expect((await lstat(path.join(workspace, "leak.txt"))).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "stolen.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("refuses to move an outside symlink whose target is inside the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-inward-link-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "a.ts");
		await writeFile(inside, "ok");
		const outsideLink = path.join(root, "link.ts");
		await symlink(inside, outsideLink);
		await expect(renameInsideWorkspace(workspace, outsideLink, path.join(workspace, "new.ts"))).rejects.toThrow(
			/escapes the workspace/,
		);
		await expect(assertDirectoryEntryInsideWorkspace(workspace, outsideLink)).rejects.toThrow(
			/escapes the workspace/,
		);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
		expect(await readFile(inside, "utf8")).toBe("ok");
		await expect(lstat(path.join(workspace, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });

		const tool = new LspTool({ cwd: workspace } as ToolSession);
		await expect(
			tool.execute("rename-inward", { action: "rename_file", file: outsideLink, new_name: "new.ts" }),
		).rejects.toThrow(/escapes the workspace/);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
		expect(await readFile(inside, "utf8")).toBe("ok");
	});

	it("refuses hop/.. that resolves through a symlink to an outside directory entry", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-hop-"));
		const workspace = path.join(root, "ws");
		const outside = path.join(root, "outside");
		await mkdir(path.join(outside, "subdir"), { recursive: true });
		await mkdir(workspace);
		const inside = path.join(workspace, "a.ts");
		await writeFile(inside, "ok");
		const outsideLink = path.join(outside, "link.ts");
		await symlink(inside, outsideLink);
		await symlink(path.join(outside, "subdir"), path.join(workspace, "hop"));
		const source = `${workspace}/hop/../link.ts`;
		await expect(renameInsideWorkspace(workspace, source, path.join(workspace, "new.ts"))).rejects.toThrow(
			/escapes the workspace/,
		);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
		expect(await readFile(inside, "utf8")).toBe("ok");
		await expect(lstat(path.join(workspace, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		const tool = new LspTool({ cwd: workspace } as ToolSession);
		await expect(
			tool.execute("rename-hop", { action: "rename_file", file: source, new_name: "new.ts" }),
		).rejects.toThrow(/escapes the workspace/);
		expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
	});

	it("allows a normal file when the workspace is the filesystem root", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lsp-root-"));
		const file = path.join(dir, "a.txt");
		await writeFile(file, "ok");
		await expect(assertInsideWorkspace(path.parse(file).root, file)).resolves.toBeUndefined();
	});

	it("rejects an empty path", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-empty-"));
		await expect(assertInsideWorkspace(workspace, "")).rejects.toThrow(/escapes the workspace/);
		await expect(assertInsideWorkspace("", path.join(workspace, "a.txt"))).rejects.toThrow(/escapes the workspace/);
	});

	it("renames a path whose .. walks through a missing directory", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-dotdot-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const viaMissing = `${workspace}${path.sep}missing${path.sep}..${path.sep}a.ts`;
		expect(viaMissing.includes(`${path.sep}missing${path.sep}..${path.sep}`)).toBe(true);
		const dest = path.join(workspace, "b.ts");
		await expect(renameInsideWorkspace(workspace, viaMissing, dest)).resolves.toBeUndefined();
		expect(await readFile(dest, "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("treats a Windows slash file path as inside its drive directory", () => {
		const split = splitAbsolute("C:/ws/a.ts", path.win32);
		expect(split.root).toBe("C:/");
		expect(split.parts.slice(0, -1)).toEqual(["ws"]);
	});

	it("renames into a directory that does not exist yet", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-nested-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const dest = path.join(workspace, "nested", "b.ts");
		await expect(renameInsideWorkspace(workspace, source, dest)).resolves.toBeUndefined();
		expect(await readFile(dest, "utf8")).toBe("ok");
	});
});

function stubLspClient(cwd: string, server: ServerConfig): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config: server,
		proc: {
			stdin: { write() {}, flush: async () => {} },
		} as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

describe("rename_file server edits", () => {
	it("does not write an earlier edit when a later willRenameFiles target leaves the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-preflight-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const source = path.join(workspace, "old.ts");
		const dest = path.join(workspace, "new.ts");
		const inside = path.join(workspace, "consumer.ts");
		const outside = path.join(root, "secret.ts");
		await writeFile(source, "export const value = 1;\n");
		await writeFile(inside, "alpha\n");
		await writeFile(outside, "secret\n");
		const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "test-lsp": server },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(stubLspClient(workspace, server));
		vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
			changes: {
				[fileToUri(inside)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						newText: "betaX",
					},
				],
				[fileToUri(outside)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
						newText: "pwnedX",
					},
				],
			},
		});
		vi.spyOn(lspClient, "sendNotification").mockResolvedValue();
		try {
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await expect(
				tool.execute("rename-preflight", {
					action: "rename_file",
					file: source,
					new_name: dest,
					timeout: 5,
				}),
			).rejects.toThrow(/escapes the workspace/);
			expect(await readFile(inside, "utf8")).toBe("alpha\n");
			expect(await readFile(outside, "utf8")).toBe("secret\n");
			expect(await readFile(source, "utf8")).toBe("export const value = 1;\n");
			await expect(lstat(dest)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("applies every in-workspace willRenameFiles edit after all targets pass", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-preflight-ok-"));
		const source = path.join(workspace, "old.ts");
		const dest = path.join(workspace, "new.ts");
		const first = path.join(workspace, "a.ts");
		const second = path.join(workspace, "b.ts");
		await writeFile(source, "export const value = 1;\n");
		await writeFile(first, "alpha\n");
		await writeFile(second, "gamma\n");
		const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "test-lsp": server },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(stubLspClient(workspace, server));
		vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
			changes: {
				[fileToUri(first)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						newText: "betaX",
					},
				],
				[fileToUri(second)]: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						newText: "delta",
					},
				],
			},
		});
		vi.spyOn(lspClient, "sendNotification").mockResolvedValue();
		try {
			const tool = new LspTool({ cwd: workspace } as ToolSession);
			await tool.execute("rename-preflight-ok", {
				action: "rename_file",
				file: source,
				new_name: dest,
				timeout: 5,
			});
			expect(await readFile(first, "utf8")).toBe("betaX\n");
			expect(await readFile(second, "utf8")).toBe("delta\n");
			await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(dest, "utf8")).toBe("export const value = 1;\n");
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe("applyWorkspaceEdit containment", () => {
	it("does not apply an earlier text edit when a later target leaves the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-ws-edit-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const inside = path.join(workspace, "a.ts");
		const outside = path.join(root, "secret.ts");
		await writeFile(inside, "alpha\n");
		await writeFile(outside, "secret\n");
		await expect(
			applyWorkspaceEdit(
				{
					changes: {
						[fileToUri(inside)]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
								newText: "betaX",
							},
						],
						[fileToUri(outside)]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
								newText: "pwnedX",
							},
						],
					},
				},
				workspace,
			),
		).rejects.toThrow(/escapes the workspace/);
		expect(await readFile(inside, "utf8")).toBe("alpha\n");
		expect(await readFile(outside, "utf8")).toBe("secret\n");
	});

	it("does not create an earlier file when a later delete leaves the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "lsp-ws-res-"));
		const workspace = path.join(root, "repo");
		await mkdir(workspace);
		const created = path.join(workspace, "created.ts");
		const outside = path.join(root, "secret.ts");
		await writeFile(outside, "secret\n");
		await expect(
			applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri: fileToUri(created) },
						{ kind: "delete", uri: fileToUri(outside) },
					],
				},
				workspace,
			),
		).rejects.toThrow(/escapes the workspace/);
		await expect(lstat(created)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(outside, "utf8")).toBe("secret\n");
	});

	it.skipIf(process.platform === "win32")(
		"does not create an earlier file when a later rename leaves the workspace",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-ws-rename-"));
			const workspace = path.join(root, "repo");
			await mkdir(workspace);
			const created = path.join(workspace, "created.ts");
			const inside = path.join(workspace, "a.ts");
			await writeFile(inside, "ok");
			const outsideLink = path.join(root, "link.ts");
			await symlink(inside, outsideLink);
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "create", uri: fileToUri(created) },
							{
								kind: "rename",
								oldUri: fileToUri(outsideLink),
								newUri: fileToUri(path.join(workspace, "moved.ts")),
							},
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			await expect(lstat(created)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
			expect(await readFile(inside, "utf8")).toBe("ok");
		},
	);

	it("creates and renames inside the workspace after every target passes", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-ws-rename-ok-"));
		const source = path.join(workspace, "a.ts");
		await writeFile(source, "ok");
		const dest = path.join(workspace, "nested", "b.ts");
		const created = path.join(workspace, "c.ts");
		const applied = await applyWorkspaceEdit(
			{
				documentChanges: [
					{ kind: "create", uri: fileToUri(created) },
					{ kind: "rename", oldUri: fileToUri(source), newUri: fileToUri(dest) },
				],
			},
			workspace,
		);
		expect(await readFile(created, "utf8")).toBe("");
		expect(await readFile(dest, "utf8")).toBe("ok");
		await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
		expect(applied).toHaveLength(2);
	});

	it("applies every in-workspace text edit after all targets pass", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-ws-ok-"));
		const first = path.join(workspace, "a.ts");
		const second = path.join(workspace, "b.ts");
		await writeFile(first, "alpha\n");
		await writeFile(second, "gamma\n");
		const applied = await applyWorkspaceEdit(
			{
				changes: {
					[fileToUri(first)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "betaX",
						},
					],
					[fileToUri(second)]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							newText: "delta",
						},
					],
				},
			},
			workspace,
		);
		expect(await readFile(first, "utf8")).toBe("betaX\n");
		expect(await readFile(second, "utf8")).toBe("delta\n");
		expect(applied).toHaveLength(2);
	});

	it("applies both edits when two URI spellings name the same file", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "lsp-alias-"));
		const file = path.join(workspace, "a.ts");
		await writeFile(file, "ab\n");
		const plain = fileToUri(file);
		const encoded = plain.replace(/a\.ts$/, "%61.ts");
		expect(encoded).not.toBe(plain);
		const applied = await applyWorkspaceEdit(
			{
				changes: {
					[plain]: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							newText: "A",
						},
					],
					[encoded]: [
						{
							range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
							newText: "B",
						},
					],
				},
			},
			workspace,
		);
		expect(await readFile(file, "utf8")).toBe("AB\n");
		expect(applied).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"does not follow a relative symlink that an earlier rename points outside",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-relink-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "safe");
			await mkdir(path.join(workspace, "deep"), { recursive: true });
			await mkdir(path.join(workspace, "safe"), { recursive: true });
			await mkdir(outside);
			await symlink("../safe", path.join(workspace, "deep", "link"));
			const link = path.join(workspace, "deep", "link");
			const moved = path.join(workspace, "link");
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(moved) },
							{ kind: "create", uri: fileToUri(path.join(moved, "new.txt")) },
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
			await expect(lstat(moved)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not follow a relative symlink inside a directory renamed by the same edit",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-nested-link-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "data");
			await mkdir(path.join(workspace, "a", "deep"), { recursive: true });
			await mkdir(path.join(workspace, "data"), { recursive: true });
			await mkdir(outside);
			const sourceDir = path.join(workspace, "a", "deep");
			await symlink("../../data", path.join(sourceDir, "inner"));
			const destDir = path.join(workspace, "deep");
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "rename", oldUri: fileToUri(sourceDir), newUri: fileToUri(destDir) },
							{ kind: "create", uri: fileToUri(path.join(destDir, "inner", "new.txt")) },
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(path.join(sourceDir, "inner"))).isSymbolicLink()).toBe(true);
			await expect(lstat(destDir)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"writes through a relative symlink when the rename keeps the target inside",
		async () => {
			const workspace = await mkdtemp(path.join(tmpdir(), "lsp-relink-ok-"));
			await mkdir(path.join(workspace, "sub"));
			await mkdir(path.join(workspace, "data"));
			const link = path.join(workspace, "sub", "link");
			await symlink("../data", link);
			const moved = path.join(workspace, "sub2", "link");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "rename", oldUri: fileToUri(link), newUri: fileToUri(moved) },
						{ kind: "create", uri: fileToUri(path.join(moved, "new.txt")) },
					],
				},
				workspace,
			);
			expect(await readFile(path.join(workspace, "data", "new.txt"), "utf8")).toBe("");
			expect((await lstat(moved)).isSymbolicLink()).toBe(true);
			await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a relative hop/.. rename source from applyWorkspaceEdit",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "lsp-rel-hop-"));
			const workspace = path.join(root, "ws");
			const outside = path.join(root, "outside");
			await mkdir(path.join(outside, "subdir"), { recursive: true });
			await mkdir(workspace);
			const inside = path.join(workspace, "a.ts");
			await writeFile(inside, "ok");
			const outsideLink = path.join(outside, "link.ts");
			await symlink(inside, outsideLink);
			await symlink(path.join(outside, "subdir"), path.join(workspace, "hop"));
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "rename",
								oldUri: `hop${path.sep}..${path.sep}link.ts`,
								newUri: "new.ts",
							},
						],
					},
					workspace,
				),
			).rejects.toThrow(/escapes the workspace/);
			expect((await lstat(outsideLink)).isSymbolicLink()).toBe(true);
			await expect(lstat(path.join(workspace, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
});
