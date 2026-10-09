import { createHmac, randomBytes } from "node:crypto";
import type { Message, TextContent } from "@gajae-code/ai/core";
import { type SessionContext, transferSessionMessageIdentity } from "../session/session-manager";
import { compileSecretRegex } from "./regex";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface SecretEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replacement generation
// ═══════════════════════════════════════════════════════════════════════════

const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Domain separator for replace-mode replacement derivation. Distinct from
 * `PLACEHOLDER_DOMAIN` so a value minted under one construction can never be
 * confused with a value minted under the other, even with the same key.
 */
const REPLACEMENT_DOMAIN = "gjc.secret-obfuscation.replacement.v1\0";

/** One HMAC-SHA256 digest block length in bytes. */
const REPLACEMENT_DIGEST_BYTES = 32;

/** Largest accepted byte for uniform rejection sampling (256 - (256 % 62)). */
const REPLACEMENT_REJECT_THRESHOLD = 248;

/**
 * Generate a deterministic, keyed, same-length replacement string from a
 * secret value.
 *
 * COMPATIBILITY CONTRACT (required behavior, must never regress):
 * - Deterministic within a process: the same secret under the same key always
 *   yields the same replacement, independent of entry order or call order.
 * - Same length: `result.length === secret.length` (UTF-16 code units, i.e.
 *   `String.prototype.length` semantics — unchanged from the pre-fix
 *   implementation). Astral-plane characters count as two units, exactly as
 *   they did before.
 * - Allowed characters: output is restricted to `[A-Za-z0-9]` (62 chars).
 * - Explicit `replacement` values in secrets.yml are authoritative and are
 *   never derived; this path runs only when `replacement` is undefined.
 * - Replace mode stays one-way: the derived value is never reversed by
 *   `deobfuscate()`.
 *
 * THREAT MODEL (issue #4166):
 * - Attacker model: an observer sees one or more replacements (model context,
 *   provider-side logs, saved/shared transcripts) and has full knowledge of
 *   the public algorithm. Without the 32-byte obfuscation key they cannot
 *   confirm a candidate secret offline and cannot predict or precompute the
 *   replacement for any secret. The construction is a keyed PRF
 *   (HMAC-SHA256), so output is unpredictable without the key, and keyed
 *   domain separation keeps this construction distinct from the placeholder
 *   construction.
 * - Accepted residual disclosure: the replacement is same-length by design
 *   (required behavior above), so the secret's exact length is still
 *   observable. This is inherent to size-preserving substitution and is
 *   explicitly out of scope; the fix removes the *keyless confirmation*
 *   oracle, not the length signal.
 * - Cross-process stability / key rotation: the process key is generated per
 *   process (`PROCESS_SECRET_OBFUSCATION_KEY`), so derived replacements are
 *   stable within a process and differ across processes or after a key
 *   rotation. This is a deliberate decision, identical in scope to the
 *   obfuscate-mode placeholder behavior. Users who need stable values across
 *   processes or restarts must set an explicit `replacement` in secrets.yml.
 * - Collision/bias: output is a keyed pseudorandom mapping. Two distinct
 *   secrets can in principle collide (birthday bound over the 62^len output
 *   space); for realistic secret lengths this is negligible. Character
 *   distribution is uniform by construction: digest bytes are rejection-
 *   sampled (bytes 248-255 rejected, 256 - (256 % 62) = 248 = 62 * 4), so
 *   every character is exactly equally likely, with no modulo bias.
 * - Empty secrets: a zero-length secret yields an empty replacement and the
 *   obfuscator treats it as a no-op (load-time validation rejects empty
 *   content anyway). Unicode secrets are hashed as UTF-8 bytes, so encoding
 *   is canonical. Very long secrets expand via a counter-based HMAC stream
 *   in O(length) blocks; generation cost is linear in the secret length.
 * - Overlapping secrets and streaming: derivation is per-secret and does not
 *   depend on matching semantics (longest-first overlap handling is
 *   unchanged), and `obfuscate()` runs per complete text payload, so chunked
 *   output (e.g. streamed LLM messages) sees the same deterministic
 *   replacement for the same secret within a process.
 */
