/**
 * FLY-2373: runner-side half of the semantic completion drain.
 *
 * `complete` answers 409 consume_pending_mail (protocol v2) with the unread
 * bodies as carrier-safe pages. The runner reads every page, acts on it, then
 * acknowledges the server-persisted read envelope through the Bridge; the
 * CLI never writes a receipt itself and never runs server text as a command.
 */

import { normalizeOptionalBearer } from "flywheel-config";
import {
	DRAIN_READ_ID_PATTERN,
	sha256Utf8,
} from "../completion-obligations.js";
import { currentWorkflowActivationFromEnv } from "./workflow-activation.js";

function isShipCarrierActivation(contextJson: string): boolean {
	try {
		const context = JSON.parse(contextJson) as unknown;
		return (
			typeof context === "object" &&
			context !== null &&
			!Array.isArray(context) &&
			(context as Record<string, unknown>).kind === "runner_ship_carrier"
		);
	} catch {
		return false;
	}
}

/** Exit code for "completion deferred until unread mail is read" (recoverable). */
export const DRAIN_PENDING_EXIT_CODE = 3;

const REQUEST_TIMEOUT_MS = 5_000;
const ATTEMPTS = 3;

export function renderDrainAckCommand(readId: string): string {
	return `node "$FLYWHEEL_COMM_CLI" inbox --ack-consumed ${readId}`;
}

export function renderDrainPageCommand(readId: string, page: number): string {
	return `node "$FLYWHEEL_COMM_CLI" inbox --drain-page ${readId} --page ${page}`;
}

interface DrainPagePayload {
	index: number;
	count: number;
	sha256: string;
	text: string;
}

function parsePage(value: unknown): DrainPagePayload | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const page = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(page.index) ||
		!Number.isSafeInteger(page.count) ||
		(page.index as number) < 1 ||
		(page.index as number) > (page.count as number) ||
		typeof page.text !== "string" ||
		typeof page.sha256 !== "string" ||
		sha256Utf8(page.text) !== page.sha256
	) {
		return undefined;
	}
	return page as unknown as DrainPagePayload;
}

/**
 * Render the v2 consume_pending_mail answer as ONE block (a single write keeps
 * stdout/stderr interleaving from splitting a body). Returns undefined when
 * the answer is not a well-formed v2 envelope.
 */
export function renderConsumePendingMail(
	response: Record<string, unknown>,
	retryCommand: string,
): { text: string; readId: string; pageCount: number } | undefined {
	const readId = response.readId;
	const page = parsePage(response.page);
	if (
		response.protocolVersion !== 2 ||
		typeof readId !== "string" ||
		!DRAIN_READ_ID_PATTERN.test(readId) ||
		!page ||
		page.index !== 1
	) {
		return undefined;
	}
	const unread = Array.isArray(response.unread) ? response.unread.length : 0;
	const lines = [
		`[complete] completion deferred: ${unread} unread item(s) must be read before this completion commits (read ${readId}, page 1/${page.count}).`,
		page.text.trimEnd(),
		"[complete] Next steps, all inside this same turn (do not park or end the turn to wait):",
	];
	let step = 1;
	if (page.count > 1) {
		lines.push(
			`  ${step}. Read the remaining page(s):`,
			...Array.from(
				{ length: page.count - 1 },
				(_, index) => `     ${renderDrainPageCommand(readId, index + 2)}`,
			),
		);
		step += 1;
	}
	lines.push(
		`  ${step}. Act on every item. A Lead instruction may change your deliverable: do the work (re-run any affected review) and report DONE quoting its full [lead-instruction <id>].`,
		`  ${step + 1}. Acknowledge the read: ${renderDrainAckCommand(readId)}`,
		`  ${step + 2}. Rerun the same completion (no --drain-receipt needed):`,
		`     ${retryCommand}`,
	);
	return { text: lines.join("\n"), readId, pageCount: page.count };
}

interface BridgeCallResult {
	status: number;
	body: Record<string, unknown> | undefined;
	error?: string;
}

