import { type Request, type Response, Router } from "express";
import { CommDB } from "flywheel-comm/db";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorizationDeps,
	type MessageProvenance,
} from "flywheel-comm/lead-lease";

interface ThreadScope {
	thread_id: string;
	issue_id: string;
	lead_id: string;
	session_role: string;
}

interface SessionScope {
	project_name: string;
}

interface LeadRequest {
	leadId: string;
	projectName: string;
	leaseClaim?: { leaseKey: string; generation: number };
	carrierClaim?: string;
	provenance?: MessageProvenance;
}

export interface FounderRoutingResponseRouterDeps {
	getThreadById: (threadId: string) => ThreadScope | undefined;
	getSessionsByIssue: (issueId: string) => SessionScope[];
	commDbPathForProject: (projectName: string) => string;
	leadLeaseEnv?: NodeJS.ProcessEnv;
	leadWriteAuthorizationDeps?: LeadWriteAuthorizationDeps;
	authorizeLeadRequest?: (input: LeadRequest) => MessageProvenance | undefined;
	now?: () => string;
	logger?: { warn: (message: string) => void };
}

function requestEnv(
	input: LeadRequest,
	base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const env = { ...base };
	delete env.FLYWHEEL_LEAD_ID;
	delete env.FLYWHEEL_LEAD_LEASE_KEY;
	delete env.FLYWHEEL_LEAD_GENERATION;
	delete env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
	env.FLYWHEEL_PROJECT_NAME = input.projectName;
	if (input.leaseClaim) {
		env.FLYWHEEL_LEAD_LEASE_KEY = input.leaseClaim.leaseKey;
		env.FLYWHEEL_LEAD_GENERATION = String(input.leaseClaim.generation);
	}
	if (input.carrierClaim) {
		env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = input.carrierClaim;
	}
	return env;
}

function authorizeRequest(
	deps: FounderRoutingResponseRouterDeps,
	input: LeadRequest,
): MessageProvenance | undefined {
	if (deps.authorizeLeadRequest) return deps.authorizeLeadRequest(input);
	const authorization = authorizeLeadWrite(
		{
			claimedLeadId: input.leadId,
			env: requestEnv(input, deps.leadLeaseEnv ?? process.env),
		},
		deps.leadWriteAuthorizationDeps,
	);
	return {
		senderLeaseKey: authorization.provenance?.senderLeaseKey,
		senderGeneration: authorization.provenance?.senderGeneration,
		senderHolderPid: authorization.provenance?.senderHolderPid,
		senderHolderStart: authorization.provenance?.senderHolderStart,
		writerPid:
			typeof input.provenance?.writerPid === "number" &&
			Number.isSafeInteger(input.provenance.writerPid) &&
			input.provenance.writerPid > 0
				? input.provenance.writerPid
				: null,
		writerStart:
			typeof input.provenance?.writerStart === "string" &&
			input.provenance.writerStart.length > 0
				? input.provenance.writerStart
				: null,
	};
}

export function createFounderRoutingResponseRouter(
	deps: FounderRoutingResponseRouterDeps,
): Router {
	const router = Router();
	router.post("/", (req: Request, res: Response) => {
		const body = (req.body ?? {}) as {
			questionId?: unknown;
			leadId?: unknown;
			answer?: unknown;
			sourceThread?: unknown;
			expectedOwner?: unknown;
			expectedCheckpoint?: unknown;
			leaseClaim?: { leaseKey?: unknown; generation?: unknown };
			carrierClaim?: unknown;
			provenance?: MessageProvenance;
		};
		if (
			typeof body.questionId !== "string" ||
			!body.questionId.trim() ||
			typeof body.leadId !== "string" ||
			!body.leadId.trim() ||
			typeof body.answer !== "string" ||
			!body.answer.trim() ||
			typeof body.sourceThread !== "string" ||
			!body.sourceThread.trim()
		) {
			res.status(400).json({ error: "missing_or_invalid_required_fields" });
			return;
		}
		if (
			(body.expectedOwner !== undefined &&
				typeof body.expectedOwner !== "string") ||
			(body.expectedCheckpoint !== undefined &&
				body.expectedCheckpoint !== null &&
				typeof body.expectedCheckpoint !== "string")
		) {
			res.status(400).json({ error: "invalid_expected_scope" });
			return;
		}

		const questionId = body.questionId;
		const leadId = body.leadId;
		const sourceThread = body.sourceThread;
		const thread = deps.getThreadById(sourceThread);
		if (!thread) {
			res.status(404).json({ error: "source_thread_not_registered" });
			return;
		}
		if (thread.lead_id !== leadId) {
			res.status(409).json({ error: "thread_lead_scope_mismatch" });
			return;
		}
		const projects = new Set(
			deps
				.getSessionsByIssue(thread.issue_id)
				.map((session) => session.project_name)
				.filter(Boolean),
		);
		if (projects.size !== 1) {
			res.status(409).json({ error: "thread_project_scope_unavailable" });
			return;
		}
		const projectName = [...projects][0]!;

		let provenance: MessageProvenance | undefined;
		try {
			provenance = authorizeRequest(deps, {
				leadId,
				projectName,
				...(typeof body.leaseClaim?.leaseKey === "string" &&
				Number.isSafeInteger(body.leaseClaim.generation) &&
				(body.leaseClaim.generation as number) > 0
					? {
							leaseClaim: {
								leaseKey: body.leaseClaim.leaseKey,
								generation: body.leaseClaim.generation as number,
							},
						}
					: {}),
				...(typeof body.carrierClaim === "string"
					? { carrierClaim: body.carrierClaim }
					: {}),
				provenance: body.provenance,
			});
		} catch (error) {
			deps.logger?.warn(
				`[founder-routing] Lead authorization denied: ${(error as Error).message}`,
			);
			res.status(403).json({ error: "lead_write_unauthorized" });
			return;
		}

		let db: CommDB | undefined;
		try {
			db = new CommDB(deps.commDbPathForProject(projectName), false);
			const question = db.getMessageById(questionId);
			if (!question) {
				res.status(404).json({ error: "question_not_found" });
				return;
			}
			const owner = db.getSession(question.from_agent);
			if (
				!owner ||
				owner.project_name !== projectName ||
				owner.issue_id !== thread.issue_id ||
				owner.lead_id !== leadId ||
				question.to_agent !== leadId
			) {
				res.status(409).json({ error: "question_thread_scope_mismatch" });
				return;
			}
			const result = db.insertGuardedResponse({
				questionId,
				authenticatedLead: leadId,
				content: body.answer,
				expectedOwner:
					typeof body.expectedOwner === "string"
						? body.expectedOwner
						: undefined,
				expectedCheckpoint:
					body.expectedCheckpoint === undefined
						? undefined
						: (body.expectedCheckpoint as string | null),
				now: (deps.now ?? (() => new Date().toISOString()))(),
				provenance,
			});
			res.json({ ok: true, responseId: result.responseId });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			deps.logger?.warn(
				`[founder-routing] response rejected for ${questionId}: ${detail}`,
			);
			if (
				/scope mismatch|not Lead-routable|already answered|no longer open/.test(
					detail,
				)
			) {
				res.status(409).json({ error: "guarded_response_rejected" });
				return;
			}
			res.status(500).json({ error: "runner_response_internal_error" });
		} finally {
			db?.close();
		}
	});
	return router;
}