function generateDeterministicReplacement(secret: string, key: Uint8Array): string {
	const length = secret.length;
	if (length === 0) return "";
	const chars: string[] = [];
	// CTR-style expansion: HMAC(key, DOMAIN || counter || secret) per 32-byte
	// block. The counter is big-endian and fixed-width, so the stream is
	// unambiguous and never repeats.
	const counter = new Uint8Array(8);
	const counterView = new DataView(counter.buffer);
	let block: Uint8Array | undefined;
	let blockOffset = REPLACEMENT_DIGEST_BYTES;
	let blockIndex = 0;
	while (chars.length < length) {
		if (block === undefined || blockOffset >= REPLACEMENT_DIGEST_BYTES) {
			counterView.setUint32(4, blockIndex, false);
			block = createHmac("sha256", key).update(REPLACEMENT_DOMAIN).update(counter).update(secret, "utf8").digest();
			blockOffset = 0;
			blockIndex++;
		}
		const byte = block[blockOffset++]!;
		if (byte >= REPLACEMENT_REJECT_THRESHOLD) continue;
		chars.push(REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length]!);
	}
	return chars.join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder format
// ═══════════════════════════════════════════════════════════════════════════

const PLACEHOLDER_DOMAIN = "gjc.secret-obfuscation.placeholder.v1\0";
const PLACEHOLDER_RE = /#GJC1_[A-Za-z0-9_-]{22}#/g;

