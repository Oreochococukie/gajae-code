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

describe("composer-live-fixtures", () => {
	it("seeds bash-discipline workdir", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-live-"));
		await seedScenarioWorkdir(dir, "bash-discipline");
		const text = await fs.readFile(path.join(dir, "src", "secret.ts"), "utf8");
		expect(text).toContain("LIVE_SECRET");
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