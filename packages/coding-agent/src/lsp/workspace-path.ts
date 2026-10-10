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

/**
 * Split a workspace path without collapsing `..`.
 * `.` is not a distinct entry. On Windows, `file://` URIs use `/` while `path.sep` is `\`.
 * On POSIX, `\` is a filename character and must not be a separator.
 */
export function splitAbsolute(
	filePath: string,
	pathApi: Pick<typeof path, "parse" | "sep"> = path,
): { root: string; parts: string[] } {
	const root = pathApi.parse(filePath).root;
	const splitter = pathApi.sep === "\\" ? /[\\/]/ : /\//;
	const parts = filePath
		.slice(root.length)
		.split(splitter)
		.filter(part => part.length > 0 && part !== ".");
	return { root, parts };
}

function toPlatformSep(filePath: string): string {
	return path.sep === "\\" ? filePath.replace(/\//g, "\\") : filePath;
}

/** Absolute path against `cwd`. `..` stays in the string so a symlink can be followed first. */
function lexicalAbsolute(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return toPlatformSep(filePath);
	const base = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd : `${cwd}${path.sep}`;
	return toPlatformSep(`${base}${filePath}`);
}

function joinRaw(parent: string, child: string): string {
	if (parent.endsWith("/") || parent.endsWith("\\")) return parent + child;
	return parent + path.sep + child;
}

function joinRoot(root: string, parts: string[]): string {
	if (parts.length === 0) return root || path.sep;
	if (root.endsWith("/") || root.endsWith("\\")) return root + parts.join(path.sep);
	if (root.length === 0) return parts.join(path.sep);
	return `${root}${path.sep}${parts.join(path.sep)}`;
}

function parentDir(filePath: string): string {
	const { root, parts } = splitAbsolute(filePath);
	return joinRoot(root, parts.slice(0, -1));
}

/** Absolute workspace path with `.` removed. `..` stays so a symlink can be followed first. */
function identityPath(filePath: string, cwd: string): string {
	const { root, parts } = splitAbsolute(lexicalAbsolute(filePath, cwd));
	return joinRoot(root, parts);
}

function isSameOrInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const prefix = parent.endsWith("/") || parent.endsWith("\\") ? parent : parent + path.sep;
	return child.startsWith(prefix);
}

type Move = { from: string; to: string; linkText: string | null };

function liveLocation(postPath: string, moves: Move[]): string {
	let current = postPath;
	for (let i = moves.length - 1; i >= 0; i--) {
		const move = moves[i];
		if (isSameOrInside(current, move.to)) current = move.from + current.slice(move.to.length);
	}
	return current;
}

function isMovedAway(postPath: string, moves: Move[]): boolean {
	let away = false;
	for (const move of moves) {
		if (isSameOrInside(postPath, move.from)) away = true;
		if (isSameOrInside(postPath, move.to)) away = false;
	}
	return away;
}

function absoluteLink(linkText: string, parent: string): string {
	const text = toPlatformSep(linkText);
	return path.isAbsolute(text) ? text : joinRaw(parent, text);
}

async function symlinkText(postPath: string, moves: Move[]): Promise<string | null> {
	const direct = [...moves].reverse().find(move => move.to === postPath);
	if (direct) return direct.linkText;
	if (isMovedAway(postPath, moves)) return null;
	try {
		const stat = await fs.lstat(liveLocation(postPath, moves));
		if (!stat.isSymbolicLink()) return null;
		return await fs.readlink(liveLocation(postPath, moves));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Where `filePath` will sit after `moves`, following relative symlinks from their new parents. */
async function locate(filePath: string, moves: Move[], depth: number): Promise<string> {
	if (depth > 40) throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	const { root, parts } = splitAbsolute(filePath);
	let cursor = root || path.sep;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === ".") continue;
		if (part === "..") {
			const link = await symlinkText(cursor, moves);
			if (link !== null) {
				cursor = parentDir(await locate(absoluteLink(link, parentDir(cursor)), moves, depth + 1));
			} else if (moves.some(move => isSameOrInside(cursor, move.to))) {
				// A renamed directory's `..` is its new parent, not the old one still on disk.
				cursor = parentDir(cursor);
			} else {
				const live = isMovedAway(cursor, moves) ? cursor : liveLocation(cursor, moves);
				try {
					cursor = parentDir(await fs.realpath(live));
				} catch (error) {
					if (!isEnoent(error)) throw error;
					cursor = parentDir(cursor);
				}
			}
			continue;
		}
		const next = joinRaw(cursor, part);
		const link = await symlinkText(next, moves);
		if (link !== null) {
			const rest = parts
				.slice(i + 1)
				.reduce((acc, piece) => joinRaw(acc, piece), absoluteLink(link, parentDir(next)));
			return locate(rest, moves, depth + 1);
		}
		cursor = next;
	}
	return cursor;
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

export async function canonicalWorkspacePath(cwd: string, filePath: string): Promise<string> {
	return canonicalize(lexicalAbsolute(filePath, cwd));
}

export async function assertInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	if (cwd.length === 0 || filePath.length === 0) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
	const root = await fs.realpath(cwd);
	const candidate = await canonicalize(lexicalAbsolute(filePath, cwd));
	if (escapes(root, candidate)) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
}

