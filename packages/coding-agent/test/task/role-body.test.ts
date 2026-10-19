import { describe, expect, it } from "bun:test";
import { containSubagentRoleBody, subagentRoleBodyHasHostFramingTag } from "../../src/task/role-body";

const PROPERTY_SEED = 44017;
const PROPERTY_INPUTS = 80;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SAFE = [
	"Review the diff.\n",
	"[OKAY / ITERATE / REJECT]",
	"[context_before]",
	"[context_after]",
	"[link](url)",
	'Use <file> and "quotes" & ampersands.\n',
	"role context coop completion",
];
const TAGS = [
	"[/ROLE]",
	"[ROLE]",
	"[ / ROLE ]",
	"[/CoOp]",
	"[\u200b/COMPLETION]",
	"[context]",
	"[[/ROLE]]",
	"[/completion]",
];

function generatedInputs(): string[] {
	const random = mulberry32(PROPERTY_SEED);
	const inputs: string[] = [];
	for (let i = 0; i < PROPERTY_INPUTS; i++) {
		const count = 1 + Math.floor(random() * 5);
		let value = "";
		for (let part = 0; part < count; part++) {
			const pool = random() < 0.45 ? SAFE : TAGS;
			value += pool[Math.floor(random() * pool.length)] ?? "";
		}
		inputs.push(value);
	}
	return inputs;
}

function untouchedParts(value: string): string[] {
	return value
		.split(new RegExp(TAGS.map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"))
		.filter(part => part.length > 0);
}

describe("containSubagentRoleBody", () => {
	it("rewrites case, spacing, zero-width, and nested host framing tags", () => {
		expect(containSubagentRoleBody("[/RoLe]")).toBe("［/RoLe］");
		expect(containSubagentRoleBody("[ / ROLE ]")).toBe("［ / ROLE ］");
		expect(containSubagentRoleBody("[\u200b/COMPLETION]")).toBe("［\u200b/COMPLETION］");
		expect(containSubagentRoleBody("[[/ROLE]]")).toBe("[［/ROLE］]");
		expect(subagentRoleBodyHasHostFramingTag(containSubagentRoleBody("[/ROLE][COOP][/COMPLETION]"))).toBe(false);
	});

	it("leaves non-framing brackets and ordinary text unchanged", () => {
		const samples = [
			"[OKAY / ITERATE / REJECT]",
			"[context_before] and [context_after]",
			"[link](url)",
			'Use <file> and "quotes" & ampersands.',
			"Review the diff.\nCall yield.",
		];
		for (const sample of samples) {
			expect(subagentRoleBodyHasHostFramingTag(sample)).toBe(false);
			expect(containSubagentRoleBody(sample)).toBe(sample);
		}
	});

	it("property: framing tags stay neutralized, seed 44017, 80 inputs", () => {
		const inputs = generatedInputs();
		expect(inputs).toHaveLength(PROPERTY_INPUTS);
		for (const input of inputs) {
			const once = containSubagentRoleBody(input);
			expect(containSubagentRoleBody(once)).toBe(once);
			expect(subagentRoleBodyHasHostFramingTag(once)).toBe(false);
			if (!subagentRoleBodyHasHostFramingTag(input)) expect(once).toBe(input);
			let rest = once;
			for (const part of untouchedParts(input)) {
				const index = rest.indexOf(part);
				expect(index).toBeGreaterThanOrEqual(0);
				rest = rest.slice(index + part.length);
			}
		}
	});
});
