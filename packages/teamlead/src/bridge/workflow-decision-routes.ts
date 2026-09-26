import express from "express";
import {
	adapterTypeToFamily,
	canonicalSubmissionDigest,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";
import type { PhaseOrchestrator } from "./phase-orchestrator.js";

interface WorkflowDecisionBody {
	credential?: unknown;
	client_request_id?: unknown;
	status?: unknown;
	summary?: unknown;
	client_pr_head_sha?: unknown;
}

export interface WorkflowDecisionRouterDeps {
	store: StateStore;
	phaseOrchestrator?: { current: PhaseOrchestrator | undefined };
	now?: () => string;
	reQa?: {
		tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
		respawn(
			canonical: WorkflowReQaCanonical,
			prHeadSha: string,
		): Promise<{ executionId: string }>;
	};
}

export interface WorkflowReQaCanonical {
	runId: string;
	issueId: string;
	projectName: string;
	sourceExecutionId: string;
	sourceAttempt: number;
	targetAttempt: number;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rejectNonLoopback(
	req: express.Request,
	res: express.Response,
): boolean {
	if (loopbackSelfOrigin(req.headers.host)) return false;
	res.status(403).json({ ok: false, reason: "non_loopback_host" });
	return true;
}

function requestHeaders(
	req: express.Request,
): Record<string, string | undefined> {
	return {
		origin:
			typeof req.headers.origin === "string" ? req.headers.origin : undefined,
		referer:
			typeof req.headers.referer === "string" ? req.headers.referer : undefined,
	};
}

function resolveReQaCanonical(
	store: StateStore,
	executionId: string,
):
	| { ok: true; canonical: WorkflowReQaCanonical }
	| { ok: false; reason: string } {
	const session = store.getSession(executionId);
	if (
		!session ||
		(session.session_role ?? "main") !== "qa" ||
		(session.chat_thread_role ?? "main") !== "qa"
	) {
		return { ok: false, reason: "not_durable_qa_execution" };
	}
	if (store.getWorkflowExecutionBinding(executionId)) {
		return { ok: false, reason: "qa_already_enrolled" };
	}
	const node = store.getWorkflowRunNodeForExecution(executionId);
	if (!node || node.node_id !== "qa") {
		return { ok: false, reason: "qa_projection_not_found" };
	}
	const run = store.getWorkflowRun(node.run_id);
	if (!run || run.status !== "active") {
		return { ok: false, reason: "active_run_not_found" };
	}
	return {
		ok: true,
		canonical: {
			runId: run.run_id,
			issueId: session.issue_id,
			projectName: session.project_name,
			sourceExecutionId: executionId,
			sourceAttempt: node.attempt,
			targetAttempt: node.attempt + 1,
		},
	};
}

/** Credential-authenticated workflow verdicts and the shared head read model. */
export function createWorkflowDecisionRouter(
	deps: WorkflowDecisionRouterDeps,
): express.Router {
	const router = express.Router();

	router.post("/head-authority", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const executionId = stringField(
			(req.body as { execution_id?: unknown } | undefined)?.execution_id,
		);
		if (!executionId) {
			res.status(400).json({ ok: false, reason: "execution_id_required" });
			return;
		}
		try {
			const authority = await resolveWorkflowHeadAuthority(
				deps.store,
				executionId,
			);
			res.json({
				ok: true,
				executionId,
				prHeadSha: authority.prHeadSha,
			});
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason: error instanceof Error ? error.message : "head_unavailable",
			});
		}
	});

	router.post("/decision", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const body = (req.body ?? {}) as WorkflowDecisionBody;
		const credential = stringField(body.credential);
		const clientRequestId = stringField(body.client_request_id);
		const status = stringField(body.status)?.toLowerCase();
		const summary = stringField(body.summary);
		const clientHead = stringField(body.client_pr_head_sha)?.toLowerCase();
		if (!credential || !clientRequestId || !status) {
			res.status(400).json({ ok: false, reason: "invalid_request" });
			return;
		}
		if (status !== "pass" && status !== "fail") {
			res.status(400).json({ ok: false, reason: "invalid_status" });
			return;
		}
		if (clientHead && !/^[0-9a-f]{40}$/.test(clientHead)) {
			res.status(400).json({ ok: false, reason: "invalid_client_head" });
			return;
		}

		const credentialRow =
			deps.store.getWorkflowSubmissionCredentialByToken(credential);
		if (!credentialRow) {
			res.status(401).json({ ok: false, reason: "credential_not_found" });
			return;
		}
		const reporting = deps.store.getSession(credentialRow.execution_id);
		if (
			!reporting ||
			(reporting.session_role ?? "main") !== "qa" ||
			(reporting.chat_thread_role ?? "main") !== "qa"
		) {
			res.status(409).json({ ok: false, reason: "not_durable_qa_execution" });
			return;
		}

		let serverHead: string;
		try {
			serverHead = (
				await resolveWorkflowHeadAuthority(deps.store, reporting.execution_id)
			).prHeadSha;
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason: error instanceof Error ? error.message : "head_unavailable",
			});
			return;
		}
		if (clientHead && clientHead !== serverHead) {
			res.status(409).json({
				ok: false,
				reason: "head_authority_mismatch",
				expectedPrHeadSha: serverHead,
			});
			return;
		}

		const producerNode = deps.store
			.listWorkflowRunNodes(credentialRow.run_id, "implement")
			.filter(
				(node) => node.execution_id && node.attempt <= credentialRow.attempt,
			)
			.at(-1);
		if (!producerNode?.execution_id) {
			res.status(409).json({ ok: false, reason: "producer_not_found" });
			return;
		}
		// The ledger stores one row per logical attempt. A normal QA kickback
		// therefore leaves historical implement rows behind; select the latest
		// producer at or before this QA attempt instead of treating history as
		// ambiguity. ORDER BY attempt in listWorkflowRunNodes makes this stable.
		const producer = deps.store.getSession(producerNode.execution_id);
		if (!producer) {
			res.status(409).json({ ok: false, reason: "producer_not_found" });
			return;
		}
		const now = deps.now?.() ?? new Date().toISOString();
		const nowMs = Date.parse(now);
		if (!Number.isFinite(nowMs)) {
			res.status(500).json({ ok: false, reason: "invalid_server_clock" });
			return;
		}
		const result = deps.store.submitWorkflowDecisionByCredential({
			credential,
			clientRequestId,
			predicate: status === "pass" ? "qa_passed" : "qa_failed",
			subjectDigest: serverHead,
			issuerVendor: adapterTypeToFamily(reporting.adapter_type),
			issuerModel:
				reporting.runner_model ??
				reporting.dispatch_model ??
				reporting.adapter_type ??
				"unknown",
			subjectProducerExecutionId: producer.execution_id,
			subjectProducerVendor: adapterTypeToFamily(producer.adapter_type),
			// Persisted credential expiry is the deterministic server-owned claim
			// deadline. Recomputing `now + TTL` here makes a response-loss retry hash
			// differently even when the client payload is exact.
			claimExpiresAt: credentialRow.expires_at,
			evidence: summary ? { summary } : undefined,
			now,
		});
		if (!result.ok) {
			res
				.status(result.reason === "credential_not_found" ? 401 : 409)
				.json(result);
			return;
		}

		const eventId = `workflow-decision:${credentialRow.id}:${clientRequestId}`;
		deps.store.insertEvent({
			event_id: eventId,
			execution_id: reporting.execution_id,
			issue_id: reporting.issue_id,
			project_name: reporting.project_name,
			event_type: "qa_result",
			source: "bridge.workflow-decision",
			payload: {
				status,
				targetExecutionId: producer.execution_id,
				qaExecutionId: reporting.execution_id,
				prHeadSha: serverHead,
				...(summary ? { summary } : {}),
			},
		});
		// The audit row is idempotent, but it must not gate the orchestration side
		// effect. If the first drive throws after the claim/event commit, an exact
		// credential replay must attempt the idempotent drive again.
		if (deps.phaseOrchestrator?.current) {
			await deps.phaseOrchestrator.current.onQaResult(reporting, {
				eventId,
				status,
				prHeadSha: serverHead,
				targetExecutionId: producer.execution_id,
				...(summary ? { summary } : {}),
			});
		}
		res.json({
			ok: true,
			claimId: result.claimId,
			serverSeq: result.serverSeq,
			idempotentReplay: result.idempotentReplay,
			requestId: clientRequestId,
		});
	});

	router.post("/re-qa/stage", (req, res) => {
		if (!deps.reQa) {
			res.status(503).json({ ok: false, reason: "re_qa_unavailable" });
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const executionId = stringField(
			(req.body as { execution_id?: unknown } | undefined)?.execution_id,
		);
		if (!executionId) {
			res.status(400).json({ ok: false, reason: "execution_id_required" });
			return;
		}
		const resolved = resolveReQaCanonical(deps.store, executionId);
		if (!resolved.ok) {
			res.status(409).json(resolved);
			return;
		}
		const confirmToken = deps.reQa.tokens.issue(
			canonicalSubmissionDigest(resolved.canonical),
		);
		res.json({ ok: true, canonical: resolved.canonical, confirmToken });
	});

	router.post("/re-qa", async (req, res) => {
		if (!deps.reQa) {
			res.status(503).json({ ok: false, reason: "re_qa_unavailable" });
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const input = (req.body ?? {}) as {
			canonical?: WorkflowReQaCanonical;
			confirmToken?: string;
		};
		if (!input.canonical || typeof input.confirmToken !== "string") {
			res.status(400).json({ ok: false, reason: "missing_canonical_or_token" });
			return;
		}
		const resolved = resolveReQaCanonical(
			deps.store,
			input.canonical.sourceExecutionId,
		);
		if (
			!resolved.ok ||
			canonicalSubmissionDigest(resolved.canonical) !==
				canonicalSubmissionDigest(input.canonical)
		) {
			res.status(409).json({ ok: false, reason: "re_qa_state_changed" });
			return;
		}
		const token = deps.reQa.tokens.verifyAndConsume(
			input.confirmToken,
			canonicalSubmissionDigest(input.canonical),
		);
		if (!token.ok) {
			res.status(403).json({ ok: false, reason: token.reason });
			return;
		}

		const run = deps.store.getWorkflowRun(input.canonical.runId);
		if ((run?.current_qa_attempt ?? 0) >= input.canonical.targetAttempt) {
			const existing = deps.store.getWorkflowRunNode(
				input.canonical.runId,
				"qa",
				input.canonical.targetAttempt,
			);
			if (
				existing?.execution_id &&
				deps.store.getWorkflowExecutionBinding(existing.execution_id)
			) {
				res.json({
					ok: true,
					idempotentReplay: true,
					executionId: existing.execution_id,
					targetAttempt: input.canonical.targetAttempt,
				});
				return;
			}
		}

		let prHeadSha: string;
		try {
			prHeadSha = (
				await resolveWorkflowHeadAuthority(
					deps.store,
					input.canonical.sourceExecutionId,
				)
			).prHeadSha;
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason: error instanceof Error ? error.message : "head_unavailable",
			});
			return;
		}
		try {
			const spawned = await deps.reQa.respawn(input.canonical, prHeadSha);
			const binding = deps.store.getWorkflowExecutionBinding(
				spawned.executionId,
			);
			if (
				!binding ||
				binding.run_id !== input.canonical.runId ||
				binding.node_id !== "qa" ||
				binding.attempt !== input.canonical.targetAttempt
			) {
				throw new Error("replacement_not_admitted");
			}
			res.json({
				ok: true,
				idempotentReplay: false,
				executionId: spawned.executionId,
				targetAttempt: input.canonical.targetAttempt,
			});
		} catch (error) {
			res.status(500).json({
				ok: false,
				reason: error instanceof Error ? error.message : "re_qa_failed",
			});
		}
	});

	return router;
}
