import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";

async function paintedLine(line: string): Promise<string> {
	const mod = await import("@gajae-code/coding-agent/modes/components/tool-execution");
	const sanitize = mod.sanitizePaintedToolLine as ((value: string) => string) | undefined;
	if (!sanitize) throw new Error("painted line filter is missing");
	return sanitize(line);
}

import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import { Text, type TUI } from "@gajae-code/tui";
import fc from "fast-check";

const SEED = 67821;
const uiStub = { requestRender() {} } as unknown as TUI;
const ERASE = "\u001b[2J";
const OSC_TITLE = "\u001b]0;prop\u0007";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

afterEach(() => {
	resetSettingsForTest();
});

function renderFind(files: string[], isPartial = false): string {
	const details = { fileCount: files.length, files };
	const component = new ToolExecutionComponent("find", { paths: ["notes/**"] }, {}, undefined, uiStub, process.cwd());
	component.updateResult({ content: [{ type: "text", text: files.join("\n") }], details }, isPartial);
	expect(details.files).toEqual(files);
	return component.render(120).join("\n");
}

function safePiece(): fc.Arbitrary<string> {
	return fc
		.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789._-[]".split("")), {
			minLength: 1,
			maxLength: 12,
		})
		.map(chars => chars.join(""));
}

describe("painted tool cards", () => {
	it("does not draw a raw erase sequence from a find path", () => {
		const attack = `notes/${ERASE}plan.ts`;
		for (const partial of [false, true]) {
			const raw = renderFind([attack], partial);
			expect(raw).not.toContain(ERASE);
			expect(raw).toContain("notes/plan.ts");
		}
	});

	it("still draws ordinary find paths, including a lookalike and a Windows path", () => {
		const lookalike = "notes/[2J] plan.ts";
		const windowsPath = "C:\\work\\plan.ts";
		const mixedCase = "Notes/Plan.TS";
		const raw = renderFind([lookalike, windowsPath, mixedCase, "notes/plan.ts "]);
		expect(raw).toContain(lookalike);
		expect(raw).toContain(windowsPath);
		expect(raw).toContain(mixedCase);
		expect(raw).toContain("notes/plan.ts");
	});

	it("strips a custom renderer card without using the text fallback", () => {
		const tool = {
			label: "Custom",
			renderResult() {
				return new Text(`alpha${ERASE}beta`, 0, 0);
			},
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom-card", {}, {}, tool, uiStub, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "fallback-marker" }], details: {} }, false);
		const raw = component.render(80).join("\n");
		expect(raw).toContain("alphabeta");
		expect(raw).not.toContain(ERASE);
		expect(raw).not.toContain("fallback-marker");
	});

	it("keeps the delete operation when one guarded path collides after control removal", () => {
		const deletePath = `notes/${ERASE}plan.ts`;
		const input = [
			"*** Begin Patch",
			`*** Delete File: ${deletePath}`,
			"*** Add File: notes/plan.ts",
			"+hello",
			"*** End Patch",
		].join("\n");
		for (const isPartial of [false, true]) {
			const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub, process.cwd());
			component.updateResult(
				{
					content: [{ type: "text", text: "refused" }],
					details: {
						perFileResults: [{ path: deletePath, diff: "", isError: true, errorText: "guard refused" }],
					},
					isError: true,
				},
				isPartial,
			);
			const raw = component.render(160).join("\n");
			const plain = Bun.stripANSI(raw);
			expect(plain).toContain("Delete");
			expect(plain).not.toContain("Create");
			expect(plain).toContain("guard refused");
			expect(raw).not.toContain(ERASE);
		}
	});
});

describe("sanitizePaintedToolLine", () => {
	it("preserves SGR color and file hyperlinks", async () => {
		const colored = "\u001b[31mnotes\u001b[39m";
		const link = "\u001b]8;id=0123abcd;file:///proj/notes.ts\u001b\\notes.ts\u001b]8;;\u001b\\";
		expect(await paintedLine(colored)).toBe(colored);
		expect(await paintedLine(link)).toBe(link);
		expect(await paintedLine(`a${ERASE}b`)).toBe("ab");
		expect(await paintedLine(`a${OSC_TITLE}b`)).toBe("ab");
		expect(await paintedLine("a\u0000b\tb")).toBe("ab\tb");
		const evil = "\u001b]8;;https://attacker.invalid/\u001b\\link\u001b]8;;\u001b\\";
		const cleaned = await paintedLine(evil);
		expect(cleaned).toContain("link");
		expect(cleaned).not.toContain("attacker.invalid");
	});

	it("property: painted line idempotence, fc.property seed 67821, numRuns 64", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ unit: "binary", maxLength: 48 }), async text => {
				const once = await paintedLine(text);
				expect(await paintedLine(once)).toBe(once);
				expect(once.length).toBeLessThanOrEqual(text.length);
				expect(once.includes("\u0000")).toBe(false);
				expect(once.includes(ERASE)).toBe(false);
				expect(once.includes("\u001b]0;")).toBe(false);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});

	it("property: ordinary find text stays visible, fc.property seed 67821, numRuns 64", () => {
		fc.assert(
			fc.property(safePiece(), text => {
				const raw = renderFind([`notes/${text}.ts`, `\t${text}`]);
				expect(raw).toContain(`notes/${text}.ts`);
				expect(raw).toContain(text);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});

	it("property: nested result controls, fc.property seed 67821, numRuns 64", () => {
		fc.assert(
			fc.property(
				safePiece(),
				fc.constantFrom(ERASE, "\u0000", "\u0007", OSC_TITLE),
				safePiece(),
				(left, ctrl, right) => {
					const label = `L${left}${ctrl}${right}R`;
					const visible = `L${left}${right}R`;
					const files = [`notes/${label}.ts`];
					const findRaw = renderFind(files);
					expect(findRaw).not.toContain(ctrl);
					expect(findRaw).toContain(`notes/${visible}.ts`);
					const details = {
						jobs: [
							{
								id: "job-1",
								type: "task" as const,
								status: "completed" as const,
								label,
								durationMs: 5,
								errorText: label,
							},
						],
					};
					const job = new ToolExecutionComponent("job", {}, {}, undefined, uiStub, process.cwd());
					job.updateResult({ content: [{ type: "text", text: "ignored" }], details }, false);
					const jobRaw = job.render(160).join("\n");
					expect(jobRaw).not.toContain(ctrl);
					expect(jobRaw).toContain(visible);
					expect(details.jobs[0]?.label).toBe(label);
					expect(details.jobs[0]?.errorText).toBe(label);
					expect(files[0]).toBe(`notes/${label}.ts`);
				},
			),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
