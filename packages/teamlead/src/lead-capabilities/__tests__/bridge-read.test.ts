import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadArtifactStore } from "../artifacts.js";
import { LeadCapabilityBroker, type LeadOperationContext } from "../broker.js";
import {
	createBridgeReadHandlers,
	createGithubBridgeHandlers,
	createInboxBatchAckHandlers,
	createMemoryBridgeHandlers,
	createPatrolHandlers,
	createRunnerBridgeHandlers,
} from "../handlers/bridge-read.js";

const current = vi.hoisted(() => ({ valid: true }));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!current.valid) throw new Error("stale");
			return {
				project: { projectRepo: "owner/repo" },
				lead: { agentId: "eng" },
			};
		},
	}),
}));
const env = {
	FLYWHEEL_PROJECT_NAME: "flywheel",
	FLYWHEEL_LEAD_ID: "eng",
	FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
	FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_CANARY",
	FLYWHEEL_API_TOKEN: "TOKEN_CANARY",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:3199",
};
const context = (): LeadOperationContext => ({
	requestId: randomUUID(),
	projectName: "flywheel",
	leadId: "eng",
	activationId: "activation",
	signal: new AbortController().signal,
	assertCurrent: async () => {},
});
it("posts the exact fixed read route and correlates request/result without model URLs or secrets", async () => {
	const ctx = context(),
		calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
	const fetchImpl = vi.fn(async (url, init) => {
		calls.push({ url, init });
		return Response.json({
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [],
			data: {
				result: { resource: "health", status: "ready" },
				receiptId: ctx.requestId,
				observedAt: new Date().toISOString(),
			},
		});
	}) as typeof fetch;
	const handler = createBridgeReadHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("bridge.read")!;
	const raw = { request: { resource: "health" } };
	await handler.authorize(raw, ctx);
	expect((await handler.execute(raw, ctx)).status).toBe("succeeded");
	expect(calls[0]!.url).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/read",
	);
	expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
	expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
		operationId: "bridge.read",
		requestId: ctx.requestId,
		input: raw,
	});
	await expect(
		handler.authorize(
			{ request: { resource: "health", path: "/api/config" } },
			ctx,
		),
	).rejects.toThrow();
	expect(calls).toHaveLength(1);
});
it("rejects stale identities before dispatch and treats malformed, mismatched or secret output as unknown", async () => {
	const ctx = context();
	let result: unknown = {};
	const fetchImpl = vi.fn(async () => Response.json(result)) as typeof fetch;
	const handler = createBridgeReadHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("bridge.read")!;
	current.valid = false;
	try {
		await expect(
			handler.execute({ request: { resource: "health" } }, ctx),
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	} finally {
		current.valid = true;
	}
	for (const data of [
		{ requestId: randomUUID(), status: "succeeded", resourceRefs: [] },
		{
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [],
			data: {
				result: { resource: "health", status: "ready" },
				secret: "TOKEN_CANARY",
			},
		},
	]) {
		result = data;
		expect(
			(await handler.execute({ request: { resource: "health" } }, ctx)).status,
		).toBe("unknown");
	}
});
it("does not accept a valid DTO for a different resource or stale identity after an HTTP await", async () => {
	const ctx = context();
	let revoke = false;
	const fetchImpl = vi.fn(async () => {
		if (revoke) current.valid = false;
		return Response.json({
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [],
			data: {
				result: {
					resource: "admission.status",
					active: false,
					remainingSeconds: 0,
				},
				receiptId: ctx.requestId,
				observedAt: new Date().toISOString(),
			},
		});
	}) as typeof fetch;
	const handler = createBridgeReadHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("bridge.read")!;
	try {
		expect(
			(await handler.execute({ request: { resource: "health" } }, ctx)).status,
		).toBe("unknown");
		revoke = true;
		expect(
			(
				await handler.execute(
					{ request: { resource: "admission.status" } },
					ctx,
				)
			).status,
		).toBe("unknown");
	} finally {
		current.valid = true;
	}
});
it("correlates resident hold response to the requested execution", async () => {
	const ctx = context();
	let executionId = "exec-1";
	const handler = createBridgeReadHandlers({
		env,
		activationId: "activation",
		fetchImpl: (async () =>
			Response.json({
				requestId: ctx.requestId,
				status: "succeeded",
				resourceRefs: [],
				data: {
					result: {
						resource: "session.resident-hold",
						executionId,
						hold: null,
					},
					receiptId: ctx.requestId,
					observedAt: new Date().toISOString(),
				},
			})) as typeof fetch,
	}).get("bridge.read")!;
	const input = {
		request: { resource: "session.resident-hold", executionId: "exec-1" },
	};
	expect((await handler.execute(input, ctx)).status).toBe("succeeded");
	executionId = "foreign";
	expect((await handler.execute(input, ctx)).status).toBe("unknown");
});

it("correlates code review evidence to execution, repository and exact head", async () => {
	const ctx = context();
	const request = {
		resource: "session.code-review",
		executionId: "exec-1",
		targetRepo: "org/repo",
		headSha: "a".repeat(40),
	};
	let result = { ...request, record: null };
	const handler = createBridgeReadHandlers({
		env,
		activationId: "activation",
		fetchImpl: (async () =>
			Response.json({
				requestId: ctx.requestId,
				status: "succeeded",
				resourceRefs: [],
				data: {
					result,
					receiptId: ctx.requestId,
					observedAt: new Date().toISOString(),
				},
			})) as typeof fetch,
	}).get("bridge.read")!;
	expect((await handler.execute({ request }, ctx)).status).toBe("succeeded");
	for (const change of [
		{ executionId: "foreign" },
		{ targetRepo: "org/other" },
		{ headSha: "b".repeat(40) },
	]) {
		result = { ...request, ...change, record: null };
		expect((await handler.execute({ request }, ctx)).status).toBe("unknown");
	}
});

it("correlates typed terminal responses on the fixed Bridge read transport", async () => {
	const ctx = context();
	let receivedExecution = "exec-1";
	const fetchImpl = vi.fn(async () =>
		Response.json({
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [],
			data: {
				execution: { executionId: receivedExecution, status: "waiting" },
				observedSessionId: "$2:%3",
				receiptId: ctx.requestId,
				observedAt: new Date().toISOString(),
			},
		}),
	) as typeof fetch;
	const handler = createBridgeReadHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("terminal.status");
	expect(handler).toBeDefined();
	expect((await handler!.execute({ executionId: "exec-1" }, ctx)).status).toBe(
		"succeeded",
	);
	receivedExecution = "foreign";
	expect((await handler!.execute({ executionId: "exec-1" }, ctx)).status).toBe(
		"unknown",
	);
});
it("sends terminal input on a fixed write route and reconciles only via the receipt route", async () => {
	const { createTerminalInputHandlers } = await import(
		"../handlers/bridge-read.js"
	);
	const ctx = context(),
		urls: string[] = [];
	const fetchImpl = vi.fn(async (url) => {
		urls.push(String(url));
		return Response.json({
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [`terminal:${ctx.requestId}`],
			data: {
				executionId: "exec-1",
				receiptId: ctx.requestId,
				observedAt: new Date().toISOString(),
			},
		});
	}) as typeof fetch;
	const handler = createTerminalInputHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("terminal.input")!;
	const input = {
		executionId: "exec-1",
		expectedSessionId: "$2:%3",
		text: "yes",
	};
	expect((await handler.execute(input, ctx)).status).toBe("succeeded");
	expect((await handler.reconcile!({} as never, input, ctx)).status).toBe(
		"succeeded",
	);
	expect(urls).toEqual([
		"http://127.0.0.1:3199/api/lead-capabilities/terminal-input",
		"http://127.0.0.1:3199/api/lead-capabilities/terminal-input-receipt",
	]);
});

it("binds inbox batch evidence and reconciles through the receipt-only endpoint", async () => {
	const ctx = context();
	let batchId = "batch";
	const fetchImpl = vi.fn(async () =>
		Response.json({
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [`inbox-batch:${ctx.requestId}`],
			data: {
				batchId,
				receiptId: ctx.requestId,
				observedAt: new Date().toISOString(),
			},
		}),
	) as typeof fetch;
	const handler = createInboxBatchAckHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("inbox.batch.ack")!;
	const raw = { batchId: "batch" };
	expect((await handler.execute(raw, ctx)).status).toBe("succeeded");
	expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/inbox-batch-ack",
	);
	expect((await handler.reconcile!({} as never, raw, ctx)).status).toBe(
		"succeeded",
	);
	expect(vi.mocked(fetchImpl).mock.calls[1]?.[0]).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/inbox-batch-ack-receipt",
	);
	batchId = "foreign";
	expect((await handler.execute(raw, ctx)).status).toBe("unknown");
});

