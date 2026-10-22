import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { formatSessionDumpText } from "@gajae-code/coding-agent/session/session-dump-format";
import fc from "fast-check";

const openaiKey = ["sk", "FAKE12345678"].join("-");
const githubToken = ["ghp", "FAKE1234567890AB"].join("_");

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp,
		content,
	};
}

function dump(messages: AgentMessage[], systemPrompt?: readonly string[]): string {
	return formatSessionDumpText({
		messages,
		systemPrompt,
		model: null,
		thinkingLevel: null,
	});
}

describe("formatSessionDumpText credential scrub", () => {
	it("removes credential-shaped tokens from session dump text", () => {
		const dumped = dump(
			[
				{ role: "user", content: `please review ${githubToken}`, timestamp: 1 },
				assistant(
					[
						{ type: "thinking", thinking: `consider ${openaiKey}` },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { note: githubToken },
						},
					],
					2,
				),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: `file has ${openaiKey}` }],
					timestamp: 3,
				},
				{
					role: "bashExecution",
					command: "echo hi",
					output: githubToken,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 4,
				},
				{
					role: "pythonExecution",
					code: "print(1)",
					output: openaiKey,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 5,
				},
				{
					role: "fileMention",
					files: [{ path: "notes.txt", content: `token ${githubToken}` }],
					timestamp: 6,
				},
			] as AgentMessage[],
			[`system with ${openaiKey}`],
		);

		expect(dumped).not.toContain(openaiKey);
		expect(dumped).not.toContain(githubToken);
		expect(dumped).toContain("«redacted-api-key»");
		expect(dumped).toContain("«redacted-github-token»");
		expect(dumped).toContain("please review");
		expect(dumped).toContain("consider");
		expect(dumped).toContain("file has");
		expect(dumped).toContain("echo hi");
		expect(dumped).toContain("print(1)");
		expect(dumped).toContain("notes.txt");
		expect(dumped).toContain("system with");
	});

	it("keeps an ordinary sentence in the session dump", () => {
		const sentence = "The ordinary sentence remains.";
		const dumped = dump(
			[
				{ role: "user", content: sentence, timestamp: 1 },
				assistant([{ type: "text", text: "Answer about the build." }], 2),
				{
					role: "bashExecution",
					command: "echo hello",
					output: "hello",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 3,
				},
				{
					role: "fileMention",
					files: [{ path: "src/main.ts", content: "export const ready = true;" }],
					timestamp: 4,
				},
			] as AgentMessage[],
			["You are a coding assistant."],
		);

		expect(dumped).toContain(sentence);
		expect(dumped).toContain("Answer about the build.");
		expect(dumped).toContain("echo hello");
		expect(dumped).toContain("hello");
		expect(dumped).toContain("src/main.ts");
		expect(dumped).toContain("export const ready = true;");
		expect(dumped).toContain("You are a coding assistant.");
		expect(dumped).not.toContain("«redacted");
	});

	it("keeps an already scrubbed marker in the session dump", () => {
		const marker = "«redacted-api-key»";
		const dumped = dump([{ role: "user", content: `saw ${marker} earlier`, timestamp: 1 }] as AgentMessage[]);

		expect(dumped).toContain(marker);
		expect(dumped).toContain("saw");
		expect(dumped).toContain("earlier");
	});

	it("property: keeps ordinary prose in the session dump, seed 70413, 64 inputs", () => {
		const prose = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: 1, maxLength: 24 })
			.map(chars => chars.join(""));
		fc.assert(
			fc.property(prose, text => {
				const dumped = dump([{ role: "user", content: text, timestamp: 1 }] as AgentMessage[]);
				return dumped.includes(text) && !dumped.includes("«redacted");
			}),
			{ seed: 70413, numRuns: 64 },
		);
	});
});