/** Build a versioned, authenticated placeholder whose identity depends only on the key and secret. */
function buildPlaceholder(secret: string, key: Uint8Array): string {
	const tag = createHmac("sha256", key)
		.update(PLACEHOLDER_DOMAIN)
		.update(secret, "utf8")
		.digest()
		.subarray(0, 16)
		.toString("base64url");
	return `#GJC1_${tag}#`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SecretObfuscator
// ═══════════════════════════════════════════════════════════════════════════

export class SecretObfuscator {
	/** Key used to authenticate reversible placeholders. */
	#placeholderKey: Uint8Array;

	/** Plain secrets: secret → index (known at construction) */
	#plainMappings = new Map<string, number>();

	/** Regex entries (patterns compiled at construction) */
	#regexEntries: Array<{ regex: RegExp; mode: "obfuscate" | "replace"; replacement?: string }> = [];

	/** All obfuscate-mode mappings: index → { secret, placeholder } */
	#obfuscateMappings = new Map<number, { secret: string; placeholder: string }>();

	/** Replace-mode plain mappings: secret → replacement */
	#replaceMappings = new Map<string, string>();

	/** Replace-mode plain mappings sorted longest-first for deterministic longest-match replacement. */
	#sortedReplaceMappings: Array<{ secret: string; replacement: string }> = [];

	/** Obfuscate-mode plain and regex-discovered mappings sorted longest-first. */
	#sortedObfuscateMappings: Array<{ secret: string; index: number; placeholder: string }> = [];

	/** Reverse lookup for obfuscate-mode secrets to avoid scanning mappings. */
	#obfuscateIndexBySecret = new Map<string, number>();

	/** Reverse lookup for deobfuscation: placeholder → secret */
	#deobfuscateMap = new Map<string, string>();

	/** Combined plain-secret regex cache for single-pass replacement. */
	#combinedPlainRegex: RegExp | undefined;
	#combinedPlainReplacementBySecret = new Map<string, string>();
	#combinedPlainRegexDirty = true;
	#useSequentialPlainReplacement = false;

	/** Next available index for regex match discoveries */
	#nextIndex: number;

	/** Whether any secrets were configured */
	#hasAny: boolean;

	constructor(entries: SecretEntry[], key: Uint8Array = randomBytes(32)) {
		if (key.byteLength !== 32) throw new Error("Secret obfuscation key must be 32 bytes");
		this.#placeholderKey = Uint8Array.from(key);
		let index = 0;
		for (const entry of entries) {
			const mode = entry.mode ?? "obfuscate";

			if (entry.type === "plain") {
				if (mode === "obfuscate") {
					const placeholder = buildPlaceholder(entry.content, this.#placeholderKey);
					this.#plainMappings.set(entry.content, index);
					this.#obfuscateMappings.set(index, { secret: entry.content, placeholder });
					this.#deobfuscateMap.set(placeholder, entry.content);
					this.#obfuscateIndexBySecret.set(entry.content, index);
					index++;
				} else {
					// replace mode
					const replacement =
						entry.replacement ?? generateDeterministicReplacement(entry.content, this.#placeholderKey);
					this.#replaceMappings.set(entry.content, replacement);
				}
			} else {
				// regex type — compiled here, matches discovered during obfuscate()
				try {
					const regex = compileSecretRegex(entry.content, entry.flags);
					this.#regexEntries.push({ regex, mode, replacement: entry.replacement });
				} catch {
					// Invalid regex — skip silently (validation happens at load time)
				}
			}
		}

		this.#nextIndex = index;
		this.#sortedReplaceMappings = [...this.#replaceMappings]
			.sort((a, b) => b[0].length - a[0].length)
			.map(([secret, replacement]) => ({ secret, replacement }));
		this.#sortedObfuscateMappings = [...this.#plainMappings]
			.sort((a, b) => b[0].length - a[0].length)
			.map(([secret, mappingIndex]) => ({
				secret,
				index: mappingIndex,
				placeholder: this.#obfuscateMappings.get(mappingIndex)!.placeholder,
			}));
		this.#hasAny = entries.length > 0;
	}

	hasSecrets(): boolean {
		return this.#hasAny;
	}

	/** Obfuscate all secrets in text. Bidirectional placeholders for obfuscate mode, one-way for replace. */
	obfuscate(text: string): string {
		if (!this.#hasAny) return text;
		let result = this.#obfuscatePlainMappings(text);

		// 3. Process regex entries — discover new matches
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = new Set<string>();
			for (;;) {
				const match = entry.regex.exec(result);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				matches.add(match[0]);
			}

			for (const matchValue of matches) {
				if (entry.mode === "replace") {
					const replacement =
						entry.replacement ?? generateDeterministicReplacement(matchValue, this.#placeholderKey);
					result = replaceAll(result, matchValue, replacement);
				} else {
					// obfuscate mode — get or create stable index
					let index = this.#findObfuscateIndex(matchValue);
					if (index === undefined) {
						index = this.#nextIndex++;
						const placeholder = buildPlaceholder(matchValue, this.#placeholderKey);
						this.#obfuscateMappings.set(index, { secret: matchValue, placeholder });
						this.#deobfuscateMap.set(placeholder, matchValue);
						this.#obfuscateIndexBySecret.set(matchValue, index);
						this.#insertSortedObfuscateMapping({ secret: matchValue, index, placeholder });
						this.#combinedPlainRegexDirty = true;
					}
					const mapping = this.#obfuscateMappings.get(index)!;
					result = replaceAll(result, matchValue, mapping.placeholder);
				}
			}
		}

		return result;
	}

	/** Deobfuscate obfuscate-mode placeholders back to original secrets. Replace-mode is NOT reversed. */
	deobfuscate(text: string): string {
		if (!this.#hasAny || !text.includes("#")) return text;
		return text.replace(PLACEHOLDER_RE, match => {
			return this.#deobfuscateMap.get(match) ?? match;
		});
	}

	/** Deep-walk an object, deobfuscating all string values. */
	deobfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}

	/** Find the obfuscate index for a known secret value. */
	#findObfuscateIndex(secret: string): number | undefined {
		return this.#obfuscateIndexBySecret.get(secret);
	}

	#insertSortedObfuscateMapping(mapping: { secret: string; index: number; placeholder: string }): void {
		let lo = 0;
		let hi = this.#sortedObfuscateMappings.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#sortedObfuscateMappings[mid]!.secret.length < mapping.secret.length) {
				hi = mid;
			} else {
				lo = mid + 1;
			}
		}
		this.#sortedObfuscateMappings.splice(lo, 0, mapping);
	}

	#obfuscatePlainMappings(text: string): string {
		this.#ensureCombinedPlainRegex();
		if (this.#useSequentialPlainReplacement) return this.#obfuscatePlainMappingsSequential(text);
		if (!this.#combinedPlainRegex) return text;
		return text.replace(
			this.#combinedPlainRegex,
			match => this.#combinedPlainReplacementBySecret.get(match) ?? match,
		);
	}

	#obfuscatePlainMappingsSequential(text: string): string {
		let result = text;
		for (const mapping of this.#sortedReplaceMappings) {
			result = replaceAll(result, mapping.secret, mapping.replacement);
		}
		for (const mapping of this.#sortedObfuscateMappings) {
			result = replaceAll(result, mapping.secret, mapping.placeholder);
		}
		return result;
	}

	#ensureCombinedPlainRegex(): void {
		if (!this.#combinedPlainRegexDirty) return;
		this.#combinedPlainRegexDirty = false;
		this.#combinedPlainReplacementBySecret = new Map<string, string>();

		const mappings = [
			...this.#sortedReplaceMappings.map(mapping => ({ secret: mapping.secret, replacement: mapping.replacement })),
			...this.#sortedObfuscateMappings.map(mapping => ({
				secret: mapping.secret,
				replacement: mapping.placeholder,
			})),
		];

		this.#useSequentialPlainReplacement = mappings.some((mapping, index) =>
			mappings.some(
				(other, otherIndex) =>
					other.secret.length > 0 &&
					(mapping.replacement.includes(other.secret) ||
						(index !== otherIndex &&
							(mapping.secret.includes(other.secret) || other.secret.includes(mapping.secret)))),
			),
		);
		for (const mapping of mappings) {
			if (!this.#combinedPlainReplacementBySecret.has(mapping.secret))
				this.#combinedPlainReplacementBySecret.set(mapping.secret, mapping.replacement);
		}
		this.#combinedPlainRegex =
			mappings.length > 0
				? new RegExp(mappings.map(mapping => escapeRegex(mapping.secret)).join("|"), "g")
				: undefined;
	}
}

