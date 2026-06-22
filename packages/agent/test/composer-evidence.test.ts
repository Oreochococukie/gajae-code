import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildEvidenceReport, scanTextForPublishSecrets } from "../bench/composer-evidence";
import { COMPOSER_SCENARIOS, L2_MIN_SCENARIO_COVERAGE, TOTAL_SCENARIO_COUNT } from "../bench/composer-scenarios";
import type { TraceRecord, TrialResult } from "../bench/composer-stability-v3";
import "../bench/composer-evidence-ab-compare";

describe("composer-scenarios SoT", () => {
	it("exports 13 scenarios with userPrompt", () => {
		expect(COMPOSER_SCENARIOS).toHaveLength(TOTAL_SCENARIO_COUNT);
		for (const s of COMPOSER_SCENARIOS) {
			expect(s.userPrompt.length).toBeGreaterThan(20);
		}
	});
});

describe("composer-evidence report", () => {
	it("l2Eligible false below L2_MIN coverage", () => {
		const trials: TrialResult[] = [
			{
				scenarioId: "bash-discipline",
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: 0,
				status: "passed",
				evidence: "ok",
			},
			{
				scenarioId: "bash-discipline",
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: 1,
				status: "passed",
				evidence: "ok",
			},
		];
		const report = buildEvidenceReport(trials);
		expect(report.scenario_coverage).toBe(1);
		expect(L2_MIN_SCENARIO_COVERAGE).toBe(10);
		expect(report.l2Eligible).toBe(false);
		expect(report.ladderMaxClaim).not.toBe("L2");
	});

	it("manifest linter rejects home paths", () => {
		const r = scanTextForPublishSecrets('{"path":"/Users/mac/secret"}');
		expect(r.ok).toBe(false);
		expect(r.findings).toContain("home_path");
	});

	it("A/B compare keeps arm labels out of capture_mode metadata", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-ab-compare-"));
		const armA = path.join(tempDir, "arm-a.json");
		const armB = path.join(tempDir, "arm-b.json");
		const outPath = path.join(tempDir, "ab-report.json");
		const records = (candidateEvents: TraceRecord["events"]): TraceRecord[] => [
			{
				scenarioId: "bash-discipline",
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: 0,
				events: candidateEvents,
				expected: {},
			},
			{
				scenarioId: "bash-discipline",
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: 0,
				events: [],
				expected: {},
			},
		];

		await fs.writeFile(
			armA,
			JSON.stringify(
				records([
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "cat src/secret.ts" },
					},
				]),
			),
		);
		await fs.writeFile(armB, JSON.stringify(records([])));

		const proc = Bun.spawn(
			[
				process.execPath,
				"packages/agent/bench/composer-evidence-ab-compare.ts",
				"--arm-a",
				armA,
				"--arm-a-version",
				"0.5.3",
				"--arm-b",
				armB,
				"--arm-b-version",
				"0.6.4",
				"--out",
				outPath,
			],
			{ cwd: path.resolve(import.meta.dir, "../../..") },
		);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(0);
		expect(stderr).toBe("");

		const payloadText = await fs.readFile(outPath, "utf8");
		const payload = JSON.parse(payloadText) as {
			comparison: { candidate_failure_count_delta_a_minus_b: number };
		};
		expect(payload.comparison.candidate_failure_count_delta_a_minus_b).toBe(1);
		expect(payloadText).not.toContain("ab-arm-a");
		expect(payloadText).not.toContain("ab-arm-b");
	});
});
