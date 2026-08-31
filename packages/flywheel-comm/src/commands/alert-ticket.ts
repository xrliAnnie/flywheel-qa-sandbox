import { normalizeOptionalBearer } from "flywheel-config";

export interface AlertTicketCommandOptions {
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: typeof fetch;
	delay?: (ms: number) => Promise<void>;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
}

type AlertTicketAction = "ack" | "handoff" | "resolve" | "outstanding";

function valueAfter(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function exitCodeForStatus(status: number): number {
	if (status === 404) return 4;
	if (status === 400 || status === 403 || status === 409) return 3;
	return 5;
}

async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return { error: `HTTP ${response.status}` };
	}
}

export async function runAlertTicketCommand(
	argv: string[],
	opts: AlertTicketCommandOptions = {},
): Promise<number> {
	const writeStdout =
		opts.writeStdout ?? ((text) => process.stdout.write(text));
	const writeStderr =
		opts.writeStderr ?? ((text) => process.stderr.write(text));
	const env = opts.env ?? process.env;
	const action = argv[0] as AlertTicketAction | undefined;
	if (
		action !== "ack" &&
		action !== "handoff" &&
		action !== "resolve" &&
		action !== "outstanding"
	) {
		writeStderr(
			"alert-ticket: usage: alert-ticket ack|handoff|resolve|outstanding [options]\n",
		);
		return 2;
	}

	const messageId = valueAfter(argv, "message-id")?.trim();
	const eventId = valueAfter(argv, "event-id")?.trim();
	const to = valueAfter(argv, "to")?.trim();
	const limitRaw = valueAfter(argv, "limit")?.trim();
	const since = valueAfter(argv, "since")?.trim();
	if (action !== "outstanding") {
		if (Number(Boolean(messageId)) + Number(Boolean(eventId)) !== 1) {
			writeStderr(
				"alert-ticket: exactly one of --message-id or --event-id is required\n",
			);
			return 2;
		}
		if (action === "handoff" && !to) {
			writeStderr("alert-ticket: handoff requires --to <lead-id>\n");
			return 2;
		}
		if (argv.includes("--limit") || argv.includes("--since")) {
			writeStderr(
				"alert-ticket: --limit and --since are only valid for outstanding\n",
			);
			return 2;
		}
	} else if (messageId || eventId || to) {
		writeStderr(
			"alert-ticket: outstanding does not accept a locator or --to\n",
		);
		return 2;
	}
	const limit = limitRaw === undefined ? undefined : Number(limitRaw);
	if (
		action === "outstanding" &&
		((argv.includes("--limit") &&
			(limit === undefined ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 100)) ||
			(argv.includes("--since") && !since))
	) {
		writeStderr(
			"alert-ticket: outstanding --limit must be 1..100 and --since needs an event cursor\n",
		);
		return 2;
	}

	const token = normalizeOptionalBearer(env.FLYWHEEL_ALERT_DUTY_TOKEN);
	const bridgeUrl =
		valueAfter(argv, "bridge-url")?.trim() ||
		env.FLYWHEEL_BRIDGE_URL?.trim() ||
		env.BRIDGE_URL?.trim();
	if (!token || !bridgeUrl) {
		writeStderr(
			`alert-ticket: ${!token ? "FLYWHEEL_ALERT_DUTY_TOKEN" : "Bridge URL"} is not configured\n`,
		);
		return 5;
	}

	const waitRaw = valueAfter(argv, "wait");
	const waitSeconds = waitRaw === undefined ? 0 : Number(waitRaw);
	if (
		!Number.isSafeInteger(waitSeconds) ||
		waitSeconds < 0 ||
		waitSeconds > 300 ||
		(waitSeconds > 0 && (action !== "ack" || !messageId))
	) {
		writeStderr(
			"alert-ticket: --wait must be 0..300 seconds and is only valid for ack --message-id\n",
		);
		return 2;
	}

	const fetchImpl = opts.fetchImpl ?? fetch;
	const base = bridgeUrl.replace(/\/+$/, "");
	const outstanding = action === "outstanding";
	const query = new URLSearchParams();
	if (outstanding && limit !== undefined) query.set("limit", String(limit));
	if (outstanding && since) query.set("since", since);
	const queryString = query.size > 0 ? `?${query.toString()}` : "";
	const url = `${base}/duty/alert-tickets/${outstanding ? "outstanding" : "transition"}${queryString}`;
	const requestBody = outstanding
		? undefined
		: {
				action,
				...(messageId ? { messageId } : { eventId }),
				...(action === "handoff" ? { to } : {}),
			};
	const retries = waitSeconds > 0 ? Math.ceil(waitSeconds / 10) : 0;
	const delay =
		opts.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
	let response: Response;
	try {
		for (let attempt = 0; ; attempt += 1) {
			response = await fetchImpl(url, {
				method: outstanding ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					...(outstanding ? {} : { "Content-Type": "application/json" }),
				},
				...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
				// resolve performs root read/edit + thread post/archive serially on the
				// Bridge. A short client deadline can report failure after the server has
				// already committed RESOLVED, so only that action gets the wider window.
				signal: AbortSignal.timeout(action === "resolve" ? 30_000 : 5_000),
			});
			if (response.status !== 404 || attempt >= retries) break;
			await delay(10_000);
		}
	} catch (error) {
		writeStderr(
			`alert-ticket: Bridge request failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 5;
	}

	const body = await responseJson(response);
	if (!response.ok) {
		writeStderr(`alert-ticket: ${JSON.stringify(body)}\n`);
		return exitCodeForStatus(response.status);
	}
	if (argv.includes("--json")) {
		writeStdout(`${JSON.stringify(body)}\n`);
	} else if (
		outstanding &&
		typeof body === "object" &&
		body !== null &&
		Array.isArray((body as { tickets?: unknown }).tickets)
	) {
		for (const ticket of (body as { tickets: unknown[] }).tickets) {
			writeStdout(`${JSON.stringify(ticket)}\n`);
		}
	} else {
		writeStdout(`alert-ticket ${action}: ok\n`);
	}
	return 0;
}
