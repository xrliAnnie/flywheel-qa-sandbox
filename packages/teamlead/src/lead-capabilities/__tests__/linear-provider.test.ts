import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import { afterEach, expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
import {
	createLinearProviderHandlers,
	createLinearProviderSession,
} from "../handlers/linear-provider.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: vi.fn() }),
}));
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "linear-provider-"));
	dirs.push(dir);
	const projectsPath = join(dir, "projects.json");
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: dir,
			linear: { team: "FLY", project: "Flywheel", label: "Tracked" },
			leads: [
				{
					agentId: "eng",
					summaryRole: "producer",
					backend: "codex-app-server",
					codexProfile: "full-access",
					codexCapabilityBundleVersion: 2,
					canSpawnRunners: false,
					botTokenEnv: "BOT_TOKEN",
					botUserId: "12345678901234567",
					chatChannel: "22345678901234567",
					match: { labels: ["Engineering"] },
				},
				{
					agentId: "product",
					summaryRole: "producer",
					canSpawnRunners: false,
					botTokenEnv: "PRODUCT_TOKEN",
					botUserId: "32345678901234567",
					chatChannel: "42345678901234567",
					match: { labels: ["Product"] },
				},
			],
		},
	];
	const save = () => writeFileSync(projectsPath, JSON.stringify(projects));
	save();
	const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });
	const team = {
		id: "team",
		key: "FLY",
		projects: vi.fn(async () => page([{ id: "project", name: "Flywheel" }])),
		labels: vi.fn(async () =>
			page([
				{ id: "eng-label", name: "Engineering" },
				{ id: "product-label", name: "Product" },
				{ id: "tracked", name: "Tracked" },
				{ id: "bug", name: "Bug" },
			]),
		),
		members: vi.fn(async () =>
			page([
				{ id: "member", active: true },
				{ id: "inactive", active: false },
			]),
		),
		states: vi.fn(async () => page([{ id: "state", type: "started" }])),
	};
	const issue = {
		id: "issue",
		identifier: "FLY-1",
		url: "https://linear.app/i/1",
		title: "Title",
		team: Promise.resolve({ id: "team" }),
		project: Promise.resolve({ id: "project" }),
		state: Promise.resolve({ id: "state" }),
		assignee: Promise.resolve(null),
		labels: async () => page([{ name: "Engineering" }, { name: "Tracked" }]),
	};
	const client = {
		teams: vi.fn(async () => page([team])),
		issue: vi.fn(async () => issue),
		createIssue: vi.fn(async () => ({
			success: true,
			issue: Promise.resolve(issue),
		})),
		updateIssue: vi.fn(async () => ({
			success: true,
			issue: Promise.resolve(issue),
		})),
	};
	const context: LeadOperationContext = {
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		projectName: "flywheel",
		leadId: "eng",
		activationId: "a1",
		signal: new AbortController().signal,
		assertCurrent: vi.fn(async () => {}),
	};
	const handlers = createLinearProviderHandlers({
		client: client as unknown as LinearClient,
		env: {
			FLYWHEEL_PROJECTS_FILE: projectsPath,
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_LEAD_ID: "eng",
		},
		activationId: "a1",
	});
	return { projectsPath, projects, save, team, client, context, handlers };
}
it("binds the actual SDK metadata request to cancellation before a mutation can run", async () => {
	const f = fixture();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const fetchImpl = vi.fn<typeof fetch>(() => {
		started();
		return new Promise(() => {});
	});
	const session = createLinearProviderSession({
		token: "PRIVATE_TOKEN",
		activationId: "a1",
		env: {
			FLYWHEEL_PROJECTS_FILE: f.projectsPath,
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_LEAD_ID: "eng",
		},
		fetchImpl,
	});
	const controller = new AbortController();
	try {
		expect(session.handlers.size).toBe(7);
		const pending = session.handlers
			.get("linear.issue.create")!
			.execute(
				{ teamId: "team", projectId: "project", title: "Title" },
				{ ...f.context, signal: controller.signal },
			);
		const rejected = expect(pending).rejects.toThrow(
			"linear_provider_unavailable",
		);
		await ready;
		controller.abort();
		await rejected;
		expect(fetchImpl).toHaveBeenCalledOnce();
		const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
		expect(body.query).toContain("query teams");
		expect(body.query).not.toContain("mutation");
	} finally {
		await session.close();
	}
});
it("resolves team/project and enforced labels from current registry and SDK metadata", async () => {
	const f = fixture();
	const result = await f.handlers
		.get("linear.issue.create")!
		.execute(
			{ teamId: "team", projectId: "project", title: "Title" },
			f.context,
		);
	expect(result.status).toBe("succeeded");
	expect(f.client.createIssue).toHaveBeenCalledWith(
		expect.objectContaining({
			teamId: "team",
			projectId: "project",
			labelIds: ["eng-label", "tracked"],
		}),
	);
	expect(f.team.projects).toHaveBeenCalled();
});
it.each([
	"incomplete",
	"ambiguous",
	"missing-label",
	"config-drift",
	"foreign-label",
	"inactive-member",
	"wrong-activation",
])("rejects %s before a provider write", async (kind) => {
	const f = fixture();
	if (kind === "incomplete")
		f.team.labels.mockResolvedValueOnce({
			nodes: [],
			pageInfo: { hasNextPage: true },
		});
	if (kind === "ambiguous")
		f.team.projects.mockResolvedValueOnce({
			nodes: [
				{ id: "p1", name: "Flywheel" },
				{ id: "p2", name: "Flywheel" },
			],
			pageInfo: { hasNextPage: false },
		});
	if (kind === "missing-label")
		f.team.labels.mockResolvedValueOnce({
			nodes: [],
			pageInfo: { hasNextPage: false },
		});
	if (kind === "config-drift")
		f.team.states.mockImplementationOnce(async () => {
			f.projects[0]!.linear.project = "Changed";
			f.save();
			return {
				nodes: [{ id: "state", type: "started" }],
				pageInfo: { hasNextPage: false },
			};
		});
	if (kind === "wrong-activation") f.context.activationId = "other";
	const operation =
		kind === "foreign-label"
			? "linear.issue.update"
			: kind === "inactive-member"
				? "linear.issue.assign"
				: "linear.issue.create";
	const input =
		kind === "foreign-label"
			? {
					issueId: "FLY-1",
					labelIds: ["eng-label", "tracked", "product-label"],
				}
			: kind === "inactive-member"
				? { issueId: "FLY-1", assigneeId: "inactive" }
				: { teamId: "team", projectId: "project", title: "Title" };
	await expect(
		f.handlers.get(operation)!.execute(input, f.context),
	).rejects.toThrow();
	expect(f.client.createIssue).not.toHaveBeenCalled();
	expect(f.client.updateIssue).not.toHaveBeenCalled();
});
it("reloads metadata for execution after authorization and does not retain a replay cache", async () => {
	const f = fixture(),
		handler = f.handlers.get("linear.issue.create")!;
	const input = { teamId: "team", projectId: "project", title: "Title" };
	await handler.authorize!(input, f.context);
	f.team.labels.mockResolvedValueOnce({
		nodes: [],
		pageInfo: { hasNextPage: false },
	});
	await expect(handler.execute(input, f.context)).rejects.toThrow();
	expect(f.client.createIssue).not.toHaveBeenCalled();
	expect(f.client.teams).toHaveBeenCalledTimes(2);
});

