import { describe, expect, it } from "bun:test";
import {
	COMPOSER_SCENARIOS,
	L2_MIN_SCENARIO_COVERAGE,
	TOTAL_SCENARIO_COUNT,
} from "../bench/composer-scenarios";
import { buildEvidenceReport, scanTextForPublishSecrets } from "../bench/composer-evidence";
import type { TrialResult } from "../bench/composer-stability-v3";

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
});