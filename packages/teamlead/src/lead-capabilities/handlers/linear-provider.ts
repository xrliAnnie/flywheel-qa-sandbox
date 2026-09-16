import { readFileSync } from "node:fs";
import type { LinearSdk } from "@linear/sdk";
import { DepartmentRegistry } from "../../department-registry.js";
import { parseAndValidateProjects } from "../../ProjectConfig.js";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { createLeadLinearClient } from "../linear-client.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import { createLinearHandlers } from "./linear.js";

const denied = () => new Error("linear_provider_scope_denied");
/** Factory entry: binds every metadata/read/write request to its broker operation lifetime. */
export function createLinearProviderSession(options: {
	token: string;
	env: NodeJS.ProcessEnv;
	activationId: string;
	fetchImpl?: typeof fetch;
}) {
	const session = createLeadLinearClient(options);
	try {
		const handlers = createLinearProviderHandlers({
			...options,
			client: session.client,
		});
		return {
			handlers: new Map<string, LeadOperationHandler>(
				[...handlers].map(([id, handler]) => [
					id,
					{
						authorize: (input, context) =>
							session.withSignal(context.signal, async () => {
								await handler.authorize!(input, context);
							}),
						execute: (input, context) =>
							session.withSignal(context.signal, () =>
								handler.execute(input, context),
							),
					},
				]),
			),
			close: session.close,
		};
	} catch (error) {
		void session.close();
		throw error;
	}
}
/** Parent-owned SDK client; no model-supplied metadata, cached grants or StateStore handles. */
export function createLinearProviderHandlers(options: {
	client: LinearSdk;
	env: NodeJS.ProcessEnv;
	activationId: string;
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env);
	const projectName = env.FLYWHEEL_PROJECT_NAME,
		leadId = env.FLYWHEEL_LEAD_ID,
		projectsPath = env.FLYWHEEL_PROJECTS_FILE;
	if (!projectName || !leadId || !projectsPath || !options.activationId)
		throw denied();
	function current(context: LeadOperationContext) {
		if (
			context.signal.aborted ||
			context.projectName !== projectName ||
			context.leadId !== leadId ||
			context.activationId !== options.activationId
		)
			throw denied();
		trusted.assertActivationCurrent();
		const projects = parseAndValidateProjects(
			JSON.parse(readFileSync(projectsPath!, "utf8")),
		);
		const project = projects.find((p) => p.projectName === projectName),
			lead = project?.leads.find((l) => l.agentId === leadId);
		if (
			!project?.linear?.team ||
			!project.linear.project ||
			!lead ||
			lead.match.labels.length !== 1
		)
			throw denied();
		return { projects, project, lead, revision: JSON.stringify(project) };
	}
	async function prepare(context: LeadOperationContext) {
		await context.assertCurrent();
		const initial = current(context),
			binding = initial.project.linear!;
		const check = () => {
			const next = current(context);
			if (next.revision !== initial.revision) throw denied();
			return next;
		};
		async function complete<T extends { id: string }>(
			request: PromiseLike<{ nodes: T[]; pageInfo: { hasNextPage: boolean } }>,
		) {
			const result = await request;
			check();
			if (
				result.pageInfo.hasNextPage !== false ||
				result.nodes.length > 250 ||
				result.nodes.some((n) => !n.id) ||
				new Set(result.nodes.map((n) => n.id)).size !== result.nodes.length
			)
				throw denied();
			return result.nodes;
		}
		const teams = (
			await complete(
				options.client.teams({
					first: 250,
					filter: { key: { eq: binding.team } },
				}),
			)
		).filter((t) => t.key === binding.team);
		if (teams.length !== 1) throw denied();
		const team = teams[0]!;
		const [projects, labels, members, states] = await Promise.all([
			complete(
				team.projects({
					first: 250,
					filter: { name: { eq: binding.project! } },
				}),
			),
			complete(team.labels({ first: 250 })),
			complete(team.members({ first: 250 })),
			complete(team.states({ first: 250 })),
		]);
		const matching = projects.filter((p) => p.name === binding.project);
		if (matching.length !== 1) throw denied();
		const requiredNames = [
			...new Set([
				...initial.lead.match.labels,
				...(binding.label ? [binding.label] : []),
			]),
		];
		const createLabelIds = requiredNames.map((name) => {
			const found = labels.filter(
				(l) => l.name.toLowerCase() === name.toLowerCase(),
			);
			if (found.length !== 1) throw denied();
			return found[0]!.id;
		});
		const authorizeLabels = async (names: string[]) => {
			const now = check();
			if (
				!new DepartmentRegistry(now.projects).isLeadDepartmentMember(
					projectName!,
					leadId!,
					names,
				).allowed ||
				requiredNames.some(
					(name) => !names.some((n) => n.toLowerCase() === name.toLowerCase()),
				)
			)
				throw denied();
		};
		await authorizeLabels(requiredNames);
		const registry = new DepartmentRegistry(initial.projects);
		const mutableLabelIds = new Set(
			labels
				.filter(
					(label) =>
						registry.isLeadDepartmentMember(projectName!, leadId!, [
							...requiredNames,
							label.name,
						]).allowed,
				)
				.map((l) => l.id),
		);
		const policy = {
			teamId: team.id,
			projectId: matching[0]!.id,
			createLabelIds,
			mutableLabelIds,
			assignableUserIds: new Set(
				members.filter((m) => m.active === true).map((m) => m.id),
			),
			// Terminal transitions trigger lifecycle closeout and stay founder-only.
			mutableStateIds: new Set(
				states
					.filter((s) => s.type !== "completed" && s.type !== "canceled")
					.map((s) => s.id),
			),
		};
		return createLinearHandlers({
			client: options.client,
			policy: () => {
				check();
				return policy;
			},
			authorizeLabels,
		});
	}
	return new Map(
		LEAD_CAPABILITY_CATALOG.filter(
			(d) =>
				d.operationId.startsWith("linear.") && d.classification !== "reserved",
		).map((d) => [
			d.operationId,
			{
				authorize: async (input, context) => {
					d.inputSchema.parse(input);
					const handlers = await prepare(context);
					await handlers.get(d.operationId)!.authorize!(input, context);
				},
				execute: async (input, context) => {
					d.inputSchema.parse(input);
					const handlers = await prepare(context);
					return handlers.get(d.operationId)!.execute(input, context);
				},
			} satisfies LeadOperationHandler,
		]),
	);
}