/**
 * Real directory that contains the final directory entry. `..` is applied after
 * following a symlink, so `hop/../link.ts` is not collapsed to a lexical parent.
 */
async function directoryContainingEntry(filePath: string, cwd: string): Promise<string> {
	const absolute = lexicalAbsolute(filePath, cwd);
	const { root, parts } = splitAbsolute(absolute);
	return locate(joinRoot(root, parts.slice(0, -1)), [], 0);
}

/** The directory entry itself must sit inside the workspace, not only its real target. */
export async function assertDirectoryEntryInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	await assertInsideWorkspace(cwd, await directoryContainingEntry(filePath, cwd));
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

export type PlannedResource =
	| { kind: "create"; filePath: string }
	| { kind: "rename"; oldPath: string; newPath: string }
	| { kind: "delete"; filePath: string };

/**
 * Reject a batch whose own earlier rename would make a later path leave the workspace.
 * The check runs before any write, so a rejected later target does not leave earlier edits applied.
 */
export async function assertBatchStaysInside(cwd: string, ops: PlannedResource[]): Promise<void> {
	if (ops.length === 0) return;
	const workspaceRoot = await fs.realpath(cwd);
	const moves: Move[] = [];
	const check = async (filePath: string) => {
		const absolute = identityPath(filePath, cwd);
		const { root, parts } = splitAbsolute(absolute);
		const parent = parts.length <= 1 ? root || path.sep : await locate(joinRoot(root, parts.slice(0, -1)), moves, 0);
		if (escapes(workspaceRoot, await canonicalize(parent))) {
			throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
		}
		const located = await locate(absolute, moves, 0);
		if (escapes(workspaceRoot, await canonicalize(located))) {
			throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
		}
	};
	for (const op of ops) {
		if (op.kind === "rename") {
			await check(op.oldPath);
			await check(op.newPath);
			const from = identityPath(op.oldPath, cwd);
			const to = identityPath(op.newPath, cwd);
			let linkText: string | null = null;
			try {
				const live = liveLocation(from, moves);
				const stat = await fs.lstat(live);
				if (stat.isSymbolicLink()) linkText = await fs.readlink(live);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			moves.push({ from, to, linkText });
			continue;
		}
		await check(op.filePath);
	}
}

/**
 * Absolute path the kernel will use. Relative URIs are anchored at the workspace, not
 * `process.cwd()`. A literal `missing/..` segment does not exist, so use the canonical
 * file after containment has walked the original spelling. `.` is not part of the identity.
 */
export async function workspaceOperand(cwd: string, filePath: string): Promise<string> {
	const absolute = identityPath(filePath, cwd);
	try {
		await fs.lstat(absolute);
		return absolute;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return canonicalize(absolute);
	}
}

/** Syscall only. The caller has already rejected any path that leaves the workspace. */
export async function renameCheckedPaths(cwd: string, source: string, dest: string): Promise<void> {
	const sourceOp = await workspaceOperand(cwd, source);
	const destOp = await workspaceOperand(cwd, dest);
	await fs.mkdir(parentDir(destOp), { recursive: true });
	await fs.rename(sourceOp, destOp);
}

/** Rename only after both real paths and both directory entries stay inside the workspace. */
export async function renameInsideWorkspace(cwd: string, source: string, dest: string): Promise<void> {
	await assertRenamePaths(cwd, identityPath(source, cwd), identityPath(dest, cwd));
	await renameCheckedPaths(cwd, source, dest);
}
