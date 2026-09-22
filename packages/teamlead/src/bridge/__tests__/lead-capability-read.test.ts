import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { expect, it, vi } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { StateStore } from "../../StateStore.js";
import { commDbPathForProject } from "../commdb-path.js";
import {
	type LeadCapabilityReadOptions,
	mountLeadCapabilityReadProvider,
} from "../lead-capability-read.js";
import { LeadEventDeliveryCoordinator } from "../lead-event-delivery.js";
import { createLeadPatrolConfiguration } from "../lead-patrol-config.js";
import { createBridgeApp } from "../plugin.js";

const carrier = vi.hoisted(() => ({
	valid: true,
	processIndeterminate: false,
	calls: 0,
}));
vi.mock("flywheel-comm/lead-lease", async (original) => ({
	...(await original<object>()),
	validateLeadCarrierAuthorization: () => {
		carrier.calls++;
		return {
			...carrier,
			disposition: "carrier_passthrough",
			leadKey: "fixture",
			carrier: { generation: 1 },
		};
	},
}));
async function fixture(
	throughBridge = false,
	eventAckEnabled = false,
	patrolEnabled = false,
	github?: LeadCapabilityReadOptions["github"],
	memoryService?: LeadCapabilityReadOptions["memoryService"],
) {
	carrier.calls = 0;
	const terminalIo = {
		inspect: vi.fn(async () => ({ observedSessionId: "$2:%3", alive: true })),
		capture: vi.fn(async () => "Proceed? [Y/n]"),
		send: vi.fn(
			async (_target: string, _text: string, guard: () => Promise<void>) => {
				await guard();
			},
		),
	};
	const home = realpathSync(mkdtempSync(join(tmpdir(), "bridge-read-")));
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel/lead-carrier-evidence.json"),
		'{"leads":{"fixture":{"generation":1}}}',
	);
	writeFileSync(
		join(home, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-08-28T00:00:00.000Z",
		}),
	);
	const outboundStore = new SqliteOutboundDedupStore(join(home, "outbound.db"));
	const projectsPath = join(home, "projects.json"),
		projects = [
			{
				projectName: "flywheel",
				projectRoot: home,
				projectRepo: "acme/project",
				linear: { team: "FLY", project: "Flywheel" },
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
				],
			},
		];
	writeFileSync(projectsPath, JSON.stringify(projects));
	const identity = resolveLeadIdentityRow({
		projectsPath,
		homeDir: home,
		projectName: "flywheel",
		leadId: "eng",
	}).identity;
	const store = await StateStore.create(
		patrolEnabled ? join(home, "state.db") : ":memory:",
	);
	const control = join(home, "control");
	mkdirSync(control, { mode: 0o700 });
	const state = {
		shutdown: false,
		labels: ["Engineering"],
		onLabels: () => {},
		nextPage: false,
	};
	const client = {
		issue: vi.fn(async (id: string) => ({
			id,
			identifier: id === "issue-2" ? "FLY-2" : "FLY-1",
			team: Promise.resolve({ key: "FLY" }),
			project: Promise.resolve({ name: "Flywheel" }),
			labels: async () => {
				state.onLabels();
				return {
					nodes: state.labels.map((name) => ({ name })),
					pageInfo: { hasNextPage: state.nextPage },
				};
			},
		})),
	} as unknown as LinearClient;
	let app = express();
	if (throughBridge) {
		vi.stubEnv("HOME", home);
		vi.stubEnv("FLYWHEEL_COMM_ROOT", join(home, "comm"));
		vi.stubEnv("FLYWHEEL_PROJECTS_FILE", projectsPath);
		const bridgeArgs: Parameters<typeof createBridgeApp> = [
			store,
			[],
			{
				host: "127.0.0.1",
				port: 0,
				dbPath: ":memory:",
				apiToken: "test-token",
				chatThreadsEnabled: false,
				linearApiKey: "fixture-not-used",
				notificationChannel: "fixture",
				defaultLeadAgentId: "eng",
				stuckThresholdMinutes: 15,
				stuckCheckIntervalMs: 300000,
				orphanThresholdMinutes: 60,
			},
		];
		bridgeArgs[11] = memoryService as Parameters<typeof createBridgeApp>[11];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let unavailablePatrol: ReturnType<typeof createLeadPatrolConfiguration>;
		try {
			unavailablePatrol = createLeadPatrolConfiguration(
				join(home, "absent-patrol-state"),
			);
			expect(warn).toHaveBeenCalledWith("[Bridge] patrol disabled: ENOENT");
		} finally {
			warn.mockRestore();
		}
		bridgeArgs[16] = { leadGithub: github, leadPatrol: unavailablePatrol };
		app = createBridgeApp(...bridgeArgs);
	} else {
		app.use(express.json());
		mountLeadCapabilityReadProvider(app, {
			memoryService,
			github,
			eventCoordinator: () =>
				new LeadEventDeliveryCoordinator({
					store,
					enabled: eventAckEnabled,
					runtimeForLead: () => undefined,
					secretProvider: {
						getActive: () => ({ secretId: "test", key: Buffer.alloc(32, 7) }),
					},
				}),
			patrol: patrolEnabled
				? createLeadPatrolConfiguration(join(home, ".flywheel"))
				: undefined,
			apiToken: "test-token",
			store,
			projectsPath,
			homeDir: home,
			env: { FLYWHEEL_COMM_ROOT: join(home, "comm") },
			terminalIo,
			terminalReceipts: outboundStore.operationReceipts,
			linearClient: client,
			shutdownStateHolder: {
				get shuttingDown() {
					return state.shutdown;
				},
			},
		});
	}
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address() as { port: number };
	const body = {
		schemaVersion: 1,
		operationId: "bridge.read",
		requestId: randomUUID(),
		projectName: "flywheel",
		leadId: "eng",
		identityDigest: identity.identityDigest,
		carrierClaim: "fixture-claim",
		activationId: "activation",
		input: { request: { resource: "health" } },
	};
	const request = async (
		input: unknown,
		token = "test-token",
		override: Record<string, unknown> = {},
		signal?: AbortSignal,
		receiptLookup = false,
	) => {
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/lead-capabilities/${override.operationId === "memory.add" ? (receiptLookup ? "memory-add-receipt" : "memory-add") : String(override.operationId ?? "").startsWith("github.") ? (receiptLookup ? "github-receipt" : "github") : override.operationId === "patrol.snapshot" ? (receiptLookup ? "patrol-snapshot-receipt" : "patrol-snapshot") : override.operationId === "patrol.judgment.record" ? (receiptLookup ? "patrol-judgment-receipt" : "patrol-judgment") : override.operationId === "inbox.event.ack" ? (receiptLookup ? "inbox-event-ack-receipt" : "inbox-event-ack") : override.operationId === "inbox.batch.ack" ? (receiptLookup ? "inbox-batch-ack-receipt" : "inbox-batch-ack") : override.operationId === "terminal.input" ? (receiptLookup ? "terminal-input-receipt" : "terminal-input") : "read"}`,
			{
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ ...body, input, ...override }),
			},
		);
		return { status: response.status, body: await response.json() };
	};
	return {
		home,
		terminalIo,
		outboundStore,
		projectsPath,
		projects,
		store,
		state,
		client,
		request,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
			outboundStore.close();
			rmSync(home, { recursive: true, force: true });
			if (throughBridge) vi.unstubAllEnvs();
			carrier.valid = true;
			carrier.processIndeterminate = false;
			carrier.calls = 0;
		},
	};
}
it("serves bounded health and admission DTOs from actual Bridge state, rejects unsafe envelopes", async () => {
	const f = await fixture();
	try {
		expect(
			(await f.request({ request: { resource: "health" } })).body.data,
		).toMatchObject({
			result: { resource: "health", status: "ready" },
			observedAt: expect.any(String),
		});
		expect(carrier.calls).toBe(1);
		f.state.shutdown = true;
		expect(
			(await f.request({ request: { resource: "health" } })).body.data.result
				.status,
		).toBe("draining");
		expect(
			(await f.request({ request: { resource: "admission.status" } })).body.data
				.result,
		).toEqual({
			resource: "admission.status",
			active: false,
			remainingSeconds: 0,
		});
		expect(
			(await f.request({ request: { resource: "health" } }, "wrong")).status,
		).toBe(401);
		expect(
			(await f.request({ request: { resource: "/api/fleet/apply" } })).status,
		).toBe(400);
		expect(
			(
				await f.request({
					request: { resource: "health", path: "/api/config" },
				})
			).status,
		).toBe(400);
		carrier.processIndeterminate = true;
		expect((await f.request({ request: { resource: "health" } })).status).toBe(
			403,
		);
	} finally {
		await f.close();
	}
});
it("projects only fresh department sessions and revalidates real registry after Linear awaits", async () => {
	const f = await fixture();
	try {
		for (const [executionId, issueId, identifier, project] of [
			["exec-1", "issue-1", "FLY-1", "flywheel"],
			["exec-2", "issue-2", "FLY-2", "flywheel"],
			["exec-foreign", "foreign", "FLY-9", "other"],
		])
			f.store.upsertSession({
				execution_id: executionId!,
				issue_id: issueId!,
				issue_identifier: identifier!,
				project_name: project!,
				status: "running",
				issue_title: "SECRET_FULL_TEXT",
				last_error: "SECRET_ERROR",
			});
		const page = await f.request({
			request: { resource: "sessions.list", limit: 1 },
		});
		expect(page.status).toBe(200);
		expect(page.body.data.result.sessions).toEqual([
			{
				executionId: "exec-1",
				issueIdentifier: "FLY-1",
				status: "running",
				lastActivityAt: null,
			},
		]);
		expect(page.body.data.result.nextCursor).toBe("1");
		expect(JSON.stringify(page.body)).not.toContain("SECRET_");
		expect(
			(
				await f.request({
					request: { resource: "session.status", executionId: "exec-foreign" },
				})
			).status,
		).toBe(403);
		f.state.labels = ["Product"];
		expect(
			(await f.request({ request: { resource: "sessions.list" } })).body.data
				.result.sessions,
		).toEqual([]);
		expect(
			(
				await f.request({
					request: { resource: "session.status", executionId: "exec-1" },
				})
			).status,
		).toBe(403);
		f.state.labels = ["Engineering"];
		f.state.nextPage = true;
		expect(
			(
				await f.request({
					request: { resource: "session.status", executionId: "exec-1" },
				})
			).status,
		).not.toBe(200);
		f.state.nextPage = false;
		f.state.onLabels = () => {
			f.projects[0]!.leads[0]!.match.labels = ["Product"];
			writeFileSync(f.projectsPath, JSON.stringify(f.projects));
		};
		expect(
			(
				await f.request({
					request: { resource: "session.status", executionId: "exec-1" },
				})
			).status,
		).toBe(403);
	} finally {
		await f.close();
	}
});
it("releases read capacity on client cancellation even when the Linear read never settles", async () => {
	const f = await fixture();
	try {
		f.store.upsertSession({
			execution_id: "exec",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		const issue = vi.mocked(f.client.issue);
		issue.mockImplementation(() => new Promise<never>(() => {}));
		for (let index = 0; index < 16; index++) {
			const controller = new AbortController();
			const pending = f
				.request(
					{ request: { resource: "session.status", executionId: "exec" } },
					"test-token",
					{},
					controller.signal,
				)
				.catch(() => null);
			await vi.waitFor(() => expect(issue).toHaveBeenCalledTimes(index + 1));
			controller.abort();
			await pending;
		}
		await vi.waitFor(async () =>
			expect(
				(await f.request({ request: { resource: "health" } })).status,
			).toBe(200),
		);
	} finally {
		await f.close();
	}
});
it("projects an actual admission pause without exposing lease/operator/reason and never invokes write APIs", async () => {
	const f = await fixture();
	try {
		f.store.setAdmissionPause({
			durationSeconds: 300,
			setBy: "PRIVATE_OPERATOR",
			reason: "PRIVATE_REASON",
		});
		const write = vi.spyOn(f.store, "setAdmissionPause"),
			clear = vi.spyOn(f.store, "clearAdmissionPause");
		const observed = await f.request({
			request: { resource: "admission.status" },
		});
		expect(observed.status).toBe(200);
		expect(observed.body.data.result).toEqual({
			resource: "admission.status",
			active: true,
			remainingSeconds: expect.any(Number),
		});
		expect(JSON.stringify(observed.body)).not.toContain("PRIVATE_");
		for (const resource of [
			"stage",
			"apply",
			"actions",
			"run.diagnostic",
			"run.holds",
			"config",
			"fleet",
		]) {
			expect((await f.request({ request: { resource } })).status).toBe(400);
		}
		expect(write).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});

it("mounts typed reads in the actual Bridge even when Discord chat threads are disabled", async () => {
	const f = await fixture(true);
	try {
		const db = new CommDB(join(f.home, "comm/flywheel/comm.db"), true);
		db.close();
		const terminals = await f.request({ limit: 1 }, "test-token", {
			operationId: "terminal.list",
		});
		expect(terminals.status).toBe(200);
		expect(terminals.body.data.executions).toEqual([]);
		const result = await f.request({ request: { resource: "health" } });
		expect(result.status).toBe(200);
		expect(result.body.data.result).toEqual({
			resource: "health",
			status: "unknown",
		});
		expect(
			(await f.request({ request: { resource: "admission.status" } })).body.data
				.result.active,
		).toBe(false);
	} finally {
		await f.close();
	}
}, 15000);
it("projects a scoped resident hold without internal receipt data and denies foreign departments", async () => {
	const f = await fixture();
	try {
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		const readHold = vi.spyOn(f.store, "getResidentHold").mockReturnValue({
			execution_id: "exec-1",
			run_id: "PRIVATE_RUN",
			node_id: "implement",
			attempt: 1,
			activation_id: "PRIVATE_ACTIVATION",
			vendor: "codex",
			revision: 2,
			boundary_seq: 3,
			state: "resident",
			grace_started_at: "2026-09-13T00:00:00Z",
			grace_expires_at: "2026-09-13T03:00:00Z",
			closed_reason: "PRIVATE_REASON",
			release_cause: null,
			release_source: "PRIVATE_SOURCE",
			updated_at: "2026-09-13T00:00:00Z",
		});
		const input = {
			request: { resource: "session.resident-hold", executionId: "exec-1" },
		};
		const response = await f.request(input);
		expect(response.status).toBe(200);
		expect(response.body.data.result).toEqual({
			resource: "session.resident-hold",
			executionId: "exec-1",
			hold: {
				nodeId: "implement",
				state: "resident",
				revision: 2,
				graceStartedAt: "2026-09-13T00:00:00Z",
				graceExpiresAt: "2026-09-13T03:00:00Z",
				releaseCause: null,
			},
		});
		expect(JSON.stringify(response.body)).not.toContain("PRIVATE_");
		readHold.mockReturnValue(undefined);
		expect((await f.request(input)).body.data.result.hold).toBeNull();
		readHold.mockClear();
		f.state.onLabels = () => {
			f.store.upsertSession({
				execution_id: "exec-1",
				issue_id: "issue-1",
				issue_identifier: "FLY-1",
				project_name: "other",
				status: "running",
			});
		};
		expect((await f.request(input)).status).toBe(403);
		expect(readHold).not.toHaveBeenCalled();
		f.state.onLabels = () => {};
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		readHold.mockClear();
		f.state.labels = ["Product"];
		expect((await f.request(input)).status).toBe(403);
		expect(readHold).not.toHaveBeenCalled();
		readHold.mockRestore();
	} finally {
		await f.close();
	}
});

it("reads exact repository/head review records from Bridge storage with current department scope", async () => {
	const f = await fixture();
	try {
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		const head = "a".repeat(40),
			targetRepo = "org/nested";
		f.store.upsertCodexReviewPending({
			executionId: "exec-1",
			targetRepoIdentity: targetRepo,
			targetPrHeadSha: head,
			issueId: "issue-1",
			projectName: "flywheel",
		});
		const input = {
			request: {
				resource: "session.code-review",
				executionId: "exec-1",
				targetRepo,
				headSha: head,
			},
		};
		const response = await f.request(input);
		expect(response.status).toBe(200);
		expect(response.body.data.result).toEqual({
			resource: "session.code-review",
			executionId: "exec-1",
			targetRepo,
			headSha: head,
			record: {
				status: "pending",
				authorFamily: null,
				reviewerFamily: null,
				rounds: null,
				approvedAt: null,
			},
		});
		expect(
			(
				await f.request({
					request: { ...input.request, headSha: "b".repeat(40) },
				})
			).body.data.result.record,
		).toBeNull();
		expect(
			(
				await f.request({
					request: { ...input.request, targetRepo: "__main__" },
				})
			).body.data.result.record,
		).toBeNull();
		const read = vi.spyOn(f.store, "getCodexReviewRecord");
		f.state.labels = ["Product"];
		expect((await f.request(input)).status).toBe(403);
		expect(read).not.toHaveBeenCalled();
		f.state.labels = ["Engineering"];
		f.state.onLabels = () =>
			f.store.upsertSession({
				execution_id: "exec-1",
				issue_id: "issue-2",
				issue_identifier: "FLY-2",
				project_name: "flywheel",
				status: "running",
			});
		expect((await f.request(input)).status).toBe(403);
		expect(read).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});

it("routes terminal reads through scoped current bindings and bounded discovery", async () => {
	const f = await fixture(),
		db = new CommDB(join(f.home, "comm/flywheel/comm.db"), true);
	try {
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		db.registerSession("exec-1", "runner:0", "flywheel", "FLY-1", "eng");
		const status = await f.request({ executionId: "exec-1" }, "test-token", {
			operationId: "terminal.status",
		});
		expect(status.status).toBe(200);
		expect(status.body.data).toMatchObject({
			execution: { executionId: "exec-1", status: "waiting" },
			observedSessionId: "$2:%3",
		});
		const capture = await f.request(
			{ executionId: "exec-1", lines: 20 },
			"test-token",
			{ operationId: "terminal.capture" },
		);
		expect(capture.body.data.text).toBe("Proceed? [Y/n]");
		const search = await f.request(
			{ executionId: "exec-1", lines: 20, pattern: "Proceed" },
			"test-token",
			{ operationId: "terminal.search" },
		);
		expect(search.body.data.text).toBe("1: Proceed? [Y/n]");
		const page = await f.request({ limit: 1 }, "test-token", {
			operationId: "terminal.list",
		});
		expect(page.body.data.executions).toEqual([
			{ executionId: "exec-1", status: "running" },
		]);
		f.state.labels = ["Other"];
		expect(
			(
				await f.request({ executionId: "exec-1" }, "test-token", {
					operationId: "terminal.status",
				})
			).status,
		).toBe(403);
		expect(f.terminalIo.send).not.toHaveBeenCalled();
	} finally {
		db.close();
		await f.close();
	}
});
it("pages terminal discovery past other leads without exposing their executions", async () => {
	const f = await fixture(),
		db = new CommDB(join(f.home, "comm/flywheel/comm.db"), true);
	try {
		for (const [executionId, lead] of [
			["a", "eng"],
			["b", "other"],
			["c", "eng"],
		]) {
			f.store.upsertSession({
				execution_id: executionId!,
				issue_id: "issue-1",
				issue_identifier: "FLY-1",
				project_name: "flywheel",
				status: "running",
			});
			db.registerSession(executionId!, "runner:0", "flywheel", "FLY-1", lead!);
		}
		const first = await f.request({ limit: 1 }, "test-token", {
			operationId: "terminal.list",
		});
		expect(
			first.body.data.executions.map(
				(e: { executionId: string }) => e.executionId,
			),
		).toEqual(["a"]);
		const second = await f.request(
			{ limit: 1, cursor: first.body.data.nextCursor },
			"test-token",
			{ operationId: "terminal.list" },
		);
		expect(
			second.body.data.executions.map(
				(e: { executionId: string }) => e.executionId,
			),
		).toEqual(["c"]);
		expect(f.terminalIo.inspect).not.toHaveBeenCalled();
	} finally {
		db.close();
		await f.close();
	}
});

it("deduplicates terminal input and rejects changed payloads without sending twice", async () => {
	const f = await fixture(),
		db = new CommDB(join(f.home, "comm/flywheel/comm.db"), true);
	try {
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		db.registerSession("exec-1", "runner:0", "flywheel", "FLY-1", "eng");
		const input = {
				executionId: "exec-1",
				expectedSessionId: "$2:%3",
				text: "yes",
			},
			override = { operationId: "terminal.input", requestId: randomUUID() };
		expect((await f.request(input, "test-token", override)).body.status).toBe(
			"succeeded",
		);
		expect((await f.request(input, "test-token", override)).body.status).toBe(
			"succeeded",
		);
		expect(
			(await f.request({ ...input, text: "no" }, "test-token", override)).body,
		).toMatchObject({ status: "rejected", errorCode: "input_digest_conflict" });
		expect(f.terminalIo.send).toHaveBeenCalledTimes(1);
	} finally {
		db.close();
		await f.close();
	}
});
it("preserves terminal rejection codes and never retries uncertain input", async () => {
	const f = await fixture(),
		db = new CommDB(join(f.home, "comm/flywheel/comm.db"), true);
	try {
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		db.registerSession("exec-1", "runner:0", "flywheel", "FLY-1", "eng");
		const input = {
			executionId: "exec-1",
			expectedSessionId: "$2:%8",
			text: "yes",
		};
		expect(
			(
				await f.request(input, "test-token", {
					operationId: "terminal.input",
					requestId: randomUUID(),
				})
			).body,
		).toMatchObject({
			status: "rejected",
			errorCode: "terminal_session_changed",
		});
		expect(f.terminalIo.send).not.toHaveBeenCalled();
		f.terminalIo.send.mockImplementation(async (_target, _text, guard) => {
			f.state.labels = ["Other"];
			await guard();
		});
		expect(
			(
				await f.request(
					{ ...input, expectedSessionId: "$2:%3" },
					"test-token",
					{ operationId: "terminal.input", requestId: randomUUID() },
				)
			).body.status,
		).toBe("rejected");
		f.state.labels = ["Engineering"];
		f.terminalIo.send.mockClear();
		f.terminalIo.send.mockImplementation(async (_target, _text, guard) => {
			await guard();
			throw new Error("transport_lost");
		});
		const override = { operationId: "terminal.input", requestId: randomUUID() };
		for (let i = 0; i < 2; i++)
			expect(
				(
					await f.request(
						{ ...input, expectedSessionId: "$2:%3" },
						"test-token",
						override,
					)
				).body.status,
			).toBe("unknown");
		expect(f.terminalIo.send).toHaveBeenCalledTimes(1);
		f.state.labels = ["Other"];
		expect(
			(
				await f.request(
					{ ...input, expectedSessionId: "$2:%3" },
					"test-token",
					{ ...override, requestId: randomUUID() },
				)
			).body.errorCode,
		).toBe("terminal_scope_denied");
	} finally {
		db.close();
		await f.close();
	}
});

it("looks up terminal input receipts without preparing or dispatching any write", async () => {
	const f = await fixture(),
		db = new CommDB(join(f.home, "comm/flywheel/comm.db"), true);
	try {
		f.store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "FLY-1",
			project_name: "flywheel",
			status: "running",
		});
		db.registerSession("exec-1", "runner:0", "flywheel", "FLY-1", "eng");
		const input = {
				executionId: "exec-1",
				expectedSessionId: "$2:%3",
				text: "yes",
			},
			override = { operationId: "terminal.input", requestId: randomUUID() };
		const prepare = vi.spyOn(f.outboundStore.operationReceipts, "prepare");
		expect(
			(await f.request(input, "test-token", override, undefined, true)).body
				.status,
		).toBe("unknown");
		expect(prepare).not.toHaveBeenCalled();
		expect(f.terminalIo.send).not.toHaveBeenCalled();
		expect((await f.request(input, "test-token", override)).body.status).toBe(
			"succeeded",
		);
		prepare.mockClear();
		expect(
			(await f.request(input, "test-token", override, undefined, true)).body
				.status,
		).toBe("succeeded");
		expect(
			(
				await f.request(
					{ ...input, text: "no" },
					"test-token",
					override,
					undefined,
					true,
				)
			).body.errorCode,
		).toBe("input_digest_conflict");
		expect(prepare).not.toHaveBeenCalled();
		expect(f.terminalIo.send).toHaveBeenCalledTimes(1);
		f.state.shutdown = true;
		expect(
			(
				await f.request(input, "test-token", {
					...override,
					requestId: randomUUID(),
				})
			).status,
		).toBe(403);
		expect(f.terminalIo.send).toHaveBeenCalledTimes(1);
	} finally {
		db.close();
		await f.close();
	}
});

it("routes inbox ACKs to the project queue with UUID receipts, ownership and drain guards", async () => {
	const f = await fixture();
	const path = commDbPathForProject("flywheel", {
		FLYWHEEL_COMM_ROOT: join(f.home, "comm"),
	});
	const queue = new MailboxQueue(path);
	const now = new Date().toISOString();
	try {
		queue.acquireOrRenewOwner({
			ownerEpoch: "owner",
			now,
			leaseTtlMs: 3600000,
		});
		for (const lead of ["eng", "design"]) {
			queue.enqueue({
				id: lead,
				fromAgent: "founder",
				toAgent: lead,
				recipientKind: "lead",
				type: "discord_chat",
				content: "hello",
				createdAt: now,
				senderRef: encodeSenderRef(),
			});
			queue.claimLeadBatchQueue({
				toAgent: lead,
				msgClass: "model",
				ownerEpoch: "owner",
				batchId: `${lead}-batch`,
				now,
				transportClaimTtlMs: 60000,
				batchWindowMs: 30000,
				batchMaxSize: 10,
				inflightMaxBatches: 1,
			});
		}
		const override = {
			operationId: "inbox.batch.ack",
			requestId: randomUUID(),
		};
		const send = (batchId: string, lookup = false, changes = {}) =>
			f.request(
				{ batchId },
				"test-token",
				{ ...override, ...changes },
				undefined,
				lookup,
			);
		expect((await send("eng-batch", true)).body.status).toBe("unknown");
		expect(queue.getById("eng")?.state).toBe("LEASED");
		const first = await send("eng-batch");
		expect(first.status).toBe(200);
		expect(first.body.data.batchId).toBe("eng-batch");
		expect(queue.getById("eng")?.state).toBe("ACKED");
		expect((await send("eng-batch", true)).body.data).toMatchObject({
			batchId: "eng-batch",
			receiptId: override.requestId,
		});
		expect((await send("eng-batch")).body.status).toBe("succeeded");
		expect((await send("design-batch")).body.status).toBe("rejected");
		expect(
			(await send("design-batch", false, { requestId: randomUUID() })).body
				.status,
		).not.toBe("succeeded");
		expect(queue.getById("design")?.state).toBe("LEASED");
		f.state.shutdown = true;
		expect(
			(await send("eng-batch", false, { requestId: randomUUID() })).status,
		).toBe(403);
		f.state.shutdown = false;
		carrier.valid = false;
		expect((await send("eng-batch", true)).status).toBe(403);
	} finally {
		queue.close();
		await f.close();
	}
});

it.each([false, true])(
	"preserves event ACK enabled=%s over the real mounted HTTP route",
	async (enabled) => {
		const f = await fixture(false, enabled);
		try {
			const seq = f.store.appendLeadEvent(
				"eng",
				"owned-event",
				"session_failed",
				JSON.stringify({
					project_name: "flywheel",
					event_type: "session_failed",
				}),
			);
			(
				f.store as unknown as {
					db: { run(sql: string, params: unknown[]): void };
				}
			).db.run(
				"UPDATE lead_events SET ack_required = 1, ack_policy = 'explicit_receipt', ack_protocol_version = 1 WHERE seq = ?",
				[seq],
			);
			const override = {
				operationId: "inbox.event.ack",
				requestId: randomUUID(),
			};
			const input = { eventHandle: `event_${seq}` };
			expect(
				(
					await f.request({ eventHandle: "event_999999" }, "test-token", {
						...override,
						requestId: randomUUID(),
					})
				).status,
			).toBe(403);
			const result = await f.request(input, "test-token", override);
			expect(result.body.status).toBe(enabled ? "succeeded" : "rejected");
			if (!enabled)
				expect(result.body.errorCode).toBe("inbox_event_ack_disabled");
			expect(Boolean(f.store.getLeadEventBySeq(seq)?.acked_at)).toBe(enabled);
			const receipt = await f.request(
				input,
				"test-token",
				override,
				undefined,
				true,
			);
			expect(receipt.body.status).toBe(result.body.status);
		} finally {
			await f.close();
		}
	},
);

it("mounts actual patrol snapshot and judgment services with scoped HTTP replay and drain guards", async () => {
	const f = await fixture(false, false, true);
	const timerSpy = vi.spyOn(globalThis, "setTimeout");
	const snapshot = {
		operationId: "patrol.snapshot",
		requestId: randomUUID(),
		githubFacts: {
			projectName: "flywheel",
			leadId: "eng",
			pulls: [],
			runs: { workflow_runs: [] },
		},
	};
	try {
		expect((await f.request({ tickId: "1" }, "wrong", snapshot)).status).toBe(
			401,
		);
		const first = await f.request({ tickId: "1" }, "test-token", snapshot);
		expect(first.status).toBe(200);
		expect(
			timerSpy.mock.calls.some(([, timeoutMs]) => timeoutMs === 275_000),
		).toBe(true);
		expect(first.body.data.text).toContain("project: flywheel\nlead: eng");
		expect(
			await f.request({ tickId: "1" }, "test-token", snapshot, undefined, true),
		).toEqual(first);
		const judgment = {
			operationId: "patrol.judgment.record",
			requestId: randomUUID(),
		};
		const input = {
			tickId: "1",
			executionId: "exec",
			step: 1,
			judgment: "healthy",
			mechanismReview: { result: "none", count: 0 },
			evidenceHandle: first.body.data.evidenceHandle,
		};
		const written = await f.request(input, "test-token", judgment);
		expect(written.status).toBe(200);
		expect(written.body.data.gates).toHaveLength(3);
		expect(readFileSync(first.body.data.path, "utf8")).toContain(
			"MECHANISM_REVIEW result=none count=0",
		);
		expect(
			await f.request(input, "test-token", judgment, undefined, true),
		).toEqual(written);
		expect(
			(await f.request({ ...input, step: 2 }, "test-token", judgment)).body
				.errorCode,
		).toBe("input_digest_conflict");
		expect(
			(await f.request(input, "test-token", { ...judgment, leadId: "foreign" }))
				.status,
		).toBe(503);
		expect(
			(await f.request(input, "test-token", { ...judgment, githubFacts: {} }))
				.status,
		).toBe(400);
		f.state.shutdown = true;
		expect(
			(
				await f.request({ tickId: "2" }, "test-token", {
					...snapshot,
					requestId: randomUUID(),
				})
			).status,
		).toBe(403);
	} finally {
		timerSpy.mockRestore();
		await f.close();
	}
}, 20000);

it.each([false, true])(
	"executes bound GitHub writes and receipt-only replay through mounted Bridge=%s",
	async (throughBridge) => {
		const pr = {
			number: 7,
			html_url: "https://github.com/acme/project/pull/7",
			title: "Title",
			draft: false,
			head: { sha: "a".repeat(40), ref: "feature-owned" },
			base: { ref: "main", repo: { full_name: "acme/project" } },
		};
		const get = vi.fn(async () => ({ data: pr })),
			createComment = vi.fn(async () => ({
				data: {
					id: 42,
					html_url: "https://github.com/acme/project/pull/7#issuecomment-42",
				},
			}));
		const loadGithub = vi.fn(() => ({
			client: { rest: { pulls: { get }, issues: { createComment } } } as any,
			secrets: ["GH_CANARY"],
		}));
		const f = await fixture(throughBridge, false, false, loadGithub);
		const override = {
				operationId: "github.pr.comment",
				requestId: randomUUID(),
			},
			input = { number: 7, body: "Bound comment" };
		const commPath = commDbPathForProject("flywheel", {
			FLYWHEEL_COMM_ROOT: join(f.home, "comm"),
		});
		expect(existsSync(commPath)).toBe(false);
		expect((await f.request(input, "test-token", override)).body.status).toBe(
			"unknown",
		);
		expect(existsSync(commPath)).toBe(false);
		const comm = new CommDB(commPath);
		try {
			expect(
				(await f.request(input, "test-token", override)).body.errorCode,
			).toBe("pr_not_bound_to_lead");
			expect(
				(await f.request(input, "test-token", override, undefined, true)).body
					.errorCode,
			).toBe("pr_not_bound_to_lead");
			expect(createComment).not.toHaveBeenCalled();
			f.store.upsertSession({
				execution_id: "github-exec",
				issue_id: "FLY-1",
				project_name: "flywheel",
				status: "running",
				pr_number: 7,
				branch: "feature-owned",
			});
			comm.registerSession(
				"github-exec",
				"runner:0",
				"flywheel",
				"FLY-1",
				"eng",
			);
			expect(
				(await f.request(input, "test-token", override, undefined, true)).body
					.status,
			).toBe("unknown");
			expect((await f.request(input, "test-token", override)).body.status).toBe(
				"succeeded",
			);
			expect((await f.request(input, "test-token", override)).body.status).toBe(
				"succeeded",
			);
			expect(createComment).toHaveBeenCalledOnce();
			const reads = get.mock.calls.length;
			const loads = loadGithub.mock.calls.length;
			expect(
				(await f.request(input, "test-token", override, undefined, true)).body
					.resourceRefs,
			).toEqual(["42"]);
			expect(get).toHaveBeenCalledTimes(reads);
			expect(loadGithub).toHaveBeenCalledTimes(loads);
			expect(
				(await f.request({ ...input, body: "changed" }, "test-token", override))
					.body.errorCode,
			).toBe("input_digest_conflict");
			expect(createComment).toHaveBeenCalledOnce();
			carrier.valid = false;
			const beforeRevoked = loadGithub.mock.calls.length;
			expect(
				(
					await f.request(input, "test-token", {
						...override,
						requestId: randomUUID(),
					})
				).body.status,
			).not.toBe("succeeded");
			expect(createComment).toHaveBeenCalledOnce();
			expect(loadGithub).toHaveBeenCalledTimes(beforeRevoked);
		} finally {
			comm.close();
			await f.close();
		}
	},
);

it.each([false, true])(
	"routes scoped memory writes/search through Bridge (full app %s)",
	async (fullApp) => {
		const memory = {
			addMessages: vi.fn(async () => ({ added: 1, updated: 0 })),
			searchLearningMemories: vi.fn(async () => [
				{
					text: "learning",
					opId: "op",
					runKey: "run",
					noteId: "note",
					collection: "c",
				},
			]),
		};
		const f = await fixture(fullApp, false, false, undefined, memory);
		const input = {
			project: "flywheel",
			text: "learning",
			collection: "c",
			noteId: "note",
			opId: "op",
			runKey: "run",
		};
		const write = { operationId: "memory.add", requestId: randomUUID() };
		try {
			expect(
				(await f.request({ ...input, project: "other" }, "test-token", write))
					.body.status,
			).toBe("rejected");
			expect(memory.addMessages).not.toHaveBeenCalled();
			expect((await f.request(input, "test-token", write)).body.status).toBe(
				"succeeded",
			);
			expect((await f.request(input, "test-token", write)).body.status).toBe(
				"succeeded",
			);
			expect(
				(await f.request(input, "test-token", write, undefined, true)).body
					.status,
			).toBe("succeeded");
			expect(memory.addMessages).toHaveBeenCalledTimes(1);
			expect(
				(await f.request({ ...input, text: "changed" }, "test-token", write))
					.body.errorCode,
			).toBe("input_digest_conflict");
			const searched = await f.request(
				{ project: "flywheel", query: "op", limit: 1 },
				"test-token",
				{ operationId: "memory.search" },
			);
			expect(searched.body.data.memories[0].opId).toBe("op");
			expect(memory.searchLearningMemories).toHaveBeenCalledWith({
				projectName: "flywheel",
				userId: "flywheel",
				query: "op",
				limit: 1,
			});
			expect(
				(
					await f.request({ project: "other", query: "op" }, "test-token", {
						operationId: "memory.search",
					})
				).body.status,
			).toBe("rejected");
		} finally {
			await f.close();
		}
	},
);