export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	const messages = obfuscator.deobfuscateObject(sessionContext.messages);
	if (messages === sessionContext.messages) return sessionContext;
	transferSessionMessageIdentity(sessionContext.messages, messages);
	return { ...sessionContext, messages };
}

// ═══════════════════════════════════════════════════════════════════════════
// Message obfuscation (outbound to LLM)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Obfuscate text and tool-call arguments. Unsigned thinking text is redacted.
 * A block whose provider replays it under integrity metadata is omitted when a
 * configured secret occurs in those bytes or in the text that would be sent
 * with them. OpenAI Responses sends the reasoning item in `thinkingSignature`
 * (and, when present, `providerPayload` history) rather than the thinking
 * prose, so a clean signature is kept and only the prose is redacted. Image
 * payloads are not scanned.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	return messages.map(msg => {
		const payload = scrubHistoryPayload(obfuscator, readProviderPayload(msg));
		const payloadChanged = payload !== readProviderPayload(msg);
		if (!Array.isArray(msg.content)) {
			return payloadChanged ? ({ ...msg, providerPayload: payload } as typeof msg) : msg;
		}

		const api = msg.role === "assistant" ? msg.api : undefined;
		let changed = false;
		const content: object[] = [];
		for (const block of msg.content) {
			if (block.type === "text") {
				const obfuscated = obfuscator.obfuscate(block.text);
				if (obfuscated !== block.text) {
					changed = true;
					content.push({ ...block, text: obfuscated } as TextContent);
				} else {
					content.push(block);
				}
				continue;
			}
			if (block.type === "thinking") {
				const next = scrubThinkingBlock(obfuscator, block, api);
				if (next === undefined) {
					changed = true;
					continue;
				}
				if (next !== block) changed = true;
				content.push(next);
				continue;
			}
			if (block.type === "redactedThinking") {
				if (textHasSecret(obfuscator, block.data)) {
					changed = true;
					continue;
				}
				content.push(block);
				continue;
			}
			if (block.type === "toolCall") {
				const obfuscatedArguments = deepWalkStrings(block.arguments, text => obfuscator.obfuscate(text));
				const dropSignature =
					textHasSecret(obfuscator, block.thoughtSignature) || obfuscatedArguments !== block.arguments;
				if (dropSignature) {
					changed = true;
					const { thoughtSignature: _signature, ...rest } = block;
					content.push({ ...rest, arguments: obfuscatedArguments });
					continue;
				}
			}
			content.push(block);
		}

		if (!changed && !payloadChanged) return msg;
		const next = changed ? { ...msg, content } : { ...msg };
		return payloadChanged ? ({ ...next, providerPayload: payload } as typeof msg) : (next as typeof msg);
	});
}

