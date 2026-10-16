/**
 * Debug launch and attach go through the session approval gate and the
 * planning mutation guard. Read-only debug actions stay ungated.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { ClientBridge, ClientBridgePermissionOutcome } from "@gajae-code/coding-agent/session/client-bridge";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

let tempDir: TempDir;
let session: AgentSession | undefined;

function makeDebugTool(): AgentTool & { executeCalls: number } {
	const tool = {
		name: "debug",
		label: "Debug",
		description: "debug",
		parameters: z.object({
			action: z.string().optional(),
			program: z.string().optional(),
		}),
		executeCalls: 0,
		async execute() {
			tool.executeCalls++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeBridge(outcome: ClientBridgePermissionOutcome): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission() {
			return outcome;
		},
	};
}

async function createSession(
	tool: AgentTool,
	bridge?: ClientBridge,
	permissionMode: "allow" | "prompt" | "deny" = "prompt",
): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [tool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body() } as never,
		toolRegistry: new Map([[tool.name, tool]]),
	});
	sess.setSdkPermissionMode(permissionMode);
	if (bridge) sess.setClientBridge(bridge);
	return sess;
}

async function wrappedDebug(sess: AgentSession): Promise<AgentTool> {
	await sess.setActiveToolsByName(["debug"]);
	const wrapped = sess.agent.state.tools.find(tool => tool.name === "debug");
	if (!wrapped) throw new Error("debug tool was not installed");
	return wrapped;
}

/** Same durable planning posture the mutation guard already honors. */
async function writeActiveDeepInterview(cwd: string, sessionId: string): Promise<void> {
	const now = new Date().toISOString();
	const sessionDir = sessionStateDir(cwd, sessionId);
	await fs.mkdir(sessionDir, { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill: "deep-interview",
		phase: "interviewing",
		updated_at: now,
		active_skills: [
			{
				skill: "deep-interview",
				phase: "interviewing",
				active: true,
				updated_at: now,
				session_id: sessionId,
			},
		],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, "deep-interview"),
		`${JSON.stringify({ active: true, current_phase: "interviewing", session_id: sessionId }, null, 2)}\n`,
	);
}

beforeEach(() => {
	tempDir = TempDir.createSync("@debug-launch-approval-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	await tempDir.remove();
});

it("rejects an unapproved debug launch before the program starts", async () => {
	const debugTool = makeDebugTool();
	session = await createSession(debugTool, undefined, "prompt");
	const wrapped = await wrappedDebug(session);

	await expect(
		wrapped.execute(
			"call-debug-launch",
			{ action: "launch", program: "payload.py" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/no permission provider is connected \(debug\)/);
	expect(debugTool.executeCalls).toBe(0);
});

it("rejects an unapproved debug attach before the program starts", async () => {
	const debugTool = makeDebugTool();
	session = await createSession(debugTool, undefined, "prompt");
	const wrapped = await wrappedDebug(session);

	await expect(
		wrapped.execute(
			"call-debug-attach",
			{ action: "attach", pid: 1 },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/no permission provider is connected \(debug\)/);
	expect(debugTool.executeCalls).toBe(0);
});

it("still allows a debug sessions read without an approval prompt", async () => {
	const debugTool = makeDebugTool();
	session = await createSession(debugTool, undefined, "prompt");
	const wrapped = await wrappedDebug(session);

	await wrapped.execute(
		"call-debug-sessions",
		{ action: "sessions" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(debugTool.executeCalls).toBe(1);
});

it("still allows debug launch when the session permission mode is allow", async () => {
	const debugTool = makeDebugTool();
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession(debugTool, bridge, "allow");
	const wrapped = await wrappedDebug(session);

	await wrapped.execute(
		"call-debug-allow",
		{ action: "launch", program: "payload.py" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(debugTool.executeCalls).toBe(1);
});

it("blocks debug launch while a planning workflow is active", async () => {
	const debugTool = makeDebugTool();
	session = await createSession(debugTool, undefined, "allow");
	await writeActiveDeepInterview(tempDir.path(), session.sessionManager.getSessionId());
	const wrapped = await wrappedDebug(session);

	await expect(
		wrapped.execute(
			"call-debug-planning",
			{ action: "launch", program: "payload.py" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/Deep-interview phase boundary/);
	expect(debugTool.executeCalls).toBe(0);
});

it("still allows a debug sessions read while a planning workflow is active", async () => {
	const debugTool = makeDebugTool();
	session = await createSession(debugTool, undefined, "prompt");
	await writeActiveDeepInterview(tempDir.path(), session.sessionManager.getSessionId());
	const wrapped = await wrappedDebug(session);

	await wrapped.execute(
		"call-debug-planning-read",
		{ action: "sessions" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(debugTool.executeCalls).toBe(1);
});
