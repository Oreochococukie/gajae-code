/**
 * Best-effort credential scrubbing for durable crash records.
 *
 * This is a *persistence-time* scrub: it keeps obvious credential shapes out of
 * a file GJC keeps indefinitely. It is explicitly NOT a privacy guarantee and
 * must never be treated as one for data that leaves the machine — outbound
 * text goes through `sanitizeExternalCrashV1` instead.
 */

const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_LABEL = "PRIVATE KEY-----";
const PEM_MARKER = "«redacted-private-key»";

/** Header or footer end, or -1. The type prefix is only A-Z, digits, and spaces, then the label. */
function privateKeyMarkerEnd(text: string, at: number, token: string): number {
	let j = at + token.length;
	const n = text.length;
	while (j < n) {
		if (text.startsWith(PEM_LABEL, j)) return j + PEM_LABEL.length;
		const c = text.charCodeAt(j);
		if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32) {
			j++;
			continue;
		}
		return -1;
	}
	return -1;
}

/**
 * Replace each complete private-key block in one forward pass.
 * An opening banner with no footer later in the text is left as-is, and the scan stops.
 */
function redactPemPrivateKeys(text: string): string {
	const parts: string[] = [];
	let cursor = 0;
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf(PEM_BEGIN, i);
		if (start < 0) break;
		const headerEnd = privateKeyMarkerEnd(text, start, PEM_BEGIN);
		if (headerEnd < 0) {
			i = start + PEM_BEGIN.length;
			continue;
		}
		let footerEnd = -1;
		let j = headerEnd;
		while (j < text.length) {
			const endAt = text.indexOf(PEM_END, j);
			if (endAt < 0) break;
			const candidate = privateKeyMarkerEnd(text, endAt, PEM_END);
			if (candidate >= 0) {
				footerEnd = candidate;
				break;
			}
			j = endAt + PEM_END.length;
		}
		if (footerEnd < 0) break;
		parts.push(text.slice(cursor, start), PEM_MARKER);
		cursor = footerEnd;
		i = footerEnd;
	}
	if (cursor === 0) return text;
	parts.push(text.slice(cursor));
	return parts.join("");
}

/**
 * Scrub credential material from crash text before it is persisted.
 * Covers bearer/basic-style headers, key=value or JSON key forms of common
 * credential names, and well-known vendor token shapes. Normal messages and
 * stack frames are untouched; matches are replaced in place so surrounding
 * diagnostic context survives.
 */
export function redactCrashSecrets(text: string): string {
	let redacted = text;
	redacted = redacted.replace(/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "«redacted-auth»");
	redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "«redacted-jwt»");
	redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "«redacted-api-key»");
	// `gh[opsur]_` covers the classic PAT/OAuth/server/user/refresh prefixes;
	// fine-grained PATs use an entirely different `github_pat_` prefix and would
	// otherwise survive into a log the module keeps indefinitely.
	redacted = redacted.replace(/\bgh[opsur]_[A-Za-z0-9]{16,}\b/g, "«redacted-github-token»");
	redacted = redacted.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "«redacted-github-token»");
	redacted = redacted.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "«redacted-slack-token»");
	// The five shapes below are the ones `crash/upstream/envelope.ts` already
	// classifies as credential-like and refuses to transmit. That refusal only
	// guards the Sentry frame fields; the persisted crash log and the
	// `gjc crash report` body — which the user files as a public issue — reach
	// egress through this function alone, so the same shapes have to be named here.
	redacted = redacted.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "«redacted-npm-token»");
	redacted = redacted.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "«redacted-gitlab-token»");
	// Stripe separates with `_`, so the `sk-` rule above never matched one.
	redacted = redacted.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "«redacted-api-key»");
	redacted = redacted.replace(/\bhf_[A-Za-z0-9]{20,}\b/g, "«redacted-api-key»");
	// A PEM block carries the key material itself, so it is replaced whole, in one
	// forward pass, before the narrower rules chew on the base64 body.
	redacted = redactPemPrivateKeys(redacted);
	// Google API keys are a fixed 39-character shape that carries no label of its
	// own, so the labeled-value rule below never sees one.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
		"«redacted-google-api-key»",
	);
	// Basic-auth credentials embedded in a URL. Scheme and host stay readable
	// because they are the diagnostic value; only the userinfo is dropped. The
	// scheme repetition is bounded: an unbounded `[a-z0-9+.-]*` in front of the
	// literal `://` re-tries every prefix of a long alphabetic run, which is
	// quadratic in input length and costs ~10s on a 200 KB crash body.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi,
		"$1«redacted-url-credential»@",
	);
	// AKIA is the long-term access key id; ASIA is the temporary/STS one, which is
	// the shape that actually shows up in a crashed request. ABIA (bearer) and
	// ACCA (context) complete the set the session-import scrubber already lists.
	// The id alone is not
	// the credential: an STS payload carries `SecretAccessKey` and `SessionToken`
	// alongside it, so the labeled-value rule below must name both. `secret_key`
	// does not match `SecretAccessKey` (the canonical field has `Access` in the
	// middle), and `access_token` does not match `SessionToken`.
	redacted = redacted.replace(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, "«redacted-aws-key»");
	// `AWS_` sits on the underscore lookbehind, so `secret_access_key` never
	// matched `AWS_SECRET_ACCESS_KEY=`. `sessionid=` is the literal cookie;
	// `sessionid%3D` is the same cookie with `=` percent-encoded, which the
	// `=` rule cannot see. A bare AWS secret is 40 base64 characters with no
	// prefix; requiring `/` or `+` leaves a 40-character alphanumeric token.
	redacted = redacted.replace(
		/(?<![A-Za-z0-9_])(["']?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?id|session[_-]?token|client[_-]?secret|secret[_-]?key|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|password|passwd|authorization)["']?\s*[=:]\s*["']?)[^\s"',;}\]]{8,}/gi,
		"$1«redacted»",
	);
	redacted = redacted.replace(/(?<![A-Za-z0-9_%])(session(?:id|[_-]id)%3[Dd])[A-Za-z0-9._~%-]{8,}/gi, "$1«redacted»");
	redacted = redacted.replace(
		/(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
		"«redacted-aws-key»",
	);
	return redacted;
}

/** Every placeholder `redactCrashSecrets` can emit. Used by downstream normalizers. */
export const CRASH_REDACTION_MARKERS: readonly string[] = [
	"«redacted-auth»",
	"«redacted-jwt»",
	"«redacted-api-key»",
	"«redacted-github-token»",
	"«redacted-slack-token»",
	"«redacted-npm-token»",
	"«redacted-gitlab-token»",
	"«redacted-aws-key»",
	"«redacted-private-key»",
	"«redacted-google-api-key»",
	"«redacted-url-credential»",
	"«redacted»",
];