function textHasSecret(obfuscator: SecretObfuscator, value: string | undefined): boolean {
	return value !== undefined && obfuscator.obfuscate(value) !== value;
}

const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);
const SIGNED_TEXT_APIS = new Set(["anthropic-messages", "bedrock-converse-stream"]);

/** Google only replays a thought signature when it is valid base64. */
function signatureIsGoogleThought(signature: string | undefined): boolean {
	if (!signature || signature.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/]+={0,2}$/.test(signature);
}

/**
 * Decide per provider whether thinking text can be redacted in place.
 * Anthropic, Bedrock, and Google send the thinking text together with a
 * signature, so a secret there drops the block instead of rewriting it.
 * Responses sends `JSON.parse(thinkingSignature)` and leaves the prose off
 * the wire, so a clean signature stays byte-for-byte.
 */
function scrubThinkingBlock<
	T extends {
		type: "thinking";
		thinking: string;
		thinkingSignature?: string;
		itemId?: string;
		summaryText?: string;
		rawText?: string;
	},
>(obfuscator: SecretObfuscator, block: T, api: string | undefined): T | undefined {
	const secretInSignature = textHasSecret(obfuscator, block.thinkingSignature);
	const secretInItemId = textHasSecret(obfuscator, block.itemId);
	const secretInSemantic =
		textHasSecret(obfuscator, block.thinking) ||
		textHasSecret(obfuscator, block.summaryText) ||
		textHasSecret(obfuscator, block.rawText);

	if (api !== undefined && RESPONSES_APIS.has(api)) {
		if (secretInSignature || secretInItemId) return undefined;
		if (!secretInSemantic) return block;
		return redactThinkingText(obfuscator, block);
	}
	if (api === "openai-completions") {
		if (secretInSignature || secretInItemId) return undefined;
		if (!secretInSemantic) return block;
		return redactThinkingText(obfuscator, block);
	}
	if (api?.startsWith("google-")) {
		if (secretInSignature || secretInItemId) return undefined;
		if (signatureIsGoogleThought(block.thinkingSignature) && secretInSemantic) return undefined;
		if (!secretInSemantic) return block;
		return redactThinkingText(obfuscator, block);
	}
	if (api !== undefined && SIGNED_TEXT_APIS.has(api)) {
		const signed = Boolean(block.thinkingSignature?.trim());
		if (secretInSignature || secretInItemId || (signed && secretInSemantic)) return undefined;
		if (!secretInSemantic) return block;
		return redactThinkingText(obfuscator, block);
	}
	const signed = Boolean(block.thinkingSignature?.trim() || block.itemId?.trim());
	if (secretInSignature || secretInItemId || (signed && secretInSemantic)) return undefined;
	if (!secretInSemantic) return block;
	return redactThinkingText(obfuscator, block);
}

function redactThinkingText<
	T extends {
		thinking: string;
		summaryText?: string;
		rawText?: string;
	},
