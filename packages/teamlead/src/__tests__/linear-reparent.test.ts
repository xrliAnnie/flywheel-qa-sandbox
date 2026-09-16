import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const rawRequest = vi.fn();
const updateIssue = vi.fn();
const createIssue = vi.fn();
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: { rawRequest },
		updateIssue,
		createIssue,
	})),
}));

function issue(identifier: string, project = "Flywheel") {
	return {
		id: `uuid-${identifier}`,
		identifier,
		title: "unchanged",
		description: "original body",
		priority: 2,
		priorityLabel: "High",
		url: `https://linear.app/test/${identifier}`,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		state: { name: "Backlog", type: "backlog" },
		labels: { nodes: [{ name: "Flywheel" }] },
		assignee: null,
		project: { id: `project-${project}`, name: project },
		parent: null as { id: string; identifier: string } | null,
	};
}
const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [{ agentId: "eng", chatChannel: "c", match: { labels: ["Eng"] } }],
		linear: { team: "FLY", project: "Flywheel", label: "Flywheel" },
	},
];

describe("FLY-2612 shared Linear reparent", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let nodes: ReturnType<typeof issue>[];
	const source = () => nodes[0]!;
	const target = () => nodes[1]!;
	async function start(overrides: Partial<BridgeConfig> = {}) {
		store = await StateStore.create(":memory:");
		server = createBridgeApp(store, projects, {
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			notificationChannel: "test",
			defaultLeadAgentId: "eng",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
			apiToken: "master",
			geminiAgentToken: "scoped",
			linearApiKey: "fake-key",
			...overrides,
		}).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
	}
	async function stop() {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	}
	const patch = (body: Record<string, unknown> = {}, token = "master") =>
		fetch(`${baseUrl}/api/linear/update-issue`, {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				issueId: "FLY-1",
				projectName: "flywheel",
				parentId: "FLY-2",
				...body,
			}),
		});
	const lookup = () =>
		fetch(`${baseUrl}/api/linear/issue?query=FLY-1&projectName=flywheel`, {
			headers: { Authorization: "Bearer master" },
		});
	beforeEach(async () => {
		vi.clearAllMocks();
		nodes = [issue("FLY-1"), issue("FLY-2"), issue("FLY-3")];
		source().parent = { id: nodes[2]!.id, identifier: "FLY-3" };
		rawRequest.mockImplementation(
			async (_query: string, vars: { id: string }) => ({
				data: {
					issue: structuredClone(
						nodes.find((n) => n.id === vars.id || n.identifier === vars.id) ??
							null,
					),
				},
			}),
		);
		updateIssue.mockImplementation(
			async (
				id: string,
				update: { parentId?: string | null; title?: string },
			) => {
				const n = nodes.find((n) => n.id === id || n.identifier === id)!;
				if (Object.hasOwn(update, "parentId")) {
					const parent = nodes.find((n) => n.id === update.parentId);
					n.parent = parent
						? { id: parent.id, identifier: parent.identifier }
						: null;
				}
				if (update.title !== undefined) n.title = update.title;
				return { success: true };
			},
		);
		await start();
	});
	afterEach(stop);
	it("forwards canonical parent UUID and reads back actual parent without replacing the issue", async () => {
		const before = structuredClone(source());
		const res = await patch();
		expect(res.status).toBe(200);
		expect(updateIssue).toHaveBeenCalledWith(before.id, {
			parentId: target().id,
		});
		expect(await res.json()).toMatchObject({
			ok: true,
			issue: {
				id: before.id,
				identifier: before.identifier,
				parent: { id: target().id, identifier: "FLY-2" },
			},
		});
		const read = await lookup();
		expect(await read.json()).toMatchObject({
			issue: {
				id: before.id,
				description: before.description,
				parent: { id: target().id, identifier: "FLY-2" },
			},
		});
		expect(source()).toEqual({
			...before,
			parent: { id: target().id, identifier: "FLY-2" },
		});
		expect(createIssue).not.toHaveBeenCalled();
	});
	it("returns real parent from exact GraphQL lookup", async () => {
		expect(await (await lookup()).json()).toMatchObject({
			issue: { parent: { id: "uuid-FLY-3", identifier: "FLY-3" } },
		});
		expect(rawRequest.mock.calls[0]![0]).toMatch(
			/parent\s*\{\s*id\s+identifier\s*\}/,
		);
	});
	it("detaches only on explicit null and reads back null", async () => {
		const res = await patch({ parentId: null });
		expect(res.status).toBe(200);
		expect(updateIssue).toHaveBeenCalledWith(source().id, { parentId: null });
		expect(await res.json()).toMatchObject({ issue: { parent: null } });
		expect(await (await lookup()).json()).toMatchObject({
			issue: { parent: null },
		});
	});
	it("preserves parent when omitted on legacy updates", async () => {
		const parent = source().parent;
		const res = await patch({ parentId: undefined, title: "changed" });
		expect(res.status).toBe(200);
		expect(updateIssue).toHaveBeenCalledWith("FLY-1", { title: "changed" });
		expect(source().parent).toEqual(parent);
	});
	it("same request remains safe after service reconstruction", async () => {
		expect((await patch()).status).toBe(200);
		await stop();
		await start();
		expect((await patch()).status).toBe(200);
		expect(source().parent?.id).toBe(target().id);
		expect(nodes).toHaveLength(3);
		expect(createIssue).not.toHaveBeenCalled();
	});
	it.each([
		["wrong", 401],
		["scoped", 403],
	] as const)(
		"rejects %s credentials before Linear access",
		async (token, status) => {
			expect((await patch({}, token)).status).toBe(status);
			expect(rawRequest).not.toHaveBeenCalled();
			expect(updateIssue).not.toHaveBeenCalled();
		},
	);
	it("requires configured master credentials", async () => {
		await stop();
		await start({ apiToken: undefined });
		expect((await patch()).status).toBe(503);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it.each(["", "  ", 42, false, {}, []])(
		"rejects invalid parent %j",
		async (parentId) => {
			expect((await patch({ parentId })).status).toBe(400);
			expect(updateIssue).not.toHaveBeenCalled();
		},
	);
	it.each([
		[undefined, 400],
		["", 400],
		["unknown", 404],
	] as const)("rejects invalid binding %s", async (projectName, status) => {
		expect((await patch({ projectName })).status).toBe(status);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it.each(["source", "target"])("rejects absent %s", async (which) => {
		nodes.splice(which === "source" ? 0 : 1, 1);
		expect((await patch()).status).toBe(404);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it.each(["source", "target"])("rejects out-of-project %s", async (which) => {
		(which === "source" ? source() : target()).project.name = "Foreign";
		expect((await patch()).status).toBe(403);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it("rejects foreign team", async () => {
		target().identifier = "GEO-2";
		expect((await patch({ parentId: target().id })).status).toBe(403);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it("rejects missing scope label", async () => {
		target().labels.nodes = [];
		expect((await patch()).status).toBe(403);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it.each(["self", "descendant", "existing-cycle"])(
		"rejects %s cycle",
		async (kind) => {
			if (kind === "descendant")
				target().parent = { id: source().id, identifier: source().identifier };
			if (kind === "existing-cycle")
				target().parent = { id: target().id, identifier: target().identifier };
			expect(
				(await patch({ parentId: kind === "self" ? source().id : target().id }))
					.status,
			).toBe(400);
			expect(updateIssue).not.toHaveBeenCalled();
		},
	);
	it("rejects a broken ancestor chain without writing", async () => {
		target().parent = { id: "missing", identifier: "FLY-999" };
		expect((await patch()).status).toBe(404);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it("rejects an out-of-scope ancestor without writing", async () => {
		target().parent = { id: nodes[2]!.id, identifier: "FLY-3" };
		nodes[2]!.project.name = "Foreign";
		expect((await patch()).status).toBe(403);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it("rejects bounded traversal overflow", async () => {
		for (let i = 4; i <= 105; i++) nodes.push(issue(`FLY-${i}`));
		for (let i = 1; i < nodes.length - 1; i++) {
			nodes[i]!.parent = {
				id: nodes[i + 1]!.id,
				identifier: nodes[i + 1]!.identifier,
			};
		}
		expect((await patch()).status).toBe(400);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it("fails closed on upstream lookup failure", async () => {
		rawRequest.mockRejectedValue(new Error("upstream unavailable"));
		expect((await patch()).status).toBe(502);
		expect(updateIssue).not.toHaveBeenCalled();
	});
	it("does not claim success after an ambiguous mutation timeout", async () => {
		updateIssue.mockRejectedValue(new Error("timeout"));
		const res = await patch();
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ mutationMayHaveSucceeded: true });
	});
	it("does not report successful writes when Linear rejects mutation", async () => {
		updateIssue.mockResolvedValue({ success: false });
		const res = await patch();
		expect(res.status).toBe(502);
		expect(await res.json()).not.toMatchObject({ ok: true });
	});
	it("fails explicitly when mutation succeeded but actual parent mismatches", async () => {
		updateIssue.mockResolvedValue({ success: true });
		const res = await patch();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/read.back|parent/i),
			mutationMayHaveSucceeded: true,
		});
	});
	it("fails explicitly when post-write lookup fails", async () => {
		updateIssue.mockImplementation(async () => {
			rawRequest.mockRejectedValue(new Error("network unavailable"));
			return { success: true };
		});
		const res = await patch();
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ mutationMayHaveSucceeded: true });
	});
});
