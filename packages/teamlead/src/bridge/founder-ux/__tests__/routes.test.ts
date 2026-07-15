/**
 * FLY-598: founder-ux gate — HTTP route integration tests (credential split).
 *
 * Spins up a real express app with mountFounderUxRoutes and exercises the two
 * routes over HTTP. Focus: the credential-separation security gating
 * (Codex R2-#1 / R3-#1 / R3-#2) + the status read predicate.
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import { StateStore } from "../../../StateStore.js";
import type { FetchImpl } from "../../founder-consent/discord-fetch.js";
import { mountFounderUxRoutes } from "../routes.js";
import { writeSignoff } from "../signoff.js";

const FOUNDER = "annie-id";
const UX_HASH = "d".repeat(64);
const INGEST = "ingest-tok";
const API = "api-tok";

interface RawMsg {
	id: string;
	content: string;
	timestamp: string;
	author?: { id?: string; bot?: boolean };
}
const fakeFetch = (messages: RawMsg[]): FetchImpl =>
	vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => messages,
	})) as unknown as FetchImpl;

describe("FLY-598 founder-ux routes", () => {
	let store: StateStore;
	let server: ReturnType<express.Express["listen"]>;
	let base: string;

	const project: ProjectEntry = {
		projectName: "proj",
		leads: [
			{
				agentId: "lead-1",
				chatChannel: "chan-1",
				botToken: "bot-tok",
			} as ProjectEntry["leads"][number],
		],
	} as ProjectEntry;

	async function start(
		opts: { ingestToken?: string; apiToken?: string; messages?: RawMsg[] } = {},
	): Promise<void> {
		const app = express();
		app.use(express.json());
		mountFounderUxRoutes(app, {
			store,
			projects: [project],
			founderUserId: FOUNDER,
			ingestToken: "ingestToken" in opts ? opts.ingestToken : INGEST,
			apiToken: "apiToken" in opts ? opts.apiToken : API,
			discordBotToken: "default-bot",
			fetchImpl: fakeFetch(opts.messages ?? []),
			now: () => Date.parse("2026-06-27T00:00:00Z"),
		});
		await new Promise<void>((resolve) => {
			server = app.listen(0, () => resolve());
		});
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	beforeEach(async () => {
		// FLY-900: the founder-UX gate is retired fleet-wide by default. These
		// existing cases assert the ORIGINAL enforce behavior (status reflects the
		// sign-off record), so run them with the kill-switch explicitly enabled.
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "1");
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "ISSUE-1",
			project_name: "proj",
			status: "running",
		});
		store.upsertChatThread("thread-1", "chan-1", "ISSUE-1", "lead-1");
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	// ── status (read, ingest-token) ──
	it("status rejects a request without the ingest token (401)", async () => {
		await start();
		const r = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
		);
		expect(r.status).toBe(401);
	});

	it("status FAIL-CLOSES (401) when the Bridge has no ingest token (never fail-open)", async () => {
		await start({ ingestToken: undefined });
		const r = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
		);
		expect(r.status).toBe(401);
	});

	it("status returns approved:false when no sign-off, true after one is recorded", async () => {
		await start();
		const h = { Authorization: `Bearer ${INGEST}` };
		const r1 = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
			{ headers: h },
		);
		expect(await r1.json()).toEqual({ approved: false });

		writeSignoff(store, "exec-1", {
			uxHash: UX_HASH,
			annieMsgId: "m",
			fetchedExcerpt: "可以",
			ts: new Date().toISOString(),
		});
		const r2 = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
			{ headers: h },
		);
		expect(await r2.json()).toEqual({ approved: true });
	});

	// ── FLY-900 kill-switch OFF (default): status short-circuits to approved ──
	it("FLY-900 gate disabled: status is approved:true even with NO sign-off (never blocks implement)", async () => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "0"); // override beforeEach "1"
		await start();
		const r = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
			{ headers: { Authorization: `Bearer ${INGEST}` } },
		);
		expect(await r.json()).toEqual({ approved: true });
	});

	it("FLY-900 gate disabled: auth is STILL enforced — no ingest token → 401 (short-circuit is after auth)", async () => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "0");
		await start();
		const r = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
		);
		expect(r.status).toBe(401);
	});

	// ── signoff (privileged write, api-token, fail-closed) ──
	it("signoff fail-closes (503) when apiToken is unset", async () => {
		await start({ apiToken: undefined });
		const r = await fetch(`${base}/api/founder-ux/signoff`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "exec-1",
				ux_hash: UX_HASH,
				annie_msg_id: "m",
			}),
		});
		expect(r.status).toBe(503);
	});

	it("signoff fail-closes (503) when apiToken === ingest token (must be distinct)", async () => {
		await start({ apiToken: INGEST, ingestToken: INGEST });
		const r = await fetch(`${base}/api/founder-ux/signoff`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${INGEST}`,
			},
			body: JSON.stringify({
				execution_id: "exec-1",
				ux_hash: UX_HASH,
				annie_msg_id: "m",
			}),
		});
		expect(r.status).toBe(503);
	});

	it("signoff REJECTS the Runner's ingest token (only the api token writes)", async () => {
		await start();
		const r = await fetch(`${base}/api/founder-ux/signoff`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${INGEST}`, // runner credential, not the api token
			},
			body: JSON.stringify({
				execution_id: "exec-1",
				ux_hash: UX_HASH,
				annie_msg_id: "m",
			}),
		});
		expect(r.status).toBe(401);
	});

	it("signoff with the api token + a verified founder message records the sign-off", async () => {
		await start({
			messages: [
				{
					id: "msg-annie",
					content: "好，就这样",
					timestamp: "2026-06-26T23:30:00Z",
					author: { id: FOUNDER, bot: false },
				},
			],
		});
		const r = await fetch(`${base}/api/founder-ux/signoff`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API}`,
			},
			body: JSON.stringify({
				execution_id: "exec-1",
				ux_hash: UX_HASH,
				annie_msg_id: "msg-annie",
			}),
		});
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({ recorded: true });
		// the status route now reports approved for this hash
		const s = await fetch(
			`${base}/api/founder-ux/status?execId=exec-1&uxHash=${UX_HASH}`,
			{ headers: { Authorization: `Bearer ${INGEST}` } },
		);
		expect(await s.json()).toEqual({ approved: true });
	});
});