>(obfuscator: SecretObfuscator, block: T): T {
	const thinking = obfuscator.obfuscate(block.thinking);
	const summaryText = block.summaryText !== undefined ? obfuscator.obfuscate(block.summaryText) : undefined;
	const rawText = block.rawText !== undefined ? obfuscator.obfuscate(block.rawText) : undefined;
	if (thinking === block.thinking && summaryText === block.summaryText && rawText === block.rawText) return block;
	return {
		...block,
		thinking,
		...(block.summaryText !== undefined ? { summaryText } : {}),
		...(block.rawText !== undefined ? { rawText } : {}),
	};
}

function readProviderPayload(msg: object): { type?: unknown; items?: unknown } | undefined {
	if (!("providerPayload" in msg)) return undefined;
	return (msg as { providerPayload?: { type?: unknown; items?: unknown } }).providerPayload;
}

/**
 * Native Responses replay prefers `providerPayload.items` over thinking blocks.
 * Reasoning items are opaque and are dropped whole. Tool arguments and message
 * text are semantic and are redacted in place.
 */
function scrubHistoryPayload<T>(obfuscator: SecretObfuscator, payload: T): T {
	if (!payload || typeof payload !== "object") return payload;
	const record = payload as { type?: unknown; items?: unknown };
	if (record.type !== "openaiResponsesHistory" || !Array.isArray(record.items)) return payload;
	let changed = false;
	const items: unknown[] = [];
	for (const item of record.items) {
		const next = scrubHistoryItem(obfuscator, item);
		if (next === undefined) {
			changed = true;
			continue;
		}
		if (next !== item) changed = true;
		items.push(next);
	}
	if (!changed) return payload;
	return { ...record, items } as T;
}

function scrubHistoryItem(obfuscator: SecretObfuscator, item: unknown): unknown | undefined {
	if (!item || typeof item !== "object") {
		return typeof item === "string" && textHasSecret(obfuscator, item) ? undefined : item;
	}
	const record = item as Record<string, unknown>;
	if (record.type === "reasoning") return historyItemHasSecret(obfuscator, record) ? undefined : record;
	if (record.type === "function_call") return rewriteHistoryField(obfuscator, record, "arguments");
	if (record.type === "custom_tool_call") return rewriteHistoryField(obfuscator, record, "input");
	if (record.type === "function_call_output" || record.type === "custom_tool_call_output") {
		return rewriteHistoryField(obfuscator, record, "output");
	}
	if (record.type === "message" && Array.isArray(record.content)) {
		const content = deepWalkStrings(record.content, text => obfuscator.obfuscate(text));
		return content === record.content ? record : { ...record, content };
	}
	return historyItemHasSecret(obfuscator, record) ? undefined : record;
}

function rewriteHistoryField(
	obfuscator: SecretObfuscator,
	item: Record<string, unknown>,
	key: "arguments" | "input" | "output",
): Record<string, unknown> {
	if (!(key in item)) return item;
	const next = deepWalkStrings(item[key], text => obfuscator.obfuscate(text));
	return next === item[key] ? item : { ...item, [key]: next };
}

function historyItemHasSecret(obfuscator: SecretObfuscator, item: Record<string, unknown>): boolean {
	let encoded: string;
	try {
		encoded = JSON.stringify(item);
	} catch {
		return false;
	}
	return textHasSecret(obfuscator, encoded);
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Replace all occurrences of `search` in `text` with `replacement`. */
function replaceAll(text: string, search: string, replacement: string): string {
	if (search.length === 0 || !text.includes(search)) return text;
	return text.split(search).join(replacement);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deep-walk an object, transforming all string values. */
function deepWalkStrings<T>(obj: T, transform: (s: string) => string): T {
	if (typeof obj === "string") {
		return transform(obj) as unknown as T;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result = obj.map(item => {
			const transformed = deepWalkStrings(item, transform);
			if (transformed !== item) changed = true;
			return transformed;
		});
		return (changed ? result : obj) as unknown as T;
	}
	if (obj !== null && typeof obj === "object") {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(obj)) {
			const value = (obj as Record<string, unknown>)[key];
			const transformed = deepWalkStrings(value, transform);
			if (transformed !== value) changed = true;
			Object.defineProperty(result, key, {
				value: transformed,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return (changed ? result : obj) as T;
	}
	return obj;
}
