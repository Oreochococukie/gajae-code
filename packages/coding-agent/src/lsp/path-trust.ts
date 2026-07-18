import * as fs from "node:fs";
import * as path from "node:path";
import { pathIsWithin } from "@gajae-code/utils";

function pathIsLexicallyWithin(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	const comparisonRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
	const comparisonCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
	const relative = path.relative(comparisonRoot, comparisonCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

function canonicalParentPath(candidate: string): string {
	const resolved = path.resolve(candidate);
	return path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
}

function findProjectTrustRoot(start: string): string {
	const fallback = path.resolve(start);
	let current = fallback;
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return fallback;
		current = parent;
	}
}

export function isProjectControlledPath(candidate: string, cwd: string): boolean {
	const lexicalTrustRoot = findProjectTrustRoot(cwd);
	if (pathIsLexicallyWithin(lexicalTrustRoot, candidate)) return true;

	const canonicalTrustRoots = new Set([canonicalPath(lexicalTrustRoot), findProjectTrustRoot(canonicalPath(cwd))]);
	for (const trustRoot of canonicalTrustRoots) {
		if (
			pathIsLexicallyWithin(trustRoot, canonicalParentPath(candidate)) ||
			pathIsWithin(trustRoot, canonicalPath(candidate))
		) {
			return true;
		}
	}
	return false;
}
