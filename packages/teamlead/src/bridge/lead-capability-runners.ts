import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Application, Router } from "express";
import {
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import {
	forwardedLeadAuthorizationEnv,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { z } from "zod";
import { createRunnerActionContext } from "../lead-backends/codex/runner-action-context.js";
import { RUNNER_ACTION_TOOL_NAMES } from "../lead-backends/codex/runner-action-names.js";
import type { OperationReceiptStore } from "../lead-capabilities/receipts.js";
import { commDbPathForProject } from "./commdb-path.js";
import { executeLeadRunnerOperation } from "./lead-runner-operation.js";

const envelope = z
	.object({
		schemaVersion: z.literal(1),
		operationId: z.enum(RUNNER_ACTION_TOOL_NAMES),
		requestId: z.string().uuid(),
		projectName: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
		leadId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		carrierClaim: z.string().min(1).max(256),
		activationId: z.string().min(1).max(128),
		input: z.record(z.string(), z.unknown()),
		receiptOnly: z.boolean().optional(),
	})
	.strict();
export interface LeadRunnerProviderOptions {
	apiToken: string;
	bridgeUrl: string;
	stateDbPath: string;
	receipts: OperationReceiptStore;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	projectsPath?: string;
	commDbPath?: (projectName: string) => string;
	fetchImpl?: typeof fetch;
	/** Isolated test seam; production uses the existing adopted-menu resolver. */
	resolveMenus?: () => string[];
}
export function createLeadRunnerRouter(
	options: LeadRunnerProviderOptions,
): Router {
	const router = Router();
	router.post("/", async (req, res) => {
		const supplied = Buffer.from(req.headers.authorization ?? ""),
			expected = Buffer.from(`Bearer ${options.apiToken}`);
		if (
			!options.apiToken ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			res.status(401).json({ status: "rejected", errorCode: "unauthorized" });
			return;
		}
		const parsed = envelope.safeParse(req.body);
		if (
			!parsed.success ||
			Buffer.byteLength(JSON.stringify(req.body)) > 65536
		) {
			res
				.status(400)
				.json({ status: "rejected", errorCode: "invalid_request" });
			return;
		}
		const body = parsed.data,
			controller = new AbortController();
		const disconnected = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", disconnected);
		res.once("close", disconnected);
		try {
			const base = options.env ?? process.env,
				home = options.homeDir ?? homedir(),
				projectsPath =
					options.projectsPath ??
					base.FLYWHEEL_PROJECTS_FILE ??
					join(home, ".flywheel/projects.json");
			const initial = resolveLeadIdentityRow({
				projectsPath,
				homeDir: home,
				projectName: body.projectName,
				leadId: body.leadId,
			});
			const env = forwardedLeadAuthorizationEnv(
				{
					claimedLeadId: body.leadId,
					projectName: body.projectName,
					identityDigest: body.identityDigest,
					carrierClaim: body.carrierClaim,
				},
				{
					...base,
					...Object.fromEntries(
						identityEnvProjection(initial.identity).map((line) => {
							const at = line.indexOf("=");
							return [line.slice(0, at), line.slice(at + 1)];
						}),
					),
					HOME: home,
					FLYWHEEL_PROJECTS_FILE: projectsPath,
					FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "1",
					FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
				},
			);
			const current = () => {
				controller.signal.throwIfAborted();
				const row = resolveLeadIdentityRow({
					projectsPath,
					homeDir: home,
					projectName: body.projectName,
					leadId: body.leadId,
				});
				const carrier = validateLeadCarrierAuthorization({
					claimedLeadId: body.leadId,
					env,
				});
				if (
					row.identity.identityDigest !== body.identityDigest ||
					row.identity.role !== "dept" ||
					row.identity.backend !== "codex-app-server" ||
					row.lead.codexProfile !== "full-access" ||
					row.lead.codexCapabilityBundleVersion !== 2 ||
					!carrier.valid ||
					carrier.processIndeterminate
				)
					throw new Error("runner_scope_denied");
			};
			current();
			const result = await executeLeadRunnerOperation({
				...body,
				receipts: options.receipts,
				signal: controller.signal,
				secrets: [options.apiToken, body.carrierClaim],
				assertCurrent: current,
				actions: {
					context: createRunnerActionContext(env),
					stateDbPath: options.stateDbPath,
					commDbPath: (options.commDbPath ?? commDbPathForProject)(
						body.projectName,
					),
					bridge: {
						bridgeUrl: options.bridgeUrl,
						apiToken: options.apiToken,
						fetchImpl: options.fetchImpl,
					},
					resolveMenus: options.resolveMenus,
				},
			});
			if (!res.destroyed) res.json(result);
		} catch {
			if (!res.destroyed)
				res.status(403).json({
					requestId: body.requestId,
					status: "rejected",
					resourceRefs: [],
					errorCode: "runner_scope_denied",
				});
		} finally {
			req.off("aborted", disconnected);
			res.off("close", disconnected);
		}
	});
	return router;
}
export function mountLeadRunnerProvider(
	app: Application,
	options: LeadRunnerProviderOptions,
): void {
	if (options.apiToken)
		app.use("/api/lead-capabilities/runners", createLeadRunnerRouter(options));
}
