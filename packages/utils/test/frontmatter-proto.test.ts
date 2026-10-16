import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "@gajae-code/utils";

const marker = "frontmatterProtoMarker";
const protoKey = "__proto__";

function own(record: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function reportPass(name: string): void {
	console.log(`(pass) ${name}`);
}

describe("parseFrontmatter prototype keys", () => {
	test("stores a __proto__ payload as data when that payload contains a kebab-case key", () => {
		const parsed = parseFrontmatter(
			`---
__proto__:
  thinking-level: low
  ${marker}: pwned
name: doc
---
body
`,
			{ level: "off" },
		);
		const frontmatter = parsed.frontmatter;
		expect(Object.hasOwn(frontmatter, protoKey)).toBe(true);
		expect(frontmatter.thinkingLevel).toBeUndefined();
		expect(frontmatter[marker]).toBeUndefined();
		expect(frontmatter.name).toBe("doc");
		const payload = own(frontmatter, protoKey) as Record<string, unknown>;
		expect(payload.thinkingLevel).toBe("low");
		expect(payload[marker]).toBe("pwned");
		expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
		expect(String(frontmatter)).toBe("[object Object]");
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		expect(parsed.body).toBe("body");
		reportPass("stores a __proto__ payload as data when that payload contains a kebab-case key");
	});

	test("stores a nested __proto__ payload as data when that payload contains a kebab-case key", () => {
		const parsed = parseFrontmatter(
			`---
meta:
  __proto__:
    inner-key: v
    ${marker}: nested
title: doc
---
body
`,
			{ level: "off" },
		);
		const meta = parsed.frontmatter.meta as Record<string, unknown>;
		expect(Object.hasOwn(meta, protoKey)).toBe(true);
		expect(meta.innerKey).toBeUndefined();
		expect(meta[marker]).toBeUndefined();
		const payload = own(meta, protoKey) as Record<string, unknown>;
		expect(payload.innerKey).toBe("v");
		expect(payload[marker]).toBe("nested");
		expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
		expect(String(meta)).toBe("[object Object]");
		expect(parsed.frontmatter.title).toBe("doc");
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		reportPass("stores a nested __proto__ payload as data when that payload contains a kebab-case key");
	});

	test("keeps ordinary kebab-case frontmatter keys", () => {
		const parsed = parseFrontmatter(
			`---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content
`,
			{ level: "off" },
		);
		expect(parsed.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(String(parsed.frontmatter)).toBe("[object Object]");
		expect(String(parsed.frontmatter.nestedField)).toBe("[object Object]");
		expect(parsed.body).toBe("Body content");
		reportPass("keeps ordinary kebab-case frontmatter keys");
	});

	test("keeps string conversion of an object frontmatter value", () => {
		const parsed = parseFrontmatter(
			`---
description:
  display-name: example
---
Prompt body
`,
			{ level: "off" },
		);
		const description = parsed.frontmatter.description as Record<string, unknown>;
		expect(description.displayName).toBe("example");
		expect(String(description)).toBe("[object Object]");
		expect(String(parsed.frontmatter)).toBe("[object Object]");
		reportPass("keeps string conversion of an object frontmatter value");
	});

	test("keeps an own __proto__ key when no frontmatter key is rewritten", () => {
		const parsed = parseFrontmatter(
			`---
__proto__:
  ${marker}: plain
name: doc
---
body
`,
			{ level: "off" },
		);
		expect(Object.hasOwn(parsed.frontmatter, protoKey)).toBe(true);
		expect(parsed.frontmatter[marker]).toBeUndefined();
		expect(parsed.frontmatter.name).toBe("doc");
		const payload = own(parsed.frontmatter, protoKey) as Record<string, unknown>;
		expect(payload[marker]).toBe("plain");
		expect(Object.hasOwn(Object.prototype, marker)).toBe(false);
		reportPass("keeps an own __proto__ key when no frontmatter key is rewritten");
	});
});
