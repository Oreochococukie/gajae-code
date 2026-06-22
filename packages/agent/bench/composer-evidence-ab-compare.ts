#!/usr/bin/env bun
/**
 * Compare two scored trace corpora (e.g. gjc v0.5.3 vs v0.6.4 live captures).
 * Point estimate only — not a statistical hypothesis test.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildEvidenceReport, type EvidenceReport } from "./composer-evidence";
import { classifyTraceRecord, type TraceRecord } from "./composer-stability-v3";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

async function loadRecords(filePath: string): Promise<TraceRecord[]> {
	const raw = await fs.readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (Array.isArray(parsed)) return parsed as TraceRecord[];
	if (typeof parsed === "object" && parsed !== null && "records" in parsed) {
		return (parsed as { records: TraceRecord[] }).records;
	}
	return [parsed as TraceRecord];
}

function trialsFromRecords(records: TraceRecord[]) {
	return records.map(record => {
		const c = classifyTraceRecord(record);
		return {
			scenarioId: record.scenarioId,
			modelRole: record.modelRole,
			model: record.model,
			trial: record.trial,
			status: c.status,
			failureClass: c.failureClasses[0],
			failureClasses: c.failureClasses,
			evidence: c.evidence,
			tracePath: record.tracePath,
		};
	});
}

function scenarioFailureMap(report: EvidenceReport): Map<string, { candidate: number; baseline: number; classes: string[] }> {
	return new Map(
		report.per_scenario.map(row => [
			row.id,
			{
				candidate: row.candidate_failures,
				baseline: row.baseline_failures,
				classes: row.failure_classes,
			},
		]),
	);
}

function perScenarioDelta(aReport: EvidenceReport, bReport: EvidenceReport) {
	const a = scenarioFailureMap(aReport);
	const b = scenarioFailureMap(bReport);
	const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
	return ids.map(id => {
		const aRow = a.get(id) ?? { candidate: 0, baseline: 0, classes: [] };
		const bRow = b.get(id) ?? { candidate: 0, baseline: 0, classes: [] };
		return {
			id,
			candidate_failure_delta_a_minus_b: aRow.candidate - bRow.candidate,
			baseline_failure_delta_a_minus_b: aRow.baseline - bRow.baseline,
			arm_a_failure_classes: aRow.classes,
			arm_b_failure_classes: bRow.classes,
		};
	});
}

function armSummary(label: string, gjcVersion: string, report: EvidenceReport) {
	return {
		label,
		gjc_version: gjcVersion,
		candidate_failure_count: report.p1.candidateFailureCount,
		baseline_failure_count: report.p1.baselineFailureCount,
		parity_delta: report.p1.parityDelta,
		scenario_coverage: report.scenario_coverage,
		scenario_coverage_ratio: report.scenario_coverage_ratio,
		l2_eligible: report.l2Eligible,
		ladder_max_claim: report.ladderMaxClaim,
		p1_passed: report.p1.passed,
	};
}

async function main(): Promise<void> {
	const aArg = process.argv.find((_, i, a) => a[i - 1] === "--arm-a");
	const bArg = process.argv.find((_, i, a) => a[i - 1] === "--arm-b");
	const aVer = process.argv.find((_, i, a) => a[i - 1] === "--arm-a-version") ?? "unknown";
	const bVer = process.argv.find((_, i, a) => a[i - 1] === "--arm-b-version") ?? "unknown";
	const outArg = process.argv.find((_, i, a) => a[i - 1] === "--out");

	if (!aArg || !bArg) {
		process.stderr.write(
			"usage: composer-evidence-ab-compare.ts --arm-a <trace.json> --arm-a-version 0.5.3 --arm-b <trace.json> --arm-b-version 0.6.4 [--out report.json]\n",
		);
		process.exit(1);
	}

	const aRecords = await loadRecords(path.resolve(aArg));
	const bRecords = await loadRecords(path.resolve(bArg));
	const aReport = buildEvidenceReport(trialsFromRecords(aRecords), {
		capture_mode: "trace-replay",
		gjc_version: aVer,
	});
	const bReport = buildEvidenceReport(trialsFromRecords(bRecords), {
		capture_mode: "trace-replay",
		gjc_version: bVer,
	});

	const candidateDelta = aReport.p1.candidateFailureCount - bReport.p1.candidateFailureCount;
	const baselineDelta = aReport.p1.baselineFailureCount - bReport.p1.baselineFailureCount;
	const parityDeltaChange = aReport.p1.parityDelta - bReport.p1.parityDelta;

	const payload = {
		schemaVersion: 1,
		disclaimer:
			"Point estimate from paired harness failure counts on frozen trace corpora. Not a statistical hypothesis test. Live A/B requires separate captures with each gjc binary on the same composer-scenarios-v1 prompts.",
		repo_commit: process.env.EVIDENCE_REPO_COMMIT ?? "dev-evidence",
		arm_a: armSummary("v0.5.3-or-baseline-arm", aVer, aReport),
		arm_b: armSummary("v0.6.4-or-candidate-arm", bVer, bReport),
		comparison: {
			candidate_failure_count_delta_a_minus_b: candidateDelta,
			baseline_failure_count_delta_a_minus_b: baselineDelta,
			parity_delta_change_a_minus_b: parityDeltaChange,
			interpretation:
				candidateDelta > 0
					? "Arm B (typically 0.6.4) shows fewer candidate failures than arm A by count delta."
					: candidateDelta < 0
						? "Arm A shows fewer candidate failures than arm B."
						: "Candidate failure counts tie on this corpus.",
		},
		per_scenario_delta: perScenarioDelta(aReport, bReport),
		per_scenario_a: aReport.per_scenario,
		per_scenario_b: bReport.per_scenario,
	};

	const outPath = outArg ? path.resolve(outArg) : path.join(REPO_ROOT, "evidence-ab-compare.json");
	await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ ok: true, outPath, comparison: payload.comparison }, null, 2)}\n`);
}

if (import.meta.main) {
	await main();
}