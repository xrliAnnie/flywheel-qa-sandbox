/**
 * GEO-292: Stage reporting command — sends pipeline stage to Bridge via HTTP.
 * Fail-open: HTTP errors produce stderr warning but exit 0.
 */

import { randomUUID } from "node:crypto";

const VALID_STAGES = new Set([
	"started",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"implement",
	"test",
	"code_review",
	"pr_created",
	"ship",
]);

const TIMEOUT_MS = 2000;

export async function stage(opts: {
	subcommand: string;
	stageName: string;
}): Promise<void> {
	if (opts.subcommand !== "set") {
		console.error(`Unknown stage subcommand: ${opts.subcommand}`);
		console.error("Usage: flywheel-comm stage set <stage>");
		process.exit(1);
	}

	if (!opts.stageName) {
		console.error("Stage name is required");
		console.error(`Valid stages: ${[...VALID_STAGES].join(", ")}`);
		process.exit(1);
	}

	if (!VALID_STAGES.has(opts.stageName)) {
		console.error(
			`Invalid stage: ${opts.stageName}. Valid stages: ${[...VALID_STAGES].join(", ")}`,
		);
		process.exit(1);
	}

	const execId = process.env.FLYWHEEL_EXEC_ID;
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	if (!execId) {
		console.error("FLYWHEEL_EXEC_ID environment variable is required");
		process.exit(1);
	}
	if (!issueId) {
		console.error("FLYWHEEL_ISSUE_ID environment variable is required");
		process.exit(1);
	}
	if (!projectName) {
		console.error("FLYWHEEL_PROJECT_NAME environment variable is required");
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
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: opts.stageName },
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) {
		headers.Authorization = `Bearer ${ingestToken}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${bridgeUrl}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) {
			console.error(
				`[flywheel-comm stage] Warning: Bridge returned ${response.status} — stage not recorded`,
			);
			return; // fail-open: exit 0
		}

		console.log(`Stage: ${opts.stageName}`);
	} catch (err) {
		clearTimeout(timeout);
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`[flywheel-comm stage] Warning: ${message} — stage not recorded`,
		);
		// fail-open: exit 0
	}
}