it("preserves the event coordinator disabled code and uses fixed receipt lookup", async () => {
	const { createInboxEventAckHandlers } = await import(
		"../handlers/bridge-read.js"
	);
	const ctx = context();
	const fetchImpl = vi.fn(async () =>
		Response.json(
			{
				requestId: ctx.requestId,
				status: "rejected",
				resourceRefs: [],
				errorCode: "inbox_event_ack_disabled",
			},
			{ status: 403 },
		),
	) as typeof fetch;
	const handler = createInboxEventAckHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	}).get("inbox.event.ack")!;
	const raw = { eventHandle: "event_1" };
	expect(await handler.execute(raw, ctx)).toEqual({
		status: "rejected",
		errorCode: "inbox_event_ack_disabled",
	});
	expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/inbox-event-ack",
	);
	expect(await handler.reconcile!({} as never, raw, ctx)).toEqual({
		status: "rejected",
		errorCode: "inbox_event_ack_disabled",
	});
	expect(vi.mocked(fetchImpl).mock.calls[1]?.[0]).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/inbox-event-ack-receipt",
	);
});

it("projects patrol reports into real artifacts and maps judgment evidence only inside the parent", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-parent-")));
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const artifacts = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const ctx = context();
	const text = "# Lead Patrol Snapshot\nproject: flywheel\nlead: eng\n";
	const sha = createHash("sha256").update(text).digest("hex"),
		filename = "20260914T010101Z-tick1.md";
	let ready = false;
	let reportSuffix = "";
	const requests: Array<{ url: string; body: any }> = [];
	const fetchImpl = vi.fn(async (url, init) => {
		const body = JSON.parse(init!.body as string);
		requests.push({ url: String(url), body });
		if (String(url).includes("patrol-snapshot")) {
			if (String(url).endsWith("-receipt") && !ready)
				return Response.json({
					requestId: body.requestId,
					status: "unknown",
					resourceRefs: [],
				});
			ready = true;
			const shown = text + reportSuffix;
			const shownSha = createHash("sha256").update(shown).digest("hex");
			return Response.json({
				requestId: body.requestId,
				status: "succeeded",
				resourceRefs: [`patrol:${filename}:${shownSha}`],
				data: {
					path: `/private/bridge/${filename}`,
					text: shown,
					sha256: shownSha,
					steps: Array.from({ length: 6 }, (_, i) => ({
						step: i + 1,
						status: "unknown",
					})),
					evidenceHandle: `patrol_${body.requestId}`,
					observedAt: "2026-09-14T01:01:01.000Z",
				},
			});
		}
		return Response.json({
			requestId: body.requestId,
			status: "succeeded",
			resourceRefs: [`pj:${filename}:${sha}:${"a".repeat(64)}:0.0.0`],
			data: {
				judgmentId: body.requestId,
				complete: true,
				gates: [1, 2, 3].map((gate) => ({ gate, passed: true, exitCode: 0 })),
				reportSha256: sha,
				receiptId: body.requestId,
				observedAt: "2026-09-14T01:01:01.000Z",
			},
		});
	}) as typeof fetch;
	const client = {
		request: vi.fn(async (route: string) => ({
			data: route.endsWith("/pulls") ? [] : { workflow_runs: [] },
		})),
	};
	const handlers = createPatrolHandlers({
		env,
		activationId: "activation",
		fetchImpl,
		artifacts,
		secrets: ["SECOND_SECRET"],
		githubClient: client as unknown as Octokit,
	});
	try {
		const handler = handlers.get("patrol.snapshot")!;
		const output = await handler.execute({ tickId: "1" }, ctx);
		expect(output.status).toBe("succeeded");
		const data = output.data as {
			artifactHandle: string;
			artifactPath: string;
		};
		expect((await artifacts.read(data.artifactHandle)).data.toString()).toBe(
			text,
		);
		expect(data.artifactPath.startsWith("artifacts/")).toBe(true);
		expect(JSON.stringify(output)).not.toContain("/private/bridge");
		expect(client.request).toHaveBeenCalledTimes(2);
		expect(await handler.execute({ tickId: "1" }, ctx)).toEqual(output);
		expect(client.request).toHaveBeenCalledTimes(2);
		const judgment = handlers.get("patrol.judgment.record")!;
		const input = {
			tickId: "1",
			executionId: "exec",
			step: 1,
			judgment: "healthy",
			evidenceHandle: data.artifactHandle,
		};
		expect((await judgment.execute(input, context())).status).toBe("succeeded");
		expect(requests.at(-1)!.body.input.evidenceHandle).toBe(
			`patrol_${ctx.requestId}`,
		);
		await expect(
			judgment.authorize({ ...input, evidenceHandle: "foreign" }, context()),
		).rejects.toThrow();
		reportSuffix = "SECOND_SECRET";
		expect((await handler.execute({ tickId: "1" }, context())).status).toBe(
			"unknown",
		);
	} finally {
		artifacts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("uses fixed GitHub write/receipt routes and retains durable refusal and replay evidence", async () => {
	const ctx = context(),
		calls: string[] = [];
	let replay = false,
		denied = false,
		foreign = false;
	const fetchImpl = vi.fn(async (url) => {
		calls.push(String(url));
		return Response.json(
			denied
				? {
						requestId: ctx.requestId,
						status: "rejected",
						resourceRefs: [],
						errorCode: "pr_not_bound_to_lead",
					}
				: {
						requestId: ctx.requestId,
						status: "succeeded",
						resourceRefs: ["42"],
						...(replay
							? {}
							: {
									data: {
										commentId: foreign ? "43" : "42",
										url: "https://github.com/owner/repo/pull/7#issuecomment-42",
										receiptId: ctx.requestId,
										observedAt: new Date().toISOString(),
									},
								}),
					},
		);
	}) as typeof fetch;
	const handler = createGithubBridgeHandlers({
			env,
			activationId: "activation",
			fetchImpl,
		}).get("github.pr.comment")!,
		input = { number: 7, body: "Comment" };
	expect((await handler.execute(input, ctx)).status).toBe("succeeded");
	replay = true;
	expect((await handler.reconcile!({} as any, input, ctx)).providerRef).toBe(
		"42",
	);
	expect(calls).toEqual([
		"http://127.0.0.1:3199/api/lead-capabilities/github",
		"http://127.0.0.1:3199/api/lead-capabilities/github-receipt",
	]);
	denied = true;
	expect((await handler.execute(input, ctx)).errorCode).toBe(
		"pr_not_bound_to_lead",
	);
	denied = false;
	replay = false;
	foreign = true;
	expect((await handler.execute(input, ctx)).status).toBe("unknown");
	expect(
		createGithubBridgeHandlers({
			env,
			activationId: "activation",
			fetchImpl,
		}).has("github.pr.create"),
	).toBe(false);
});

it("routes all six runner handlers through result-only Bridge transport and correlates write receipts", async () => {
	const ctx = context();
	let badRef = false;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(init!.body as string);
		expect(body.operationId).toBe("send_runner");
		return Response.json({
			requestId: ctx.requestId,
			status: "succeeded",
			resourceRefs: [
				`runner-instruction:${badRef ? randomUUID() : ctx.requestId}`,
			],
			data: {
				result: {
					outcome: "queued",
					executionId: ctx.requestId,
					instructionId: ctx.requestId,
				},
				receiptId: ctx.requestId,
				observedAt: new Date().toISOString(),
			},
		});
	});
	const handlers = createRunnerBridgeHandlers({
		env,
		activationId: "activation",
		fetchImpl,
	});
	expect([...handlers.keys()]).toEqual([
		"start_runner",
		"list_runners",
		"get_runner_status",
		"read_runner_tmux",
		"send_runner",
		"respond_runner",
	]);
	const handler = handlers.get("send_runner")!,
		raw = {
			executionId: ctx.requestId,
			text: "instruction",
			idempotencyKey: "same-key",
		};
	expect((await handler.execute(raw, ctx)).status).toBe("succeeded");
	expect(fetchImpl.mock.calls[0]![0]).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/runners",
	);
	const receipt = {
		projectName: ctx.projectName,
		leadId: ctx.leadId,
		activationId: ctx.activationId,
		requestId: ctx.requestId,
		operationId: "send_runner",
		inputDigest: "a".repeat(64),
		state: "unknown" as const,
		providerRef: null,
		errorCode: null,
		startedAt: 1,
		updatedAt: 1,
	};
	expect((await handler.reconcile!(receipt, raw, ctx)).status).toBe(
		"succeeded",
	);
	expect(
		JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).receiptOnly,
	).toBe(true);
	expect(fetchImpl.mock.calls[1]![0]).toBe(fetchImpl.mock.calls[0]![0]);
	badRef = true;
	expect((await handler.execute(raw, ctx)).status).toBe("unknown");
	await expect(
		handler.authorize({ ...raw, text: "TOKEN_CANARY" }, ctx),
	).rejects.toThrow();
	expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it("binds memory operations to fixed Bridge endpoints and receipt identities", async () => {
	const ctx = context();
	const calls: string[] = [];
	const handlers = createMemoryBridgeHandlers({
		env,
		activationId: "activation",
		fetchImpl: async (url, init) => {
			calls.push(String(url));
			const body = JSON.parse(init!.body as string);
			const write = body.operationId === "memory.add";
			return Response.json({
				requestId: ctx.requestId,
				status: "succeeded",
				resourceRefs: write ? [`memory:${ctx.requestId}`] : [],
				data: write
					? {
							opId: "op",
							receiptId: ctx.requestId,
							observedAt: new Date().toISOString(),
						}
					: {
							memories: [],
							receiptId: ctx.requestId,
							observedAt: new Date().toISOString(),
						},
			});
		},
	});
	expect(
		(
			await handlers.get("memory.add")!.execute(
				{
					project: "flywheel",
					text: "learning",
					opId: "op",
					runKey: "r",
					noteId: "n",
					collection: "c",
				},
				ctx,
			)
		).status,
	).toBe("succeeded");
	expect(
		(
			await handlers
				.get("memory.search")!
				.execute({ project: "flywheel", query: "op" }, ctx)
		).status,
	).toBe("succeeded");
	expect(calls).toEqual([
		"http://127.0.0.1:3199/api/lead-capabilities/memory-add",
		"http://127.0.0.1:3199/api/lead-capabilities/read",
	]);
});

