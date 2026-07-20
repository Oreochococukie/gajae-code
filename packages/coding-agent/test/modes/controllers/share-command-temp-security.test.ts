import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

const originalAgentDir = getAgentDir();
const originalAgentDirOverride = process.env.GJC_CODING_AGENT_DIR;
const originalPath = process.env.PATH;

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		clear() {
			this.children = [];
		},
	};
}

function createContext(exportToHtml: (file: string) => Promise<unknown>) {
	const editor = {};
	const editorContainer = createContainer();
	editorContainer.addChild(editor);
	const ctx = {
		session: { exportToHtml: vi.fn(exportToHtml) },
		editor,
		editorContainer,
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		showError: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, editorContainer };
}

async function waitForFile(file: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await Bun.file(file).exists()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

describe("/share temporary export security", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Expected red-claw theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		if (originalAgentDirOverride === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
		process.env.PATH = originalPath;
	});

	it("uses exclusive owner-private staging and removes it after export failure", async () => {
		const tempDir = path.join(os.tmpdir(), "gjc-share-random");
		const tempFile = path.join(tempDir, "session.html");
		const close = vi.fn(async () => undefined);
		const mkdtemp = vi.spyOn(fs, "mkdtemp").mockResolvedValue(tempDir);
		const chmod = vi.spyOn(fs, "chmod").mockResolvedValue(undefined);
		const open = vi.spyOn(fs, "open").mockResolvedValue({ close } as unknown as fs.FileHandle);
		const rm = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
		const { ctx } = createContext(async () => {
			throw new Error("export failed");
		});

		await new CommandController(ctx).handleShareCommand();

		expect(mkdtemp).toHaveBeenCalledWith(path.join(os.tmpdir(), "gjc-share-"));
		if (process.platform !== "win32") expect(chmod).toHaveBeenCalledWith(tempDir, 0o700);
		expect(open).toHaveBeenCalledWith(tempFile, "wx", 0o600);
		expect(close).toHaveBeenCalledTimes(1);
		expect(ctx.session.exportToHtml).toHaveBeenCalledWith(tempFile);
		expect(rm).toHaveBeenCalledWith(tempDir, { recursive: true, force: true });
		expect(ctx.showError).toHaveBeenCalledWith("Failed to export session: export failed");
	});

	it("does not replace the export error when cleanup fails", async () => {
		const tempDir = path.join(os.tmpdir(), "gjc-share-cleanup-failure");
		vi.spyOn(fs, "mkdtemp").mockResolvedValue(tempDir);
		vi.spyOn(fs, "chmod").mockResolvedValue(undefined);
		vi.spyOn(fs, "open").mockResolvedValue({ close: vi.fn() } as unknown as fs.FileHandle);
		vi.spyOn(fs, "rm").mockRejectedValue(new Error("cleanup failed"));
		const { ctx } = createContext(async () => {
			throw new Error("export failed");
		});

		await new CommandController(ctx).handleShareCommand();

		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(ctx.showError).toHaveBeenCalledWith("Failed to export session: export failed");
	});

	it("keeps a private custom-share export until the handler settles, then removes the directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-share-test-"));
		const agentDir = path.join(root, "agent");
		const observed = path.join(root, "observed.json");
		const release = path.join(root, "release");
		await fs.mkdir(agentDir);
		setAgentDir(agentDir);
		await Bun.write(
			path.join(agentDir, "share.ts"),
			`import * as fs from "node:fs/promises";
import * as path from "node:path";
export default async (htmlPath: string) => {
	const [dir, file] = await Promise.all([fs.stat(path.dirname(htmlPath)), fs.stat(htmlPath)]);
	await Bun.write(${JSON.stringify(observed)}, JSON.stringify({ htmlPath, dirMode: dir.mode & 0o777, fileMode: file.mode & 0o777 }));
	while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(5);
	return "https://example.test/share";
};
`,
		);
		let stagedFile = "";
		const { ctx } = createContext(async file => {
			stagedFile = file;
			await Bun.write(file, "session");
		});

		const command = new CommandController(ctx).handleShareCommand();
		await waitForFile(observed);
		const snapshot = (await Bun.file(observed).json()) as { htmlPath: string; dirMode: number; fileMode: number };
		expect(snapshot.htmlPath).toBe(stagedFile);
		if (process.platform !== "win32") {
			expect(snapshot.dirMode).toBe(0o700);
			expect(snapshot.fileMode).toBe(0o600);
		}
		expect(await Bun.file(stagedFile).exists()).toBe(true);

		await Bun.write(release, "go");
		await command;

		expect(await Bun.file(path.dirname(stagedFile)).exists()).toBe(false);
		expect(ctx.showStatus).toHaveBeenCalledWith("Share URL: https://example.test/share");
		await fs.rm(root, { recursive: true, force: true });
	});
});
