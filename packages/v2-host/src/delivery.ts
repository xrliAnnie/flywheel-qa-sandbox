import {
	type AttemptHandle,
	type EngineRuntime,
	issueProposalCapability,
	type PollOnceOptions,
	type ProposalAuthorization,
	parseSessionBinding,
	pollOnce,
	type RegisteredAgent,
} from "flywheel-v2-engine";
import {
	FENCE,
	FenceViolation,
	type Kernel,
	recordActionIntent,
	recordActionOutcome,
	recordExternalEffectIntentTx,
} from "flywheel-v2-kernel";

/**
 * FLY-1503 item 1 / FLY-1543 ④: the delivery contract, carried in every
 * envelope. A runner or lead must be able to learn the rules from the envelope
 * itself rather than from pretrained knowledge of this repo.
 */
export const DELIVERY_PROTOCOL = {
	v: 1,
	settlement: "one delivery is settled by exactly one submitted proposal",
	submit: {
		cli: "the flywheel-v2 CLI named by FLYWHEEL_V2_CLIENT_CLI",
		verb: "submit",
		flags: [
			"--socket <FLYWHEEL_V2_SOCKET>",
			"--secret <FLYWHEEL_V2_SECRET_PATH>",
			"--agent <handle.agent.agentId>",
			"--attempt <handle.attemptUid>",
			"--message <handle.messageUid>",
			"--capability-id <authorization.capabilityId>",
			"--token <authorization.token>",
			"--effects-file <absolute path to a JSON array of effects>",
		],
		// Codex R1 MEDIUM-6 (FLY-1503): the first *distinct* proposal wins; an
		// identical re-submit is safe; a different one conflicts.
		oneShot:
			"exactly one distinct proposal settles this attemptUid. Re-submitting the byte-identical effects is safe and replays the stored receipt; submitting different effects is a digest conflict and is refused",
		retryCaveat:
			"if a submit fails after the host accepted it but before durable settlement, retry the byte-identical effects. If a retry reports that no converter is waiting, the outcome is AMBIGUOUS -- the proposal may have settled or the delivery may have been consumed without settling. Do not change the effects and do not assume success: report the ambiguity",
		noAcknowledgement:
			"there is no acknowledgement step. The host records a delivery as sent once the response frame leaves it, which does not prove you read it -- so a crash right after receiving an envelope can leave that delivery recorded with no proposal until the attempt is crash-settled and the message is rescheduled. If you hold an envelope you cannot settle, report it as an event effect rather than assuming the host knows",
	},
	effects: {
		allowedKinds: ["event", "task"],
		event: {
			kind: "event",
			eventKind: "<string>",
			payload: "<string>",
		},
		task: {
			kind: "task",
			taskKind: "<string>",
			state: "draft | ready",
			payload: "<string>",
			projectId: "<string>",
			lineageRootTaskId: "<optional string>",
		},
		note: "verdicts and node completion are not proposable: they are recorded by the operator-side direct kernel verbs, not by an executor",
	},
	// FLY-1543 ③: the upstream channel exists now. A runner talks to its lead
	// through the same DB mailbox, never through vendor team tooling.
	reporting:
		"final results travel as effects in the single settling proposal. To reach the lead DURING the work -- a question, a progress note, a blocker -- use the `ask` verb: `ask --socket <FLYWHEEL_V2_SOCKET> --secret <FLYWHEEL_V2_SECRET_PATH> --session <FLYWHEEL_V2_SESSION_REF> --ask-kind ask|progress|blocked --payload <text>`. The recipient is resolved server-side (the issue's lead); the returned uid is the correlation key, and the lead's reply arrives in this session's own mailbox as an `ask_response` envelope whose payload carries the same uid. Vendor team tools (AskUserQuestion, SendMessage) do NOT reach the lead",
	redelivery:
		"a delivery is scoped to (messageUid, attemptUid). If a crash settles the processing attempt before your proposal, the same messageUid is delivered again with a NEW attemptUid and a new capability -- settle the attemptUid you were given, and do not reuse a capability from an earlier attemptUid",
	// FLY-1544 (founder ruling): settle timing is decided by the message kind,
	// with ZERO new machinery -- the mailbox's own unsettled-means-redelivered
	// property is the ledger.
	leadSettlement:
		"a LEAD settles by message kind: a mechanical notice (lifecycle events such as issue_opened/task_dispatched/node_completed/pr_ready/issue_merged/issue_closed, and progress asks) is settled IMMEDIATELY on read (`ack`, an empty-effects submit). A runner_ask that requires an answer is settled ONLY AFTER the reply was sent (enqueue the ask_response first, then settle) -- an unanswered ask deliberately stays pending in the mailbox as the living todo; no receipt table, no second ledger",
	// FLY-1547: the mailbox MCP tool face fulfils this SAME contract — no new
	// semantics, only a friendlier surface.
	mailboxMcp:
		"when a `flywheel-v2-mailbox` MCP server is registered in your session, its tools map onto this exact contract: `next`→next_delivery (the pull IS the read receipt), `settle`→submit (FYI letters auto-ack on your next mailbox tool call; actionable letters need an explicit settle, with `settle({reply})` deriving the reply route from the letter itself), `send`→enqueue (always pass a dedupe_key and reuse it on retry), `ask`→ask, `status`→mailbox_status. The bell notification only announces mail — content always comes from `next`",
	// FLY-1543 ④⑤: pull is the only post-spawn channel, in two forms.
	pull: {
		verb: "next",
		runner:
			"a runner pulls its own session mailbox with `next --socket <FLYWHEEL_V2_SOCKET> --secret <FLYWHEEL_V2_SECRET_PATH> --session <FLYWHEEL_V2_SESSION_REF>`. Long-polls up to ~10s; a timeout error (`no delivery became available`) is normal idleness -- pull again or keep working. Settle each envelope with `submit` before pulling the next",
		credential:
			"a lead pulls with --agent plus --delivery-credential-file <path written by register-lead --delivery-credential-out>. The host secret alone does not authorise a lead pull, and the token is never accepted as a flag value because argv is readable by every process sharing this uid",
		supersession:
			"a lead credential dies with its registration: after a takeover it is revoked, and a pull with it is refused rather than served a stale envelope. A runner session needs no credential -- its activation IS its registration, and a terminal activation is refused",
	},
} as const;

