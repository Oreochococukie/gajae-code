/**
 * Tests for project-scope registry resolution contracts.
 *
 * resolveActiveProjectRegistryPath: walk-up, .git fallback, null return, canonical path.
 * listAnthropic modelPluginRoots: project entries shadow user entries for same plugin ID.
 *
 * Note: helpers.ts imports @gajae-code/natives (Rust addon via glob).
 * This file imports from helpers.ts directly — the native addon IS present in the
 * test environment (verified: `bun run import-helpers.ts` succeeds).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addInstalledPlugin,
	buildPluginId,
	getCachedPluginPath,
	type InstalledPluginEntry,
	MarketplaceManager,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "@gajae-code/coding-agent/extensibility/plugins/marketplace";
import { getPluginsDir } from "@gajae-code/utils";
import { safeRmSync } from "../../../../scripts/safe-cleanup";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	resolveActiveProjectRegistryPath,
} from "../../src/discovery/helpers";
import { loadSkills } from "../../src/extensibility/skills";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(
	installPath: string,
	scope: InstalledPluginEntry["scope"] = "user",
	version = "1.0.0",
): InstalledPluginEntry {
	return {
		scope,
		installPath,
		version,
		installedAt: "2025-01-01T00:00:00.000Z",
		lastUpdated: "2025-01-01T00:00:00.000Z",
	};
}

function installedCachePath(home: string, marketplace: string, pluginName: string, version: string): string {
	return getCachedPluginPath(path.join(getPluginsDir(home), "cache", "plugins"), marketplace, pluginName, version);
}

function writePluginSkill(pluginRoot: string, skillName: string, body: string): void {
	const skillDir = path.join(pluginRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: ${skillName} description\n---\n${body}\n`,
	);
}

// ── resolveActiveProjectRegistryPath ─────────────────────────────────────────

describe("resolveActiveProjectRegistryPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-proj-scope-"));
	});

	afterEach(() => {
		safeRmSync(tmpDir, { recursive: true, force: true });
	});

	it("walk-up finds nearest .gjc/ directory", async () => {
		// Layout: tmpDir/.gjc/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must climb from cwd → sub → tmpDir and find .gjc/ there.
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, ".gjc", "plugins", "installed_plugins.json"));
	});

	it("walk-up stops at the nearest .gjc/ — does not skip to a more distant one", async () => {
		// Layout: tmpDir/.gjc/   +   tmpDir/sub/.gjc/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must stop at tmpDir/sub/.gjc/, not climb further to tmpDir/.gjc/.
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "sub", ".gjc"), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, "sub", ".gjc", "plugins", "installed_plugins.json"));
	});

	it("stops at an explicitly supplied home before an unrelated ancestor registry", async () => {
		const suppliedHome = path.join(tmpDir, "alternate-home");
		const cwd = path.join(suppliedHome, "nested", "project");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd, suppliedHome);

		expect(result).toBeNull();
	});

	it("canonicalizes a symlinked cwd before comparing the supplied-home boundary", async () => {
		if (process.platform === "win32") return;
		const suppliedHome = path.join(tmpDir, "real-home");
		const linkedHome = path.join(tmpDir, "linked-home");
		const realCwd = path.join(suppliedHome, "nested", "project");
		fs.mkdirSync(realCwd, { recursive: true });
		fs.symlinkSync(suppliedHome, linkedHome, "dir");
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });

		const result = await resolveActiveProjectRegistryPath(path.join(linkedHome, "nested", "project"), suppliedHome);

		expect(result).toBeNull();
	});

	it("reuses the canonical cwd for the .git fallback boundary", async () => {
		if (process.platform === "win32") return;
		const suppliedHome = path.join(tmpDir, "real-home-git");
		const linkedHome = path.join(tmpDir, "linked-home-git");
		const realCwd = path.join(suppliedHome, "nested", "project");
		fs.mkdirSync(realCwd, { recursive: true });
		fs.symlinkSync(suppliedHome, linkedHome, "dir");
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

		const result = await resolveActiveProjectRegistryPath(path.join(linkedHome, "nested", "project"), suppliedHome);

		expect(result).toBeNull();
	});

	it("falls back to .git root when no .gjc/ exists", async () => {
		// Layout: tmpDir/.git/   +   tmpDir/sub/  (cwd)
		// No .gjc/ anywhere → second pass finds .git/ at tmpDir.
		// Returned path is relative to the .git root, not .git itself.
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
		const cwd = path.join(tmpDir, "sub");
		fs.mkdirSync(cwd, { recursive: true });

		// Bound the walk-up at os.tmpdir() so a `.gjc/` polluting a shared ancestor
		// (e.g. a /tmp/.gjc left by other processes on CI runners) cannot shadow the
		// intended .git fallback. resolveActiveProjectRegistryPath stops before homedir.
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(os.tmpdir());
		try {
			const result = await resolveActiveProjectRegistryPath(cwd);
			expect(result).toBe(path.join(tmpDir, ".gjc", "plugins", "installed_plugins.json"));
		} finally {
			homeSpy.mockRestore();
		}
	});

	it("returns null when neither .gjc/ nor .git/ found anywhere in the tree", async () => {
		// Start at the filesystem root — guaranteed to have no .gjc/ or .git/ ancestors.
		const result = await resolveActiveProjectRegistryPath(path.sep);

		expect(result).toBeNull();
	});

	it("does not treat ~/.git as a project root (pass-2 home-dir guard)", async () => {
		// Simulate a dotfiles repo managed with a bare-git technique: ~/.git exists.
		// resolveActiveProjectRegistryPath must NOT return ~/.gjc/.../installed_plugins.json.
		//
		// Issue #4794: the fake home is a MOCKED temp home, not the operator's
		// real home — the previous version created and recursively deleted
		// ~/.git in the real home, which the safe-cleanup boundary refuses
		// (correctly), failing the test on machines without a pre-existing ~/.git.
		const fakeHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bare-git-home-"));
		const homeDir = path.join(fakeHomeRoot, "home");
		const fakeHomeGit = path.join(homeDir, ".git");
		const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		fs.mkdirSync(fakeHomeGit, { recursive: true });
		try {
			// Start from a tmpDir that has no .gjc/ or .git/ of its own.
			const result = await resolveActiveProjectRegistryPath(tmpDir);
			// Must not resolve to the home-dir GJC registry.
			const homeGjcPath = path.join(homeDir, ".gjc", "plugins", "installed_plugins.json");
			expect(result).not.toBe(homeGjcPath);
		} finally {
			homeSpy.mockRestore();
			safeRmSync(fakeHomeRoot, { recursive: true, force: true });
		}
	});

	it("canonical path — /repo and /repo/src resolve to the same registry file", async () => {
		// Both sub-directories of the same project must produce identical paths.
		fs.mkdirSync(path.join(tmpDir, ".gjc"), { recursive: true });
		const src = path.join(tmpDir, "src");
		fs.mkdirSync(src, { recursive: true });

		const fromRoot = await resolveActiveProjectRegistryPath(tmpDir);
		const fromSrc = await resolveActiveProjectRegistryPath(src);

		expect(fromRoot).not.toBeNull();
		expect(fromRoot).toBe(fromSrc);
	});
});

// ── listAnthropic modelPluginRoots: project shadows user ───────────────────────────────

describe("listClaudePluginRoots — project shadows user", () => {
	let tmpHome: string;
	let tmpProject: string;
	/** Path where listAnthropic modelPluginRoots reads the user GJC registry. */
	let userRegPath: string;
	/** Path where listAnthropic modelPluginRoots reads the project registry (resolved from tmpProject). */
	let projectRegPath: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shadow-home-"));
		tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-shadow-proj-"));

		// Create .gjc/ in project so resolveActiveProjectRegistryPath finds it.
		fs.mkdirSync(path.join(tmpProject, ".gjc", "plugins"), { recursive: true });

		userRegPath = path.join(tmpHome, ".gjc", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(userRegPath), { recursive: true });

		projectRegPath = path.join(tmpProject, ".gjc", "plugins", "installed_plugins.json");
	});

	afterEach(() => {
		// Cache is keyed by home:projectPath — must clear between tests.
		clearClaudePluginRootsCache();
		safeRmSync(tmpHome, { recursive: true, force: true });
		safeRmSync(tmpProject, { recursive: true, force: true });
	});

	it("project entry shadows user entry when plugin IDs match", async () => {
		const pluginId = buildPluginId("shared-plugin", "test-mkt");

		// User registry has the plugin at a user-side install path.
		let userReg = await readInstalledPluginsRegistry(userRegPath);
		userReg = addInstalledPlugin(userReg, pluginId, makeEntry("/user/install/shared-plugin"));
		await writeInstalledPluginsRegistry(userRegPath, userReg);

		// Project registry records the installer cache path for the same plugin ID.
		const projectInstallPath = installedCachePath(tmpHome, "test-mkt", "shared-plugin", "1.0.0");
		let projReg = await readInstalledPluginsRegistry(projectRegPath);
		projReg = addInstalledPlugin(projReg, pluginId, makeEntry(projectInstallPath, "project"));
		await writeInstalledPluginsRegistry(projectRegPath, projReg);

		const { roots } = await listClaudePluginRoots(tmpHome, tmpProject);
		const matching = roots.filter(r => r.id === pluginId);

		// Exactly one entry survives — the user entry is suppressed.
		expect(matching).toHaveLength(1);
		expect(matching[0]?.path).toBe(projectInstallPath);
		expect(matching[0]?.scope).toBe("project");
	});

	it("does not let a project registry path outside the cache hide the user install", async () => {
		const pluginId = buildPluginId("shared-plugin", "test-mkt");
		let userReg = await readInstalledPluginsRegistry(userRegPath);
		userReg = addInstalledPlugin(userReg, pluginId, makeEntry("/user/install/shared-plugin"));
		await writeInstalledPluginsRegistry(userRegPath, userReg);

		let projReg = await readInstalledPluginsRegistry(projectRegPath);
		projReg = addInstalledPlugin(projReg, pluginId, makeEntry(path.join(tmpProject, "vendored-plugin"), "project"));
		await writeInstalledPluginsRegistry(projectRegPath, projReg);

		const { roots, warnings } = await listClaudePluginRoots(tmpHome, tmpProject);
		const matching = roots.filter(r => r.id === pluginId);
		expect(matching).toHaveLength(1);
		expect(matching[0]?.path).toBe("/user/install/shared-plugin");
		expect(matching[0]?.scope).toBe("user");
		expect(warnings.some(warning => warning.includes("not the installed cache path"))).toBe(true);
	});
});

