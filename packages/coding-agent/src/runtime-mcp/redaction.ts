const REDACTED = "<redacted>";

export function redactMCPEndpoint(value: string | undefined): string | undefined {
	if (!value) return value;
	try {
		const url = new URL(value);
		if (url.username) url.username = REDACTED;
		if (url.password) url.password = REDACTED;
		for (const key of Array.from(url.searchParams.keys())) {
			url.searchParams.set(key, REDACTED);
		}
		url.hash = "";
		return url.toString();
	} catch {
		return REDACTED;
	}
}