export interface DeliveryEnvelope {
	v: 1;
	message: {
		messageUid: string;
		payload: string;
		kind: string;
		sourceKind: string;
		seq: number;
	};
	handle: AttemptHandle;
	authorization: ProposalAuthorization;
	deliveryActionId: string;
	protocol: typeof DELIVERY_PROTOCOL;
}

export interface PreparedDelivery {
	handle: AttemptHandle;
	deliveryActionId: string;
	envelope?: DeliveryEnvelope;
}

/** Prefix of every mailbox delivery action id; the suffix is the attempt uid.
 * Versioned (Codex R4 MEDIUM-5, FLY-1503): the prefix carries the logical
 * scope, so an action written before the scope changed and one written after
 * can never share an id. */
const DELIVERY_ACTION_PREFIX = "mailbox-delivery:pa1:";

export function deliveryActionId(attemptUid: string): string {
	return `${DELIVERY_ACTION_PREFIX}${attemptUid}`;
}

export function deliveryLogicalEffectId(
	messageUid: string,
	attemptUid: string,
): string {
	return `deliver:${messageUid}:${attemptUid}`;
}

function actionActor(agent: AttemptHandle["agent"]) {
	return agent.kind === "runner"
		? {
				kind: "runner" as const,
				agentId: agent.agentId,
				instanceId: agent.instanceId,
				generation: agent.generation,
				activationId: agent.activationId,
			}
		: {
				kind: "lead" as const,
				agentId: agent.agentId,
				instanceId: agent.instanceId,
				generation: agent.generation,
			};
}

/**
 * Record the delivery intent and mint the settle capability for one (message,
 * processing attempt) pair. Shared by the lead push/pull path, the runner
 * spawn-injection path and the runner session pull path.
 *
 * The logical scope of a delivery is (message, PROCESSING ATTEMPT) -- see the
 * FLY-1503 Codex R3 analysis: handing message X to attempt #1 and to attempt
 * #2 are two different external effects, both real, both recorded.
 */
