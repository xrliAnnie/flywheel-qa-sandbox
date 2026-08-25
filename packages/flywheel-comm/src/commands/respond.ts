import { hasApprovalIntent } from "../approval-intent.js";
import { CommDB } from "../db.js";
import { isReservedApprovalAttribution } from "../founder-attribution.js";
import { isFounderReviewCheckpoint } from "../founder-review.js";
import {
	defaultGateMarkerDir,
	markGateMarkerAnswered,
	readGateMarker,
	removeAskMarker,
} from "../gate-marker.js";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorization,
	type LeadWriteAuthorizationDeps,
	postCarrierClaim,
} from "../lead-lease.js";
import { isRunnerStopReport } from "../runner-stop-report.js";

export const GATED_CHECKPOINTS = new Set(["approve_to_ship"]);

export interface RespondArgs {
	questionId: string;
	fromAgent: string;
	answer: string;
	dbPath: string;
	bridgeUrl?: string;
	projectName?: string;
	sourceThread?: string;
	expectedOwner?: string;
	expectedCheckpoint?: string | null;
	kickback?: boolean;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	authorizationDeps?: LeadWriteAuthorizationDeps;
}

/** Persist one response; the Bridge Runner lane owns the delivery doorbell. */
export async function respond(args: RespondArgs): Promise<void> {
	const env = args.env ?? process.env;
	const db = new CommDB(args.dbPath, false);
	try {
		const question = db.getMessageById(args.questionId);
		if (!question) throw new Error(`Question not found: ${args.questionId}`);
		if (isRunnerStopReport(question)) {
			throw new Error(
				"flywheel-comm: runner-stop report does not accept responses; ACK its enclosing mailbox batch/event instead.",
			);
		}
		if (isFounderReviewCheckpoint(question.checkpoint)) {
			throw new Error(
				"flywheel-comm: founder_review is founder-bound; only the trusted founder writer may answer or request revisions.",
			);
		}
		if (question.checkpoint && GATED_CHECKPOINTS.has(question.checkpoint)) {
			if (isReservedApprovalAttribution(args.fromAgent)) {
				throw new Error(
					`flywheel-comm: "${args.fromAgent}" is a RESERVED approval attribution ` +
						"(bridge / bridge-founder-consent / a Discord-snowflake founder id) — " +
						"a Lead cannot respond to an approve_to_ship gate under that name.",
				);
			}
		}
		const authorization = authorizeLeadWrite(
			{ claimedLeadId: args.fromAgent, env },
			args.authorizationDeps,
		);
		if (question.checkpoint && GATED_CHECKPOINTS.has(question.checkpoint)) {
			if (hasApprovalIntent(args.answer)) {
				throw new Error(
					"flywheel-comm: lead_ack_rejected — Lead approval cannot resolve a founder-bound gate; only the trusted founder writer may approve.",
				);
			}
			const bridgeUrl =
				args.bridgeUrl?.trim() ||
				env.BRIDGE_URL?.trim() ||
				env.FLYWHEEL_BRIDGE_URL?.trim();
			if (bridgeUrl) {
				await routeThroughBridge({
					bridgeUrl,
					questionId: args.questionId,
					leadId: args.fromAgent,
					answer: args.answer,
					executionId: question.from_agent,
					projectName: args.projectName,
					kickback: args.kickback,
					authorization,
					env,
					fetchImpl: args.fetchImpl,
				});
				retireMarker(args.questionId, question.from_agent, env);
				return;
			}
			throw new Error(
				"flywheel-comm: refusing to resolve approve_to_ship gate directly. " +
					"Set BRIDGE_URL or --bridge-url so the wrapper enforces founder consent.",
			);
		}
		if (args.sourceThread) {
			const bridgeUrl =
				args.bridgeUrl?.trim() ||
				env.BRIDGE_URL?.trim() ||
				env.FLYWHEEL_BRIDGE_URL?.trim();
			if (!bridgeUrl) {
				throw new Error(
					"flywheel-comm: --source-thread requires --bridge-url or BRIDGE_URL; no local fallback is permitted.",
				);
			}
			await routeFounderResponseThroughBridge({
				bridgeUrl,
				questionId: args.questionId,
				leadId: args.fromAgent,
				answer: args.answer,
				sourceThread: args.sourceThread,
				expectedOwner: args.expectedOwner ?? question.from_agent,
				expectedCheckpoint:
					args.expectedCheckpoint === undefined
						? question.checkpoint
						: args.expectedCheckpoint,
				authorization,
				env,
				fetchImpl: args.fetchImpl,
			});
			retireMarker(args.questionId, question.from_agent, env);
			return;
		}

		db.insertGuardedResponse({
			questionId: args.questionId,
			authenticatedLead: args.fromAgent,
			content: args.answer,
			expectedOwner: args.expectedOwner,
			expectedCheckpoint: args.expectedCheckpoint,
			now: new Date().toISOString(),
			provenance: authorization.provenance,
		});
		retireMarker(args.questionId, question.from_agent, env);
	} finally {
		db.close();
	}
}

