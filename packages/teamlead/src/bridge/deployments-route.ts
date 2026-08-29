/**
 * FLY-727: /api/deployments — deployment_events ingestion (the digest's primary
 * "deployed to live" source of truth).
 *
 * POST /report  { projectName, source, (issueIdentifier | prNumber), + at least
 *                 one identity of (mergeSha | deployedSha | deployBatchId |
 *                 sourceEventId), [environment], [deployedAt], [metadataJson] }
 *   → validates + idempotently inserts a deployment_events row (dedup_key).
 *
 * AUTH-REQUIRED at the plugin layer (503 without TEAMLEAD_API_TOKEN) — this route
 * is the source of truth for "shipped today" and accepts remote webhooks, so it
 * must never run unauthenticated (Codex design review R2 #2).
 */

import { Router } from "express";
import type { DeploymentEventInput, StateStore } from "../StateStore.js";

const SHA40 = /^[0-9a-f]{40}$/i;

export function createDeploymentsRouter(store: StateStore): Router {
	const router = Router();

	router.post("/report", (req, res) => {
		const b = (req.body ?? {}) as Record<string, unknown>;

		const projectName =
			typeof b.projectName === "string" ? b.projectName.trim() : "";
		const source = typeof b.source === "string" ? b.source.trim() : "";
		if (!projectName || !source) {
			res.status(400).json({ error: "projectName and source are required" });
			return;
		}

		const issueIdentifier =
			typeof b.issueIdentifier === "string" && b.issueIdentifier.trim()
				? b.issueIdentifier.trim()
				: undefined;
		const prNumber =
			typeof b.prNumber === "number" && Number.isFinite(b.prNumber)
				? b.prNumber
				: undefined;
		if (!issueIdentifier && prNumber === undefined) {
			res.status(400).json({
				error: "at least one of issueIdentifier / prNumber is required",
			});
			return;
		}

		const str = (v: unknown): string | undefined =>
			typeof v === "string" && v.trim() ? v.trim() : undefined;
		const mergeSha = str(b.mergeSha);
		const deployedSha = str(b.deployedSha);
		const deployBatchId = str(b.deployBatchId);
		const sourceEventId = str(b.sourceEventId);

		// Codex R2 #3: require an explicit event identity so distinct no-SHA deploys
		// do not collapse under the dedup key.
		if (!mergeSha && !deployedSha && !deployBatchId && !sourceEventId) {
			res.status(400).json({
				error:
					"at least one identity of mergeSha / deployedSha / deployBatchId / sourceEventId is required",
			});
			return;
		}
		if (mergeSha && !SHA40.test(mergeSha)) {
			res.status(400).json({ error: "mergeSha must be a 40-hex sha" });
			return;
		}
		if (deployedSha && !SHA40.test(deployedSha)) {
			res.status(400).json({ error: "deployedSha must be a 40-hex sha" });
			return;
		}

		const input: DeploymentEventInput = {
			projectName,
			issueIdentifier,
			prNumber,
			mergeSha,
			deployedSha,
			deployBatchId,
			sourceEventId,
			environment: str(b.environment),
			source,
			deployedAt: str(b.deployedAt), // StateStore defaults to now when omitted
			metadataJson: str(b.metadataJson),
		};

		try {
			const { inserted } = store.insertDeploymentEvent(input);
			res.json({ ok: true, inserted });
		} catch (err) {
			console.error("[deployments/report] failed:", (err as Error).message);
			res
				.status(500)
				.json({ error: `deployment report failed: ${(err as Error).message}` });
		}
	});

	return router;
}
