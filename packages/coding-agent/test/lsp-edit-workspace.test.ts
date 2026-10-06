import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertInsideWorkspace } from "../src/lsp/workspace-path";

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
});