// Terminal states are lifecycle authority, including when the state name is innocuous.
it.each(["completed", "canceled"])(
	"denies %s states before authorization or direct execution can write",
	async (type) => {
		const f = fixture();
		f.team.states.mockResolvedValue({
			nodes: [{ id: "terminal-state", type }],
			pageInfo: { hasNextPage: false },
		});
		const handler = f.handlers.get("linear.issue.update")!;
		const input = { issueId: "FLY-1", stateId: "terminal-state" };
		await expect(handler.authorize!(input, f.context)).rejects.toThrow(
			"linear_scope_denied",
		);
		await expect(handler.execute(input, f.context)).rejects.toThrow(
			"linear_scope_denied",
		);
		expect(f.client.updateIssue).not.toHaveBeenCalled();
	},
);
it("permits a nonterminal state but reloads its type before execution", async () => {
	const f = fixture(),
		handler = f.handlers.get("linear.issue.update")!;
	const input = { issueId: "FLY-1", stateId: "state" };
	await handler.authorize!(input, f.context);
	expect((await handler.execute(input, f.context)).status).toBe("succeeded");
	expect(f.client.updateIssue).toHaveBeenCalledWith("issue", {
		stateId: "state",
	});
	f.client.updateIssue.mockClear();
	await handler.authorize!(input, f.context);
	f.team.states.mockResolvedValue({
		nodes: [{ id: "state", type: "completed" }],
		pageInfo: { hasNextPage: false },
	});
	await expect(handler.execute(input, f.context)).rejects.toThrow(
		"linear_scope_denied",
	);
	expect(f.client.updateIssue).not.toHaveBeenCalled();
});
