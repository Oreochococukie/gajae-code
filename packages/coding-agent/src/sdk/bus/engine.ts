import { redactCrashSecrets, replaceAbsolutePaths } from "@gajae-code/utils";
import { buildRedactedAction, type RedactableAction } from "./config";

/**
 * Outbound crash scrub (`redactCrashSecrets`, then `replaceAbsolutePaths`).
 * One scanner holds each http(s) URL from scheme:// up to whitespace or a
 * closing quote or backtick. Balanced `()` and `[]` stay inside that span,
 * and nothing inside the span is path-masked. Asks stay answerable.
 * Runs before adapter truncation.
 */
function redactEgressText(value: string): string {
	const scrubbed = redactCrashSecrets(value);
	const urls: string[] = [];
	let shielded = "";
	let cursor = 0;
	for (const match of scrubbed.matchAll(/https?:\/\//gi)) {
		const start = match.index ?? 0;
		if (start < cursor) continue;
		const prev = start > 0 ? scrubbed.charAt(start - 1) : "";
		if (prev !== "" && /[A-Za-z0-9+.-]/.test(prev)) continue;
		const end = httpUrlEnd(scrubbed, start);
		shielded += scrubbed.slice(cursor, start);
		shielded += `\uE000${urls.length}\uE001`;
		urls.push(scrubbed.slice(start, end));
		cursor = end;
	}
	shielded += scrubbed.slice(cursor);
	return replaceAbsolutePaths(shielded).replace(/\uE000(\d+)\uE001/g, (_match, index) => urls[Number(index)] ?? "");
}

/** End of one URL span. An unmatched `)` or `]` ends the span before that character. */
function httpUrlEnd(value: string, start: number): number {
	const stack: string[] = [];
	let index = start;
	while (index < value.length) {
		const ch = value.charAt(index);
		if (/\s/u.test(ch) || ch === '"' || ch === "'" || ch === "`") break;
		if (ch === "(" || ch === "[") {
			stack.push(ch);
			index += 1;
			continue;
		}
		if (ch === ")" || ch === "]") {
			const open = ch === ")" ? "(" : "[";
			if (stack.length > 0 && stack[stack.length - 1] === open) {
				stack.pop();
				index += 1;
				continue;
			}
			break;
		}
		index += 1;
	}
	return index;
}

function redactFrameFields(frame: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(frame)) {
		out[key] = typeof field === "string" ? redactEgressText(field) : field;
	}
	return out;
}

export type NotificationEvent =
	| ({ type: "action_needed" } & RedactableAction)
	| { type: "action_resolved"; id: string; sessionId: string; resolvedBy?: string }
	| { type: "frame"; sessionId: string; frame: Record<string, unknown> };

export interface NotificationReplyRoute {
	sessionId: string;
	actionId: string;
	answer: number | string | { selected?: Array<number | string>; custom?: string };
}

export interface NotificationAdapterPayload {
	adapter: string;
	channelKey?: string;
	body: unknown;
	route?: Omit<NotificationReplyRoute, "answer">;
}

export interface NotificationPresentationAdapter {
	readonly kind: "telegram" | "discord" | "slack";
	render(event: NotificationEvent): NotificationAdapterPayload[];
	mapInbound(input: unknown): NotificationReplyRoute | undefined;
}

export interface EngineSessionSink {
	sendReply(route: NotificationReplyRoute): void;
}

export interface NotificationEngineOptions {
	redact: boolean;
}

/**
 * Shared presentation engine for managed notification clients.
 *
 * It owns fanout, redaction boundaries, pending-action routing, and reply
 * delivery into session sinks. Transport adapters stay pure: render an internal
 * event into a public-safe payload and map an inbound transport interaction
 * back into a session/action answer.
 */
export class NotificationPresentationEngine {
	readonly adapters: readonly NotificationPresentationAdapter[];
	private readonly sessions = new Map<string, EngineSessionSink>();
	private readonly pending = new Map<string, { sessionId: string; actionId: string }>();

	constructor(
		adapters: readonly NotificationPresentationAdapter[],
		private readonly opts: NotificationEngineOptions,
	) {
		this.adapters = adapters;
	}

	connectSession(sessionId: string, sink: EngineSessionSink): void {
		this.sessions.set(sessionId, sink);
	}

	dropSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		for (const [key, route] of this.pending) {
			if (route.sessionId === sessionId) this.pending.delete(key);
		}
	}

	fanout(event: NotificationEvent): NotificationAdapterPayload[] {
		const safeEvent = this.redactEvent(event);
		if (safeEvent.type === "action_needed" && safeEvent.kind === "ask") {
			this.pending.set(safeEvent.id, { sessionId: safeEvent.sessionId, actionId: safeEvent.id });
		}
		if (safeEvent.type === "action_resolved") {
			this.pending.delete(safeEvent.id);
		}
		return this.adapters.flatMap(adapter => adapter.render(safeEvent));
	}

	routeInbound(adapterKind: NotificationPresentationAdapter["kind"], input: unknown): boolean {
		const adapter = this.adapters.find(candidate => candidate.kind === adapterKind);
		const route = adapter?.mapInbound(input);
		if (!route) return false;
		const pending = this.pending.get(route.actionId);
		if (!pending || pending.sessionId !== route.sessionId) return false;
		const sink = this.sessions.get(route.sessionId);
		if (!sink) return false;
		sink.sendReply(route);
		return true;
	}

	private redactEvent(event: NotificationEvent): NotificationEvent {
		if (!this.opts.redact) return event;
		if (event.type === "frame") {
			return { ...event, frame: redactFrameFields(event.frame) };
		}
		if (event.type !== "action_needed") return event;
		const redacted = buildRedactedAction(event, { redact: true });
		if (event.kind !== "ask") return { ...redacted, type: "action_needed" };
		return {
			...redacted,
			type: "action_needed",
			...(event.question === undefined ? {} : { question: redactEgressText(event.question) }),
			...(event.options === undefined ? {} : { options: event.options.map(option => redactEgressText(option)) }),
		};
	}
}
