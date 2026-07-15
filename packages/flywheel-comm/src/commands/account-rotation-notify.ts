/**
 * FLY-696 M1/④ — account-rotation-notify.
 *
 * Makes a Codex per-runner account rotation (flywheel-codex-with-fallback,
 * which today rotates silently) visible in Alerts. Emits a DEDICATED
 * `account_rotation` event to the Bridge /events (NOT `artifact_emitted` — Codex
 * R1#4 flagged that overloading it is the wrong protocol). The Bridge routes the
 * event to the unified Alerts channel. `fetchImpl` is injected for tests.
 */

import { randomUUID } from "node:crypto";

export interface AccountRotationNotifyArgs {
	provider: string;
	from?: string;
	to: string;
	reason: string;
	resetAt?: string;
	execId?: string;
	bridgeUrl?: string; // FLYWHEEL_BRIDGE_URL
	ingestToken?: string; // FLYWHEEL_INGEST_TOKEN
	/** Hard bound on the POST (default 5s) — a hung Bridge must never wedge the caller. */
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	uuid?: () => string;
}

export interface AccountRotationNotifyResult {
	exitCode: number;
	posted: boolean;
}

export async function accountRotationNotify(
	args: AccountRotationNotifyArgs,
): Promise<AccountRotationNotifyResult> {
	const bridgeUrl = args.bridgeUrl ?? process.env.FLYWHEEL_BRIDGE_URL;
	if (!bridgeUrl) {
		throw new Error(
			"account-rotation-notify: bridge url missing — set FLYWHEEL_BRIDGE_URL or pass --bridge-url",
		);
	}
	const fetchImpl = args.fetchImpl ?? globalThis.fetch;

	const eventBody = {
		event_id: (args.uuid ?? randomUUID)(),
		execution_id: args.execId,
		event_type: "account_rotation",
		source: "flywheel-comm",
		payload: {
			provider: args.provider,
			from: args.from ?? null,
			to: args.to,
			reason: args.reason,
			resetAt: args.resetAt ?? null,
		},
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = args.ingestToken ?? process.env.FLYWHEEL_INGEST_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;

	const url = `${bridgeUrl.replace(/\/+$/, "")}/events`;
	try {
		// Codex R1 HIGH-1: the caller is flywheel-codex-with-fallback's rotation
		// retry loop — a hung Bridge must never wedge a rotation, so the POST is
		// hard-bounded (the bash hook additionally fires this in the background).
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(eventBody),
			signal: AbortSignal.timeout(args.timeoutMs ?? 5_000),
		});
		if (!res.ok) {
			console.error(
				`account-rotation-notify: POST ${url} returned ${res.status} ${res.statusText}`,
			);
			return { exitCode: 2, posted: false };
		}
		return { exitCode: 0, posted: true };
	} catch (err) {
		console.error(
			`account-rotation-notify: POST ${url} threw: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return { exitCode: 2, posted: false };
	}
}
