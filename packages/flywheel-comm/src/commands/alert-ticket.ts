import { normalizeOptionalBearer } from "flywheel-config";
import { type AlertLookup, runOncallDraftCommand } from "./oncall-draft.js";

export interface AlertTicketCommandOptions {
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: typeof fetch;
	delay?: (ms: number) => Promise<void>;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
}

type AlertTicketAction =
	| "lookup"
	| "ack"
	| "handoff"
	| "resolve"
	| "outstanding"
	| "board";

type Locator =
	| { messageId: string; eventId?: never }
	| { eventId: string; messageId?: never };

interface AlertBoardBody {
	totals?: {
		unreviewed?: number;
		in_duty?: number;
		handed_off?: number;
		resolved_in_window?: number;
	};
	items?: Array<Record<string, unknown>>;
	nextCursor?: string | null;
	truncated?: boolean;
}

const DUTY_UNCONFIGURED_MESSAGE =
	"alert-ticket: duty write path unconfigured on Bridge (FLYWHEEL_ALERT_DUTY_TOKEN)\n";

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

function parseLocator(argv: string[]): Locator | undefined {
	const messageId = valueAfter(argv, "message-id")?.trim();
	const eventId = valueAfter(argv, "event-id")?.trim();
	if (Number(Boolean(messageId)) + Number(Boolean(eventId)) !== 1) {
		return undefined;
	}
	return messageId ? { messageId } : { eventId: eventId as string };
}

function lookupQuery(locator: Locator): string {
	const query = new URLSearchParams();
	if (locator.messageId) query.set("messageId", locator.messageId);
	else query.set("eventId", locator.eventId as string);
	return query.toString();
}

function isAlertLookup(body: unknown): body is AlertLookup {
	if (typeof body !== "object" || body === null) return false;
	const value = body as Partial<AlertLookup>;
	return (
		(value.lane === "thread" || value.lane === "mailbox") &&
		typeof value.correlationKey === "string" &&
		Boolean(value.correlationKey) &&
		typeof value.eventId === "string" &&
		Boolean(value.eventId) &&
		typeof value.kind === "string" &&
		Boolean(value.kind) &&
		typeof value.ref === "string" &&
		Boolean(value.ref)
	);
}

