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
 * Bun's dotenv whitespace. NBSP and other Unicode spaces are values, not
 * separators: trimming them would make the snapshot disagree with `process.env`.
 * Shell files keep their own comment rule in `stripInlineShellComment`.
 */
const BUN_DOTENV_WHITESPACE = new Set([" ", "\t", "\v", "\f", "\n", "\r"]);

function isBunDotenvWhitespace(char: string | undefined): boolean {
	return char !== undefined && BUN_DOTENV_WHITESPACE.has(char);
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
 * `process.env` against this parse, so a declaration Bun loads has to produce
 * the same value here. That includes `export KEY=value`, ASCII whitespace
 * around `=` or a colon that is followed by whitespace, and `#` comments on
 * unquoted values (quotes keep their `#`). `$VAR` and `${VAR}` stay literal
 * and are marked dynamic, so an expansion Bun would perform is refused instead
 * of compared. Backticks are quotes, as they are for Bun, not shell commands.
 *
 * Quote handling has to match Bun's loader, not a one-line strip. A double-quoted
 * value may span physical lines, and Bun's ASCII whitespace (including a newline)
 * may separate the key, `=` or `:`, and the opening quote. Inside double quotes
 * only the pairs `\n` and `\r` become newline and carriage return; every other
 * backslash pair keeps its backslash. Single quotes and backticks do not
 * unescape. Text after the closing quote is discarded. An unquoted `#` starts a
 * comment even after a backslash. The decoded value is stored, including a
 * newline: dropping the key would make the value Bun loaded into `process.env`
 * look like an operator override. `$` expansion is left literal and marked
 * dynamic, so an expanded declaration is refused instead of compared.
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

function skipBunDotenvWhitespace(text: string, index: number): number {
	while (isBunDotenvWhitespace(text[index])) index++;
	return index;
}

function trimBunDotenvWhitespace(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && isBunDotenvWhitespace(value[start])) start++;
	while (end > start && isBunDotenvWhitespace(value[end - 1])) end--;
	return value.slice(start, end);
}

function stripLeadingUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * The closer is the next quote that is not the second character of a backslash
 * pair. `\"` and `\'` therefore stay inside the value instead of ending it.
 */
function findClosingQuote(text: string, start: number, quote: '"' | "'" | "`"): number {
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
	const quotedAt = skipBunDotenvWhitespace(text, index);
	const opener = text[quotedAt];
	if ((opener === '"' || opener === "'" || opener === "`") && quotedAt < text.length) {
		const close = findClosingQuote(text, quotedAt + 1, opener);
		if (close !== -1) {
			const raw = text.slice(quotedAt + 1, close);
			return {
				text: opener === '"' ? decodeDoubleQuoted(raw) : raw,
				next: indexAfterLine(text, close + 1),
			};
		}
	}
	let end = index;
	while (end < text.length && text[end] !== "#" && text[end] !== "\n" && text[end] !== "\r") end++;
	const next = end >= text.length ? text.length : text[end] === "\n" ? end + 1 : indexAfterLine(text, end);
	return { text: trimBunDotenvWhitespace(text.slice(index, end)), next };
}

/** Parse dotenv content that has already been read from a trusted file. */
export function parseEnvFileContent(content: string): Record<string, string> {
	const text = normalizeDotenvNewlines(stripLeadingUtf8Bom(content));
	const result: Record<string, string> = {};
	const length = text.length;
	let index = 0;
	while (index < length) {
		index = skipBunDotenvWhitespace(text, index);
		if (index >= length) break;
		if (text[index] === "#") {
			index = indexAfterLine(text, index);
			continue;
		}

		const lineStart = index;
		if (text.startsWith("export", index) && isBunDotenvWhitespace(text[index + 6])) {
			const exported = skipBunDotenvWhitespace(text, index + 6);
			if (isEnvKeyStart(text[exported])) index = exported;
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

		index = skipBunDotenvWhitespace(text, index);
		const separator = text[index];
		if (separator === "=") {
			index++;
		} else if (separator === ":" && isBunDotenvWhitespace(text[index + 1])) {
			index += 2;
		} else {
			index = indexAfterLine(text, lineStart);
			continue;
		}

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