export function prepareDelivery(
	kernel: Kernel,
	runtime: EngineRuntime,
	expectedEpoch: number,
	message: DeliveryEnvelope["message"],
	handle: AttemptHandle,
): PreparedDelivery {
	const actionId = deliveryActionId(handle.attemptUid);
	const intent = kernel.write("host.delivery-intent", (tx) => {
		const runnerScope =
			handle.agent.kind === "runner"
				? tx.get<{
						task_id: string;
						attempt_id: string;
						attempt_generation: number;
					}>(
						`SELECT a.task_id,a.id AS attempt_id,
						        a.generation AS attempt_generation
						   FROM activations act
						   JOIN attempts a ON a.id=act.attempt_id
						  WHERE act.id=@activationId
						    AND act.session_ref=@sessionRef
						    AND act.state='active'`,
						{
							activationId: handle.agent.activationId,
							sessionRef: handle.agent.instanceId,
						},
					)
				: undefined;
		if (handle.agent.kind === "runner" && !runnerScope) {
			throw new FenceViolation(
				"runner delivery activation scope is missing or stale",
			);
		}
		const scope = runnerScope
			? {
					taskId: runnerScope.task_id,
					attemptId: runnerScope.attempt_id,
					attemptGeneration: runnerScope.attempt_generation,
				}
			: {};
		return recordActionIntent(
			tx,
			{
				id: actionId,
				...scope,
				actor: actionActor(handle.agent),
				kind: "mailbox.deliver",
				payload: {
					message_uid: message.messageUid,
					attempt_uid: handle.attemptUid,
				},
				logicalEffectId: deliveryLogicalEffectId(
					message.messageUid,
					handle.attemptUid,
				),
				invocationUid: `mailbox:${handle.attemptUid}`,
				cutoverEpoch: expectedEpoch,
			},
			{
				prepare: (writeTx) => {
					recordExternalEffectIntentTx(writeTx, {
						effectKey: `deliver:${handle.attemptUid}`,
						family: "deliver",
						nowIso: runtime.clock.nowIso(),
					});
				},
			},
		);
	});
	if (intent.outcome === "replayed" && intent.action.state === "succeeded") {
		return { handle, deliveryActionId: actionId };
	}
	if (intent.outcome === "replayed" && intent.action.state !== "intended") {
		throw new FenceViolation(
			`delivery ${actionId} already escaped the host; manual evidence is required`,
		);
	}
	const authorization = issueProposalCapability(
		kernel,
		runtime,
		handle,
		actionId,
	);
	return {
		handle,
		deliveryActionId: actionId,
		envelope: {
			v: 1,
			message,
			handle,
			authorization,
			deliveryActionId: actionId,
			protocol: DELIVERY_PROTOCOL,
		},
	};
}

/**
 * FLY-1547 §2.1: same-recipient re-poll is the self-evidence of a lost handoff.
 *
 * The protocol requires settle-before-next. When the same recipient polls
 * again while a running processing attempt exists whose delivery action has
 * already SUCCEEDED (the host frame flushed), the only legal reading is that
 * the handoff chain (host frame → MCP/tool result → model) died after the
 * flush. This settles that attempt as crashed in one transaction, releasing
 * `pa_one_running` so the very next poll re-serves the SAME message under a
 * NEW attemptUid + capability (the envelope redelivery clause, at-least-once).
 *
 * Deliberately NOT applied to `dag_task_dispatch` rows: the first envelope is
 * durably embedded in the spawn prompt, so a re-poll is not evidence of loss —
 * crash-settling it would silently kill the embedded capability of a healthy
 * runner that polls before settling its assignment.
 *
 * Known bound (documented, loud): two CONCURRENT polls from one recipient can
 * crash-settle an envelope that is still in flight to the first caller; the
 * first caller's settle then fails on the capability fence rather than
 * anything being lost. Recipients are serial by protocol; the MCP tool face
 * serializes calls.
 */
export function redeliverLostHandoffTx(
	kernel: Kernel,
	runtime: EngineRuntime,
	input: { attemptUid: string; messageUid: string; sessionRef: string },
): void {
	kernel.write("host.delivery-handoff-lost", (tx) => {
		tx.cas(FENCE.processingAttemptCasRunningSettled, {
			attemptUid: input.attemptUid,
			outcome: "crashed",
			settledAt: runtime.clock.nowIso(),
			proposalDigest: null,
		});
		const eventUid = `delivery_handoff_lost:${input.attemptUid}`;
		if (
			!tx.get("SELECT 1 FROM events WHERE event_uid=@eventUid", { eventUid })
		) {
			tx.run(
				`INSERT INTO events
				 (event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,
				  cutover_epoch,created_at)
				 VALUES(@eventUid,NULL,NULL,'delivery_handoff_lost','host',
				        @sourceId,@payload,
				        (SELECT CAST(value AS INTEGER) FROM meta
				          WHERE key='cutover_epoch'),@now)`,
				{
					eventUid,
					sourceId: input.attemptUid,
					payload: JSON.stringify({
						message_uid: input.messageUid,
						attempt_uid: input.attemptUid,
						session_ref: input.sessionRef,
					}),
					now: runtime.clock.nowIso(),
				},
			);
		}
	});
}

