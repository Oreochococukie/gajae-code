import {
	COMPOSER_SCENARIOS_VERSION,
	DEFAULT_CODEX_BASELINE_MODEL,
	DEFAULT_COMPOSER_CANDIDATE_MODEL,
	L2_MIN_SCENARIO_COVERAGE,
	TOTAL_SCENARIO_COUNT,
	type ScenarioId,
} from "./composer-scenarios";
import type { P1Summary, TrialResult } from "./composer-stability-v3";
import { createP1Summary } from "./composer-stability-v3";

export type EvidenceReportMeta = {
	gjc_version?: string;
	git_sha?: string;
	capture_mode?: "print" | "tmux" | "hermes-mcp" | "trace-replay";
	composer_scenarios_version?: string;
	discipline_injection_verified?: boolean;
	trace_artifacts?: string[];
};

export type PerScenarioEvidence = {
	id: ScenarioId;
	candidate_failures: number;
	baseline_failures: number;
	failure_classes: string[];
};

export type EvidenceReport = {
	schemaVersion: 1;
	generatedAt: string;
	ladderMaxClaim: "L0" | "L1" | "L2" | "L2-H" | "L3" | "none";
	p1: P1Summary;
	l2Eligible: boolean;
	scenario_coverage: number;
	scenario_coverage_ratio: string;
	composer_harness_failure_rate: number;
	baseline_failure_rate: number;
	parityDelta: number;
	per_scenario: PerScenarioEvidence[];
	composer_scenarios_version: string;
	candidate_model: string;
	baseline_model: string;
	meta: EvidenceReportMeta;
	manifest_linter_ok: boolean;
	manifest_linter_findings: string[];
};

const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
	{ id: "authorization_header", pattern: /\bAuthorization\s*:\s*Bearer\s+/i },
	{ id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
	{ id: "openai_sk", pattern: /\bsk-[A-Za-z0-9]{20,}/ },
	{ id: "grok_env_value", pattern: /GROK_CLI_OAUTH_TOKEN\s*=\s*\S+/ },
	{ id: "home_path", pattern: /\/Users\/[^/\s]+/ },
	{ id: "tilde_home", pattern: /~\/\.[^\s'"]+/ },
];

export function scanTextForPublishSecrets(text: string): { ok: boolean; findings: string[] } {
	const findings: string[] = [];
	for (const { id, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) findings.push(id);
	}
	return { ok: findings.length === 0, findings };
}

export function countScenarioCoverage(trialResults: TrialResult[]): number {
	const candidateIds = new Set(
		trialResults.filter(r => r.modelRole === "candidate").map(r => r.scenarioId),
	);
	const baselineIds = new Set(
		trialResults.filter(r => r.modelRole === "baseline").map(r => r.scenarioId),
	);
	return Array.from(candidateIds).filter(id => baselineIds.has(id)).length;
}

export function buildPerScenarioEvidence(trialResults: TrialResult[]): PerScenarioEvidence[] {
	const byScenario = new Map<ScenarioId, PerScenarioEvidence>();
	for (const result of trialResults) {
		const existing = byScenario.get(result.scenarioId) ?? {
			id: result.scenarioId,
			candidate_failures: 0,
			baseline_failures: 0,
			failure_classes: [],
		};
		if (result.modelRole === "candidate" && result.status === "failed") {
			existing.candidate_failures += 1;
			for (const fc of result.failureClasses ?? []) {
				if (!existing.failure_classes.includes(fc)) existing.failure_classes.push(fc);
			}
		}
		if (result.modelRole === "baseline" && result.status === "failed") {
			existing.baseline_failures += 1;
			for (const fc of result.failureClasses ?? []) {
				if (!existing.failure_classes.includes(fc)) existing.failure_classes.push(fc);
			}
		}
		byScenario.set(result.scenarioId, existing);
	}
	return Array.from(byScenario.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveLadderMaxClaim(p1: P1Summary, l2Eligible: boolean): EvidenceReport["ladderMaxClaim"] {
	if (!p1.applicable) return "L1";
	if (l2Eligible && p1.passed && p1.parityDelta <= 0) return "L2";
	if (p1.passed) return "L1";
	return "none";
}

export function buildEvidenceReport(
	trialResults: TrialResult[],
	meta: EvidenceReportMeta = {},
	manifestText = "",
): EvidenceReport {
	const p1 = createP1Summary(trialResults);
	const coverage = countScenarioCoverage(trialResults);
	const l2Eligible = coverage >= L2_MIN_SCENARIO_COVERAGE && p1.applicable && p1.passed && p1.parityDelta <= 0;
	const candidateCount = trialResults.filter(r => r.modelRole === "candidate").length;
	const baselineCount = trialResults.filter(r => r.modelRole === "baseline").length;
	const candidateFailures = p1.candidateFailureCount;
	const baselineFailures = p1.baselineFailureCount;
	const linter = scanTextForPublishSecrets(manifestText);

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		ladderMaxClaim: resolveLadderMaxClaim(p1, l2Eligible),
		p1,
		l2Eligible,
		scenario_coverage: coverage,
		scenario_coverage_ratio: `${coverage}/${TOTAL_SCENARIO_COUNT}`,
		composer_harness_failure_rate: candidateCount > 0 ? candidateFailures / candidateCount : 0,
		baseline_failure_rate: baselineCount > 0 ? baselineFailures / baselineCount : 0,
		parityDelta: p1.parityDelta,
		per_scenario: buildPerScenarioEvidence(trialResults),
		composer_scenarios_version: meta.composer_scenarios_version ?? COMPOSER_SCENARIOS_VERSION,
		candidate_model: DEFAULT_COMPOSER_CANDIDATE_MODEL,
		baseline_model: DEFAULT_CODEX_BASELINE_MODEL,
		meta,
		manifest_linter_ok: linter.ok,
		manifest_linter_findings: linter.findings,
	};
}