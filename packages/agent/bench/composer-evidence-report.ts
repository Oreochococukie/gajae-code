#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildEvidenceReport } from "./composer-evidence";
import { classifyTraceRecord, type TraceRecord } from "./composer-stability-v3";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

async function loadTraceFile(filePath: string): Promise<TraceRecord[]> {
	const raw = await fs.readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (Array.isArray(parsed)) return parsed as TraceRecord[];
	if (typeof parsed === "object" && parsed !== null && "records" in parsed) {
		return (parsed as { records: TraceRecord[] }).records;
	}
	return [parsed as TraceRecord];
}

async function main(): Promise<void> {
	const traceDirArg = process.argv.find((_, i, a) => a[i - 1] === "--trace-dir");
	const traceFileArg = process.argv.find((_, i, a) => a[i - 1] === "--trace-file");
	const outArg = process.argv.find((_, i, a) => a[i - 1] === "--out");

	const records: TraceRecord[] = [];
	if (traceFileArg) {
		records.push(...(await loadTraceFile(path.resolve(traceFileArg))));
	}
	if (traceDirArg) {
		const dir = path.resolve(traceDirArg);
		const entries = await fs.readdir(dir);
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			records.push(...(await loadTraceFile(path.join(dir, name))));
		}
	}

	const trials = records.map(record => {
		const classified = classifyTraceRecord(record);
		return {
			scenarioId: record.scenarioId,
			modelRole: record.modelRole,
			model: record.model,
			trial: record.trial,
			status: classified.status,
			failureClass: classified.failureClasses[0],
			failureClasses: classified.failureClasses,
			evidence: classified.evidence,
			tracePath: record.tracePath,
		};
	});

	const manifestPath = traceDirArg ? path.join(path.resolve(traceDirArg), "..", "provenance-manifest.json") : "";
	let manifestText = "";
	try {
		manifestText = await fs.readFile(manifestPath, "utf8");
	} catch {
		manifestText = "";
	}

	const report = buildEvidenceReport(trials, { capture_mode: "trace-replay" }, manifestText);
	const outPath = outArg ? path.resolve(outArg) : path.join(REPO_ROOT, "evidence-report.json");
	await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ ok: true, outPath, ladderMaxClaim: report.ladderMaxClaim, l2Eligible: report.l2Eligible }, null, 2)}\n`);
}

if (import.meta.main) {
	await main();
}