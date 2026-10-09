/**
 * Environment-file parsing primitives.
 *
 * Kept in a leaf module so both `env.ts` and `dirs.ts` can use them. `env.ts`
 * imports `dirs.ts`, so anything `dirs.ts` needs from the env layer has to live
 * below both of them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeEnvValue } from "./spawn-env";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

function stripInlineShellComment(value: string): string {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
			return value.slice(0, i).trimEnd();
		}
	}
	return value.trimEnd();
}

/**
 * Strips an unquoted trailing `# comment` from a dotenv value the way Bun's
 * dotenv loader does: an unescaped `#` starts a comment regardless of the
 * preceding character (`a#b` loads as `a`), while `#` inside quotes or after a
 * backslash escape survives. Used for unquoted dotenv values; shell files use
 * `stripInlineShellComment`, whose POSIX rule requires whitespace before `#`.
 */
function stripInlineDotenvComment(value: string): string {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (char === "#" && !quote) return value.slice(0, i).trimEnd();
	}
	return value.trimEnd();
}

/**
 * Parses simple POSIX shell environment assignments from files such as
 * ~/.zshrc without executing user shell code. Supports `export KEY=value` and
 * `KEY=value`, including single/double quoted literal values. Dynamic shell
 * expressions are intentionally ignored because evaluating startup files would
 * run arbitrary code during CLI startup.
 */
export function parseShellEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
			if (!match) continue;

			const key = match[1];
			if (!isValidEnvName(key)) continue;

			let value = stripInlineShellComment(match[2] ?? "").trim();
			if (value.endsWith(";")) value = value.slice(0, -1).trimEnd();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;
			if (/[$`]/.test(value)) continue;

			result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	return result;
}

/**
 * Parses a .env file synchronously and extracts key-value string pairs.
 * Ignores lines that are empty or start with '#'. Trims whitespace.
 * Allows values to be quoted with single or double quotes.
 * Returns an object of key-value pairs.
 *
 * The trust guards (`trustedAgentDirOverrideFor`, `trustedConfigDirName`,
 * `filterCredentialInheritedEnv`) decide provenance by comparing
 * `process.env` against this parse, so the accepted syntax must be a superset
 * of what Bun's own dotenv loader honors in `cwd/.env`: `export KEY=value`,
 * whitespace around `=` or `:`, and `#` comments after unquoted values (quotes keep
 * their `#`). Values that Bun would expand (`$VAR`, `${VAR}`, backticks,
 * command substitution) are kept as their literal text: the trust rule only
 * needs the parser to see the key at all, and an operator environment value
 * cannot equal attacker-written expansion text, so a literal parse stays
 * conservative.
 *
 * Quote handling has to match Bun's loader, not a one-line strip. A double-quoted
 * value may span physical lines. Inside double quotes only the pairs `\n` and `\r`
 * become newline and carriage return; every other backslash pair keeps its
 * backslash. Single quotes do not unescape. Text after the closing quote is
 * discarded. The decoded newline is stored: dropping the key would make the
 * value Bun loaded into `process.env` look like an operator override.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	try {
		return parseEnvFileContent(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// File doesn't exist or can't be read - return empty result
		return {};
	}
}

/**
 * Bun treats CR, LF, and CRLF as line breaks, including a carriage return inside
 * quotes. Normalize before decoding, so a quoted `\r` escape is still a carriage
 * return rather than another line break.
 */
function normalizeDotenvNewlines(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isInlineWhitespace(char: string | undefined): boolean {
	return char !== undefined && char !== "\n" && char !== "\r" && /\s/.test(char);
}

function isEnvKeyStart(char: string | undefined): boolean {
	return char !== undefined && ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_");
}

function isEnvKeyContinue(char: string | undefined): boolean {
	return isEnvKeyStart(char) || (char !== undefined && char >= "0" && char <= "9");
}

function indexAfterLine(text: string, index: number): number {
	const end = text.indexOf("\n", index);
	return end === -1 ? text.length : end + 1;
}

/**
 * The closer is the next quote that is not the second character of a backslash
 * pair. `\"` and `\'` therefore stay inside the value instead of ending it.
 */
function findClosingQuote(text: string, start: number, quote: '"' | "'"): number {
	for (let index = start; index < text.length; index++) {
		if (text[index] === "\\") {
			if (index + 1 >= text.length) return -1;
			index++;
			continue;
		}
		if (text[index] === quote) return index;
	}
	return -1;
}

/** Inside double quotes, only `\n` and `\r` are escapes. Other pairs keep the backslash. */
function decodeDoubleQuoted(raw: string): string {
	const out: string[] = [];
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index];
		if (char !== "\\" || index + 1 >= raw.length) {
			if (char !== undefined) out.push(char);
			continue;
		}
		const next = raw[index + 1];
		if (next === "n") out.push("\n");
		else if (next === "r") out.push("\r");
		else if (next !== undefined) out.push("\\", next);
		index++;
	}
	return out.join("");
}

