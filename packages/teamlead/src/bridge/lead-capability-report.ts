import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import {
	forwardedLeadAuthorizationEnv,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { z } from "zod";
import { DepartmentRegistry } from "../department-registry.js";
import { parseAndValidateProjects } from "../ProjectConfig.js";
import type { ReportRegistry } from "./report-registry.js";
import { isReportExpired } from "./report-retention.js";

const coordinate = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const requestSchema = z
	.object({
		projectName: coordinate,
		html: z
			.string()
			.min(1)
			.max(512 * 1024),
		title: z.string().max(200).optional(),
		capability: z
			.object({
				schemaVersion: z.literal(1),
				operationId: z.literal("report.publish"),
				requestId: z.string().uuid(),
				leadId: coordinate,
				identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
				carrierClaim: z.string().min(1).max(256),
				activationId: coordinate,
				issueId: coordinate,
			})
			.strict(),
	})
	.strict();
const denied = () => new Error("report_scope_denied");
/** Bridge-owned issue authorization; invoked inside the existing publish queue.
 * No StateStore handle or permission result is exported to the model. */
interface LeadReportScopeOptions {
	projectsPath?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	linearClient: LinearClient;
}
export function createLeadReportPublishAuthorizer(
	options: LeadReportScopeOptions,
) {
	const authorize = createLeadReportIssueAuthorizer(options);
	return async (
		raw: Readonly<Record<string, unknown>>,
	): Promise<() => void> => {
		try {
			const body = requestSchema.parse(raw);
			if (Buffer.byteLength(body.html, "utf8") > 512 * 1024) throw denied();
			return await authorize(body.projectName, body.capability);
		} catch {
			throw denied();
		}
	};
}

/** Shared current issue authorization, without performing a report operation. */
function createLeadReportIssueAuthorizer(options: LeadReportScopeOptions) {
	const env = Object.freeze({ ...(options.env ?? process.env) });
	const home = options.homeDir ?? env.HOME ?? homedir();
	const projectsPath =
		options.projectsPath ??
		env.FLYWHEEL_PROJECTS_FILE ??
		join(home, ".flywheel/projects.json");
	return async (
		projectName: string,
		proof: {
			leadId: string;
			identityDigest: string;
			carrierClaim: string;
			issueId: string;
		},
	): Promise<() => void> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let expired = false;
		const deadline = Date.now() + 15000;
		try {
			const claimEnv = forwardedLeadAuthorizationEnv(
				{
					claimedLeadId: proof.leadId,
					projectName: projectName,
					identityDigest: proof.identityDigest,
					carrierClaim: proof.carrierClaim,
				},
				{ ...env, HOME: home, FLYWHEEL_PROJECTS_FILE: projectsPath },
			);
			let revision: string | undefined;
			const current = () => {
				if (expired || Date.now() >= deadline) throw denied();
				const row = resolveLeadIdentityRow({
					projectsPath,
					homeDir: home,
					projectName: projectName,
					leadId: proof.leadId,
				});
				const carrier = validateLeadCarrierAuthorization({
					claimedLeadId: proof.leadId,
					env: claimEnv,
				});
				if (
					row.identity.identityDigest !== proof.identityDigest ||
					row.identity.backend !== "codex-app-server" ||
					row.identity.role !== "dept" ||
					row.lead.codexCapabilityBundleVersion !== 2 ||
					row.lead.codexProfile !== "full-access" ||
					!carrier.valid ||
					carrier.processIndeterminate
				)
					throw denied();
				const projects = parseAndValidateProjects(
					JSON.parse(readFileSync(projectsPath, "utf8")),
				);
				const project = projects.find((p) => p.projectName === projectName);
				if (
					!project?.linear?.team ||
					!project.linear.project ||
					!project.leads.some((l) => l.agentId === proof.leadId)
				)
					throw denied();
				const next = JSON.stringify(projects);
				if (revision !== undefined && revision !== next) throw denied();
				revision = next;
				return { projects, project };
			};
			current();
			const work = async () => {
				const issue = await options.linearClient.issue(proof.issueId);
				current();
				if (!issue) throw denied();
				const [team, project, labels] = await Promise.all([
					issue.team,
					issue.project,
					issue.labels({ first: 100 }),
				]);
				const scope = current();
				if (
					team?.key !== scope.project.linear!.team ||
					project?.name !== scope.project.linear!.project ||
					labels.pageInfo.hasNextPage !== false ||
					labels.nodes.length > 100
				)
					throw denied();
				const names = labels.nodes.map((l) => l.name);
				if (
					!new DepartmentRegistry(scope.projects).isLeadDepartmentMember(
						projectName,
						proof.leadId,
						names,
					).allowed ||
					(scope.project.linear!.label &&
						!names.some(
							(name) =>
								name.toLowerCase() ===
								scope.project.linear!.label!.toLowerCase(),
						))
				)
					throw denied();
				current();
			};
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					expired = true;
					reject(denied());
				}, 15000);
			});
			await Promise.race([work(), timeout]);
			current();
			return () => {
				try {
					current();
				} catch {
					throw denied();
				}
			};
		} catch {
			throw denied();
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
}

