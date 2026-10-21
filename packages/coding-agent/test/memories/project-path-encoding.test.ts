import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import fc from "fast-check";
import { Settings } from "../../src/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot } from "../../src/memories";
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

	it("property: project memory directory names stay injective, seed 30321, 64 inputs", () => {
		const cwd = fc.string({
			maxLength: 24,
			unit: fc.constantFrom(..."abcXYZ09/\\:-%._"),
		});
		fc.assert(
			fc.property(cwd, cwd, (left, right) => {
				const leftName = directoryName(left);
				const rightName = directoryName(right);
				expect(leftName.startsWith("--")).toBe(true);
				expect(leftName.endsWith("--")).toBe(true);
				expect(leftName.includes("/") || leftName.includes("\\") || leftName.includes(":")).toBe(false);
				expect(path.basename(path.join(AGENT_DIR, leftName))).toBe(leftName);
				expect(decodeDirectoryName(leftName)).toBe(stripped(left));
				expect(directoryName(left)).toBe(leftName);
				if (stripped(left) === stripped(right)) expect(leftName).toBe(rightName);
				else expect(leftName).not.toBe(rightName);
				if (!/[%\\:-]/.test(stripped(left))) expect(leftName).toBe(historicalName(left));
			}),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});
});
