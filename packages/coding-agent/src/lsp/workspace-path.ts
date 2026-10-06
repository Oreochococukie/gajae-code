import * as fs from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/tool-errors";

export async function assertInsideWorkspace(cwd: string, filePath: string): Promise<void> {
	const root = await fs.realpath(cwd);
	let candidate = filePath;
	try {
		candidate = await fs.realpath(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
		const realParent = await fs.realpath(path.dirname(filePath));
		candidate = path.join(realParent, path.basename(filePath));
	}
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
		throw new ToolError(`LSP edit escapes the workspace: ${filePath}`);
	}
}
