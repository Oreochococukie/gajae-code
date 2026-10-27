import { expect, test } from "bun:test";
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateEnumExports } from "../scripts/gen-enums";

const nativeDir = path.join(import.meta.dir, "../native");
const jsPath = path.join(nativeDir, "index.js");
const dtsPath = path.join(nativeDir, "index.d.ts");
const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

function symlinksAvailable(): boolean {
	const dir = fssync.mkdtempSync(path.join(os.tmpdir(), "native-link-probe-"));
	let created = false;
	try {
		fssync.symlinkSync("target", path.join(dir, "link"));
		created = true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES") throw err;
	} finally {
		fssync.rmSync(dir, { recursive: true, force: true });
	}
	return created;
}

const canSymlink = symlinksAvailable();

const loader = `prelude-keep\n${MARKER_START}\nexport const Old = 1;\n${MARKER_END}\ntail-keep\n`;
const declaration =
	'export declare const enum Color {\n\tRed = "red",\n}\nexport declare function editFindMatch(): void\n';

async function restoreNative(jsBytes: Buffer, dtsBytes: Buffer): Promise<void> {
	await fs.unlink(jsPath).catch(() => {});
	await fs.unlink(dtsPath).catch(() => {});
	await fs.writeFile(jsPath, jsBytes);
	await fs.writeFile(dtsPath, dtsBytes);
	for (const entry of await fs.readdir(nativeDir)) {
		if (entry.includes(".tmp.")) await fs.unlink(path.join(nativeDir, entry)).catch(() => {});
	}
}

async function withNativeFiles(run: () => Promise<void>): Promise<void> {
	const jsBytes = await fs.readFile(jsPath);
	const dtsBytes = await fs.readFile(dtsPath);
	try {
		await run();
	} finally {
		await restoreNative(jsBytes, dtsBytes);
	}
}

async function loadInstall(): Promise<(outputDir: string) => Promise<void>> {
	const mod = await import("../scripts/build-native");
	if (typeof mod.installGeneratedBindings !== "function") {
		throw new Error("installGeneratedBindings is not exported");
	}
	return mod.installGeneratedBindings;
}

test("generateEnumExports keeps the hand-written loader outside the marker block", async () => {
	await withNativeFiles(async () => {
		await fs.writeFile(jsPath, loader);
		await fs.writeFile(dtsPath, declaration);
		await generateEnumExports();
		const jsOut = await fs.readFile(jsPath, "utf8");
		expect(jsOut.startsWith("prelude-keep\n")).toBe(true);
		expect(jsOut.endsWith("tail-keep\n")).toBe(true);
		expect(jsOut.includes("export const editFindMatch = nativeBindings.editFindMatch;")).toBe(true);
		expect(jsOut.includes("export const Old = 1;")).toBe(false);
		const dtsOut = await fs.readFile(dtsPath, "utf8");
		expect(dtsOut.includes("export declare enum Color")).toBe(true);
		expect(dtsOut.includes("export const enum")).toBe(false);
		expect(dtsOut.includes("export declare function editFindMatch(): void")).toBe(true);
		expect((await fs.lstat(jsPath)).isSymbolicLink()).toBe(false);
		expect((await fs.lstat(dtsPath)).isSymbolicLink()).toBe(false);
	});
});

test.skipIf(!canSymlink)(
	"generateEnumExports replaces symlinked index.js and index.d.ts without changing their targets",
	async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-enum-outside-"));
		try {
			await withNativeFiles(async () => {
				const jsTarget = path.join(outside, "index.js");
				const dtsTarget = path.join(outside, "index.d.ts");
				await fs.writeFile(jsTarget, loader);
				await fs.writeFile(dtsTarget, declaration);
				await fs.unlink(jsPath);
				await fs.unlink(dtsPath);
				await fs.symlink(jsTarget, jsPath);
				await fs.symlink(dtsTarget, dtsPath);
				await generateEnumExports();
				expect(await fs.readFile(jsTarget, "utf8")).toBe(loader);
				expect(await fs.readFile(dtsTarget, "utf8")).toBe(declaration);
				expect((await fs.lstat(jsPath)).isSymbolicLink()).toBe(false);
				expect((await fs.lstat(dtsPath)).isSymbolicLink()).toBe(false);
				const jsOut = await fs.readFile(jsPath, "utf8");
				expect(jsOut.includes("prelude-keep")).toBe(true);
				expect(jsOut.includes("export const editFindMatch = nativeBindings.editFindMatch;")).toBe(true);
				expect((await fs.readFile(dtsPath, "utf8")).includes("export declare enum Color")).toBe(true);
			});
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	},
);

