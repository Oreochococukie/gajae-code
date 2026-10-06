import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expandInternalUrls } from "../../src/tools/bash-skill-urls";

describe("expandInternalUrls local://", () => {
	it("does not expand a symlink that leaves the session local root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "local-bash-"));
		const artifacts = path.join(root, "artifacts");
		const localRoot = path.join(artifacts, "local");
		await mkdir(localRoot, { recursive: true });
		const secret = path.join(root, "secret.txt");
		await writeFile(secret, "secret");
		await symlink(secret, path.join(localRoot, "leak.txt"));
		await expect(
			expandInternalUrls("cat local://leak.txt", {
				skills: [],
				localOptions: {
					getArtifactsDir: () => artifacts,
					getSessionId: () => "session",
				},
			}),
		).rejects.toThrow(/escapes the session local root/);
	});
});
