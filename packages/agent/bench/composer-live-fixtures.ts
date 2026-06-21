import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ScenarioId } from "./composer-scenarios";

/** Seed an isolated print-mode workdir for a V3 scenario (paths match composer-scenarios v1 prompts). */
export async function seedScenarioWorkdir(workdir: string, scenarioId: ScenarioId): Promise<void> {
	await fs.mkdir(workdir, { recursive: true });
	const ws = path.join(workdir, "fixtures", "workspace");
	const src = path.join(workdir, "src");
	const pkg = path.join(ws, "src", "pkg");
	const transcripts = path.join(workdir, "fixtures", "transcripts");

	switch (scenarioId) {
		case "bash-discipline":
			await write(path.join(src, "secret.ts"), "export const SECRET = 'LIVE_SECRET_7319';\n");
			break;
		case "read-edit-hashline":
			await write(path.join(src, "foo.ts"), "export const greeting = 'hello-old';\n");
			break;
		case "three-turn-tools":
			await write(path.join(src, "a.ts"), "export const TARGET_MARKER = 'pending';\n");
			await write(path.join(src, "b.ts"), "// secondary\n");
			break;
		case "file-discovery-discipline":
			await write(path.join(ws, "src", "one.ts"), "export const x = 1;\n");
			await write(path.join(ws, "src", "two.ts"), "export const y = 2;\n");
			break;
		case "shell-write-discipline":
			await write(path.join(ws, "src", "write-target.ts"), "export const VALUE = 0;\n");
			break;
		case "command-contamination":
			await mkdir(transcripts, "command-contamination");
			await write(path.join(transcripts, "command-contamination", "sample.json"), "{}\n");
			break;
		case "grok-sanitize-replay":
			await mkdir(transcripts, "grok-sanitize-replay");
			await write(path.join(transcripts, "grok-sanitize-replay", "sample.json"), "{}\n");
			break;
		case "multi-file-search-edit":
		case "multi-file-search-edit-bad-anchor":
			await write(path.join(pkg, "alpha.ts"), "export const pkg_marker_alpha = 'pkg-marker-alpha';\n");
			await write(path.join(pkg, "beta.ts"), "export const other = 1;\n");
			break;
		case "bad-anchor-recovery":
			await write(path.join(ws, "src", "target.ts"), "export const STATUS = 'pending';\n");
			break;
		case "tool-json-malformed-recovery":
			await mkdir(transcripts, "tool-json-malformed-recovery");
			await write(path.join(transcripts, "tool-json-malformed-recovery", "sample.json"), "{}\n");
			await write(path.join(ws, "src", "foo.ts"), "export const ok = true;\n");
			break;
		case "multi-turn-yield-discipline":
			await write(path.join(ws, "src", "multi.ts"), "export const MULTI_TURN = 'base';\n");
			break;
		case "timeout-handling":
			await mkdir(transcripts, "timeout");
			await write(path.join(transcripts, "timeout", "sample.json"), "{}\n");
			break;
		default:
			break;
	}
}

async function write(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

async function mkdir(dir: string, sub?: string): Promise<void> {
	await fs.mkdir(sub ? path.join(dir, sub) : dir, { recursive: true });
}