export function recordDeliverySucceeded(
	kernel: Kernel,
	delivery: Pick<DeliveryEnvelope, "deliveryActionId" | "handle">,
): void {
	kernel.write("host.delivery-outcome", (tx) => {
		recordActionOutcome(tx, {
			id: delivery.deliveryActionId,
			actor: actionActor(delivery.handle.agent),
			state: "succeeded",
			result: { delivered: true },
		});
	});
}

interface ActivationRow {
	id: string;
	attempt_id: string;
	session_ref: string;
	generation: number;
	state: string;
	session_binding: string | null;
	last_poll_at: string | null;
}

/**
 * FLY-1543 ⑤: build the runner ledger identity for an ACTIVE session. The
 * anti-zombie predicate is the activation state; a terminal or unknown session
 * ref fails closed. The binding is attached when recorded (post-spawn) and
 * absent before the tmux process exists.
 */
export function requireActiveRunnerAgent(
	kernel: Kernel,
	sessionRef: string,
): Extract<RegisteredAgent, { kind: "runner" }> {
	const row = kernel.read((tx) =>
		tx.get<ActivationRow>(
			`SELECT id,attempt_id,session_ref,generation,state,session_binding,last_poll_at
			   FROM activations WHERE session_ref=@sessionRef AND state='active'`,
			{ sessionRef },
		),
	);
	if (!row) {
		throw new FenceViolation(`session ${sessionRef} has no active activation`);
	}
	return {
		kind: "runner",
		agentId: sessionRef,
		instanceId: sessionRef,
		generation: row.generation,
		activationId: row.id,
		...(row.session_binding
			? { sessionBinding: parseSessionBinding(row.session_binding) }
			: {}),
	};
}

export type RunnerPollOutcome =
	| {
			status: "available";
			message: DeliveryEnvelope["message"];
			handle: AttemptHandle;
	  }
	| { status: "empty" };

/**
 * Pull-side poll for one session: resumes the running processing attempt if one
 * exists (at-least-once), otherwise starts the next pending message addressed
 * to this session. Runner sessions never touch the driver.
 */
export type LeadPollOutcome =
	| {
			status: "available";
			message: DeliveryEnvelope["message"];
			handle: AttemptHandle;
			nextFounderStreak: number;
	  }
	| { status: "empty"; nextFounderStreak: number };

/**
 * FLY-1547 §2.2: claim-at-next for LEADS. The processing attempt (the read
 * receipt: who/when/which) is created here, inside the recipient's own
 * authenticated pull — never by a registration-time prefetch loop. The founder
 * VIP streak is threaded by the caller (host keeps it per lead), preserving
 * the driver-era founder-first ordering byte for byte.
 */
export function pollLeadDelivery(
	kernel: Kernel,
	runtime: EngineRuntime,
	agent: RegisteredAgent,
	founderStreak: number,
): LeadPollOutcome {
	const polled = pollOnce(kernel, runtime, agent, founderStreak);
	if (polled.result.status !== "available") {
		return { status: "empty", nextFounderStreak: polled.nextFounderStreak };
	}
	const available = polled.result;
	return {
		status: "available",
		message: {
			messageUid: available.handle.messageUid,
			payload: available.payload,
			kind: available.kind,
			sourceKind: available.sourceKind,
			seq: available.seq,
		},
		handle: available.handle,
		nextFounderStreak: polled.nextFounderStreak,
	};
}

export function pollRunnerDelivery(
	kernel: Kernel,
	runtime: EngineRuntime,
	sessionRef: string,
	options?: PollOnceOptions,
): RunnerPollOutcome {
	const agent = requireActiveRunnerAgent(kernel, sessionRef);
	const polled = pollOnce(kernel, runtime, agent, 0, undefined, options);
	if (polled.result.status !== "available") return { status: "empty" };
	const available = polled.result;
	return {
		status: "available",
		message: {
			messageUid: available.handle.messageUid,
			payload: available.payload,
			kind: available.kind,
			sourceKind: available.sourceKind,
			seq: available.seq,
		},
		handle: available.handle,
	};
}