export const leadReportOwnerRequestSchema = z
	.object({
		projectName: coordinate,
		capability: z
			.object({
				schemaVersion: z.literal(1),
				operationId: z.enum(["report.verify", "report.deliver"]),
				requestId: z.string().uuid(),
				leadId: coordinate,
				identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
				carrierClaim: z.string().min(1).max(256),
				activationId: coordinate,
				reportId: z.string().regex(/^[a-f0-9]{32}$/),
				issueId: coordinate.optional(),
			})
			.strict(),
	})
	.strict();

/** Only published provenance grants access; unowned legacy reports remain unavailable. */
export function createLeadReportOwnerAuthorizer(
	options: LeadReportScopeOptions & {
		registry: ReportRegistry;
	},
) {
	const authorizeIssue = createLeadReportIssueAuthorizer(options);
	return async (raw: Readonly<Record<string, unknown>>) => {
		try {
			const body = leadReportOwnerRequestSchema.parse(raw),
				proof = body.capability;
			if (proof.operationId === "report.deliver" && !proof.issueId)
				throw denied();
			let snapshot: string | undefined;
			const owned = () => {
				const report = options.registry
					.list()
					.find((r) => r.token === proof.reportId);
				const owner = report?.capabilityOwner;
				if (
					!report ||
					!owner ||
					report.projectName !== body.projectName ||
					owner.leadId !== proof.leadId ||
					owner.identityDigest !== proof.identityDigest ||
					(proof.issueId !== undefined && proof.issueId !== owner.issueId) ||
					!Number.isFinite(Date.parse(report.createdAt)) ||
					isReportExpired(Date.now(), Date.parse(report.createdAt))
				)
					throw denied();
				const next = JSON.stringify(report);
				if (snapshot !== undefined && snapshot !== next) throw denied();
				snapshot = next;
				return report;
			};
			const report = owned();
			const guard = await authorizeIssue(body.projectName, {
				...proof,
				issueId: report.capabilityOwner!.issueId,
			});
			const assertCurrent = () => {
				guard();
				owned();
			};
			assertCurrent();
			return { report: structuredClone(report), assertCurrent };
		} catch {
			throw denied();
		}
	};
}

export const leadReportPublishReceiptRequestSchema = requestSchema.pick({
	projectName: true,
	capability: true,
});
/** Read only the registry commit corresponding to the original upload UUID. */
export function createLeadReportPublishReceiptAuthorizer(
	options: LeadReportScopeOptions & {
		registry: ReportRegistry;
	},
) {
	const authorizeIssue = createLeadReportIssueAuthorizer(options);
	return async (raw: Readonly<Record<string, unknown>>) => {
		try {
			const body = leadReportPublishReceiptRequestSchema.parse(raw),
				proof = body.capability;
			const guard = await authorizeIssue(body.projectName, proof);
			const read = () => {
				const matches = options.registry
					.list()
					.filter(
						(report) =>
							report.projectName === body.projectName &&
							report.capabilityOwner?.leadId === proof.leadId &&
							report.capabilityOwner?.identityDigest === proof.identityDigest &&
							report.capabilityOwner?.issueId === proof.issueId &&
							report.capabilityOwner?.requestId === proof.requestId,
					);
				if (matches.length > 1) throw denied();
				const report = matches[0];
				if (
					!report ||
					!Number.isFinite(Date.parse(report.createdAt)) ||
					isReportExpired(Date.now(), Date.parse(report.createdAt))
				)
					return undefined;
				return report;
			};
			guard();
			const report = read(),
				snapshot = JSON.stringify(report);
			const assertCurrent = () => {
				guard();
				if (JSON.stringify(read()) !== snapshot) throw denied();
			};
			assertCurrent();
			return {
				report: report ? structuredClone(report) : undefined,
				assertCurrent,
			};
		} catch {
			throw denied();
		}
	};
}
