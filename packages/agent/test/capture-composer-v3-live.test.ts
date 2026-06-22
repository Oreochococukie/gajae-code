import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { seedScenarioWorkdir } from "../bench/composer-live-fixtures";
import {
	buildTraceRecord,
	sessionLinesToTraceEvents,
	traceExpectationForScenario,
} from "../bench/composer-print-trace";
import { classifyTraceRecord } from "../bench/composer-stability-v3";
import "../bench/capture-composer-v3-live";

describe("composer-live-fixtures", () => {
	it("seeds bash-discipline workdir", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-live-"));
		await seedScenarioWorkdir(dir, "bash-discipline");
		const text = await fs.readFile(path.join(dir, "src", "secret.ts"), "utf8");
		expect(text).toContain("LIVE_SECRET");
	});

	it("seeds composer-scenarios-v2 workdirs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-live-v2-"));
		await seedScenarioWorkdir(dir, "wrong-target-disambiguation");
		await seedScenarioWorkdir(dir, "cost-safe-timeout");
		const target = await fs.readFile(
			path.join(dir, "fixtures", "workspace", "src", "disambiguation", "target.ts"),
			"utf8",
		);
		const timeoutFixture = await fs.readFile(
			path.join(dir, "fixtures", "transcripts", "cost-safe-timeout", "sample.json"),
			"utf8",
		);
		expect(target).toContain("EXACT_TARGET");
		expect(timeoutFixture.trim()).toBe("{}");
	});
});

describe("capture-composer-v3-live dry-run", () => {
	it("prints L3 planning metadata without running live sessions", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"packages/agent/bench/capture-composer-v3-live.ts",
				"--dry-run",
				"--k",
				"3",
				"--scenarios",
				"bash-discipline",
				"--model",
				"grok-build/grok-composer-2.5-fast",
				"--baseline-model",
				"openai-codex/gpt-5.5:low",
			],
			{ cwd: path.resolve(import.meta.dir, "../../..") },
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(0);
		expect(stderr).toBe("");

		const payload = JSON.parse(stdout) as {
			composer_scenarios_version: string;
			capture_mode: string;
			k: number;
			planned_records: number;
			candidate_model: string;
			baseline_model: string;
		};
		expect(payload.composer_scenarios_version).toBe("v2");
		expect(payload.capture_mode).toBe("print");
		expect(payload.k).toBe(3);
		expect(payload.planned_records).toBe(6);
		expect(payload.candidate_model).toBe("grok-build/grok-composer-2.5-fast");
		expect(payload.baseline_model).toBe("openai-codex/gpt-5.5:low");
	});
});

describe("composer-print-trace", () => {
	it("converts session toolResult to tool_execution_end", () => {
		const lines = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "src/secret.ts" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "ok\n" }],
				},
			},
		];
		const events = sessionLinesToTraceEvents(lines as never, 0);
		expect(events.some(e => e.type === "tool_execution_end" && e.toolName === "read")).toBe(true);
		expect(events.at(-1)).toEqual({ type: "scenario_result", status: "passed" });
	});

	it("classifies converted bash-discipline trace as pass", () => {
		const record = buildTraceRecord({
			scenarioId: "bash-discipline",
			modelRole: "candidate",
			model: "grok-build/grok-composer-2.5-fast",
			trial: 0,
			events: [
				{ type: "tool_execution_end", toolName: "read", status: "success" },
				{ type: "scenario_result", status: "passed" },
			],
			tracePath: "/tmp/trace.json",
			expected: traceExpectationForScenario("bash-discipline"),
		});
		const classified = classifyTraceRecord(record);
		expect(classified.status).toBe("passed");
	});
});