async function routeFounderResponseThroughBridge(opts: {
	bridgeUrl: string;
	questionId: string;
	leadId: string;
	answer: string;
	sourceThread: string;
	expectedOwner: string;
	expectedCheckpoint: string | null;
	authorization: LeadWriteAuthorization;
	env: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const token = opts.env.TEAMLEAD_API_TOKEN;
	if (!token) {
		throw new Error(
			"flywheel-comm: TEAMLEAD_API_TOKEN required when routing a founder-thread response via Bridge.",
		);
	}
	const url = `${opts.bridgeUrl.replace(/\/+$/, "")}/api/founder-routing/runner-response`;
	const body = {
		questionId: opts.questionId,
		leadId: opts.leadId,
		answer: opts.answer,
		sourceThread: opts.sourceThread,
		expectedOwner: opts.expectedOwner,
		expectedCheckpoint: opts.expectedCheckpoint,
		leaseClaim: opts.authorization.leaseClaim,
		identityDigest: opts.authorization.identityDigest,
		provenance: opts.authorization.provenance,
	};
	const headers = {
		"content-type": "application/json",
		Authorization: `Bearer ${token}`,
	};
	const fetchImpl = opts.fetchImpl ?? fetch;
	const response = opts.authorization.carrierClaim
		? await postCarrierClaim({
				url,
				carrierClaim: opts.authorization.carrierClaim,
				body,
				headers,
				fetchImpl,
			})
		: await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
	if (!response.ok) {
		let detail = `HTTP ${response.status}`;
		try {
			detail = JSON.stringify(await response.json());
		} catch {}
		throw new Error(
			`flywheel-comm: Bridge refused founder-thread response (HTTP ${response.status}): ${detail}. Retry after Bridge/scope recovery; no local write occurred.`,
		);
	}
}

function retireMarker(
	questionId: string,
	executionId: string,
	env: NodeJS.ProcessEnv,
): void {
	const markerDir = defaultGateMarkerDir(env);
	const marker = readGateMarker(markerDir, questionId);
	if (marker) {
		if (marker.executionId !== executionId) {
			process.stderr.write(
				`[flywheel-comm] gate marker ${questionId} execution mismatch ` +
					`(marker=${marker.executionId}, question=${executionId}) — marker retained.\n`,
			);
			return;
		}
		markGateMarkerAnswered(markerDir, questionId);
		return;
	}
	removeAskMarker(markerDir, questionId);
}

async function routeThroughBridge(opts: {
	bridgeUrl: string;
	questionId: string;
	leadId: string;
	answer: string;
	executionId?: string;
	projectName?: string;
	kickback?: boolean;
	authorization: LeadWriteAuthorization;
	env: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const token = opts.env.TEAMLEAD_API_TOKEN;
	if (!token) {
		throw new Error(
			"flywheel-comm: TEAMLEAD_API_TOKEN required when routing approve_to_ship via Bridge.",
		);
	}
	const url = `${opts.bridgeUrl.replace(/\/+$/, "")}/api/founder-consent/runner-gate-response`;
	const body = {
		questionId: opts.questionId,
		leadId: opts.leadId,
		answer: opts.answer,
		executionId: opts.executionId,
		projectName: opts.projectName,
		...(opts.kickback === true ? { kickback: true } : {}),
		leaseClaim: opts.authorization.leaseClaim,
		identityDigest: opts.authorization.identityDigest,
		provenance: opts.authorization.provenance,
	};
	const headers = {
		"content-type": "application/json",
		Authorization: `Bearer ${token}`,
	};
	const fetchImpl = opts.fetchImpl ?? fetch;
	const response = opts.authorization.carrierClaim
		? await postCarrierClaim({
				url,
				carrierClaim: opts.authorization.carrierClaim,
				body,
				headers,
				fetchImpl,
			})
		: await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
	if (!response.ok) {
		let detail = `HTTP ${response.status}`;
		try {
			detail = JSON.stringify(await response.json());
		} catch {}
		throw new Error(
			`flywheel-comm: Bridge refused approve_to_ship gate (HTTP ${response.status}): ${detail}`,
		);
	}
	try {
		const result = (await response.json()) as { warning?: string };
		if (result.warning) {
			process.stderr.write(
				`[flywheel-comm respond] WARNING: ${result.warning}\n`,
			);
		}
	} catch {}
}
