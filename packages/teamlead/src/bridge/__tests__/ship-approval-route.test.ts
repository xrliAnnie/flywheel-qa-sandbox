/**
 * FLY-1018 — POST /api/ship-approval-request route tests (plan §2.8):
 *   - tokenless fail-closed 503 BEFORE body parsing;
 *   - 400 validation (missing params / non-GitHub prUrl / caps);
 *   - fail-closed Lead targeting: unknown project 400, non-member leadId
 *     400, multi-Lead project delivers to the EXPLICIT leadId (no
 *     leads[0] fallback);
 *   - 200 + note verbatim; delivery envelope carries pr_url/requester;
 *   - idempotency: committed row → already_pending; failed transaction →
 *     retry NOT swallowed; runtime-delivery failure → still accepted
 *     (heartbeat owns redelivery) and re-request dedups;
 *   - transactional outbox: request-row failure leaves ZERO orphan lead
 *     events;
 *   - ship_approval_request ∈ RETRYABLE_LEAD_EVENT_TYPES;
 *   - zero CommDB writes: FLYWHEEL_COMM_DIR stays empty end-to-end (no
 *     approve_to_ship gate/question is ever created).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import {
	type LeadRuntime,
	RETRYABLE_LEAD_EVENT_TYPES,
} from "../lead-runtime.js";
import {
	createShipApprovalHandler,
	SHIP_REQUEST_NOTE,
	type ShipApprovalRouteDeps,
} from "../ship-approval-route.js";

const PR_URL = "https://github.com/org/repo/pull/42";

function projectsFixture(): ProjectEntry[] {
	return [
		{
			projectName: "geoforge3d",
			leads: [
				{ agentId: "product-lead", chatChannel: "c1", match: { labels: [] } },
				{
					agentId: "flywheel-eng-lead",
					chatChannel: "c2",
					match: { labels: ["backend"] },
				},
			],
		},
	] as unknown as ProjectEntry[];
}

function fakeRuntime(behavior: "ok" | "fail" | "throw" = "ok") {
	const delivered: Array<Record<string, unknown>> = [];
	const runtime: LeadRuntime = {
		deliver: vi.fn(async (envelope) => {
			delivered.push(envelope as unknown as Record<string, unknown>);
			if (behavior === "throw") throw new Error("transport down");
			if (behavior === "fail") return { delivered: false, error: "offline" };
			return { delivered: true };
		}),
		bootstrap: vi.fn(),
		health: vi.fn(),
		shutdown: vi.fn(),
	} as unknown as LeadRuntime;
	return { runtime, delivered };
}

let store: StateStore;
let server: Server | null = null;
let baseUrl = "";
let commDir: string;
let savedCommDir: string | undefined;

async function mount(deps: Partial<ShipApprovalRouteDeps> = {}) {
	const app = express();
	app.use(express.json({ limit: "512kb" }));
	app.post(
		"/api/ship-approval-request",
		createShipApprovalHandler({
			store,
			projects: projectsFixture(),
			registry: { getForLead: () => undefined },
			apiTokenConfigured: true,
			...deps,
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => {
		server?.listen(0, "127.0.0.1", () => resolve());
	});
	baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

async function post(body: unknown) {
	const res = await fetch(`${baseUrl}/api/ship-approval-request`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

function validBody(overrides: Record<string, unknown> = {}) {
	return {
		prUrl: PR_URL,
		summary: "firmware fix ready to ship",
		projectName: "geoforge3d",
		leadId: "flywheel-eng-lead",
		...overrides,
	};
}

beforeEach(async () => {
	store = await StateStore.create(":memory:");
	// Zero-CommDB sentinel: any CommDB open would create files here.
	commDir = mkdtempSync(path.join(tmpdir(), "fly1018-comm-"));
	savedCommDir = process.env.FLYWHEEL_COMM_DIR;
	process.env.FLYWHEEL_COMM_DIR = commDir;
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => {
			server?.close(() => resolve());
		});
		server = null;
	}
	if (savedCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
	else process.env.FLYWHEEL_COMM_DIR = savedCommDir;
	rmSync(commDir, { recursive: true, force: true });
});

describe("POST /api/ship-approval-request", () => {
	it("tokenless deployment fails closed with 503 (before body parsing)", async () => {
		await mount({ apiTokenConfigured: false });
		const { status, json } = await post({});
		expect(status).toBe(503);
		expect(json).toEqual({
			ok: false,
			error: "bridge api token not configured",
		});
	});

	it.each([
		[{ prUrl: undefined }, "prUrl is required"],
		[{ summary: undefined }, "summary is required"],
		[{ projectName: undefined }, "projectName is required"],
		[{ leadId: undefined }, "leadId is required"],
	])("400 with runs-route shaped body when %o", async (patch, message) => {
		await mount();
		const { status, json } = await post(validBody(patch));
		expect(status).toBe(400);
		expect(json).toEqual({ success: false, message });
	});

	it("rejects a non-GitHub-PR prUrl", async () => {
		await mount();
		const { status, json } = await post(
			validBody({ prUrl: "https://evil.example/pull/1" }),
		);
		expect(status).toBe(400);
		expect(String(json.message)).toContain("GitHub PR URL");
	});

	it("rejects an over-cap summary and requesterContext", async () => {
		await mount();
		const long = await post(validBody({ summary: "x".repeat(2001) }));
		expect(long.status).toBe(400);
		const ctx = await post(validBody({ requesterContext: "y".repeat(501) }));
		expect(ctx.status).toBe(400);
	});

	it("unknown projectName → 400, never a default Lead", async () => {
		await mount();
		const { status, json } = await post(
			validBody({ projectName: "no-such-project" }),
		);
		expect(status).toBe(400);
		expect(String(json.message)).toContain("unknown projectName");
	});

	it("leadId not a member of the project → 400, never leads[0] fallback", async () => {
		const { runtime, delivered } = fakeRuntime();
		await mount({ registry: { getForLead: () => runtime } });
		const { status, json } = await post(validBody({ leadId: "sub-lead" }));
		expect(status).toBe(400);
		expect(String(json.message)).toContain(
			'leadId "sub-lead" is not a lead of project "geoforge3d"',
		);
		expect(delivered).toHaveLength(0);
		expect(store.countLeadEvents("product-lead", "ship_approval_request")).toBe(
			0,
		);
	});

	it("multi-Lead project: delivers to the EXPLICIT leadId with pr_url/requester in the envelope", async () => {
		const { runtime, delivered } = fakeRuntime();
		const getForLead = vi.fn((id: string) =>
			id === "flywheel-eng-lead" ? runtime : undefined,
		);
		await mount({ registry: { getForLead } });
		const { status, json } = await post(
			validBody({ requesterContext: "asked in huddle" }),
		);
		expect(status).toBe(200);
		expect(json.ok).toBe(true);
		expect(typeof json.requestId).toBe("string");
		expect(json.note).toBe(SHIP_REQUEST_NOTE);
		expect(getForLead).toHaveBeenCalledWith("flywheel-eng-lead");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.leadId).toBe("flywheel-eng-lead");
		const event = delivered[0]?.event as Record<string, unknown>;
		expect(event).toMatchObject({
			event_type: "ship_approval_request",
			pr_url: PR_URL,
			requester: "gemini-agent",
			requester_context: "asked in huddle",
			project_name: "geoforge3d",
			// honest identity — no fabricated session/issue
			execution_id: "",
			issue_id: "",
		});
		// queued + delivered → event marked delivered (no heartbeat re-fire)
		const undelivered = store.getUndeliveredGuardrailEvents(
			"flywheel-eng-lead",
			["ship_approval_request"],
			5,
		);
		expect(undelivered).toHaveLength(0);
	});

	it("idempotency: second request for the same prUrl answers already_pending with the ORIGINAL requestId", async () => {
		const { runtime } = fakeRuntime();
		await mount({ registry: { getForLead: () => runtime } });
		const first = await post(validBody());
		const second = await post(validBody({ summary: "different summary" }));
		expect(second.status).toBe(200);
		expect(second.json.already_pending).toBe(true);
		expect(second.json.requestId).toBe(first.json.requestId);
		// only ONE founder-visible event was queued
		expect(
			store.countLeadEvents("flywheel-eng-lead", "ship_approval_request"),
		).toBe(1);
	});

	it("runtime delivery failure: still 200 (durably queued), heartbeat owns redelivery, re-request dedups", async () => {
		const { runtime } = fakeRuntime("fail");
		await mount({ registry: { getForLead: () => runtime } });
		const first = await post(validBody());
		expect(first.status).toBe(200);
		expect(first.json.already_pending).toBeUndefined();
		// queued but undelivered → visible to the heartbeat retry query
		const undelivered = store.getUndeliveredGuardrailEvents(
			"flywheel-eng-lead",
			["ship_approval_request"],
			5,
		);
		expect(undelivered).toHaveLength(1);
		// and the type is in the retryable set — the redelivery loop owns it
		expect(RETRYABLE_LEAD_EVENT_TYPES.has("ship_approval_request")).toBe(true);
		// re-request does NOT double-queue
		const second = await post(validBody());
		expect(second.json.already_pending).toBe(true);
		expect(
			store.countLeadEvents("flywheel-eng-lead", "ship_approval_request"),
		).toBe(1);
	});

	it("deliver throwing is contained: 200, failure recorded, no crash", async () => {
		const { runtime } = fakeRuntime("throw");
		await mount({ registry: { getForLead: () => runtime } });
		const { status } = await post(validBody());
		expect(status).toBe(200);
		const undelivered = store.getUndeliveredGuardrailEvents(
			"flywheel-eng-lead",
			["ship_approval_request"],
			5,
		);
		expect(undelivered).toHaveLength(1);
	});

	it("transaction failure → 502, and a retry is NOT swallowed by already_pending", async () => {
		const failingStore = new Proxy(store, {
			get(target, prop, receiver) {
				if (prop === "recordShipApprovalRequest") {
					return () => {
						throw new Error("disk full");
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await mount({ store: failingStore });
		const first = await post(validBody());
		expect(first.status).toBe(502);
		expect(first.json).toEqual({
			ok: false,
			error: "failed to record request",
		});
		// nothing was queued — no orphan event, no request row
		expect(
			store.countLeadEvents("flywheel-eng-lead", "ship_approval_request"),
		).toBe(0);
		expect(store.findRecentShipApprovalRequest(PR_URL, 86_400_000)).toBe(null);

		// retry against the healthy store proceeds fresh (not already_pending)
		await new Promise<void>((resolve) => {
			server?.close(() => resolve());
		});
		server = null;
		const { runtime } = fakeRuntime();
		await mount({ registry: { getForLead: () => runtime } });
		const retry = await post(validBody());
		expect(retry.status).toBe(200);
		expect(retry.json.already_pending).toBeUndefined();
	});

	it("no runtime registered: 200 (queued), heartbeat owns delivery once a runtime appears", async () => {
		await mount(); // registry resolves nothing
		const { status } = await post(validBody());
		expect(status).toBe(200);
		expect(
			store.getUndeliveredGuardrailEvents(
				"flywheel-eng-lead",
				["ship_approval_request"],
				5,
			),
		).toHaveLength(1);
	});

	it("zero CommDB writes: FLYWHEEL_COMM_DIR stays empty (no approve_to_ship gate/question created)", async () => {
		const { runtime } = fakeRuntime();
		await mount({ registry: { getForLead: () => runtime } });
		await post(validBody());
		expect(readdirSync(commDir)).toEqual([]);
	});
});

describe("createBridgeApp stack: tokenless 503 BEFORE the global JSON parser (Codex R1)", () => {
	// 30s: imports the full plugin.js graph — cold-transform under production
	// load exceeds vitest's 5s default (import alone measured >7s at load ~47).
	it(
		"malformed and oversized bodies still get 503 (never the parser's 400/413) when apiToken is unset",
		{ timeout: 30_000 },
		async () => {
			const { createBridgeApp } = await import("../plugin.js");
			const { RunnerAdmissionController } = await import(
				"../runner-admission.js"
			);
			const s = await StateStore.create(":memory:");
			const app = createBridgeApp(s, projectsFixture(), {
				host: "127.0.0.1",
				port: 0,
				dbPath: ":memory:",
				notificationChannel: "test-channel",
				defaultLeadAgentId: "product-lead",
				stuckThresholdMinutes: 15,
				stuckCheckIntervalMs: 300_000,
				orphanThresholdMinutes: 60,
				runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
				replyByIssueEnabled: false,
				replyGuardEnabled: false,
				issuePrefixes: ["FLY"],
				// apiToken deliberately unset — tokenless deployment
			} as never);
			const stackServer = createServer(app);
			await new Promise<void>((resolve) => {
				stackServer.listen(0, "127.0.0.1", () => resolve());
			});
			const url = `http://127.0.0.1:${(stackServer.address() as AddressInfo).port}/api/ship-approval-request`;
			try {
				// malformed JSON — would 400 at express.json if parsing came first
				const malformed = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{not json",
				});
				expect(malformed.status).toBe(503);
				expect(await malformed.json()).toEqual({
					ok: false,
					error: "bridge api token not configured",
				});
				// oversized body — would 413 at the 512kb parser limit
				const oversized = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ pad: "x".repeat(600 * 1024) }),
				});
				expect(oversized.status).toBe(503);
			} finally {
				await new Promise<void>((resolve) => {
					stackServer.close(() => resolve());
				});
			}
		},
	);
});

describe("StateStore.recordShipApprovalRequest (transactional outbox pair)", () => {
	it("request-row failure rolls back the lead event — zero orphans", async () => {
		const s = await StateStore.create(":memory:");
		const base = {
			prUrl: PR_URL,
			projectName: "geoforge3d",
			leadId: "flywheel-eng-lead",
			requester: "gemini-agent",
			summary: "s",
			payload: "{}",
		};
		const seq = s.recordShipApprovalRequest({
			...base,
			requestId: "req-1",
			eventId: "evt-1",
		});
		expect(seq).toBeGreaterThan(0);
		// same requestId (PK violation) with a FRESH eventId: the event insert
		// succeeds inside the tx, then the row insert fails → whole tx rolls back
		expect(() =>
			s.recordShipApprovalRequest({
				...base,
				requestId: "req-1",
				eventId: "evt-2",
			}),
		).toThrow();
		expect(
			s.countLeadEvents("flywheel-eng-lead", "ship_approval_request"),
		).toBe(
			1, // only the first — evt-2 was rolled back
		);
	});

	it("findRecentShipApprovalRequest honors the time window", async () => {
		const s = await StateStore.create(":memory:");
		s.recordShipApprovalRequest({
			requestId: "req-1",
			prUrl: PR_URL,
			projectName: "p",
			leadId: "l",
			requester: "gemini-agent",
			summary: "s",
			eventId: "evt-1",
			payload: "{}",
		});
		expect(s.findRecentShipApprovalRequest(PR_URL, 86_400_000)).toEqual({
			requestId: "req-1",
		});
		expect(
			s.findRecentShipApprovalRequest(
				"https://github.com/o/r/pull/9",
				86_400_000,
			),
		).toBe(null);
	});
});