describe("project plugin registry skill loading", () => {
	const pluginName = "evil-plugin";
	const marketplace = "evil-market";
	const version = "6.6.6";
	const skillName = "evil-skill";

	async function writeProjectRegistry(project: string, installPath: string): Promise<void> {
		const projectRegPath = path.join(project, ".gjc", "plugins", "installed_plugins.json");
		fs.mkdirSync(path.dirname(projectRegPath), { recursive: true });
		const pluginId = buildPluginId(pluginName, marketplace);
		let registry = await readInstalledPluginsRegistry(projectRegPath);
		registry = addInstalledPlugin(registry, pluginId, makeEntry(installPath, "project", version));
		await writeInstalledPluginsRegistry(projectRegPath, registry);
	}

	it("does not load a repo plugin skill from a project registry installPath outside the cache", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-skill-home-"));
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-skill-proj-"));
		try {
			clearClaudePluginRootsCache();
			const repoPlugin = path.join(project, ".gjc", "plugins", pluginName);
			writePluginSkill(repoPlugin, skillName, "repo skill body");
			await writeProjectRegistry(project, repoPlugin);

			const { skills } = await loadSkills({ cwd: project, home, trustUserSkills: false });
			expect(skills.some(skill => skill.name === `${pluginName}:${skillName}`)).toBe(false);
		} finally {
			clearClaudePluginRootsCache();
			safeRmSync(home, { recursive: true, force: true });
			safeRmSync(project, { recursive: true, force: true });
		}
	});

	it("still loads a project registry skill whose installPath is the installed cache path", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-skill-home-"));
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-skill-proj-"));
		try {
			clearClaudePluginRootsCache();
			const cachePath = installedCachePath(home, marketplace, pluginName, version);
			writePluginSkill(cachePath, skillName, "installed cache skill body");
			await writeProjectRegistry(project, cachePath);

			const { skills } = await loadSkills({ cwd: project, home, trustUserSkills: false });
			const loaded = skills.find(skill => skill.name === `${pluginName}:${skillName}`);
			expect(loaded?.source).toBe("claude-plugins:project");
			expect(fs.realpathSync(loaded?.filePath ?? "")).toBe(
				fs.realpathSync(path.join(cachePath, "skills", skillName, "SKILL.md")),
			);
			if (!loaded?.loadContent) throw new Error("Expected the installed cache skill body loader");
			expect(await loaded.loadContent()).toContain("installed cache skill body");
		} finally {
			clearClaudePluginRootsCache();
			safeRmSync(home, { recursive: true, force: true });
			safeRmSync(project, { recursive: true, force: true });
		}
	});
});

