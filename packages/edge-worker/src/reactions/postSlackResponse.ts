/**
 * Post a follow-up message to Slack's response_url.
 * Best-effort: logs errors but does not throw.
 */
export async function postSlackResponse(
	responseUrl: string,
	text: string,
): Promise<void> {
	if (!isValidSlackResponseUrl(responseUrl)) {
		console.warn(
			`[postSlackResponse] Invalid response URL (not Slack): ${redactUrl(responseUrl)}`,
		);
		return;
	}

	try {
		const response = await fetch(responseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ replace_original: false, text }),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			console.warn(
				`[postSlackResponse] Non-OK response: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
			);
		} else {
			await response.text().catch(() => {});
		}
	} catch (err) {
		console.warn(
			`[postSlackResponse] Failed to post: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.hostname}/***`;
	} catch {
		return "(invalid URL)";
	}
}

function isValidSlackResponseUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname.endsWith(".slack.com")
		);
	} catch {
		return false;
	}
}
