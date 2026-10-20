/**
 * Skill/hook import publication must keep a destination that was a real
 * directory at validation inside that directory if an ancestor is replaced
 * before the write. The still-allowed case is a real directory (including one
 * the import creates).
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyImport, buildImportPreview } from "@gajae-code/coding-agent/customization/import";
import { resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import fc from "fast-check";

const SKILL_MD = `---
description: Fixture skill for tests.
---

# Fixture

Do the thing.
`;

let tmpRoot: string | undefined;
const previousAgentDir = process.env.GJC_CODING_AGENT_DIR;

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = previousAgentDir;
	resetAgentDirFromEnvironment();
	if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
	tmpRoot = undefined;
});

async function layout(): Promise<{ projectDir: string; homeDir: string }> {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-import-ancestor-"));
	const projectDir = path.join(tmpRoot, "project");
	const homeDir = path.join(tmpRoot, "home");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	setAgentDir(path.join(homeDir, ".gjc", "agent"));
	const skill = path.join(projectDir, ".claude", "skills", "claude-skill", "SKILL.md");
	await fs.mkdir(path.dirname(skill), { recursive: true });
	await fs.writeFile(skill, SKILL_MD);
	return { projectDir, homeDir };
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,12}$/;

test("property: import destination shape stays under the root", async () => {
	const { importDestinationShapeAllowed } = await import("@gajae-code/coding-agent/customization/import");
	fc.assert(
		fc.property(
			fc.array(fc.stringMatching(SAFE_SEGMENT), { minLength: 1, maxLength: 4 }),
			fc.stringMatching(SAFE_SEGMENT),
			(segments, name) => {
				const root = path.join("/proj", ".gjc");
				const target = path.join(root, ...segments, name);
				const allowed = importDestinationShapeAllowed(root, target);
				expect(allowed).toBe(importDestinationShapeAllowed(root, target));
				expect(allowed).toBe(true);
				expect(path.relative(root, path.dirname(target)).startsWith("..")).toBe(false);
				expect(importDestinationShapeAllowed(root, path.join(root, "..", name))).toBe(false);
				expect(importDestinationShapeAllowed(root, path.join(root, "ok", `bad\n${name}`))).toBe(false);
			},
		),
		{ seed: 424, numRuns: 64 },
	);
});

test("still allows a skill import that creates a real destination directory", async () => {
	const { projectDir, homeDir } = await layout();
	const plan = await buildImportPreview({
		product: "claude-code",
		sourceScope: "project",
		destinationScope: "project",
		surfaces: ["skills"],
		collisionPolicy: "skip",
		cwd: projectDir,
		homeDir,
	});
	const result = await applyImport(plan, { cwd: projectDir });
	const written = path.join(projectDir, ".gjc", "skills", "claude-skill", "SKILL.md");
	expect(result.ok).toBe(true);
	expect(result.entries[0]?.outcome).toBe("imported");
	const stat = await fs.lstat(written);
	expect(stat.isSymbolicLink()).toBe(false);
	expect(stat.isFile()).toBe(true);
	expect(await fs.readFile(written, "utf-8")).toContain("x-gjc-imported-from");
});

test.skipIf(process.platform === "win32")(
	"does not publish a skill outside the destination when its directory is replaced before publication",
	async () => {
		const { projectDir, homeDir } = await layout();
		const skills = path.join(projectDir, ".gjc", "skills");
		const outside = path.join(tmpRoot!, "outside");
		await fs.mkdir(skills, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		const plan = await buildImportPreview({
			product: "claude-code",
			sourceScope: "project",
			destinationScope: "project",
			surfaces: ["skills"],
			collisionPolicy: "skip",
			cwd: projectDir,
			homeDir,
		});
		let swapped = false;
		const originalMkdir = fs.mkdir.bind(fs);
		const mkdir = spyOn(fs, "mkdir").mockImplementation((async (target, options) => {
			const destinationRoot = path.join(projectDir, ".gjc");
			if (
				!swapped &&
				typeof target === "string" &&
				(target === destinationRoot || target.startsWith(`${destinationRoot}${path.sep}`))
			) {
				swapped = true;
				await fs.rename(skills, `${skills}-real`);
				await fs.symlink(outside, skills);
			}
			return originalMkdir(target, options);
		}) as typeof fs.mkdir);
		try {
			const result = await applyImport(plan, { cwd: projectDir });
			expect(swapped).toBe(true);
			expect(result.ok).toBe(false);
			expect(result.entries.some(entry => entry.reason?.includes("symlink"))).toBe(true);
			await expect(fs.lstat(path.join(outside, "claude-skill", "SKILL.md"))).rejects.toThrow();
			const leaked = await fs.readdir(outside).catch(() => []);
			expect(leaked).toEqual([]);
		} finally {
			mkdir.mockRestore();
		}
	},
);