async function postBridge(
	path: string,
	payload: Record<string, unknown>,
	fetchImpl: typeof fetch,
): Promise<BridgeCallResult> {
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL?.trim();
	if (!bridgeUrl) {
		return {
			status: 0,
			body: undefined,
			error: "FLYWHEEL_BRIDGE_URL is required",
		};
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = normalizeOptionalBearer(process.env.FLYWHEEL_INGEST_TOKEN);
	if (token) headers.Authorization = `Bearer ${token}`;
	let last: BridgeCallResult = {
		status: 0,
		body: undefined,
		error: "not attempted",
	};
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetchImpl(`${bridgeUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			let body: Record<string, unknown> | undefined;
			try {
				const parsed = JSON.parse(await response.text()) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					body = parsed as Record<string, unknown>;
				}
			} catch {
				body = undefined;
			}
			last = { status: response.status, body };
			if (response.status < 500) return last;
		} catch (error) {
			last = {
				status: 0,
				body: undefined,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			clearTimeout(timer);
		}
	}
	return last;
}

function drainRequestBody(
	executionId: string,
	readId: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		execution_id: executionId,
		read_id: readId,
	};
	try {
		const activation = currentWorkflowActivationFromEnv(executionId);
		if (activation && isShipCarrierActivation(activation.context_json)) {
			// complete omits a carrier activation; the Bridge maps the carrier
			// activation + TURN epoch to this execution instead.
			body.carrierActivation = {
				activationId: activation.activation_id,
				turnEpoch: activation.epoch,
			};
		} else if (activation) {
			body.workflowActivation = {
				activationId: activation.activation_id,
				runId: activation.run_id,
				nodeId: activation.node_id,
				attempt: activation.attempt,
				turnEpoch: activation.epoch,
			};
		}
	} catch {
		// Without an activation the Bridge refuses (reader_identity_changed).
	}
	return body;
}

function describeFailure(result: BridgeCallResult): string {
	if (result.error) return result.error;
	const error = result.body?.error;
	return `Bridge returned ${result.status}${typeof error === "string" ? `: ${error}` : ""}`;
}

/** `inbox --drain-page <read-id> --page <n>`: print one page verbatim. */
export async function readCompletionDrainPage(input: {
	executionId: string;
	readId: string;
	page: number;
	fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; output: string }> {
	if (!DRAIN_READ_ID_PATTERN.test(input.readId)) {
		return { ok: false, output: `[inbox] invalid read id: ${input.readId}` };
	}
	if (!Number.isSafeInteger(input.page) || input.page < 1) {
		return { ok: false, output: "[inbox] --page must be a positive integer" };
	}
	const result = await postBridge(
		"/events/completion-drain/page",
		{ ...drainRequestBody(input.executionId, input.readId), page: input.page },
		input.fetchImpl ?? fetch,
	);
	const page = parsePage(result.body?.page);
	if (result.status !== 200 || !page || page.index !== input.page) {
		return {
			ok: false,
			output: `[inbox] drain page ${input.page} unavailable: ${describeFailure(result)}`,
		};
	}
	const next =
		page.index < page.count
			? `next: ${renderDrainPageCommand(input.readId, page.index + 1)}`
			: `all pages read; after acting on them run: ${renderDrainAckCommand(input.readId)}`;
	return {
		ok: true,
		output: `${page.text.trimEnd()}\n[inbox] read ${input.readId} page ${page.index}/${page.count}; ${next}`,
	};
}

/** `inbox --ack-consumed <read-id>`: acknowledge one server read envelope. */
export async function acknowledgeCompletionDrain(input: {
	executionId: string;
	readId: string;
	fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; output: string }> {
	if (!DRAIN_READ_ID_PATTERN.test(input.readId)) {
		return { ok: false, output: `[inbox] invalid read id: ${input.readId}` };
	}
	const result = await postBridge(
		"/events/completion-drain/ack",
		drainRequestBody(input.executionId, input.readId),
		input.fetchImpl ?? fetch,
	);
	const body = result.body ?? {};
	if (result.status === 200 && body.ok === true) {
		return {
			ok: true,
			output: `[inbox] acknowledged ${String(body.accepted)} item(s) of read ${input.readId}. Rerun your complete command now.`,
		};
	}
	if (body.error === "pages_not_read" && Array.isArray(body.missingPages)) {
		const pages = body.missingPages.filter((page): page is number =>
			Number.isSafeInteger(page),
		);
		return {
			ok: false,
			output: [
				`[inbox] read ${input.readId} is not acknowledged: page(s) ${pages.join(", ")} were never shown. Read them first:`,
				...pages.map(
					(page) => `  ${renderDrainPageCommand(input.readId, page)}`,
				),
			].join("\n"),
		};
	}
	if (Array.isArray(body.rejected) && body.rejected.length > 0) {
		const rejected = body.rejected
			.map((item) => {
				const record = item as Record<string, unknown>;
				return `${String(record.subjectId)} (${String(record.reason)})`;
			})
			.join(", ");
		return {
			ok: false,
			output: `[inbox] acknowledged ${String(body.accepted ?? 0)} item(s); refused ${rejected}. Rerun complete to receive the current version of any changed item.`,
		};
	}
	return {
		ok: false,
		output: `[inbox] drain acknowledgement failed: ${describeFailure(result)}`,
	};
}
