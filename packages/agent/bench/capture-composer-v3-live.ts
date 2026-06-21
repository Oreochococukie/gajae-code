#!/usr/bin/env bun
/**
 * Plans or (with credentials) runs live Composer V3 matrix capture.
 * Default: --dry-run prints the matrix without API calls.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	COMPOSER_SCENARIOS,
	COMPOSER_SCENARIOS_VERSION,
	DEFAULT_CODEX_BASELINE_MODEL,
	DEFAULT_COMPOSER_CANDIDATE_MODEL,
	TOTAL_SCENARIO_COUNT,
} from "./composer-scenarios";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

type Role = "candidate" | "baseline";

function parseArgs(argv: string[]): {
	dryRun: boolean;
	k: number;
	out?: string;
	candidateModel: string;
	baselineModel: string;
} {
	let dryRun = true;
	let k = 1;
	let out: string | undefined;
	let candidateModel = DEFAULT_COMPOSER_CANDIDATE_MODEL;
	let baselineModel = DEFAULT_CODEX_BASELINE_MODEL;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--run") dryRun = false;
		if (arg === "--dry-run") dryRun = true;
		if (arg === "-k" || arg === "--k") k = Number(argv[++i] ?? "1");
		if (arg === "--out") out = argv[++i];
		if (arg === "--model") candidateModel = argv[++i] ?? candidateModel;
		if (arg === "--baseline-model") baselineModel = argv[++i] ?? baselineModel;
	}
	return { dryRun, k, out, candidateModel, baselineModel };
}

function hasGrokCreds(): boolean {
	return Boolean(process.env.GROK_CLI_OAUTH_TOKEN?.trim());
}

function hasBaselineCreds(): boolean {
	return Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_AUTH?.trim());
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const planned: Array<{
		scenarioId: string;
		role: Role;
		model: string;
		trial: number;
		userPrompt: string;
	}> = [];
	let trial = 0;
	for (const scenario of COMPOSER_SCENARIOS) {
		for (let t = 0; t < args.k; t++) {
			planned.push({
				scenarioId: scenario.id,
				role: "candidate",
				model: args.candidateModel,
				trial: trial++,
				userPrompt: scenario.userPrompt,
			});
			planned.push({
				scenarioId: scenario.id,
				role: "baseline",
				model: args.baselineModel,
				trial: trial++,
				userPrompt: scenario.userPrompt,
			});
		}
	}

	const payload = {
		schemaVersion: 1,
		composer_scenarios_version: COMPOSER_SCENARIOS_VERSION,
		scenario_count: TOTAL_SCENARIO_COUNT,
		planned_records: planned.length,
		k: args.k,
		dry_run: args.dryRun,
		credentials: {
			grok: hasGrokCreds(),
			baseline: hasBaselineCreds(),
		},
		repo_root: REPO_ROOT,
		planned,
	};

	if (args.dryRun) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	if (!hasGrokCreds() || !hasBaselineCreds()) {
		process.stderr.write(
			"capture-composer-v3-live: missing GROK_CLI_OAUTH_TOKEN and/or baseline credentials; use --dry-run or set env\n",
		);
		process.exit(2);
	}

	const outDir =
		args.out ??
		path.join(REPO_ROOT, ".gjc/ultragoal/artifacts", `composer-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	await fs.mkdir(path.join(outDir, "traces"), { recursive: true });
	const manifestPath = path.join(outDir, "provenance-manifest.json");
	await fs.writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				...payload,
				note: "Live execution driver stub: operator should run print-mode gjc per planned row and append trace JSONL; scorer: composer-evidence-report.ts",
				outDir,
			},
			null,
			2,
		)}\n`,
	);
	process.stdout.write(`${JSON.stringify({ ok: true, outDir, manifestPath, planned_records: planned.length }, null, 2)}\n`);
}

if (import.meta.main) {
	await main();
}