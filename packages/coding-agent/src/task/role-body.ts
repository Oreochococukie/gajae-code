/**
 * Keep a subagent role body inside the host [ROLE] block.
 *
 * The body is the agent instruction. It is inserted between host [ROLE] and
 * [/ROLE]. A literal framing tag would end that block early. Only the four
 * host framing names are rewritten; other brackets stay literal.
 */
const HOST_FRAMING_TAG_SOURCE =
	"\\[(?:[\\u200b\\u200c\\u200d\\ufeff]|\\s)*\\/?(?:[\\u200b\\u200c\\u200d\\ufeff]|\\s)*(?:role|context|coop|completion)(?:[\\u200b\\u200c\\u200d\\ufeff]|\\s)*\\]";

const FULLWIDTH_LEFT = "［";
const FULLWIDTH_RIGHT = "］";

export function containSubagentRoleBody(body: string): string {
	return body.replace(new RegExp(HOST_FRAMING_TAG_SOURCE, "gi"), tag =>
		tag.replaceAll("[", FULLWIDTH_LEFT).replaceAll("]", FULLWIDTH_RIGHT),
	);
}

export function subagentRoleBodyHasHostFramingTag(body: string): boolean {
	return new RegExp(HOST_FRAMING_TAG_SOURCE, "i").test(body);
}
