import { randomUUID } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaRoomRouter, type QaRoomAuthStore } from "../qa-room-routes.js";
import type { QaRoomRuntime } from "../qa-room-runtime.js";
import { QaRoomService } from "../qa-room-service.js";
import { QaRoomStore } from "../qa-room-store.js";

const execution = randomUUID();
describe("QA room HTTP authorization", () => {
	let db: Database.Database;
	let server: Server;
	let base: string;
	let auth: QaRoomAuthStore;
	let store: QaRoomStore;
	let enabled: boolean;
	beforeEach(async () => {
		db = new Database(":memory:");
		store = new QaRoomStore(db);
		store.migrate();
		enabled = true;
		auth = {
			getSession: vi.fn(() => ({
				execution_id: execution,
				status: "running",
				session_role: "qa",
				issue_identifier: "FLY-2405",
			})),
			resolveCurrentWorkflowActivation: vi.fn(() => ({ kind: "none" })),
			getWorkflowSubmissionCredentialForActivation: vi.fn(() => undefined),
			getWorkflowSubmissionCredentialByToken: vi.fn(() => undefined),
			preflightStrengthTwoEvidenceCredential: vi.fn(() => ({ ok: true })),
		} as unknown as QaRoomAuthStore;
		const runtime = {
			occupied: () => false,
			logTail: () => [],
		} as unknown as QaRoomRuntime;
		const service = new QaRoomService({
			store,
			runtime,
			stateRoot: "/fixture/rooms",
			slotCount: 4,
			now: () => Date.now(),
			load: () => 0,
			threshold: () => 144,
			ownerTerminal: () => false,
			enabled: () => enabled,
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/api/qa-rooms",
			createQaRoomRouter({
				store: auth,
				service,
				apiToken: "master",
				ingestToken: "runner",
				enabled: () => enabled,
			}),
		);
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", resolve);
		});
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/qa-rooms`;
	});
	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		db.close();
	});
	const post = async (
		body: object = {},
		headers: Record<string, string> = {},
	) => {
		const response = await fetch(base, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer runner",
				...headers,
			},
			body: JSON.stringify({
				execution_id: execution,
				request_id: randomUUID(),
				head: "a".repeat(40),
				...body,
			}),
		});
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	};
	it("requires a configured valid bearer, refuses production targets, and audits each refusal", async () => {
		expect((await post({}, { authorization: "Bearer wrong" })).status).toBe(
			401,
		);
		expect((await post({ label: "com.flywheel.bridge" })).body.reason).toBe(
			"production_target_refused",
		);
		expect(store.audits().map((a) => a.decision)).toEqual([
			"refused",
			"refused",
		]);
	});
	it("admits QA and current implement callers but never missing, terminal, stale or design sessions", async () => {
		vi.mocked(auth.getSession).mockReturnValue(undefined);
		expect((await post()).status).toBe(403);
		vi.mocked(auth.getSession).mockReturnValue({
			execution_id: execution,
			status: "terminated",
			session_role: "qa",
			issue_identifier: "FLY-2405",
		} as never);
		expect((await post()).status).toBe(403);
		vi.mocked(auth.getSession).mockReturnValue({
			execution_id: execution,
			status: "running",
			session_role: "main",
			issue_identifier: "FLY-2405",
		} as never);
		expect((await post()).status).toBe(403);
		vi.mocked(auth.resolveCurrentWorkflowActivation).mockReturnValue({
			kind: "current",
			binding: { activation_id: "activation" },
			node: { type: "implement" },
		} as never);
		expect((await post()).status).toBe(202);
		vi.mocked(auth.resolveCurrentWorkflowActivation).mockReturnValue({
			kind: "ambiguous",
			activationIds: [],
		} as never);
		expect((await post()).status).toBe(403);
	});
	it("requires the current activation credential when one exists and rejects expiry/revocation", async () => {
		vi.mocked(auth.resolveCurrentWorkflowActivation).mockReturnValue({
			kind: "current",
			binding: { activation_id: "current" },
			node: { type: "qa" },
		} as never);
		vi.mocked(
			auth.getWorkflowSubmissionCredentialForActivation,
		).mockReturnValue({ id: 1 } as never);
		expect((await post()).body.reason).toBe("credential_required");
		vi.mocked(auth.getWorkflowSubmissionCredentialByToken).mockReturnValue({
			id: 1,
			execution_id: execution,
			activation_id: "old",
		} as never);
		expect((await post({ credential: "old" })).status).toBe(403);
		vi.mocked(auth.getWorkflowSubmissionCredentialByToken).mockReturnValue({
			id: 1,
			execution_id: execution,
			activation_id: "current",
		} as never);
		vi.mocked(auth.preflightStrengthTwoEvidenceCredential).mockReturnValue({
			ok: false,
			reason: "credential_revoked",
		});
		expect((await post({ credential: "revoked" })).status).toBe(403);
		vi.mocked(auth.preflightStrengthTwoEvidenceCredential).mockReturnValue({
			ok: true,
		});
		expect((await post({ credential: "current" })).status).toBe(202);
		expect(JSON.stringify(store.rooms())).not.toContain('"credential"');
	});
	it("binds Lead actor to its header and allows scoped reads using headers without query secrets", async () => {
		const leadBody = { request_id: randomUUID(), head: "a".repeat(40) };
		let response = await fetch(base, {
			method: "POST",
			headers: {
				authorization: "Bearer master",
				"content-type": "application/json",
			},
			body: JSON.stringify(leadBody),
		});
		expect(response.status).toBe(400);
		response = await fetch(base, {
			method: "POST",
			headers: {
				authorization: "Bearer master",
				"X-Flywheel-Lead-Id": "eng",
				"content-type": "application/json",
			},
			body: JSON.stringify(leadBody),
		});
		expect(response.status).toBe(202);
		expect(store.rooms()[0]?.owner_actor_key).toBe("lead:eng");
		const own = await post({ slot: 2 });
		expect(own.status).toBe(202);
		const get = await fetch(`${base}/${own.body.room_id}`, {
			headers: {
				authorization: "Bearer runner",
				"X-Flywheel-Execution-Id": execution,
			},
		});
		expect(get.status).toBe(200);
		const list = await fetch(base, {
			headers: {
				authorization: "Bearer runner",
				"X-Flywheel-Execution-Id": execution,
			},
		});
		const body = (await list.json()) as { rooms: unknown[] };
		expect(body.rooms).toHaveLength(1);
	});
	it("rejects a non-loopback Host and disabled service without spawning", async () => {
		// Native fetch rewrites Host; raw HTTP proves the actual boundary header.
		const code = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				base,
				{
					method: "POST",
					headers: {
						host: "outside.example",
						authorization: "Bearer runner",
						"content-type": "application/json",
					},
				},
				(res) => {
					res.resume();
					resolve(res.statusCode!);
				},
			);
			req.on("error", reject);
			req.end(
				JSON.stringify({
					execution_id: execution,
					request_id: randomUUID(),
					head: "a".repeat(40),
				}),
			);
		});
		expect(code).toBe(403);
		enabled = false;
		expect((await post()).status).toBe(503);
		expect(store.rooms()).toHaveLength(0);
	});
});
