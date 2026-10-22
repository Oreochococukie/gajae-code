import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { PlanModeController } from "../../../src/modes/controllers/plan-mode-controller";
import type { AgentSession } from "../../../src/session/agent-session";
import type { SessionManager } from "../../../src/session/session-manager";

const envKeys = ["EDITOR", "VISUAL", "PLAN_EDITOR_BODY", "PLAN_EDITOR_MARKER"] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map(key => [key, Bun.env[key]]));

afterEach(() => {
	for (const key of envKeys) {
		const value = savedEnv.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

function controllerFor(root: string, warnings: string[], cwd = root, editorCommand?: string) {
	const seen = { preview: null as string | null, edited: null as string | null };
	const sessionManager = {
		getArtifactsDir: () => path.join(root, "artifacts"),
		isManagedDestination: () => false,
		getSessionId: () => "plan-editor-workspace",
		getCwd: () => cwd,
	} as SessionManager;
	const controller = new PlanModeController({
		session: { abort: async () => {} } as AgentSession,
		sessionManager,
		modeGate: undefined as never,
		chatContainer: undefined as never,
		inputCallback: undefined,
		externalEditorKey: "ctrl+g",
		externalEditorKeys: ["ctrl+g"],
		startPendingSubmission: () => {
			throw new Error("unused");
		},
		addChatChild: () => {},
		requestRender: () => {},
		stopUi: () => {},
		startUi: () => {},
		showStatus: () => {},
		showWarning: message => warnings.push(message),
		showError: message => warnings.push(message),
		showHookConfirm: async () => false,
		showPlanPreview: async (content, options) => {
			seen.preview = content;
			seen.edited = (await options?.onExternalEditor?.()) ?? null;
			return { comments: [], notes: "", snapshotHash: "unused" };
		},
		flushCompactionQueue: async () => {},
		updatePlanModeStatus: () => {},
		handleClearCommand: async () => false,
		handleCompactCommand: async () => "cancelled",
		updateEditorChrome: () => {},
		getEditorCommand: editorCommand ? () => editorCommand : undefined,
	});
	controller.setEnabledForCompatibility(true);
	return { controller, seen };
}

const runtimeEditor = `
import { writeFileSync } from "node:fs";
const target = process.argv.at(-1);
const marker = process.env.PLAN_EDITOR_MARKER;
if (!target || !marker) process.exit(2);
writeFileSync(target, process.env.PLAN_EDITOR_BODY ?? "");
writeFileSync(marker, "ran");
`;

async function installEditor(dir: string, body: string, marker: string): Promise<string> {
	const script = path.join(dir, "edit-plan.mjs");
	await fs.writeFile(script, runtimeEditor);
	// A runtime script runs on Windows. A POSIX shell fixture does not.
	let command = `${process.execPath} ${script}`;
	if (process.platform === "win32" && (process.execPath.includes(" ") || script.includes(" "))) {
		const launcher = path.join(dir, "edit-plan.cmd");
		await fs.writeFile(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
		command = launcher;
	}
	Bun.env.EDITOR = command;
	Bun.env.VISUAL = command;
	Bun.env.PLAN_EDITOR_BODY = body;
	Bun.env.PLAN_EDITOR_MARKER = marker;
	return command;
}

async function approve(root: string, planFilePath: string, body: string) {
	const marker = path.join(root, "editor-ran");
	const warnings: string[] = [];
	const command = await installEditor(root, body, marker);
	const { controller, seen } = controllerFor(root, warnings, root, command);
	await controller.handleApproval({
		planFilePath,
		finalPlanFilePath: planFilePath,
		title: "Plan",
		planExists: true,
	});
	const editorRan = await fs
		.access(marker)
		.then(() => true)
		.catch(() => false);
	return { seen, warnings, editorRan };
}

describe("plan editor workspace root", () => {
	it("still allows a relative plan file inside the session directory", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
		const root = path.join(parent, "workspace");
		const planPath = path.join(root, "PLAN.md");
		try {
			await fs.mkdir(root, { recursive: true });
			await fs.writeFile(planPath, "original plan\n");
			const { seen, editorRan } = await approve(root, "PLAN.md", "updated plan\n");
			expect(editorRan).toBe(true);
			expect(seen.preview).toBe("original plan\n");
			expect(seen.edited).toBe("updated plan\n");
			expect(await fs.readFile(planPath, "utf8")).toBe("updated plan\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it("still allows an absolute plan path inside the session directory", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
		const root = path.join(parent, "workspace");
		const planPath = path.join(root, "PLAN.md");
		try {
			await fs.mkdir(root, { recursive: true });
			await fs.writeFile(planPath, "original plan\n");
			const { seen, editorRan } = await approve(root, planPath, "updated plan\n");
			expect(editorRan).toBe(true);
			expect(seen.preview).toBe("original plan\n");
			expect(await fs.readFile(planPath, "utf8")).toBe("updated plan\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"still allows a symlink whose target stays inside the session directory",
		async () => {
			const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
			const root = path.join(parent, "workspace");
			const target = path.join(root, "target.md");
			const link = path.join(root, "link.md");
			try {
				await fs.mkdir(root, { recursive: true });
				await fs.writeFile(target, "original plan\n");
				await fs.symlink(target, link);
				const { seen, editorRan } = await approve(root, "link.md", "updated plan\n");
				expect(editorRan).toBe(true);
				expect(seen.preview).toBe("original plan\n");
				expect(await fs.readFile(target, "utf8")).toBe("updated plan\n");
				expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			} finally {
				await fs.rm(parent, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")("still allows a plan file when the session directory is /", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
		const planPath = path.join(parent, "PLAN.md");
		try {
			await fs.writeFile(planPath, "original plan\n");
			const marker = path.join(parent, "editor-ran");
			const warnings: string[] = [];
			const command = await installEditor(parent, "updated plan\n", marker);
			const { controller, seen } = controllerFor(parent, warnings, "/", command);
			await controller.handleApproval({
				planFilePath: planPath,
				finalPlanFilePath: planPath,
				title: "Plan",
				planExists: true,
			});
			expect(seen.preview).toBe("original plan\n");
			expect(seen.edited).toBe("updated plan\n");
			expect(await fs.readFile(planPath, "utf8")).toBe("updated plan\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "win32")(
		"still allows a plan file when the session directory is the drive root",
		async () => {
			const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
			const planPath = path.join(parent, "PLAN.md");
			const drive = path.parse(parent).root;
			try {
				await fs.writeFile(planPath, "original plan\n");
				const marker = path.join(parent, "editor-ran");
				const warnings: string[] = [];
				const command = await installEditor(parent, "updated plan\n", marker);
				const { controller, seen } = controllerFor(parent, warnings, drive, command);
				await controller.handleApproval({
					planFilePath: planPath,
					finalPlanFilePath: planPath,
					title: "Plan",
					planExists: true,
				});
				expect(seen.preview).toBe("original plan\n");
				expect(seen.edited).toBe("updated plan\n");
				expect(await fs.readFile(planPath, "utf8")).toBe("updated plan\n");
			} finally {
				await fs.rm(parent, { recursive: true, force: true });
			}
		},
	);

	it("does not read or write a plan path that leaves the session directory with ..", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
		const root = path.join(parent, "workspace");
		const outside = path.join(parent, "outside.md");
		try {
			await fs.mkdir(root, { recursive: true });
			await fs.writeFile(outside, "secret\n");
			const { seen, warnings, editorRan } = await approve(root, "../outside.md", "pwned\n");
			expect(editorRan).toBe(false);
			expect(seen.preview).toBeNull();
			expect(seen.edited).toBeNull();
			expect(await fs.readFile(outside, "utf8")).toBe("secret\n");
			expect(warnings.some(message => message.includes("outside trust boundary"))).toBe(true);
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it("does not read or write an absolute plan path outside the session directory", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
		const root = path.join(parent, "workspace");
		const outside = path.join(parent, "outside.md");
		try {
			await fs.mkdir(root, { recursive: true });
			await fs.writeFile(outside, "secret\n");
			const { seen, editorRan } = await approve(root, outside, "pwned\n");
			expect(editorRan).toBe(false);
			expect(seen.preview).toBeNull();
			expect(seen.edited).toBeNull();
			expect(await fs.readFile(outside, "utf8")).toBe("secret\n");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not read or write a symlink that points outside the session directory",
		async () => {
			const parent = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-ws-"));
			const root = path.join(parent, "workspace");
			const outside = path.join(parent, "outside.md");
			const link = path.join(root, "link.md");
			try {
				await fs.mkdir(root, { recursive: true });
				await fs.writeFile(outside, "secret\n");
				await fs.symlink(outside, link);
				const { seen, warnings, editorRan } = await approve(root, "link.md", "pwned\n");
				expect(editorRan).toBe(false);
				expect(seen.preview).toBeNull();
				expect(seen.edited).toBeNull();
				expect(await fs.readFile(outside, "utf8")).toBe("secret\n");
				expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
				expect(warnings.some(message => message.includes("outside trust boundary"))).toBe(true);
			} finally {
				await fs.rm(parent, { recursive: true, force: true });
			}
		},
	);

	it("property: in-root plan names stay inside and parent escapes do not, seed 41420, 64 inputs", async () => {
		const { pathIsWithin } = await import("../../../src/tools/atomic-file-write");
		fc.assert(
			fc.property(
				fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), { minLength: 1, maxLength: 4 }),
				fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), { minLength: 0, maxLength: 3 }),
				fc.integer({ min: 1, max: 4 }),
				(rootSegs, inner, ups) => {
					const root = path.join(path.parse(process.cwd()).root, "workspace", ...rootSegs);
					const inside = path.join(root, ...inner, "PLAN.md");
					const escaped = path.resolve(root, ...Array.from({ length: ups }, () => ".."), "OUT.md");
					expect(pathIsWithin(inside, root)).toBe(true);
					expect(pathIsWithin(path.resolve(inside), root)).toBe(true);
					expect(pathIsWithin(path.join(inside, "..", "PLAN.md"), root)).toBe(true);
					expect(pathIsWithin(escaped, root)).toBe(false);
					expect(pathIsWithin(inside, path.parse(root).root)).toBe(true);
					expect(pathIsWithin(inside, root)).toBe(pathIsWithin(path.resolve(inside), root));
				},
			),
			{ seed: 41420, numRuns: 64 },
		);
	});
});