it.each([
	["github.pr.comment", { number: 7, body: "comment" }, "42"],
	[
		"github.pr.review",
		{ number: 7, body: "review", commitId: "a".repeat(40) },
		"43",
	],
	["github.pr.edit", { number: 7, title: "updated" }, "pr:7"],
	["github.pr.ready", { number: 7 }, "pr:7"],
	["github.run.rerun", { number: 7, runId: "99" }, "run:99"],
] as const)(
	"parent broker reconciles %s from a receipt without another write",
	async (operationId, input, providerRef) => {
		const root = mkdtempSync(join(tmpdir(), "github-reconcile-"));
		const journal = new SqliteJournalStore(join(root, "journal.sqlite"));
		let writes = 0,
			lookups = 0;
		const requestId = randomUUID();
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation",
			receipts: journal.operationReceipts,
			secrets: [],
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: createGithubBridgeHandlers({
				env,
				activationId: "activation",
				fetchImpl: async (url, init) => {
					expect(JSON.parse(init!.body as string).requestId).toBe(requestId);
					if (String(url).endsWith("/github")) {
						writes++;
						throw new Error("response_lost");
					}
					expect(String(url)).toBe(
						"http://127.0.0.1:3199/api/lead-capabilities/github-receipt",
					);
					lookups++;
					return Response.json({
						requestId,
						status: "succeeded",
						resourceRefs: [providerRef],
					});
				},
			}),
		});
		try {
			const request = { schemaVersion: 1, operationId, requestId, input };
			expect((await broker.execute(request)).status).toBe("unknown");
			expect(await broker.execute(request)).toMatchObject({
				status: "succeeded",
				resourceRefs: [providerRef],
			});
			expect((await broker.execute(request)).status).toBe("succeeded");
			expect({ writes, lookups }).toEqual({ writes: 1, lookups: 1 });
			expect(
				(await broker.execute({ ...request, input: { ...input, number: 8 } }))
					.errorCode,
			).toBe("input_digest_conflict");
			expect({ writes, lookups }).toEqual({ writes: 1, lookups: 1 });
		} finally {
			await broker.close();
			journal.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it.each(["dispatch", "missing-ref", "malformed-data", "secret"])(
	"GitHub receipt recovery keeps %s output invalid",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "github-reconcile-denied-"));
		const journal = new SqliteJournalStore(join(root, "journal.sqlite"));
		const operationId = "github.pr.comment",
			requestId = randomUUID();
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation",
			receipts: journal.operationReceipts,
			secrets: ["TOKEN_CANARY"],
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: createGithubBridgeHandlers({
				env,
				activationId: "activation",
				fetchImpl: async (url) => {
					if (mode !== "dispatch" && String(url).endsWith("/github"))
						throw new Error("response_lost");
					return Response.json({
						requestId,
						status: "succeeded",
						resourceRefs:
							mode === "missing-ref"
								? []
								: [mode === "secret" ? "TOKEN_CANARY" : "42"],
						...(mode === "malformed-data" ? { data: { commentId: "42" } } : {}),
					});
				},
			}),
		});
		try {
			const request = {
				schemaVersion: 1,
				operationId,
				requestId,
				input: { number: 7, body: "comment" },
			};
			expect((await broker.execute(request)).status).toBe("unknown");
			if (mode !== "dispatch")
				expect((await broker.execute(request)).status).toBe("unknown");
		} finally {
			await broker.close();
			journal.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
