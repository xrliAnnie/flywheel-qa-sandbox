import { timingSafeEqual } from "node:crypto";
import express from "express";
import { isOperationalTerminalStatus } from "../operational-terminal-status.js";
import type { StateStore } from "../StateStore.js";
import { QaRoomError } from "./qa-room-contract.js";
import type { QaRoomActor, QaRoomService } from "./qa-room-service.js";
import { rejectNonLoopback } from "./workflow-decision-routes.js";

export type QaRoomAuthStore = Pick<
	StateStore,
	| "getSession"
	| "resolveCurrentWorkflowActivation"
	| "getWorkflowSubmissionCredentialForActivation"
	| "getWorkflowSubmissionCredentialByToken"
	| "preflightStrengthTwoEvidenceCredential"
>;
interface Options {
	store: QaRoomAuthStore;
	service: QaRoomService;
	apiToken?: string;
	ingestToken?: string;
	enabled: () => boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function matches(header: string, token: string | undefined): boolean {
	if (!token) return false;
	const a = Buffer.from(header);
	const b = Buffer.from(`Bearer ${token}`);
	return a.length === b.length && timingSafeEqual(a, b);
}
function authenticate(options: Options, req: express.Request): QaRoomActor {
	const header = req.headers.authorization ?? "";
	if (matches(header, options.apiToken)) {
		const lead = req.get("X-Flywheel-Lead-Id");
		if (!lead || !/^[A-Za-z0-9._-]{1,100}$/.test(lead))
			throw new QaRoomError("lead_id_required");
		if (req.body?.execution_id !== undefined)
			throw new QaRoomError("lead_execution_id_forbidden");
		return { key: `lead:${lead}`, issue: null, lead: true };
	}
	if (!matches(header, options.ingestToken))
		throw new QaRoomError("unauthorized", 401);
	const execution =
		req.method === "GET"
			? req.get("X-Flywheel-Execution-Id")
			: req.body?.execution_id;
	if (typeof execution !== "string" || !uuid.test(execution))
		throw new QaRoomError("execution_id_required", 403);
	const session = options.store.getSession(execution);
	if (
		!session ||
		isOperationalTerminalStatus(session.status) ||
		session.terminal_at
	)
		throw new QaRoomError("runner_not_active", 403);
	const activation = options.store.resolveCurrentWorkflowActivation(execution);
	if (activation.kind === "ambiguous")
		throw new QaRoomError("runner_activation_stale", 403);
	if (
		session.session_role !== "qa" &&
		!(
			activation.kind === "current" &&
			["implement", "qa"].includes(activation.node.type)
		)
	)
		throw new QaRoomError("runner_role_refused", 403);
	if (
		activation.kind === "current" &&
		options.store.getWorkflowSubmissionCredentialForActivation(
			activation.binding.activation_id,
		)
	) {
		const token =
			req.method === "GET"
				? req.get("X-Flywheel-Submission-Credential")
				: req.body?.credential;
		if (typeof token !== "string" || !token)
			throw new QaRoomError("credential_required", 403);
		const credential =
			options.store.getWorkflowSubmissionCredentialByToken(token);
		if (
			!credential ||
			credential.execution_id !== execution ||
			credential.activation_id !== activation.binding.activation_id
		)
			throw new QaRoomError("credential_mismatch", 403);
		const result = options.store.preflightStrengthTwoEvidenceCredential(
			credential.id,
			new Date().toISOString(),
		);
		if (!result.ok) throw new QaRoomError(result.reason, 403);
	}
	return {
		key: `runner:${execution}`,
		issue: session.issue_identifier ?? null,
		lead: false,
	};
}

export function createQaRoomRouter(options: Options): express.Router {
	const router = express.Router();
	router.use((req, res, next) => {
		const mutation = req.method === "POST";
		const action = req.path.endsWith("/teardown")
			? "teardown"
			: req.path.endsWith("/drills")
				? "drill"
				: "deploy";
		try {
			if (rejectNonLoopback(req, res)) {
				if (mutation)
					options.service.refuse(
						{ key: "unauthenticated", issue: null, lead: false },
						action,
						"non_loopback_host",
						req.body,
					);
				return;
			}
			if (!options.enabled())
				throw new QaRoomError("room_service_disabled", 503);
			if (!options.apiToken && !options.ingestToken)
				throw new QaRoomError("room_auth_unconfigured", 503);
			res.locals.qaRoomActor = authenticate(options, req);
			next();
		} catch (error) {
			const failure =
				error instanceof QaRoomError
					? error
					: new QaRoomError("room_authority_unavailable", 503);
			if (mutation)
				options.service.refuse(
					{ key: "unauthenticated", issue: null, lead: false },
					action,
					failure.reason,
					req.body,
				);
			res
				.status(failure.code)
				.json({
					ok: false,
					reason: failure.reason,
					...(failure.fields ? { fields: failure.fields } : {}),
				});
		}
	});
	const handle =
		(
			fn: (req: express.Request, res: express.Response) => void,
		): express.RequestHandler =>
		(req, res) => {
			try {
				fn(req, res);
			} catch (error) {
				const failure =
					error instanceof QaRoomError
						? error
						: new QaRoomError("room_service_failure", 500);
				res
					.status(failure.code)
					.json({
						ok: false,
						reason: failure.reason,
						...(failure.fields ? { fields: failure.fields } : {}),
					});
			}
		};
	router.post(
		"/",
		handle((req, res) => {
			res
				.status(202)
				.json(options.service.deploy(res.locals.qaRoomActor, req.body));
		}),
	);
	router.post(
		"/:room/teardown",
		handle((req, res) => {
			const id = String(req.params.room);
			if (!uuid.test(id)) {
				options.service.refuse(
					res.locals.qaRoomActor,
					"teardown",
					"room_id_invalid",
					req.body,
					id,
				);
				throw new QaRoomError("room_id_invalid");
			}
			res
				.status(202)
				.json(options.service.teardown(res.locals.qaRoomActor, id, req.body));
		}),
	);
	router.post(
		"/:room/drills",
		handle((req, res) => {
			const id = String(req.params.room);
			if (!uuid.test(id)) {
				options.service.refuse(
					res.locals.qaRoomActor,
					"drill",
					"room_id_invalid",
					req.body,
					id,
				);
				throw new QaRoomError("room_id_invalid");
			}
			res
				.status(202)
				.json(options.service.drill(res.locals.qaRoomActor, id, req.body));
		}),
	);
	router.get(
		"/",
		handle((_req, res) => {
			res.json({
				ok: true,
				rooms: options.service.list(res.locals.qaRoomActor),
			});
		}),
	);
	router.get(
		"/:room",
		handle((req, res) => {
			res.json(
				options.service.status(
					res.locals.qaRoomActor,
					String(req.params.room),
					typeof req.query.operation_id === "string"
						? req.query.operation_id
						: undefined,
				),
			);
		}),
	);
	return router;
}
