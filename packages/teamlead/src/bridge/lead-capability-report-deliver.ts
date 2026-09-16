import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import {
	CodexLeadOutboundHandler,
	type DiscordSendFn,
	type OutboundDedupStore,
} from "../lead-backends/codex/CodexLeadOutboundHandler.js";
import { buildLeadDiscordSend } from "../lead-backends/codex/leadDiscordSend.js";
import {
	buildAuthorizeLeadChannel,
	buildResolveBotToken,
} from "../lead-backends/codexLeadBridgeWiring.js";
import { parseAndValidateProjects } from "../ProjectConfig.js";
import { leadReportOwnerRequestSchema } from "./lead-capability-report.js";
import type { ReportEntry, ReportRegistry } from "./report-registry.js";
import { reportUrlForToken } from "./report-url.js";
import { buildReportMessage } from "./reports-route.js";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Scoped report delivery uses the existing Bridge-owned durable outbound store. */
export function createLeadReportDeliverRouter(options: {
	registry: ReportRegistry;
	store: OutboundDedupStore;
	apiToken: string;
	authorize(
		raw: Readonly<Record<string, unknown>>,
	): Promise<{ report: ReportEntry; assertCurrent(): void }>;
	resolveIssueThread(
		issue: string,
		project: string,
	): string | undefined | Promise<string | undefined>;
	authorizeChannel(
		project: string,
		lead: string,
		channel: string,
	): boolean | "unavailable" | Promise<boolean | "unavailable">;
	send: DiscordSendFn;
}): Router {
	const router = Router();
	for (const path of ["/deliver", "/delivery-receipt"] as const) {
		router.post(path, async (req, res) => {
			const parsed = leadReportOwnerRequestSchema.safeParse(req.body);
			if (
				!parsed.success ||
				parsed.data.capability.operationId !== "report.deliver" ||
				!parsed.data.capability.issueId
			) {
				res.status(403).json({ error: "report scope denied" });
				return;
			}
			const body = parsed.data,
				proof = body.capability;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15000);
			const onClose = () => {
				if (!res.writableEnded) controller.abort();
			};
			req.once("aborted", onClose);
			res.once("close", onClose);
			const aborted = new Promise<never>((_, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => reject(new Error("report_delivery_aborted")),
					{ once: true },
				);
			});
			let dispatched = false;
			const work = async () => {
				let scope = await options.authorize(body);
				controller.signal.throwIfAborted();
				scope.assertCurrent();
				const report = scope.report;
				if (
					report.token !== proof.reportId ||
					report.projectName !== body.projectName
				)
					throw new Error("report_scope_denied");
				const url = reportUrlForToken(options.registry, report.token);
				if (
					!url ||
					!/^https:\/\/fw-reports-[a-f0-9]{6}\.vercel\.app\/r\/[a-f0-9]{32}\/$/.test(
						url,
					)
				)
					throw new Error("report_scope_denied");
				const channel = await options.resolveIssueThread(
					proof.issueId!,
					body.projectName,
				);
				controller.signal.throwIfAborted();
				scope.assertCurrent();
				if (!channel || !/^\d{17,20}$/.test(channel))
					throw new Error("report_scope_denied");
				const text = buildReportMessage(
					report.title ?? "Report",
					report.projectName,
					url,
					false,
				);
				const beforeSideEffect = async () => {
					controller.signal.throwIfAborted();
					scope.assertCurrent();
					const next = await options.authorize(body);
					controller.signal.throwIfAborted();
					scope.assertCurrent();
					next.assertCurrent();
					if (
						JSON.stringify(next.report) !== JSON.stringify(report) ||
						(await options.resolveIssueThread(
							proof.issueId!,
							body.projectName,
						)) !== channel
					)
						throw new Error("report_scope_denied");
					controller.signal.throwIfAborted();
					next.assertCurrent();
					if (
						(await options.authorizeChannel(
							body.projectName,
							proof.leadId,
							channel,
						)) !== true
					)
						throw new Error("report_scope_denied");
					controller.signal.throwIfAborted();
					next.assertCurrent();
					scope = next;
				};
				await beforeSideEffect();
				const key = `report-delivery:${hash([
					body.projectName,
					proof.leadId,
					proof.requestId,
					proof.reportId,
					proof.issueId,
					channel,
				])}`;
				const output = (messageId: string) => ({
					requestId: proof.requestId,
					status: "succeeded",
					resourceRefs: [messageId],
					data: {
						reportId: report.token,
						channelId: channel,
						messageId,
						delivery: "link-only",
						receiptId: proof.requestId,
						observedAt: new Date().toISOString(),
					},
				});
				if (path === "/delivery-receipt") {
					const existing = options.store.get(key);
					scope.assertCurrent();
					controller.signal.throwIfAborted();
					return existing?.status === "sent" &&
						existing.messageId &&
						/^\d{17,20}$/.test(existing.messageId)
						? output(existing.messageId)
						: {
								requestId: proof.requestId,
								status: "unknown",
								resourceRefs: [],
							};
				}
				const sender = new CodexLeadOutboundHandler({
					expectedApiToken: options.apiToken,
					store: options.store,
					send: options.send,
					authorizeLeadChannel: async (project, lead, target) => {
						if (
							project !== body.projectName ||
							lead !== proof.leadId ||
							target !== channel
						)
							return false;
						await beforeSideEffect();
						return true;
					},
				});
				dispatched = true;
				const result = await sender.handle({
					providedToken: options.apiToken,
					body: {
						projectName: body.projectName,
						leadId: proof.leadId,
						channelId: channel,
						text,
						idempotencyKey: key,
						nonce: hash(key).slice(0, 24),
					},
					guard: {
						signal: controller.signal,
						beforeSideEffect,
						assertSideEffectCurrent: () => {
							controller.signal.throwIfAborted();
							scope.assertCurrent();
						},
					},
				});
				controller.signal.throwIfAborted();
				scope.assertCurrent();
				if (
					["sent", "deduped"].includes(result.status) &&
					result.messageId &&
					/^\d{17,20}$/.test(result.messageId)
				)
					return output(result.messageId);
				return {
					requestId: proof.requestId,
					status: result.status === "rejected" ? "rejected" : "unknown",
					resourceRefs: [],
				};
			};
			try {
				res.json(await Promise.race([work(), aborted]));
			} catch {
				if (dispatched || controller.signal.aborted)
					res.status(503).json({
						requestId: proof.requestId,
						status: "unknown",
						resourceRefs: [],
					});
				else res.status(403).json({ error: "report scope denied" });
			} finally {
				clearTimeout(timer);
				controller.abort();
				req.off("aborted", onClose);
				res.off("close", onClose);
			}
		});
	}
	return router;
}

/** Bridge-only provider wiring. Reload registry for each token/channel decision. */
export function createLeadReportDeliveryProviders(
	options: {
		projectsPath?: string;
		env?: NodeJS.ProcessEnv;
		homeDir?: string;
	} = {},
) {
	const env = options.env ?? process.env;
	const path =
		options.projectsPath ??
		env.FLYWHEEL_PROJECTS_FILE ??
		join(options.homeDir ?? env.HOME ?? homedir(), ".flywheel/projects.json");
	const currentProjects = () =>
		parseAndValidateProjects(JSON.parse(readFileSync(path, "utf8")));
	const resolveBotToken = (project: string, lead: string) =>
		buildResolveBotToken(currentProjects(), env)(project, lead);
	return {
		currentProjects,
		send: buildLeadDiscordSend({ resolveBotToken }),
		authorizeChannel: async (project: string, lead: string, channel: string) =>
			buildAuthorizeLeadChannel(currentProjects(), { resolveBotToken })(
				project,
				lead,
				channel,
			),
	};
}