test("installGeneratedBindings updates a regular index.d.ts and creates a missing one", async () => {
	const installGeneratedBindings = await loadInstall();
	const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-out-"));
	try {
		await withNativeFiles(async () => {
			await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
			await fs.writeFile(dtsPath, "old-bindings");
			await installGeneratedBindings(outputDir);
			expect(await fs.readFile(dtsPath, "utf8")).toBe("new-bindings");
			expect((await fs.lstat(dtsPath)).isFile()).toBe(true);
			await fs.unlink(dtsPath);
			await installGeneratedBindings(outputDir);
			expect(await fs.readFile(dtsPath, "utf8")).toBe("new-bindings");
			expect((await fs.lstat(dtsPath)).isSymbolicLink()).toBe(false);
		});
	} finally {
		await fs.rm(outputDir, { recursive: true, force: true });
	}
});

test.skipIf(!canSymlink)(
	"installGeneratedBindings replaces a symlinked index.d.ts without changing its target",
	async () => {
		const installGeneratedBindings = await loadInstall();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-outside-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-out-"));
		try {
			await withNativeFiles(async () => {
				const target = path.join(outside, "secret.d.ts");
				await fs.writeFile(target, "SECRET");
				await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
				await fs.unlink(dtsPath);
				await fs.symlink(target, dtsPath);
				await installGeneratedBindings(outputDir);
				expect(await fs.readFile(target, "utf8")).toBe("SECRET");
				const st = await fs.lstat(dtsPath);
				expect(st.isSymbolicLink()).toBe(false);
				expect(st.isFile()).toBe(true);
				expect(await fs.readFile(dtsPath, "utf8")).toBe("new-bindings");
			});
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	},
);

test.skipIf(!canSymlink)(
	"installGeneratedBindings ignores a symlink at the old predictable temporary name",
	async () => {
		const installGeneratedBindings = await loadInstall();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-temp-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-out-"));
		try {
			await withNativeFiles(async () => {
				const sentinel = path.join(outside, "sentinel");
				const planted = `${dtsPath}.tmp.${process.pid}`;
				await fs.writeFile(sentinel, "SECRET");
				await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
				await fs.writeFile(dtsPath, "old-bindings");
				await fs.symlink(sentinel, planted);
				await installGeneratedBindings(outputDir);
				expect(await fs.readFile(sentinel, "utf8")).toBe("SECRET");
				expect((await fs.lstat(planted)).isSymbolicLink()).toBe(true);
				const st = await fs.lstat(dtsPath);
				expect(st.isSymbolicLink()).toBe(false);
				expect(st.isFile()).toBe(true);
				expect(await fs.readFile(dtsPath, "utf8")).toBe("new-bindings");
				const leftovers = (await fs.readdir(nativeDir)).filter(entry => entry.includes(".tmp."));
				expect(leftovers).toEqual([path.basename(planted)]);
			});
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	},
);

test("installGeneratedBindings finishes with one regular declaration when two installs overlap", async () => {
	const installGeneratedBindings = await loadInstall();
	const outputA = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-a-"));
	const outputB = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-b-"));
	try {
		await withNativeFiles(async () => {
			await fs.writeFile(path.join(outputA, "index.d.ts"), "bindings-a");
			await fs.writeFile(path.join(outputB, "index.d.ts"), "bindings-b");
			await fs.writeFile(dtsPath, "old-bindings");
			await Promise.all([installGeneratedBindings(outputA), installGeneratedBindings(outputB)]);
			expect(["bindings-a", "bindings-b"]).toContain(await fs.readFile(dtsPath, "utf8"));
			expect((await fs.lstat(dtsPath)).isSymbolicLink()).toBe(false);
			expect((await fs.readdir(nativeDir)).filter(entry => entry.includes(".tmp."))).toEqual([]);
		});
	} finally {
		await fs.rm(outputA, { recursive: true, force: true });
		await fs.rm(outputB, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"installGeneratedBindings publishes index.d.ts as a new file when another hard link exists",
	async () => {
		const installGeneratedBindings = await loadInstall();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-link-"));
		const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-binding-out-"));
		try {
			await withNativeFiles(async () => {
				const other = path.join(outside, "linked.d.ts");
				await fs.writeFile(dtsPath, "old-bindings");
				await fs.link(dtsPath, other);
				await fs.writeFile(path.join(outputDir, "index.d.ts"), "new-bindings");
				await installGeneratedBindings(outputDir);
				expect(await fs.readFile(dtsPath, "utf8")).toBe("new-bindings");
				expect(await fs.readFile(other, "utf8")).toBe("old-bindings");
			});
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outputDir, { recursive: true, force: true });
		}
	},
);
