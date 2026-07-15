/**
 * FLY-1278 — supervised Lead governance for an already-delivered review finding.
 *
 * This command is intentionally interactive and single-shot: the Bridge is the
 * authority, so a 4xx or transport failure is surfaced immediately and the Lead
 * decides whether to retry. Free-form gate/request text is never a ruling.
 */

export interface ReviewRulingOptions {
	project?: string;
	issue?: string;
	finding?: string;
	requestId?: string;
	findingIndex?: number;
	disposition?: string;
	followUp?: string;
	reason?: string;
	lead?: string;
	revoke?: string;
	execId?: string;
	/** Test seams. */
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

interface ReviewRulingAck {
	accepted?: boolean;
	reason?: string;
	ruling?: unknown;
}

/** Exit codes: 0 = accepted; 1 = usage/env; 2 = Bridge/network rejection. */
export async function reviewRuling(opts: ReviewRulingOptions): Promise<never> {
	const env = opts.env ?? process.env;
	const projectName = opts.project?.trim();
	const rationale = opts.reason?.trim();
	const ruledBy = opts.lead?.trim();
	const revokeRulingId = opts.revoke?.trim();
	const bridgeUrl = env.FLYWHEEL_BRIDGE_URL?.trim().replace(/\/$/, "");
	if (!projectName || !rationale || !ruledBy || !bridgeUrl) {
		console.error(
			"--project, --reason, --lead and FLYWHEEL_BRIDGE_URL are required",
		);
		process.exit(1);
	}

	let payload: Record<string, unknown>;
	if (revokeRulingId) {
		if (
			opts.issue ||
			opts.finding ||
			opts.requestId ||
			opts.findingIndex !== undefined ||
			opts.disposition ||
			opts.followUp
		) {
			console.error("--revoke cannot be combined with record-ruling options");
			process.exit(1);
		}
		payload = {
			projectName,
			revokeRulingId,
			rationale,
			ruledBy,
			...(opts.execId?.trim() ? { executionId: opts.execId.trim() } : {}),
		};
	} else {
		const issue = opts.issue?.trim();
		const findingKey = opts.finding?.trim();
		const requestId = opts.requestId?.trim();
		const hasExactLocator =
			Boolean(requestId) &&
			Number.isInteger(opts.findingIndex) &&
			(opts.findingIndex ?? -1) >= 0;
		const hasPartialExactLocator =
			Boolean(requestId) || opts.findingIndex !== undefined;
		const disposition =
			opts.disposition === "follow-up"
				? "follow_up"
				: opts.disposition === "overruled"
					? "overruled"
					: undefined;
		const followUpIssue = opts.followUp?.trim();
		if (
			!issue ||
			!disposition ||
			Boolean(findingKey) === hasExactLocator ||
			(hasPartialExactLocator && !hasExactLocator) ||
			(disposition === "follow_up" && !followUpIssue) ||
			(disposition === "overruled" && Boolean(followUpIssue))
		) {
			console.error(
				"recording requires --issue, --disposition, exactly one locator (--finding or --request-id plus --finding-index), and --follow-up only for follow-up",
			);
			process.exit(1);
		}
		payload = {
			projectName,
			issue,
			...(findingKey ? { findingKey } : {}),
			...(requestId ? { requestId } : {}),
			...(hasExactLocator ? { findingIndex: opts.findingIndex } : {}),
			disposition,
			...(followUpIssue ? { followUpIssue } : {}),
			rationale,
			ruledBy,
			...(opts.execId?.trim() ? { executionId: opts.execId.trim() } : {}),
		};
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (env.FLYWHEEL_INGEST_TOKEN) {
		headers.Authorization = `Bearer ${env.FLYWHEEL_INGEST_TOKEN}`;
	}
	let response: Response;
	let body: ReviewRulingAck | undefined;
	try {
		response = await (opts.fetchImpl ?? fetch)(`${bridgeUrl}/review-rulings`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		body = (await response.json().catch(() => undefined)) as
			| ReviewRulingAck
			| undefined;
	} catch (err) {
		console.error(
			`[review-ruling] request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(2);
	}
	if (response.ok && body?.accepted === true && body.ruling !== undefined) {
		console.log(JSON.stringify(body.ruling));
		process.exit(0);
	}
	console.error(
		`[review-ruling] Bridge rejected (${response.status}): ${body?.reason ?? "unknown"}`,
	);
	process.exit(2);
}
