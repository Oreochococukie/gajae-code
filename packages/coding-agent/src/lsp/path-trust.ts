import * as fs from "node:fs";
import * as path from "node:path";
import { pathIsWithin } from "@gajae-code/utils";

function canonicalPath(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

function findProjectTrustRoot(cwd: string): string {
	let current = canonicalPath(cwd);
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return canonicalPath(cwd);
		current = parent;
	}
}

export function isProjectControlledPath(candidate: string, cwd: string): boolean {
	return pathIsWithin(findProjectTrustRoot(cwd), canonicalPath(candidate));
}
