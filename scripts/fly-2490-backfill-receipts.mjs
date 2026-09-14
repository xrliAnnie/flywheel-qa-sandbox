#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { probeCodexDaemonEvidence } from "../packages/claude-runner/dist/index.js";
import { StateStore } from "../packages/teamlead/dist/StateStore.js";

const Database = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
)("better-sqlite3");

/** One-time historical repair. Operator-reviewed events are evidence for this
 * offline operation only; runtime closeout never trusts session_events. */
export async function backfillReceipts(options) {
	const {
		statePath,
		commPath,
		manifest,
		sessionRoot,
		socketRoot,
		apply = false,
		confirmQuiesced = false,
	} = options;
	if (apply && !confirmQuiesced) throw new Error("confirm_quiesced_required");
	if (
		![statePath, commPath, sessionRoot, socketRoot].every(
			(v) => typeof v === "string" && v.length > 0,
		)
	)
		throw new Error("explicit_paths_required");
	if (
		!Array.isArray(manifest) ||
		manifest.length < 1 ||
		manifest.length > 2 ||
		new Set(manifest.map((n) => n.executionId)).size !== manifest.length ||
		manifest.some(
			(n) =>
				!["FLY-2351", "FLY-2382"].includes(n.issueIdentifier) ||
				typeof n.executionId !== "string" ||
				!n.executionId ||
				typeof n.sourceEventId !== "string" ||
				!n.sourceEventId,
		)
	)
		throw new Error("invalid_reviewed_manifest");
	const state = new Database(statePath, {
		readonly: true,
		fileMustExist: true,
	});
	let comm;
	let writer;
	try {
		comm = new Database(commPath, { readonly: true, fileMustExist: true });
		const nodes = [];
		for (const node of manifest) {
			const session = state
				.prepare("SELECT * FROM sessions WHERE execution_id = ?")
				.get(node.executionId);
			const claim = state
				.prepare(
					"SELECT state FROM lifecycle_launch_claims WHERE execution_id = ?",
				)
				.get(node.executionId);
			const event = state
				.prepare(
					"SELECT * FROM session_events WHERE execution_id = ? AND event_id = ?",
				)
				.get(node.executionId, node.sourceEventId);
			let payload;
			try {
				payload = JSON.parse(event?.payload ?? "null");
			} catch {
				payload = null;
			}
			let reason;
			if (
				!session ||
				session.issue_identifier !== node.issueIdentifier ||
				session.project_name !== "flywheel" ||
				session.adapter_type !== "codex-tmux"
			)
				reason = "identity_mismatch";
			else if (session.status !== "failed" || session.tmux_session !== null)
				reason = "not_failed_empty_node";
			else if (
				comm
					.prepare("SELECT 1 FROM sessions WHERE execution_id = ?")
					.get(node.executionId)
			)
				reason = "commdb_row_present";
			else if (claim?.state !== "closed") reason = "claim_not_closed";
			else if (
				event?.event_type !== "session_failed" ||
				event.source !== "direct-event-sink" ||
				event.issue_id !== session.issue_id ||
				event.project_name !== session.project_name ||
				!(
					Date.parse(event.ts + (event.ts.includes("T") ? "" : "Z")) <
					Date.parse("2026-09-11T00:00:00Z")
				) ||
				payload?.failureKind !== "worktree_takeover_failed"
			)
				reason = "historical_evidence_missing";
			if (!reason) {
				const evidence = await probeCodexDaemonEvidence(node.executionId, {
					env: {
						...process.env,
						FLYWHEEL_CODEX_SESSION_DIR: sessionRoot,
						FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: socketRoot,
					},
				});
				if (
					evidence.liveness !== "unknown" ||
					evidence.ledger !== "missing" ||
					evidence.socketLive ||
					evidence.spawnLock !== "absent"
				)
					reason = "daemon_evidence_present";
			}
			nodes.push({
				...node,
				...(reason
					? { action: "refused", reason }
					: { action: "would_insert" }),
			});
		}
		// Validate the whole reviewed batch before opening a writable StateStore.
		if (apply && nodes.some((n) => n.action === "refused"))
			throw new Error("backfill_batch_refused:" + JSON.stringify(nodes));
		if (apply) writer = await StateStore.create(statePath);
		for (const node of nodes) {
			if (node.action === "refused") continue;
			const hasTable = state
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE name = 'pre_adapter_failure_receipts'",
				)
				.get();
			const prior =
				hasTable &&
				state
					.prepare(
						"SELECT source_event_id FROM pre_adapter_failure_receipts WHERE execution_id = ?",
					)
					.get(node.executionId);
			if (prior) {
				if (prior.source_event_id !== node.sourceEventId)
					throw new Error("existing_receipt_mismatch");
				node.action = "already_recorded";
			} else if (writer) {
				const session = writer.getSession(node.executionId);
				if (
					session?.status !== "failed" ||
					session.tmux_session != null ||
					writer.getLaunchClaim(node.executionId)?.state !== "closed"
				)
					throw new Error("state_changed");
				// Durable intent precedes receipt; replay completes either crash window.
				writer.insertEvent({
					event_id: `fly2490-backfill:${node.executionId}`,
					execution_id: node.executionId,
					issue_id: session.issue_id,
					project_name: session.project_name,
					event_type: "pre_adapter_receipt_backfill_authorized",
					source: "ops.fly-2490",
					payload: {
						sourceEventId: node.sourceEventId,
						issueIdentifier: node.issueIdentifier,
					},
				});
				const result = writer.recordPreAdapterFailureReceipt({
					executionId: node.executionId,
					failureKind: "worktree_takeover_failed",
					sourceEventId: node.sourceEventId,
					now: new Date().toISOString(),
				});
				if (!result.ok) throw new Error(result.reason);
				node.action = result.inserted ? "inserted" : "already_recorded";
			}
		}
		return { mode: apply ? "apply" : "dry-run", nodes };
	} finally {
		writer?.close();
		comm?.close();
		state.close();
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		const { values } = parseArgs({
			options: {
				"state-db": { type: "string" },
				"comm-db": { type: "string" },
				manifest: { type: "string" },
				"session-root": { type: "string" },
				"socket-root": { type: "string" },
				apply: { type: "boolean", default: false },
				"confirm-quiesced": { type: "boolean", default: false },
			},
		});
		const report = await backfillReceipts({
			statePath: values["state-db"],
			commPath: values["comm-db"],
			sessionRoot: values["session-root"],
			socketRoot: values["socket-root"],
			manifest: JSON.parse(readFileSync(values.manifest, "utf8")),
			apply: values.apply,
			confirmQuiesced: values["confirm-quiesced"],
		});
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
		if (report.nodes.some((n) => n.action === "refused")) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(error.message + "\n");
		process.exitCode = 1;
	}
}
