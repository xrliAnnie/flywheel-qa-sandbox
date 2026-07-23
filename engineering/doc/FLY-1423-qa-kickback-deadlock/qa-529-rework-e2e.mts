#!/usr/bin/env node
/**
 * FLY-1423 isolated-room fixture helper.
 *
 * The real workflow engine, Bridge, StateStore, CommDB, mailbox, TURN, and
 * runner launch paths stay untouched. The only fixture customization is the
 * runner vendor on the schema-v1 heavy template: the managed runner sandbox
 * cannot write the host-level Claude workspace-trust file, so the disposable
 * template selects Codex for design. QA stays Claude to preserve the
 * cross-vendor review invariant. Live dispatch policy may still replace the
 * template vendor; the QA report records the actors actually launched.
 *
 * Usage (Bridge stopped):
 *   pnpm exec tsx \
 *     engineering/doc/FLY-1423-qa-kickback-deadlock/qa-529-rework-e2e.mts \
 *     prepare-template /tmp/flywheel-test-slot-1/teamlead.db
 *
 * When the managed host rejects the nested runner shell after admission, the
 * room may exercise the scoped decision path through the same public recovery
 * primitive used by the dispatcher:
 *   pnpm exec tsx <this-file> submit-qa-decision <db> <bridge-url> \
 *     <qa-exec> <pass|fail> <target-exec> <head-sha> <summary>
 */

import { randomUUID } from "node:crypto";
import { StateStore } from "../../../packages/teamlead/src/StateStore.js";

const [
	action,
	dbPath,
	bridgeUrl,
	executionId,
	status,
	targetExecutionId,
	clientPrHeadSha,
	...summaryParts
] = process.argv.slice(2);

if (!dbPath || !dbPath.startsWith("/tmp/flywheel-test-slot-")) {
	throw new Error(
		"the helper only accepts a /tmp/flywheel-test-slot-* database",
	);
}

async function main(): Promise<void> {
	const store = await StateStore.create(dbPath);

	try {
		if (action === "submit-qa-decision") {
			if (
				!bridgeUrl ||
				!executionId ||
				!status ||
				!targetExecutionId ||
				!clientPrHeadSha ||
				!summaryParts.length ||
				!new Set(["pass", "fail"]).has(status)
			) {
				throw new Error(
					"usage: qa-529-rework-e2e.mts submit-qa-decision <teamlead.db> <bridge-url> <qa-exec> <pass|fail> <target-exec> <head-sha> <summary>",
				);
			}
			const owner = store.getWorkflowLaunchOwner(executionId);
			if (!owner || owner.committed_generation != null) {
				throw new Error("QA execution has no recoverable pre-launch owner");
			}
			const now = new Date();
			const deadline = new Date(owner.lease_expires_at);
			const expiresAt = new Date(
				Math.min(now.getTime() + 5 * 60_000, deadline.getTime() - 1_000),
			);
			const rotated = store.rotateGeneralizedWorkflowSubmissionCredential({
				executionId,
				ownerId: owner.owner_id,
				generation: owner.owner_generation,
				now: now.toISOString(),
				expiresAt: expiresAt.toISOString(),
				absoluteDeadlineAt: deadline.toISOString(),
			});
			if (!rotated.ok) {
				throw new Error(
					`submission credential rotation rejected: ${rotated.reason}`,
				);
			}
			const clientRequestId = randomUUID();
			const response = await fetch(
				`${bridgeUrl.replace(/\/$/, "")}/api/workflow/decision`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						credential: rotated.submissionCredential,
						client_request_id: clientRequestId,
						status,
						client_pr_head_sha: clientPrHeadSha,
						target_execution_id: targetExecutionId,
						summary: summaryParts.join(" "),
					}),
				},
			);
			const responseText = await response.text();
			if (!response.ok) {
				throw new Error(
					`workflow decision returned ${response.status}: ${responseText}`,
				);
			}
			console.log(
				JSON.stringify({
					status: "submitted",
					executionId,
					verdict: status,
					clientRequestId,
					httpStatus: response.status,
					response: JSON.parse(responseText),
				}),
			);
			return;
		}

		if (action !== "prepare-template") {
			throw new Error(
				"usage: qa-529-rework-e2e.mts prepare-template <teamlead.db>",
			);
		}

		const templateId = "tpl_eng_heavy";
		const template = store.getWorkflowTemplate(templateId);
		if (!template?.current_published_revision) {
			throw new Error(`${templateId} has no published revision`);
		}

		const currentRevision = template.current_published_revision;
		const row = store.getWorkflowTemplateRevision(templateId, currentRevision);
		if (!row) throw new Error(`${templateId}@${currentRevision} is missing`);

		const manifest = JSON.parse(row.manifest) as {
			schema_version: number;
			nodes: Array<Record<string, unknown> & { id: string }>;
		};
		const alreadyPrepared = manifest.nodes
			.filter((node) => node.id === "design" || node.id === "qa")
			.every((node) =>
				node.id === "design"
					? node.vendor === "codex" && node.model === "gpt-5.6-sol"
					: node.vendor === "claude" && node.model === "claude-opus-4-8",
			);

		if (alreadyPrepared) {
			console.log(
				JSON.stringify({
					status: "already_prepared",
					templateId,
					revision: currentRevision,
				}),
			);
			return;
		}

		const roomManifest = {
			...manifest,
			nodes: manifest.nodes.map((node) => {
				if (node.id === "design") {
					return {
						...node,
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "xhigh",
					};
				}
				if (node.id === "qa") {
					const { effort: _discardedEffort, ...qaNode } = node;
					return {
						...qaNode,
						vendor: "claude",
						model: "claude-opus-4-8",
					};
				}
				return node;
			}),
		};
		const revision = store.createWorkflowTemplateRevision({
			templateId,
			manifest: roomManifest,
			schemaVersion: 1,
			createdBy: "FLY-1423-qa-room",
		});
		const published = store.publishWorkflowTemplate({
			templateId,
			revision,
			expectedRevision: currentRevision,
			publishedBy: "FLY-1423-qa-room",
		});
		if (published.status !== "published") {
			throw new Error(
				`failed to publish ${templateId}@${revision}: ${JSON.stringify(published)}`,
			);
		}

		console.log(
			JSON.stringify({
				status: "published",
				templateId,
				revision,
				baseRevision: currentRevision,
				designVendor: "codex",
				qaVendor: "claude",
			}),
		);
	} finally {
		store.close();
	}
}

await main();
