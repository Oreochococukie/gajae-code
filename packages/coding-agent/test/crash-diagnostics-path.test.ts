import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatCrashDiagnosticNotice, writeCrashReport } from "../src/debug/crash-diagnostics";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-path-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("crash diagnostics path", () => {
	it("does not follow a project dotenv directory or chmod a symlink target", async () => {
		const cwd = await makeTempDir();
		const planted = path.join(cwd, "planted");
		const real = path.join(cwd, "real");
		const link = path.join(cwd, "link");
		await fs.mkdir(real);
		await fs.chmod(real, 0o755);
		await fs.symlink(real, link);
		await fs.writeFile(path.join(cwd, ".env"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted}\n`);
		const fromDotenv = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: planted } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:03.000Z"),
			},
		);
		expect(fromDotenv.path === null || !fromDotenv.path.startsWith(planted)).toBe(true);
		await expect(fs.stat(planted)).rejects.toThrow();

		const viaLink = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: link } as NodeJS.ProcessEnv,
			},
		);
		expect(viaLink.path).toBeNull();
		expect((await fs.stat(real)).mode & 0o777).toBe(0o755);
	});

	it("scrubs a persisted stderr secret", async () => {
		const dir = await makeTempDir();
		const crashed = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom sk-abcdefghijklmnop" },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:04.000Z"),
			},
		);
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as { stderrPreview?: string };
		expect(report.stderrPreview).not.toContain("sk-abcdefghijklmnop");
		expect(report.stderrPreview).toContain("«redacted-api-key»");
	});

	it("treats a commented project dotenv value as a project declaration", async () => {
		const cwd = await makeTempDir();
		const planted = path.join(cwd, "planted");
		await fs.writeFile(path.join(cwd, ".env"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted} # comment\n`);
		const fromDotenv = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: planted } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:05.000Z"),
			},
		);
		expect(fromDotenv.path === null || !fromDotenv.path.startsWith(planted)).toBe(true);
		await expect(fs.stat(planted)).rejects.toThrow();
	});

	it("scrubs a spawn error secret from the persisted reason and notice", async () => {
		const dir = await makeTempDir();
		const secret = "sk-abcdefghijklmnop";
		const crashed = await writeCrashReport(
			{ kind: "bash", spawnError: new Error(`spawn failed ${secret}`) },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:06.000Z"),
			},
		);
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as {
			reason: string;
			spawnError?: string;
		};
		expect(report.reason).not.toContain(secret);
		expect(report.reason).toContain("«redacted-api-key»");
		expect(report.spawnError).not.toContain(secret);
		const notice = formatCrashDiagnosticNotice(crashed);
		expect(notice).not.toContain(secret);
		expect(notice).toContain("«redacted-api-key»");
	});
});
