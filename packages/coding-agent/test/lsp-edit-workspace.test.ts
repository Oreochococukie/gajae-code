import { describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LspTool } from "../src/lsp";
import {
	assertDirectoryEntryInsideWorkspace,
	assertInsideWorkspace,
	renameInsideWorkspace,
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
});
