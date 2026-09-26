/**
 * FLY-598: Founder-facing UX gate CLI commands.
 *
 * Three commands implement the runner/Lead side of the gate. The AUTHORITY lives
 * in the Bridge (StateStore + server-side founder-identity verification); these
 * commands are thin HTTP clients with the correct, separated credentials:
 *
 *  - `declare-founder-ux` (Runner backup trigger): POSTs a `founder_ux_declared`
 *    event with the Runner's ingest token. The Bridge sets founder_facing_ux=1,
 *    audits, and notifies the founder. Prints the fail-closed next-step sequence
 *    so the backup path never depends on the Runner remembering what to do.
 *
 *  - `record-founder-ux-signoff` (Lead privileged write): POSTs to a privileged
 *    Bridge route that requires TEAMLEAD_API_TOKEN (Lead-only). The Bridge
 *    server-fetches the cited Annie Discord message from the issue thread and
 *    verifies authorId === founderUserId before writing the sign-off. FAIL-CLOSED
 *    if TEAMLEAD_API_TOKEN is unset — the Runner's ingest token must NOT be able
 *    to write a sign-off (Codex R2-#1 / R3-#1).
 *
 *  - `await-founder-ux-gate` (Runner hard stop): polls the read-only status route
 *    with the Runner's ingest token, FAIL-CLOSED until a verified sign-off bound
 *    to the current ux-brief hash exists (or Bridge is unreachable / timeout).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/** await-founder-ux-gate default timeout (matches await-codex-gate: 30 min). */
const DEFAULT_AWAIT_TIMEOUT_MS = 30 * 60 * 1000;
/** await poll interval. */
const DEFAULT_POLL_INTERVAL_MS = 2000;
/** Short timeout for the one-shot declare/record POSTs. */
const POST_TIMEOUT_MS = 5000;

/**
 * Canonical hash of the UX-brief artifact (the single source of "current UX
 * understanding"). record + await + the stage guard all hash the SAME way so the
 * gate can distinguish a current-brief sign-off from a stale one (FLY-598 ④,
 * Codex R2-#2). Normalization: strip a UTF-8 BOM and CRLF→LF, then sha256-hex
 * — so trivial line-ending churn doesn't force a re-sign, but content changes do.
 */
export function computeUxHash(uxFilePath: string): string {
	if (!existsSync(uxFilePath)) {
		console.error(`--ux-file not found: ${uxFilePath}`);
		process.exit(1);
	}
	let raw: string;
	try {
		raw = readFileSync(uxFilePath, "utf-8");
	} catch (err) {
		console.error(
			`--ux-file unreadable: ${uxFilePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
	const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/** The fail-closed next-step sequence printed after a self-declare so the backup
 * path never relies on the Runner remembering (Codex R2-#5). */
const DECLARE_NEXT_STEPS = [
	"FOUNDER-FACING UX DECLARED. Before you may enter `implement` you MUST:",
	"  1. Brainstorm the UX with Annie in this issue's Discord thread.",
	"  2. Capture the agreed UX in a canonical UX-brief file (e.g. doc/<issue>-<slug>/ux-brief.md).",
	"  3. Have your Lead record Annie's natural-language approval:",
	"       flywheel-comm record-founder-ux-signoff --exec-id <id> --ux-file <brief> --annie-msg-id <id>",
	"  4. Before writing implementation code, block on the gate:",
	"       flywheel-comm await-founder-ux-gate --exec-id <id> --ux-file <brief>",
	"     It fail-closes until Annie's sign-off (for THIS ux-brief) is verified.",
].join("\n");

/** Runner self-declaration (trigger C / backup). */
export async function declareFounderUx(opts: {
	execId?: string;
	reason: string;
}): Promise<void> {
	const execId = opts.execId ?? process.env.FLYWHEEL_EXEC_ID;
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	if (!execId) {
		console.error("--exec-id is required (or set FLYWHEEL_EXEC_ID)");
		process.exit(1);
	}
	if (!opts.reason || opts.reason.trim().length === 0) {
		console.error(
			'a one-line reason is required: declare-founder-ux --exec-id <id> "<why this is founder-facing UX>"',
		);
		process.exit(1);
	}
	if (!bridgeUrl) {
		console.error("FLYWHEEL_BRIDGE_URL environment variable is required");
		process.exit(1);
	}

	const body = {
		event_id: randomUUID(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "founder_ux_declared",
		source: "flywheel-comm",
		payload: { reason: opts.reason },
	};
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
	try {
		const response = await fetch(`${bridgeUrl}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!response.ok) {
			// Declaration is the trigger that OPENS the gate; if the Bridge rejects
			// it, fail-closed (exit 1) so the Runner stops rather than proceeding as
			// if the gate were satisfied.
			console.error(
				`[declare-founder-ux] Bridge returned ${response.status} — declaration NOT recorded. Stop; do not enter implement.`,
			);
			process.exit(1);
		}
		console.log("founder-facing UX declared (flag set, founder notified).");
		console.log(DECLARE_NEXT_STEPS);
	} catch (err) {
		clearTimeout(timeout);
		console.error(
			`[declare-founder-ux] ${err instanceof Error ? err.message : String(err)} — declaration NOT recorded. Stop; do not enter implement.`,
		);
		process.exit(1);
	}
}