const MARKETPLACE_FIXTURE = path.join(import.meta.dir, "fixtures", "valid-marketplace");

describe("project install cache root", () => {
	async function installProjectPlugin(home: string, project: string, pluginsCacheDir: string): Promise<string> {
		fs.mkdirSync(path.join(project, ".gjc", "plugins"), { recursive: true });
		const manager = new MarketplaceManager({
			marketplacesRegistryPath: path.join(home, "marketplaces.json"),
			installedRegistryPath: path.join(home, "installed_plugins.json"),
			projectInstalledRegistryPath: path.join(project, ".gjc", "plugins", "installed_plugins.json"),
			marketplacesCacheDir: path.join(home, "marketplaces"),
			pluginsCacheDir,
		});
		await manager.addMarketplace(MARKETPLACE_FIXTURE);
		const installed = await manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });
		return installed.installPath;
	}

	it("discovers a project install written under the caller-supplied plugins cache", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cache-root-home-"));
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cache-root-proj-"));
		const customCache = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-caller-plugin-cache-"));
		try {
			const installPath = await installProjectPlugin(home, project, customCache);
			clearClaudePluginRootsCache();
			expect(installPath).toBe(getCachedPluginPath(customCache, "test-marketplace", "hello-plugin", "1.0.0"));
			expect(installPath).not.toBe(installedCachePath(home, "test-marketplace", "hello-plugin", "1.0.0"));

			const hidden = await listClaudePluginRoots(home, project);
			expect(hidden.roots.some(root => root.path === installPath)).toBe(false);

			const visible = await listClaudePluginRoots(home, project, false, undefined, customCache);
			const matching = visible.roots.filter(root => root.id === "hello-plugin@test-marketplace");
			expect(matching).toHaveLength(1);
			expect(matching[0]?.path).toBe(installPath);
			expect(matching[0]?.scope).toBe("project");
		} finally {
			clearClaudePluginRootsCache();
			safeRmSync(home, { recursive: true, force: true });
			safeRmSync(project, { recursive: true, force: true });
			safeRmSync(customCache, { recursive: true, force: true });
		}
	});

	it("still discovers a project install under the canonical installer cache", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cache-root-home-"));
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cache-root-proj-"));
		const canonicalCache = path.join(getPluginsDir(home), "cache", "plugins");
		try {
			const installPath = await installProjectPlugin(home, project, canonicalCache);
			clearClaudePluginRootsCache();
			expect(installPath).toBe(installedCachePath(home, "test-marketplace", "hello-plugin", "1.0.0"));
			const { roots } = await listClaudePluginRoots(home, project);
			const matching = roots.filter(root => root.id === "hello-plugin@test-marketplace");
			expect(matching).toHaveLength(1);
			expect(matching[0]?.path).toBe(installPath);
			expect(matching[0]?.scope).toBe("project");
		} finally {
			clearClaudePluginRootsCache();
			safeRmSync(home, { recursive: true, force: true });
			safeRmSync(project, { recursive: true, force: true });
		}
	});

	it("does not adopt a registry path that is not the configured cache path", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cache-root-home-"));
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cache-root-proj-"));
		const customCache = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-caller-plugin-cache-"));
		try {
			fs.mkdirSync(path.join(project, ".gjc", "plugins"), { recursive: true });
			const forged = path.join(customCache, "forged-plugin");
			fs.mkdirSync(forged, { recursive: true });
			const pluginId = buildPluginId("hello-plugin", "test-marketplace");
			const registryPath = path.join(project, ".gjc", "plugins", "installed_plugins.json");
			let registry = await readInstalledPluginsRegistry(registryPath);
			registry = addInstalledPlugin(registry, pluginId, makeEntry(forged, "project", "1.0.0"));
			await writeInstalledPluginsRegistry(registryPath, registry);
			expect(forged).not.toBe(getCachedPluginPath(customCache, "test-marketplace", "hello-plugin", "1.0.0"));

			clearClaudePluginRootsCache();
			const { roots, warnings } = await listClaudePluginRoots(home, project, false, undefined, customCache);
			expect(roots.some(root => root.id === pluginId || root.path === forged)).toBe(false);
			expect(warnings.some(warning => warning.includes("not the installed cache path"))).toBe(true);
		} finally {
			clearClaudePluginRootsCache();
			safeRmSync(home, { recursive: true, force: true });
			safeRmSync(project, { recursive: true, force: true });
			safeRmSync(customCache, { recursive: true, force: true });
		}
	});
});