function readDotenvValue(text: string, index: number): { text: string; next: number } {
	const opener = text[index];
	if (opener === '"' || opener === "'") {
		const close = findClosingQuote(text, index + 1, opener);
		if (close !== -1) {
			const raw = text.slice(index + 1, close);
			return {
				text: opener === '"' ? decodeDoubleQuoted(raw) : raw,
				next: indexAfterLine(text, close + 1),
			};
		}
	}
	const end = text.indexOf("\n", index);
	const lineEnd = end === -1 ? text.length : end;
	return {
		text: stripInlineDotenvComment(text.slice(index, lineEnd)).trim(),
		next: end === -1 ? text.length : end + 1,
	};
}

/** Parse dotenv content that has already been read from a trusted file. */
export function parseEnvFileContent(content: string): Record<string, string> {
	const text = normalizeDotenvNewlines(content);
	const result: Record<string, string> = {};
	const length = text.length;
	let index = 0;
	while (index < length) {
		while (isInlineWhitespace(text[index])) index++;
		if (index >= length) break;
		if (text[index] === "\n") {
			index++;
			continue;
		}
		if (text[index] === "#") {
			index = indexAfterLine(text, index);
			continue;
		}

		const lineStart = index;
		if (text.startsWith("export", index) && isInlineWhitespace(text[index + 6])) {
			index += 6;
			while (isInlineWhitespace(text[index])) index++;
		}

		const keyStart = index;
		if (!isEnvKeyStart(text[index])) {
			index = indexAfterLine(text, lineStart);
			continue;
		}
		index++;
		while (isEnvKeyContinue(text[index])) index++;
		const key = text.slice(keyStart, index);
		if (!isValidEnvName(key)) {
			index = indexAfterLine(text, lineStart);
			continue;
		}

		while (isInlineWhitespace(text[index])) index++;
		const separator = text[index];
		if (separator !== "=" && separator !== ":") {
			index = indexAfterLine(text, lineStart);
			continue;
		}
		index++;
		while (isInlineWhitespace(text[index])) index++;

		const value = readDotenvValue(text, index);
		index = value.next;
		// A newline is a real snapshot value. Skipping the key here would fail open.
		if (!isSafeEnvValue(value.text)) continue;
		result[key] = value.text;
	}

	return result;
}

/**
 * What the caller's checkout declares through its dotenv files.
 *
 * `values` is the merged declaration set, later layers winning. `dynamic` holds
 * the keys whose surviving declaration is one Bun expands at load time, which
 * every provenance guard refuses outright because a value comparison cannot see
 * what such a declaration became.
 */
export interface ProjectEnvSnapshot {
	values: Record<string, string>;
	dynamic: Set<string>;
}

/**
 * Windows environment variable names are case-insensitive, so a project dotenv
 * line `userprofile=...` is what `process.env.USERPROFILE` resolves to. Every
 * provenance lookup is spelled in upper case, so the snapshot must be keyed the
 * same way or the declaration is invisible to the guard while still being live
 * in the process. POSIX names are case-sensitive and must not fold.
 */
export function canonicalEnvKey(name: string): string {
	return process.platform === "win32" ? name.toUpperCase() : name;
}

/**
 * The layered dotenv declarations Bun overlays into `process.env` for a cwd.
 *
 * Lives in this leaf module so every consumer shares ONE notion of provenance.
 * `dirs.ts` resolves the config, agent and log directories from it, and
 * `scripts/test-preload.ts` decides test isolation from it — a second, narrower
 * reader (only `cwd/.env`, its own regex, its own dynamic test) is how a
 * `GJC_LOG_DIR` declared in `.env.local` / `.env.$NODE_ENV` came to be honored
 * by the preload and then rejected in production, silently routing test log
 * records to the operator's canonical sink. This module imports only `node:fs`,
 * `node:path` and the import-free `./spawn-env`, so importing it has no side
 * effects and cannot freeze resolver state the way importing `dirs.ts` would.
 *
 * `.env.local` is deliberately skipped when `NODE_ENV === "test"`, matching the
 * convention that a local override file is not part of a test run.
 */
export function projectEnvSnapshot(cwd = process.cwd()): ProjectEnvSnapshot {
	const nodeEnv = process.env.NODE_ENV;
	const validNodeEnv = nodeEnv && /^[A-Za-z0-9_-]+$/.test(nodeEnv) ? nodeEnv : undefined;
	const files = [
		".env",
		...(validNodeEnv ? [`.env.${validNodeEnv}`] : []),
		...(validNodeEnv !== "test" ? [".env.local"] : []),
		...(validNodeEnv ? [`.env.${validNodeEnv}.local`] : []),
	];
	const values: Record<string, string> = {};
	const dynamic = new Set<string>();
	for (const file of files) {
		for (const [rawKey, value] of Object.entries(parseEnvFile(path.join(cwd, file)))) {
			const key = canonicalEnvKey(rawKey);
			values[key] = value;
			if (/[$`]/.test(value)) dynamic.add(key);
			else dynamic.delete(key);
		}
	}
	return { values, dynamic };
}