function normalizedResolvedSince(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const relative = /^(\d+)d$/.exec(raw);
	if (!relative) return raw;
	const days = Number(relative[1]);
	if (!Number.isSafeInteger(days) || days < 1 || days > 3650) return raw;
	return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

function writeBoardHuman(
	body: AlertBoardBody,
	writeStdout: (text: string) => void,
): void {
	const totals = body.totals ?? {};
	writeStdout(
		`unreviewed=${totals.unreviewed ?? 0} in_duty=${totals.in_duty ?? 0} handed_off=${totals.handed_off ?? 0} resolved_in_window=${totals.resolved_in_window ?? 0}\n`,
	);
	writeStdout("lane\tkind\tstate\towner\troute\tletter\tfires\topened\n");
	for (const item of body.items ?? []) {
		const values = [
			item.lane,
			item.kind,
			item.state,
			item.ownerRef,
			item.routeClass,
			item.handoffLetter,
			item.fireCount,
			item.openedAt,
		].map((value) =>
			value === null || value === undefined || value === ""
				? "-"
				: String(value),
		);
		writeStdout(`${values.join("\t")}\n`);
	}
	if (body.truncated && body.nextCursor) {
		writeStdout(`nextCursor=${body.nextCursor}\n`);
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
		action !== "lookup" &&
		action !== "ack" &&
		action !== "handoff" &&
		action !== "resolve" &&
		action !== "outstanding" &&
		action !== "board"
	) {
		writeStderr(
			"alert-ticket: usage: alert-ticket lookup|ack|handoff|resolve|outstanding|board [options]\n",
		);
		return 2;
	}

	const locatorAction =
		action === "lookup" ||
		action === "ack" ||
		action === "handoff" ||
		action === "resolve";
	const locator = locatorAction ? parseLocator(argv) : undefined;
	if (locatorAction && !locator) {
		writeStderr(
			"alert-ticket: exactly one of --message-id or --event-id is required\n",
		);
		return 2;
	}

	const to = valueAfter(argv, "to")?.trim();
	const reason = valueAfter(argv, "reason")?.trim();
	const note = valueAfter(argv, "note")?.trim();
	const draft = valueAfter(argv, "draft")?.trim();
	if (action === "handoff") {
		if (!to) {
			writeStderr("alert-ticket: handoff requires --to <lead-id>\n");
			return 2;
		}
		if (reason !== "contact_book" && reason !== "no_entry") {
			writeStderr(
				"alert-ticket: handoff requires --reason contact_book|no_entry\n",
			);
			return 2;
		}
		if (note && note.length > 400) {
			writeStderr(
				"alert-ticket: handoff --note must be at most 400 characters\n",
			);
			return 2;
		}
	}
	if (action === "resolve" && !draft) {
		writeStderr("alert-ticket: resolve requires --draft <file|->\n");
		return 2;
	}

	const limitRaw = valueAfter(argv, "limit")?.trim();
	const since = valueAfter(argv, "since")?.trim();
	const resolvedSinceRaw = valueAfter(argv, "resolved-since")?.trim();
	const cursor = valueAfter(argv, "cursor")?.trim();
	const limit = limitRaw === undefined ? undefined : Number(limitRaw);
	if (action === "outstanding") {
		if (
			locator ||
			to ||
			reason ||
			note ||
			draft ||
			resolvedSinceRaw ||
			cursor
		) {
			writeStderr(
				"alert-ticket: outstanding accepts only --limit, --since, and --json\n",
			);
			return 2;
		}
		if (
			(argv.includes("--limit") &&
				(limit === undefined ||
					!Number.isSafeInteger(limit) ||
					limit < 1 ||
					limit > 100)) ||
			(argv.includes("--since") && !since)
		) {
			writeStderr(
				"alert-ticket: outstanding --limit must be 1..100 and --since needs an event cursor\n",
			);
			return 2;
		}
	} else if (action === "board") {
		if (
			valueAfter(argv, "message-id") ||
			valueAfter(argv, "event-id") ||
			to ||
			reason ||
			note ||
			draft ||
			since ||
			(argv.includes("--limit") &&
				(limit === undefined ||
					!Number.isSafeInteger(limit) ||
					limit < 1 ||
					limit > 500)) ||
			(argv.includes("--resolved-since") && !resolvedSinceRaw) ||
			(argv.includes("--cursor") && !cursor)
		) {
			writeStderr(
				"alert-ticket: board accepts --resolved-since, --limit 1..500, --cursor, and --json\n",
			);
			return 2;
		}
	} else if (
		argv.includes("--limit") ||
		argv.includes("--since") ||
		argv.includes("--resolved-since") ||
		argv.includes("--cursor")
	) {
		writeStderr("alert-ticket: list options are not valid for this action\n");
		return 2;
	}

	const token = normalizeOptionalBearer(env.FLYWHEEL_ALERT_DUTY_TOKEN);
	const bridgeUrl =
		valueAfter(argv, "bridge-url")?.trim() ||
		env.FLYWHEEL_BRIDGE_URL?.trim() ||
		env.BRIDGE_URL?.trim();
	if (!token) {
		writeStderr(DUTY_UNCONFIGURED_MESSAGE);
		return 5;
	}
	if (!bridgeUrl) {
		writeStderr("alert-ticket: Bridge URL is not configured\n");
		return 5;
	}

	const waitRaw = valueAfter(argv, "wait");
	const waitSeconds = waitRaw === undefined ? 0 : Number(waitRaw);
	if (
		!Number.isSafeInteger(waitSeconds) ||
		waitSeconds < 0 ||
		waitSeconds > 300 ||
		(waitSeconds > 0 && (action !== "ack" || !locator?.messageId))
	) {
		writeStderr(
			"alert-ticket: --wait must be 0..300 seconds and is only valid for ack --message-id\n",
		);
		return 2;
	}

	const fetchImpl = opts.fetchImpl ?? fetch;
	const base = bridgeUrl.replace(/\/+$/, "");
	const request = async (
		url: string,
		init: RequestInit,
		retries = 0,
	): Promise<{ response: Response; body: unknown } | { error: unknown }> => {
		const delay =
			opts.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
		try {
			let response: Response;
			for (let attempt = 0; ; attempt += 1) {
				response = await fetchImpl(url, init);
				if (response.status !== 404 || attempt >= retries) break;
				await delay(10_000);
			}
			return { response, body: await responseJson(response) };
		} catch (error) {
			return { error };
		}
	};
	const handleFailure = (
		result: { response: Response; body: unknown } | { error: unknown },
	): number | undefined => {
		if ("error" in result) {
			writeStderr(
				`alert-ticket: Bridge request failed: ${result.error instanceof Error ? result.error.message : String(result.error)}\n`,
			);
			return 5;
		}
		if (result.response.ok) return undefined;
		if (
			result.response.status === 503 &&
			typeof result.body === "object" &&
			result.body !== null &&
			(result.body as { error?: unknown }).error === "alert_duty_unconfigured"
		) {
			writeStderr(DUTY_UNCONFIGURED_MESSAGE);
		} else {
			writeStderr(`alert-ticket: ${JSON.stringify(result.body)}\n`);
		}
		return exitCodeForStatus(result.response.status);
	};

	if (action === "lookup" || action === "resolve") {
		const lookupResult = await request(
			`${base}/duty/alert-tickets/lookup?${lookupQuery(locator as Locator)}`,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(5_000),
			},
		);
		const lookupFailure = handleFailure(lookupResult);
		if (lookupFailure !== undefined) return lookupFailure;
		const lookupBody = (lookupResult as { body: unknown }).body;
		if (!isAlertLookup(lookupBody)) {
			writeStderr("alert-ticket: invalid lookup response from Bridge\n");
			return 5;
		}
		if (action === "lookup") {
			writeStdout(
				argv.includes("--json")
					? `${JSON.stringify(lookupBody)}\n`
					: `alert-ticket lookup: lane=${lookupBody.lane} event=${lookupBody.eventId} kind=${lookupBody.kind} ref=${lookupBody.ref}\n`,
			);
			return 0;
		}

		let draftId = "";
		const addCode = await runOncallDraftCommand(
			[
				"add",
				"--book",
				"runbook",
				"--event-id",
				lookupBody.eventId,
				"--file",
				draft as string,
			],
			{
				env,
				fetchImpl,
				lookupAlert: async () => lookupBody,
				writeStdout: (text) => {
					draftId += text;
				},
				writeStderr,
			},
		);
		if (addCode !== 0) return addCode;
		draftId = draftId.trim();
		if (!draftId) {
			writeStderr("alert-ticket: oncall-draft returned no draft id\n");
			return 5;
		}

		const transition = await request(`${base}/duty/alert-tickets/transition`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action,
				...(locator as Locator),
				draftId,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const transitionFailure = handleFailure(transition);
		if (transitionFailure !== undefined) return transitionFailure;
		writeStdout(
			argv.includes("--json")
				? `${JSON.stringify((transition as { body: unknown }).body)}\n`
				: "alert-ticket resolve: ok\n",
		);
		return 0;
	}

	const query = new URLSearchParams();
	let url: string;
	let method: "GET" | "POST";
	let requestBody: Record<string, unknown> | undefined;
	if (action === "outstanding") {
		if (limit !== undefined) query.set("limit", String(limit));
		if (since) query.set("since", since);
		url = `${base}/duty/alert-tickets/outstanding${query.size ? `?${query}` : ""}`;
		method = "GET";
	} else if (action === "board") {
		const resolvedSince = normalizedResolvedSince(resolvedSinceRaw);
		if (resolvedSince) query.set("resolvedSince", resolvedSince);
		if (limit !== undefined) query.set("limit", String(limit));
		if (cursor) query.set("cursor", cursor);
		url = `${base}/duty/alert-board${query.size ? `?${query}` : ""}`;
		method = "GET";
	} else {
		url = `${base}/duty/alert-tickets/transition`;
		method = "POST";
		requestBody = {
			action,
			...(locator as Locator),
			...(action === "handoff"
				? { to, reason, ...(note ? { note } : {}) }
				: {}),
		};
	}
	const result = await request(
		url,
		{
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
			},
			...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
			signal: AbortSignal.timeout(5_000),
		},
		waitSeconds > 0 ? Math.ceil(waitSeconds / 10) : 0,
	);
	const failure = handleFailure(result);
	if (failure !== undefined) return failure;
	const body = (result as { body: unknown }).body;
	if (argv.includes("--json")) {
		writeStdout(`${JSON.stringify(body)}\n`);
	} else if (action === "outstanding") {
		const tickets =
			typeof body === "object" && body !== null
				? (body as { tickets?: unknown }).tickets
				: undefined;
		if (Array.isArray(tickets)) {
			for (const ticket of tickets) writeStdout(`${JSON.stringify(ticket)}\n`);
		} else {
			writeStdout("alert-ticket outstanding: ok\n");
		}
	} else if (action === "board") {
		writeBoardHuman(body as AlertBoardBody, writeStdout);
	} else {
		writeStdout(`alert-ticket ${action}: ok\n`);
	}
	return 0;
}
