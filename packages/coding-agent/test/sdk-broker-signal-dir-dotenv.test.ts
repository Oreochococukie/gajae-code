import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectEnvSnapshot } from "@gajae-code/utils/env-file";
import fc from "fast-check";
import { brokerSpawnEnvironmentForTest, emitBrokerStartupTestSignal } from "../src/sdk/broker/ensure";
import type { SdkInternalSpawnCommand } from "../src/sdk/broker/runtime";

const SIGNAL_DIR = "GJC_SDK_TEST_BROKER_SIGNAL_DIR";
const SIGNAL = "retirement-finished";
const PROPERTY_SEED = 309733;

const spawnCommand: SdkInternalSpawnCommand = {
	kind: "compiled",
	file: "gjc",
	args: ["sdk", "broker-internal"],
	env: {},
};

async function withRepo(
	envText: string,
	body: (paths: { root: string; attack: string }) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-signal-"));
	const repo = path.join(root, "repo");
	const attack = path.join(root, "attacker-chosen");
	await fs.mkdir(repo);
	if (envText.length > 0) await fs.writeFile(path.join(repo, ".env"), envText);
	const previous = process.cwd();
	const prior = process.env[SIGNAL_DIR];
	try {
		process.chdir(repo);
		await body({ root, attack });
	} finally {
		if (prior === undefined) delete process.env[SIGNAL_DIR];
		else process.env[SIGNAL_DIR] = prior;
		process.chdir(previous);
		await fs.rm(root, { recursive: true, force: true });
	}
}

const homeDir = (): string => process.env.USERPROFILE ?? process.env.HOME ?? os.tmpdir();

function handedEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const home = homeDir();
	return brokerSpawnEnvironmentForTest(spawnCommand, {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		...extra,
	});
}

async function childSignal(env: NodeJS.ProcessEnv): Promise<string> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", `console.log(process.env[${JSON.stringify(SIGNAL_DIR)}] ?? "")`],
		{ cwd: os.tmpdir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`signal child exited ${code}: ${stderr}`);
	return stdout.trim();
}

