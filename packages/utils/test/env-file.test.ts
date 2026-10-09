import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnvFileContent, projectEnvSnapshot } from "../src/env-file";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("parseEnvFileContent Bun quote and newline parsing", () => {
	test("double-quoted \\n is a real newline", () => {
		const value = parseEnvFileContent('DQ="a\\nb"\n').DQ;
		expect(value).toBe("a\nb");
		expect(JSON.stringify(value)).toBe('"a\\nb"');
	});

	test("a backslash before bash stays a backslash", () => {
		const value = parseEnvFileContent('BS="a\\bash"\n').BS;
		expect(value).toBe("a\\bash");
		expect(JSON.stringify(value)).toBe('"a\\\\bash"');
		expect(parseEnvFileContent('TWO="a\\\\nb"\n').TWO).toBe("a\\\\nb");
	});

	test("single quotes do not unescape", () => {
		const value = parseEnvFileContent("SQ='a\\nb'\n").SQ;
		expect(value).toBe("a\\nb");
		expect(value?.split("")).toEqual(["a", "\\", "n", "b"]);
	});

	test("a physical newline inside double quotes is part of the value", () => {
		const value = parseEnvFileContent('ML="line1\nline2"\n').ML;
		expect(value).toBe("line1\nline2");
	});

	test("the suffix after a closing quote is discarded", () => {
		expect(parseEnvFileContent('SUF="v" ignored\n').SUF).toBe("v");
	});

	test("an escaped newline keeps its suffix discarded", () => {
		const value = parseEnvFileContent('TAIL="a\\nb" extra\n').TAIL;
		expect(value).toBe("a\nb");
		expect(JSON.stringify(value)).toBe('"a\\nb"');
	});

	test("double quotes unescape only \\n and \\r", () => {
		expect(parseEnvFileContent('CR="a\\rb"\n').CR).toBe("a\rb");
		expect(parseEnvFileContent('BK="a\\b"\n').BK).toBe("a\\b");
		expect(parseEnvFileContent('EQ="a\\"b"\n').EQ).toBe('a\\"b');
	});

	test("stores a newline planted in GJC_CODING_AGENT_DIR instead of dropping the key", () => {
		const parsed = parseEnvFileContent('GJC_CODING_AGENT_DIR="/tmp/planted-agent\\n"\n');
		expect(Object.hasOwn(parsed, "GJC_CODING_AGENT_DIR")).toBe(true);
		expect(parsed.GJC_CODING_AGENT_DIR).toBe("/tmp/planted-agent\n");
		expect(parseEnvFileContent('GJC_CODING_AGENT_DIR="/tmp/planted\\agent"\n').GJC_CODING_AGENT_DIR).toBe(
			"/tmp/planted\\agent",
		);
	});

	test("keeps unquoted # comments and does not expand $ or backticks", () => {
		const parsed = parseEnvFileContent(
			["INLINE=value # note", "TIGHT=value#note", 'QUOTED="v # kept"', 'DYN="$KEEP"', "BT=`cmd`"].join("\n"),
		);
		expect(parsed.INLINE).toBe("value");
		expect(parsed.TIGHT).toBe("value");
		expect(parsed.QUOTED).toBe("v # kept");
		expect(parsed.DYN).toBe("$KEEP");
		expect(parsed.BT).toBe("`cmd`");

		const cwd = tempDir("gjc-env-quote-snap-");
		fs.writeFileSync(path.join(cwd, ".env"), 'A="$KEEP"\nB=`cmd`\nC="plain\\n"\n');
		const snapshot = projectEnvSnapshot(cwd);
		expect(snapshot.values.A).toBe("$KEEP");
		expect(snapshot.values.B).toBe("`cmd`");
		expect(snapshot.values.C).toBe("plain\n");
		expect(snapshot.dynamic.has("A")).toBe(true);
		expect(snapshot.dynamic.has("B")).toBe(true);
		expect(snapshot.dynamic.has("C")).toBe(false);
	});
});

const dirsSource = path.join(import.meta.dir, "../src/dirs.ts");

async function printedAgentDir(cwd: string, env: Record<string, string | undefined> = {}): Promise<string> {
	const script = path.join(cwd, "print-agent-dir.ts");
	await Bun.write(script, `import { getAgentDir } from ${JSON.stringify(dirsSource)};\nconsole.log(getAgentDir());\n`);
	const childEnv: Record<string, string | undefined> = { ...process.env, HOME: env.HOME, ...env };
	delete childEnv.GJC_CODING_AGENT_DIR;
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.GJC_CONFIG_DIR;
	delete childEnv.PI_CONFIG_DIR;
	if (env.GJC_CODING_AGENT_DIR !== undefined) childEnv.GJC_CODING_AGENT_DIR = env.GJC_CODING_AGENT_DIR;
	const proc = Bun.spawn([process.execPath, script], {
		cwd,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(stderr || stdout || `getAgentDir probe exited ${code}`);
	const printed = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (printed.length === 0) throw new Error(`getAgentDir probe printed nothing: ${stderr}`);
	return printed;
}

describe("getAgentDir quote provenance", () => {
	test("does not follow a double-quoted newline planted by the project .env", async () => {
		const cwd = tempDir("gjc-env-quote-nl-");
		const home = tempDir("gjc-env-quote-home-");
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-agent\\n"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir.includes("planted-agent")).toBe(false);
	});

	test("does not follow a planted value whose backslash is not an escape", async () => {
		const cwd = tempDir("gjc-env-quote-bs-");
		const home = tempDir("gjc-env-quote-home-");
		const planted = "/tmp/planted\\agent";
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted\\agent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir).not.toBe(planted);
		expect(agentDir).not.toBe(path.resolve(planted));
		expect(agentDir.includes("planted")).toBe(false);
	});

	test("does not follow a double-quoted agent dir split across physical lines", async () => {
		const cwd = tempDir("gjc-env-quote-ml-");
		const home = tempDir("gjc-env-quote-home-");
		const planted = "/tmp/planted-multiline\nagent";
		fs.writeFileSync(path.join(cwd, ".env"), 'GJC_CODING_AGENT_DIR="/tmp/planted-multiline\nagent"\n');
		const agentDir = await printedAgentDir(cwd, { HOME: home });
		expect(agentDir).not.toBe(planted);
		expect(agentDir).not.toBe(path.resolve(planted));
		expect(agentDir.includes("planted-multiline")).toBe(false);
	});

	test("still honors an operator agent dir when the project has no .env", async () => {
		const cwd = tempDir("gjc-env-quote-op-");
		const home = tempDir("gjc-env-quote-home-");
		const operatorDir = tempDir("gjc-env-quote-operator-");
		const agentDir = await printedAgentDir(cwd, { HOME: home, GJC_CODING_AGENT_DIR: operatorDir });
		expect(agentDir).toBe(operatorDir);
	});
});
