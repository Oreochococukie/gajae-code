import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { getAgentDbPath } from "@gajae-code/utils";
import fc from "fast-check";
import { Settings } from "../../src/config/settings";
import { buildMemoryToolDeveloperInstructions, clearMemoryData, getMemoryRoot } from "../../src/memories";
import { closeMemoryDb, openMemoryDb, upsertThreads } from "../../src/memories/storage";
import { AgentRegistry } from "../../src/registry/agent-registry";

const PROPERTY_SEED = 30321;
const PROPERTY_RUNS = 64;
const AGENT_DIR = path.join(os.tmpdir(), "memory-path-encoding-agent");
const SLASH_PROJECT = "/var/proj/alpha";
const DASH_PROJECT = "/var/proj-alpha";

function directoryName(cwd: string): string {
	return path.basename(getMemoryRoot(AGENT_DIR, cwd));
}

function stripped(cwd: string): string {
	return cwd.replace(/^[/\\]/, "");
}

function historicalName(cwd: string): string {
	return `--${stripped(cwd).replace(/[/\\:]/g, "-")}--`;
}

function reversibleName(cwd: string): string {
	const encoded = stripped(cwd)
		.replace(/%/g, "%25")
		.replace(/\\/g, "%5C")
		.replace(/:/g, "%3A")
		.replace(/-/g, "%2D")
		.replace(/\//g, "-");
	return `--${encoded}--`;
}

function decodeDirectoryName(name: string): string {
	const body = name.slice(2, -2).replace(/-/g, "/");
	return body.replace(/%2D/g, "-").replace(/%3A/g, ":").replace(/%5C/g, "\\").replace(/%25/g, "%");
}

function sessionFor(cwd: string, agentDir: string): AgentSession {
	return {
		settings: { getAgentDir: () => agentDir },
		sessionManager: {
			getCwd: () => cwd,
			getArtifactsDir: () => null,
			getSessionId: () => "memory-path",
		},
	} as unknown as AgentSession;
}

describe("project memory path encoding", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("keeps slash-only project paths on their historical memory directory", () => {
		for (const cwd of [SLASH_PROJECT, "/home/u/proj", "/srv/app/v2", "/a/b/c"]) {
			expect(directoryName(cwd)).toBe(historicalName(cwd));
		}
		const exactLimit = `/${"a".repeat(251)}`;
		expect(Buffer.byteLength(directoryName(exactLimit))).toBe(255);
		expect(directoryName(exactLimit)).toBe(historicalName(exactLimit));
	});

	it("keeps a long dashed project path able to store and read its own memory", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-path-long-"));
		const leftCwd = `/var/${"a-".repeat(70)}`;
		const rightCwd = `/var/${"a-".repeat(69)}b-`;
		try {
			const settings = Settings.isolated({ "memories.enabled": true });
			const leftRoot = getMemoryRoot(agentDir, leftCwd);
			const rightRoot = getMemoryRoot(agentDir, rightCwd);
			expect(leftRoot).not.toBe(rightRoot);
			expect(Buffer.byteLength(path.basename(leftRoot))).toBeLessThanOrEqual(255);
			expect(Buffer.byteLength(path.basename(rightRoot))).toBeLessThanOrEqual(255);
			await fs.mkdir(leftRoot, { recursive: true });
			await fs.mkdir(rightRoot, { recursive: true });
			await Bun.write(path.join(leftRoot, "memory_summary.md"), "LONG_ALPHA_TOKEN");
			await Bun.write(path.join(rightRoot, "memory_summary.md"), "LONG_BETA_TOKEN");

			const leftInstructions = await buildMemoryToolDeveloperInstructions(
				agentDir,
				settings,
				sessionFor(leftCwd, agentDir),
			);
			const rightInstructions = await buildMemoryToolDeveloperInstructions(
				agentDir,
				settings,
				sessionFor(rightCwd, agentDir),
			);
			expect(leftInstructions).toContain("LONG_ALPHA_TOKEN");
			expect(leftInstructions).not.toContain("LONG_BETA_TOKEN");
			expect(rightInstructions).toContain("LONG_BETA_TOKEN");
			expect(rightInstructions).not.toContain("LONG_ALPHA_TOKEN");

			AgentRegistry.resetGlobalForTests();
			InternalUrlRouter.resetForTests();
			AgentRegistry.global().register({
				id: "long-left",
				displayName: "long-left",
				kind: "main",
				session: sessionFor(leftCwd, agentDir),
				sessionFile: null,
			});
			const leftResource = await InternalUrlRouter.instance().resolve("memory://root");
			expect(leftResource.content).toBe("LONG_ALPHA_TOKEN");
			AgentRegistry.resetGlobalForTests();
			InternalUrlRouter.resetForTests();
			AgentRegistry.global().register({
				id: "long-right",
				displayName: "long-right",
				kind: "main",
				session: sessionFor(rightCwd, agentDir),
				sessionFile: null,
			});
			const rightResource = await InternalUrlRouter.instance().resolve("memory://root");
			expect(rightResource.content).toBe("LONG_BETA_TOKEN");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("does not inject another project's memory summary", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-path-prompt-"));
		try {
			const settings = Settings.isolated({ "memories.enabled": true });
			const slashRoot = getMemoryRoot(agentDir, SLASH_PROJECT);
			const dashRoot = getMemoryRoot(agentDir, DASH_PROJECT);
			expect(slashRoot).not.toBe(dashRoot);
			await fs.mkdir(slashRoot, { recursive: true });
			await fs.mkdir(dashRoot, { recursive: true });
			await Bun.write(path.join(slashRoot, "memory_summary.md"), "ALPHA_ONLY_TOKEN");
			await Bun.write(path.join(dashRoot, "memory_summary.md"), "DASH_ONLY_TOKEN");

			const slashInstructions = await buildMemoryToolDeveloperInstructions(
				agentDir,
				settings,
				sessionFor(SLASH_PROJECT, agentDir),
			);
			const dashInstructions = await buildMemoryToolDeveloperInstructions(
				agentDir,
				settings,
				sessionFor(DASH_PROJECT, agentDir),
			);
			expect(slashInstructions).toContain("ALPHA_ONLY_TOKEN");
			expect(slashInstructions).not.toContain("DASH_ONLY_TOKEN");
			expect(dashInstructions).toContain("DASH_ONLY_TOKEN");
			expect(dashInstructions).not.toContain("ALPHA_ONLY_TOKEN");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("resolves memory:// from the same directory the writer stored", async () => {
		const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-path-url-"));
		try {
			const agentDir = path.join(cleanupRoot, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			const slashRoot = getMemoryRoot(agentDir, SLASH_PROJECT);
			const dashRoot = getMemoryRoot(agentDir, DASH_PROJECT);
			expect(slashRoot).not.toBe(dashRoot);
			await fs.mkdir(slashRoot, { recursive: true });
			await fs.mkdir(dashRoot, { recursive: true });
			await Bun.write(path.join(slashRoot, "memory_summary.md"), "ALPHA_ONLY_TOKEN");
			await Bun.write(path.join(dashRoot, "memory_summary.md"), "DASH_ONLY_TOKEN");

			AgentRegistry.resetGlobalForTests();
			InternalUrlRouter.resetForTests();
			AgentRegistry.global().register({
				id: "dash-project",
				displayName: "dash",
				kind: "main",
				session: sessionFor(DASH_PROJECT, agentDir),
				sessionFile: null,
			});
			const dashResource = await InternalUrlRouter.instance().resolve("memory://root");
			expect(dashResource.content).toBe("DASH_ONLY_TOKEN");
			const dashSource = dashResource.sourcePath;
			if (dashSource === undefined) throw new Error("expected memory source path");
			expect(dashSource.startsWith(`${await fs.realpath(dashRoot)}${path.sep}`)).toBe(true);

			AgentRegistry.resetGlobalForTests();
			InternalUrlRouter.resetForTests();
			AgentRegistry.global().register({
				id: "slash-project",
				displayName: "slash",
				kind: "main",
				session: sessionFor(SLASH_PROJECT, agentDir),
				sessionFile: null,
			});
			const slashResource = await InternalUrlRouter.instance().resolve("memory://root");
			expect(slashResource.content).toBe("ALPHA_ONLY_TOKEN");
		} finally {
			await fs.rm(cleanupRoot, { recursive: true, force: true });
		}
	});

	it("leaves an ambiguous legacy memory directory in place when the current root is cleared", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-clear-legacy-"));
		try {
			const current = getMemoryRoot(agentDir, DASH_PROJECT);
			const legacy = path.join(path.dirname(current), historicalName(DASH_PROJECT));
			expect(current).not.toBe(legacy);
			expect(legacy).toBe(getMemoryRoot(agentDir, SLASH_PROJECT));
			await fs.mkdir(current, { recursive: true });
			await fs.mkdir(legacy, { recursive: true });
			await Bun.write(path.join(current, "memory_summary.md"), "CURRENT_ONLY_TOKEN");
			await Bun.write(path.join(legacy, "memory_summary.md"), "LEGACY_ONLY_TOKEN");

			await clearMemoryData(agentDir, DASH_PROJECT);

			await expect(fs.stat(current)).rejects.toThrow();
			expect(await Bun.file(path.join(legacy, "memory_summary.md")).text()).toBe("LEGACY_ONLY_TOKEN");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("clears shared database rows and jobs globally while removing only the current directory", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-clear-global-db-"));
		const otherProject = "/var/other";
		try {
			const current = getMemoryRoot(agentDir, SLASH_PROJECT);
			const other = getMemoryRoot(agentDir, otherProject);
			expect(current).not.toBe(other);
			await fs.mkdir(current, { recursive: true });
			await fs.mkdir(other, { recursive: true });
			await Bun.write(path.join(current, "memory_summary.md"), "CURRENT_ONLY_TOKEN");
			await Bun.write(path.join(other, "memory_summary.md"), "OTHER_PROJECT_TOKEN");

			const db = openMemoryDb(getAgentDbPath(agentDir));
			try {
				upsertThreads(db, [
					{
						id: "thread-current",
						updatedAt: 1,
						rolloutPath: "current.jsonl",
						cwd: SLASH_PROJECT,
						sourceKind: "cli",
					},
					{
						id: "thread-other",
						updatedAt: 1,
						rolloutPath: "other.jsonl",
						cwd: otherProject,
						sourceKind: "cli",
					},
				]);
				db.prepare(
					"INSERT INTO jobs (kind, job_key, status, retry_remaining) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
				).run(
					"memory_stage1",
					"thread-other",
					"pending",
					1,
					"memory_consolidate_global",
					`global:${otherProject}`,
					"pending",
					1,
					"some_other_job",
					"x",
					"pending",
					1,
				);
			} finally {
				closeMemoryDb(db);
			}

			await clearMemoryData(agentDir, SLASH_PROJECT);

			await expect(fs.stat(current)).rejects.toThrow();
			expect(await Bun.file(path.join(other, "memory_summary.md")).text()).toBe("OTHER_PROJECT_TOKEN");
			const after = openMemoryDb(getAgentDbPath(agentDir));
			try {
				const threads = after.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number };
				const memoryJobs = after
					.prepare(
						"SELECT COUNT(*) AS count FROM jobs WHERE kind IN ('memory_stage1', 'memory_consolidate_global')",
					)
					.get() as { count: number };
				const otherJobs = after
					.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'some_other_job'")
					.get() as {
					count: number;
				};
				expect(threads.count).toBe(0);
				expect(memoryJobs.count).toBe(0);
				expect(otherJobs.count).toBe(1);
			} finally {
				closeMemoryDb(after);
			}
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("still removes the current memory directory for a slash-only project path", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-clear-slash-"));
		try {
			const current = getMemoryRoot(agentDir, SLASH_PROJECT);
			expect(path.basename(current)).toBe(historicalName(SLASH_PROJECT));
			await fs.mkdir(current, { recursive: true });
			await Bun.write(path.join(current, "MEMORY.md"), "SLASH_ONLY_TOKEN");

			await clearMemoryData(agentDir, SLASH_PROJECT);

			await expect(fs.stat(current)).rejects.toThrow();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("property: project memory directory names stay injective, seed 30321, 64 inputs", () => {
		const short = fc.string({
			maxLength: 24,
			unit: fc.constantFrom(..."abcXYZ09/\\:-%._", "가", "你"),
		});
		const growing = fc
			.record({
				lead: fc.constantFrom("", "/"),
				piece: fc.constantFrom("a-", "가-", "b:", "%"),
				count: fc.integer({ min: 1, max: 90 }),
			})
			.map(({ lead, piece, count }) => `${lead}${piece.repeat(count)}`);
		const boundary = fc.constantFrom(
			`/var/${"a-".repeat(70)}`,
			`/var/${"a-".repeat(69)}b-`,
			`/${"가-".repeat(50)}`,
			`/${"a".repeat(251)}`,
			`/${"a".repeat(252)}`,
		);
		const cwd = fc.oneof(short, growing, boundary);
		fc.assert(
			fc.property(cwd, cwd, (left, right) => {
				const leftName = directoryName(left);
				const rightName = directoryName(right);
				const leftExpanded = reversibleName(left);
				const rightExpanded = reversibleName(right);
				expect(leftName.startsWith("--")).toBe(true);
				expect(leftName.endsWith("--")).toBe(true);
				expect(leftName.includes("/") || leftName.includes("\\") || leftName.includes(":")).toBe(false);
				expect(Buffer.byteLength(leftName)).toBeLessThanOrEqual(255);
				expect(path.basename(path.join(AGENT_DIR, leftName))).toBe(leftName);
				expect(directoryName(left)).toBe(leftName);
				if (Buffer.byteLength(leftExpanded) <= 255) {
					expect(leftName).toBe(leftExpanded);
					expect(decodeDirectoryName(leftName)).toBe(stripped(left));
					if (!/[%\\:-]/.test(stripped(left))) expect(leftName).toBe(historicalName(left));
				} else {
					expect(leftName.startsWith("--%00")).toBe(true);
					expect(leftName).not.toContain("/");
				}
				if (left === right) expect(leftName).toBe(rightName);
				else if (Buffer.byteLength(leftExpanded) <= 255 && Buffer.byteLength(rightExpanded) <= 255) {
					if (stripped(left) === stripped(right)) expect(leftName).toBe(rightName);
					else expect(leftName).not.toBe(rightName);
				} else expect(leftName).not.toBe(rightName);
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});
});
