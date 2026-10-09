import * as fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/tool-errors";

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** `path.relative` keeps workspace `/` contained. A `//` string prefix does not. */
function escapes(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
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
	if (cwd.length === 0 || filePath.length === 0) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
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
			try {
				cursor = path.dirname(await fs.realpath(cursor));
			} catch (error) {
				if (!isEnoent(error)) throw error;
				cursor = path.dirname(cursor);
			}
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

/** Real content and the directory entry that names it must both stay inside the workspace. */
export async function assertWorkspaceTarget(cwd: string, filePath: string): Promise<void> {
	await assertInsideWorkspace(cwd, filePath);
	await assertDirectoryEntryInsideWorkspace(cwd, filePath);
}

/** Both rename endpoints, including the directory entries `rename` will move or create. */
export async function assertRenamePaths(cwd: string, source: string, dest: string): Promise<void> {
	await assertWorkspaceTarget(cwd, source);
	await assertWorkspaceTarget(cwd, dest);
}

/** Rename only after both real paths and both directory entries stay inside the workspace. */
export async function renameInsideWorkspace(cwd: string, source: string, dest: string): Promise<void> {
	await assertRenamePaths(cwd, source, dest);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.rename(source, dest);
}