async function signalFile(directory: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path.join(directory, SIGNAL), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

describe("broker startup signal directory provenance", () => {
	it("refuses a project dotenv signal directory before writing a broker signal file", async () => {
		await withRepo("", async ({ attack }) => {
			await fs.writeFile(path.join(process.cwd(), ".env"), `${SIGNAL_DIR}=${attack}\n`);
			process.env[SIGNAL_DIR] = attack;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(attack)).toBeUndefined();
		});
	});

	it("refuses a dynamic project dotenv signal directory before writing", async () => {
		await withRepo(`${SIGNAL_DIR}=$GJC_PLANTED_SIGNAL_DIR\n`, async ({ attack }) => {
			process.env[SIGNAL_DIR] = attack;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(attack)).toBeUndefined();
		});
	});

	it("drops a project dotenv signal directory from the spawned broker environment", async () => {
		await withRepo("", async ({ attack }) => {
			await fs.writeFile(path.join(process.cwd(), ".env"), `${SIGNAL_DIR}=${attack}\n`);
			process.env[SIGNAL_DIR] = attack;
			const spawned = handedEnv({ [SIGNAL_DIR]: attack, [SIGNAL_DIR.toLowerCase()]: attack });
			expect(spawned[SIGNAL_DIR]).toBeUndefined();
			expect(spawned[SIGNAL_DIR.toLowerCase()]).toBeUndefined();
			expect(await childSignal(spawned)).toBe("");
		});
	});

	it("keeps an operator signal directory the project does not declare", async () => {
		await withRepo("UNRELATED_PROJECT_FLAG=1\n", async ({ root }) => {
			const operator = path.join(root, "operator-signal");
			process.env[SIGNAL_DIR] = operator;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(operator)).toContain(`${process.pid}`);
		});
	});

	it("still allows an operator signal directory when the project declares another value", async () => {
		await withRepo("", async ({ root }) => {
			const declared = path.join(root, "project-declared");
			const operator = path.join(root, "operator-override");
			await fs.writeFile(path.join(process.cwd(), ".env"), `${SIGNAL_DIR}=${declared}\n`);
			process.env[SIGNAL_DIR] = operator;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(operator)).toContain(`${process.pid}`);
			expect(await signalFile(declared)).toBeUndefined();
		});
	});

	it("keeps the operator signal directory in the spawned broker environment", async () => {
		await withRepo("UNRELATED_PROJECT_FLAG=1\n", async ({ root }) => {
			const operator = path.join(root, "operator-child");
			const spawned = handedEnv({ [SIGNAL_DIR]: operator, OWNED_SENTINEL: "kept" });
			expect(spawned[SIGNAL_DIR]).toBe(operator);
			expect(spawned.OWNED_SENTINEL).toBe("kept");
			expect(await childSignal(spawned)).toBe(operator);
		});
	});

	it.skipIf(process.platform === "win32")(
		"finishes when project dotenv is a fifo and the signal directory is unset",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-signal-fifo-"));
			const repo = path.join(root, "repo");
			const attack = path.join(root, "attacker-chosen");
			await fs.mkdir(repo);
			const made = Bun.spawn(["mkfifo", path.join(repo, ".env")], { stdout: "ignore", stderr: "pipe" });
			const mkCode = await made.exited;
			if (mkCode !== 0) {
				await fs.rm(root, { recursive: true, force: true });
				throw new Error(`mkfifo exited ${mkCode}`);
			}
			const ensurePath = path.join(import.meta.dir, "../src/sdk/broker/ensure.ts");
			const script = `
			import { brokerSpawnEnvironmentForTest, emitBrokerStartupTestSignal } from ${JSON.stringify(ensurePath)};
			process.chdir(${JSON.stringify(repo)});
			const key = ${JSON.stringify(SIGNAL_DIR)};
			const attack = ${JSON.stringify(attack)};
			const mode = process.env.PROBE_MODE;
			if (mode !== "set") delete process.env[key];
			else process.env[key] = attack;
			console.log("before");
			if (mode === "set") await emitBrokerStartupTestSignal(${JSON.stringify(SIGNAL)});
			const env = brokerSpawnEnvironmentForTest(
				{ kind: "compiled", file: "gjc", args: [], env: {} },
				{ PATH: "/usr/bin:/bin", ...(mode === "set" ? { [key]: attack } : {}) },
			);
			console.log("after");
			console.log("seen=" + (env[key] ?? ""));
		`;
			try {
				for (const mode of ["unset", "set"] as const) {
					const home = homeDir();
					const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
						cwd: os.tmpdir(),
						env: {
							PATH: process.env.PATH ?? "/usr/bin:/bin",
							HOME: home,
							USERPROFILE: home,
							PROBE_MODE: mode,
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
					const killer = setTimeout(() => child.kill(), 5_000);
					const [stdout, stderr, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					clearTimeout(killer);
					expect({ mode, code, stderr, stdout }).toMatchObject({ mode, code: 0 });
					expect(stdout).toContain("before");
					expect(stdout).toContain("after");
					expect(stdout).toContain("seen=");
					expect(stdout).not.toContain(`seen=${attack}`);
				}
				expect(await signalFile(attack)).toBeUndefined();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it("refuses a project dotenv file larger than the read cap", async () => {
		await withRepo("", async ({ attack }) => {
			await fs.writeFile(path.join(process.cwd(), ".env"), "A".repeat(128 * 1024));
			process.env[SIGNAL_DIR] = attack;
			await emitBrokerStartupTestSignal(SIGNAL);
			const spawned = handedEnv({ [SIGNAL_DIR]: attack });
			expect(await signalFile(attack)).toBeUndefined();
			expect(spawned[SIGNAL_DIR]).toBeUndefined();
			expect(await childSignal(spawned)).toBe("");
		});
	});

	it("property: broker signal directory matches operator provenance, seed 309733, 64 inputs", async () => {
		const mod = await import("../src/sdk/broker/ensure");
		const decide = mod.trustedBrokerSignalDirectoryForTest;
		if (typeof decide !== "function") throw new Error("trustedBrokerSignalDirectoryForTest is required");
		const directory = fc
			.string({ minLength: 1, maxLength: 48 })
			.filter(value => value.trim().length > 0 && !value.includes("\0"));
		fc.assert(
			fc.property(directory, fc.boolean(), (raw, dynamic) => {
				const declared: ProjectEnvSnapshot = {
					values: { [SIGNAL_DIR]: raw },
					dynamic: dynamic ? new Set([SIGNAL_DIR]) : new Set<string>(),
				};
				expect(decide({ [SIGNAL_DIR]: raw }, declared)).toBeUndefined();
				expect(decide({}, declared)).toBeUndefined();
				if (dynamic) {
					expect(decide({ [SIGNAL_DIR]: `${raw}-operator` }, declared)).toBeUndefined();
				} else {
					const operator = `${raw}-operator`;
					expect(decide({ [SIGNAL_DIR]: operator }, declared)).toBe(operator.trim());
				}
				const empty: ProjectEnvSnapshot = { values: {}, dynamic: new Set() };
				const accepted = decide({ [SIGNAL_DIR]: raw }, empty);
				expect(accepted).toBe(raw.trim());
				expect(decide({ [SIGNAL_DIR]: raw }, empty)).toBe(accepted);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});