/** Lead privileged sign-off write. Requires TEAMLEAD_API_TOKEN (fail-closed). */
export async function recordFounderUxSignoff(opts: {
	execId?: string;
	uxFile: string;
	annieMsgId: string;
	bridgeUrl?: string;
}): Promise<void> {
	const execId = opts.execId ?? process.env.FLYWHEEL_EXEC_ID;
	const bridgeUrl = opts.bridgeUrl ?? process.env.FLYWHEEL_BRIDGE_URL;
	// Codex R2-#1 / R3-#1: the sign-off WRITE is a privileged route. It must use
	// the Lead-only TEAMLEAD_API_TOKEN and FAIL CLOSED when it is unset — never
	// fall back to the Runner's ingest token (which would make the write
	// Runner-forgeable).
	const apiToken = process.env.TEAMLEAD_API_TOKEN;

	if (!execId) {
		console.error("--exec-id is required (or set FLYWHEEL_EXEC_ID)");
		process.exit(1);
	}
	if (!opts.uxFile) {
		console.error("--ux-file is required (the canonical UX-brief path)");
		process.exit(1);
	}
	if (!opts.annieMsgId) {
		console.error(
			"--annie-msg-id is required (the Discord message id of Annie's UX approval)",
		);
		process.exit(1);
	}
	if (!bridgeUrl) {
		console.error("FLYWHEEL_BRIDGE_URL is required (or pass --bridge-url)");
		process.exit(1);
	}
	if (!apiToken) {
		console.error(
			"record-founder-ux-signoff requires TEAMLEAD_API_TOKEN (Lead-only privileged write). Refusing to write a sign-off without it (fail-closed).",
		);
		process.exit(1);
	}

	const uxHash = computeUxHash(opts.uxFile);
	const body = {
		execution_id: execId,
		ux_hash: uxHash,
		annie_msg_id: opts.annieMsgId,
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
	try {
		const response = await fetch(`${bridgeUrl}/api/founder-ux/signoff`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiToken}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timeout);
		const text = await response.text();
		if (!response.ok) {
			// The Bridge does the founder-identity server-fetch verification; a
			// non-2xx means it could NOT verify Annie authored the cited message
			// (or the route is unauthorized). Surface and fail-closed.
			console.error(
				`[record-founder-ux-signoff] Bridge returned ${response.status}: ${text} — sign-off NOT recorded.`,
			);
			process.exit(1);
		}
		console.log(
			`founder UX sign-off recorded for ${execId} (ux_hash=${uxHash.slice(0, 12)}…), verified by Bridge.`,
		);
	} catch (err) {
		clearTimeout(timeout);
		console.error(
			`[record-founder-ux-signoff] ${err instanceof Error ? err.message : String(err)} — sign-off NOT recorded.`,
		);
		process.exit(1);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Runner hard-stop checkpoint (Layer A). Polls the read-only status route with
 * the ingest token; exits 0 only on a verified sign-off for the current ux_hash;
 * fail-closed (exit 1) on timeout / Bridge unreachable / not-approved. */
export async function awaitFounderUxGate(opts: {
	execId?: string;
	uxFile: string;
	bridgeUrl?: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
}): Promise<void> {
	const execId = opts.execId ?? process.env.FLYWHEEL_EXEC_ID;
	const bridgeUrl = opts.bridgeUrl ?? process.env.FLYWHEEL_BRIDGE_URL;
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	if (!execId) {
		console.error("--exec-id is required (or set FLYWHEEL_EXEC_ID)");
		process.exit(1);
	}
	if (!opts.uxFile) {
		console.error("--ux-file is required (the canonical UX-brief path)");
		process.exit(1);
	}
	if (!bridgeUrl) {
		console.error("FLYWHEEL_BRIDGE_URL is required (or pass --bridge-url)");
		process.exit(1);
	}

	const uxHash = computeUxHash(opts.uxFile);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	const url = `${bridgeUrl}/api/founder-ux/status?execId=${encodeURIComponent(execId)}&uxHash=${encodeURIComponent(uxHash)}`;
	const headers: Record<string, string> = {};
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	while (Date.now() < deadline) {
		let approved = false;
		try {
			const controller = new AbortController();
			const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
			const response = await fetch(url, { headers, signal: controller.signal });
			clearTimeout(t);
			if (response.ok) {
				const data = (await response.json()) as { approved?: boolean };
				approved = data.approved === true;
			}
			// not approved yet / transient non-2xx → keep polling until deadline
		} catch {
			// Bridge unreachable → keep polling until deadline, then fail-closed
		}
		// process.exit OUTSIDE the try so a real exit is never swallowed by the
		// fetch catch (and so the success path can't be mistaken for "unreachable").
		if (approved) {
			console.log(
				`[await-founder-ux-gate] founder UX sign-off verified for ${execId} (ux_hash=${uxHash.slice(0, 12)}…). Proceeding.`,
			);
			process.exit(0);
		}
		await sleep(pollIntervalMs);
	}

	console.error(
		`[await-founder-ux-gate] timeout after ${timeoutMs}ms with no verified founder UX sign-off for exec=${execId} (ux_hash=${uxHash.slice(0, 12)}…). FAIL-CLOSED: do not enter implement.`,
	);
	process.exit(1);
}
