import * as fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/tool-errors";

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function escapes(root: string, candidate: string): boolean {
	return candidate !== root && !candidate.startsWith(`${root}${path.sep}`);
}

/** Resolve a missing path through the nearest existing ancestor. */
async function canonicalize(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const missing: string[] = [];
	let cursor = filePath;
	for (;;) {
		let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat) {
			try {
				return path.join(await fs.realpath(cursor), ...missing);
			} catch (error) {
				if (isEnoent(error)) throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
				throw error;
			}
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

export async function assertInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	const root = await fs.realpath(cwd);
	const candidate = await canonicalize(filePath);
	if (escapes(root, candidate)) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
}

/**
 * Real directory that contains the final directory entry. `..` is applied after
 * following a symlink, so `hop/../link.ts` is not collapsed to a lexical parent.
 */
async function directoryContainingEntry(filePath: string): Promise<string> {
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
	const root = path.parse(absolute).root;
	const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
	let cursor = root;
	for (const part of parts.slice(0, -1)) {
		if (part === ".") continue;
		if (part === "..") {
			const real = await fs.realpath(cursor);
			cursor = path.dirname(real);
			continue;
		}
		const next = path.join(cursor, part);
		let stat: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			stat = await fs.lstat(next);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			cursor = next;
			continue;
		}
		cursor = stat.isSymbolicLink() ? await fs.realpath(next) : next;
	}
	return cursor;
}

/** The directory entry itself must sit inside the workspace, not only its real target. */
export async function assertDirectoryEntryInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	await assertInsideWorkspace(cwd, await directoryContainingEntry(filePath));
}

/** Rename only after both real paths and the source directory entry stay inside the workspace. */
export async function renameInsideWorkspace(cwd: string, source: string, dest: string): Promise<void> {
	await assertInsideWorkspace(cwd, source);
	await assertInsideWorkspace(cwd, dest);
	await assertDirectoryEntryInsideWorkspace(cwd, source);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.rename(source, dest);
}
