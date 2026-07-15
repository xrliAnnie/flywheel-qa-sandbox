/**
 * FLY-618: INDEPENDENT QA (not implementer self-test) for the FLY-598
 * founder-facing UX gate (#369). Authored by the QA runner, folded into the PR
 * for permanent regression protection.
 *
 * Why this exists ON TOP of the implementer's unit/route tests:
 *  - The implementer's `routes.test.ts` mounts ONLY `mountFounderUxRoutes` on a
 *    BARE express app. It therefore can never prove the production MOUNT ORDER:
 *    that `GET /api/founder-ux/status` (ingest-token) is reached BEFORE the broad
 *    `/api` apiToken middleware shadows it. This suite instantiates the REAL
 *    `createBridgeApp` — the actual production wiring, including every broad
 *    `/api` apiToken middleware — and drives the real HTTP surface.
 *  - The crown-jewel verification runs through the REAL `DiscordFetcher` (the
 *    plugin passes NO `fetchImpl`, so production uses `globalThis.fetch`). We
 *    stub only the Discord HTTP boundary (discord.com) — every other byte of the
 *    path is the shipping code. This is the closest possible proxy to the live
 *    Discord surface (the genuinely-live founder-reply leg is coordinated
 *    separately, same mechanism as FLY-612).
 *  - Adds adversarial cases the unit tests do not cover: bot-impersonation,
 *    missing authorId, non-finite timestamp, the privileged api-token being
 *    unable to READ the ingest-gated status route (separation in BOTH
 *    directions), and the Layer-B stage guard exercised through the real
 *    `/events` route end-to-end (their guard tests call the pure function).
 *
 * Freshness: the plugin passes no `now` to the gate, so verify.ts uses real
 * Date.now(); fixtures are timestamped relative to the real clock.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../../ProjectConfig.js";
import { StateStore } from "../../../StateStore.js";
import { createBridgeApp } from "../../plugin.js";
import { RunnerAdmissionController } from "../../runner-admission.js";
import type { BridgeConfig } from "../../types.js";
import { readSignoff } from "../signoff.js";

// plugin.ts imports @linear/sdk at module load — mock it (we never hit Linear).
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: { rawRequest: vi.fn() },
	})),
}));

const FOUNDER = "annie-discord-id";
const LEAD = "lead-discord-id";
const BOT = "bot-discord-id";
const INGEST = "ingest-tok-618";
const API = "api-tok-618";
const UX_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const EXEC = "exec-fly618";
const ISSUE = "ISSUE-618";
const PROJECT = "proj618";
const CHAN = "chan618";
const THREAD = "thread618";

interface RawMsg {
	id: string;
	content: string;
	timestamp: string;
	author?: { id?: string; bot?: boolean };
}

/** Fresh = 1h ago vs the real clock (verify.ts uses real Date.now()). */
const freshTs = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
/** Stale = 7d ago (outside the 48h freshness window). */
const staleTs = () =>
	new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const project: ProjectEntry = {
	projectName: PROJECT,
	projectRoot: "/tmp/proj618",
	leads: [
		{
			agentId: "lead-1",
			chatChannel: CHAN,
			botToken: "bot-tok-618",
		} as ProjectEntry["leads"][number],
	],
} as ProjectEntry;

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "lead-1",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		ingestToken: INGEST,
		apiToken: API,
		// founderUserId is read from founderConsent; decisionMode "off" keeps the
		// FLY-175 consent wiring a no-op so only the founder-ux gate is exercised.
		founderConsent: {
			decisionMode: "off",
			founderUserId: FOUNDER,
		} as BridgeConfig["founderConsent"],
		...overrides,
	} as BridgeConfig;
}

describe("FLY-618 independent QA — founder-ux gate via REAL createBridgeApp", () => {
	let store: StateStore;
	let server: http.Server;
	let base: string;
	/** Mutable per-test Discord thread history returned by the stubbed fetch. */
	let threadMessages: RawMsg[];
	/** When true, the stubbed Discord fetch returns a 500 (upstream error). */
	let discordUpstream500 = false;
	/** When true, the stubbed Discord fetch returns a non-array body. */
	let discordNonArray = false;
	let realFetch: typeof globalThis.fetch;

	beforeEach(async () => {
		// FLY-900: the founder-UX gate is retired fleet-wide by default. This whole
		// suite asserts the ORIGINAL enforce behavior (status/stage-guard react to
		// the sign-off), so run it with the kill-switch explicitly enabled. The
		// FLY-900 disabled-path cases below override this per-test.
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "1");
		threadMessages = [];
		discordUpstream500 = false;
		discordNonArray = false;
		realFetch = globalThis.fetch;
		// Route ONLY discord.com through the fake; everything else (none, since the
		// client uses node http) falls back to the real fetch.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: unknown) => {
				if (typeof url === "string" && url.includes("discord.com")) {
					if (discordUpstream500) {
						return { ok: false, status: 500, json: async () => ({}) };
					}
					return {
						ok: true,
						status: 200,
						json: async () =>
							discordNonArray ? { not: "array" } : threadMessages,
					};
				}
				return realFetch(url as string, init as RequestInit);
			}),
		);

		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
		});
		store.upsertChatThread(THREAD, CHAN, ISSUE, "lead-1");
	});

	afterEach(async () => {
		if (server) await new Promise<void>((r) => server.close(() => r()));
		store.close();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	async function startApp(
		configOverrides: Partial<BridgeConfig> = {},
	): Promise<void> {
		const app = createBridgeApp(store, [project], makeConfig(configOverrides));
		await new Promise<void>((resolve) => {
			server = app.listen(0, "127.0.0.1", () => resolve());
		});
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	/** Node http client so the global `fetch` stub only ever sees Discord calls. */
	function req(
		method: string,
		path: string,
		opts: { headers?: Record<string, string>; body?: unknown } = {},
	): Promise<{ status: number; json: unknown }> {
		return new Promise((resolve, reject) => {
			const payload =
				opts.body === undefined ? undefined : JSON.stringify(opts.body);
			const u = new URL(base + path);
			const r = http.request(
				{
					hostname: u.hostname,
					port: u.port,
					path: u.pathname + u.search,
					method,
					headers: {
						...(payload !== undefined
							? {
									"Content-Type": "application/json",
									"Content-Length": Buffer.byteLength(payload),
								}
							: {}),
						...(opts.headers ?? {}),
					},
				},
				(res) => {
					let data = "";
					res.on("data", (c) => {
						data += c.toString();
					});
					res.on("end", () => {
						let parsed: unknown = data;
						try {
							parsed = data ? JSON.parse(data) : null;
						} catch {
							/* leave as raw string */
						}
						resolve({ status: res.statusCode ?? 0, json: parsed });
					});
				},
			);
			r.on("error", reject);
			if (payload !== undefined) r.write(payload);
			r.end();
		});
	}

	const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

	const signoffBody = (annieMsgId: string, uxHash = UX_HASH) => ({
		execution_id: EXEC,
		ux_hash: uxHash,
		annie_msg_id: annieMsgId,
	});

	const statusPath = (uxHash = UX_HASH) =>
		`/api/founder-ux/status?execId=${EXEC}&uxHash=${uxHash}`;

	const founderMsg = (id: string, content = "可以，就这样做"): RawMsg => ({
		id,
		content,
		timestamp: freshTs(),
		author: { id: FOUNDER, bot: false },
	});

	// ────────────────────────── ANTI-FORGERY (crown jewel) ──────────────────────────

	it("HAPPY PATH: founder-authored, in-thread, fresh → 200 recorded; status approved; excerpt is SERVER content", async () => {
		threadMessages = [founderMsg("m-annie", "好，可以")];
		await startApp();

		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(200);
		expect(w.json).toMatchObject({ recorded: true });

		const s = await req("GET", statusPath(), { headers: bearer(INGEST) });
		expect(s.json).toEqual({ approved: true });

		// CLI never supplies a quote; the stored excerpt MUST be the server-fetched
		// content, not anything an attacker could inject.
		const rec = readSignoff(store, EXEC);
		expect(rec?.fetchedExcerpt).toBe("好，可以");
		expect(rec?.uxHash).toBe(UX_HASH);
	});

	it("FORGERY: Lead cites its OWN (non-founder) message → 403, no sign-off", async () => {
		threadMessages = [
			{
				id: "m-lead",
				content: "可以 (Lead pretending to be Annie)",
				timestamp: freshTs(),
				author: { id: LEAD, bot: false },
			},
		];
		await startApp();

		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-lead"),
		});
		expect(w.status).toBe(403);
		expect(readSignoff(store, EXEC)).toBeNull();
		const s = await req("GET", statusPath(), { headers: bearer(INGEST) });
		expect(s.json).toEqual({ approved: false });
	});

	it("FORGERY: bot-authored impersonation message (founder-like content) → 403", async () => {
		threadMessages = [
			{
				id: "m-bot",
				content: "可以",
				timestamp: freshTs(),
				author: { id: BOT, bot: true },
			},
		];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-bot"),
		});
		expect(w.status).toBe(403);
		expect(readSignoff(store, EXEC)).toBeNull();
	});

	it("FORGERY: message with MISSING authorId → 403 (authorId '' !== founder)", async () => {
		threadMessages = [
			{ id: "m-noauthor", content: "可以", timestamp: freshTs(), author: {} },
		];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-noauthor"),
		});
		expect(w.status).toBe(403);
	});

	it("THREAD BINDING: cited message id NOT in the thread → 422", async () => {
		threadMessages = [founderMsg("m-real")];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-does-not-exist"),
		});
		expect(w.status).toBe(422);
		expect(readSignoff(store, EXEC)).toBeNull();
	});

	it("FRESHNESS: founder-authored but STALE (7d old) → 422", async () => {
		threadMessages = [
			{
				id: "m-stale",
				content: "可以",
				timestamp: staleTs(),
				author: { id: FOUNDER, bot: false },
			},
		];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-stale"),
		});
		expect(w.status).toBe(422);
	});

	it("FRESHNESS: founder message with a NON-FINITE timestamp → 422 (no NaN bypass)", async () => {
		threadMessages = [
			{
				id: "m-garbage-ts",
				content: "可以",
				timestamp: "not-a-real-date",
				author: { id: FOUNDER, bot: false },
			},
		];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-garbage-ts"),
		});
		expect(w.status).toBe(422);
	});

	it("FAIL-CLOSED: Discord upstream error (500) → 502, no sign-off (never allow on fetch failure)", async () => {
		discordUpstream500 = true;
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(502);
		expect(readSignoff(store, EXEC)).toBeNull();
	});

	it("FAIL-CLOSED: founder id NOT configured → 503 (cannot verify 'is it Annie')", async () => {
		threadMessages = [founderMsg("m-annie")];
		await startApp({
			founderConsent: {
				decisionMode: "off",
				founderUserId: "",
			} as BridgeConfig["founderConsent"],
		});
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(503);
	});

	// ──────────────────────── CREDENTIAL SEPARATION (real wiring) ────────────────────────

	it("MOUNT ORDER: ingest-token status READ reaches the handler (NOT shadowed by the broad /api apiToken middleware)", async () => {
		await startApp();
		// The whole point: with the REAL app (broad `/api` apiToken middleware
		// present), an ingest-token GET still hits the founder-ux status handler.
		const s = await req("GET", statusPath(), { headers: bearer(INGEST) });
		expect(s.status).toBe(200);
		expect(s.json).toEqual({ approved: false });
	});

	it("SEPARATION: the privileged API token CANNOT read the ingest-gated status route → 401", async () => {
		await startApp();
		const s = await req("GET", statusPath(), { headers: bearer(API) });
		expect(s.status).toBe(401);
	});

	it("SEPARATION: status with NO token → 401", async () => {
		await startApp();
		const s = await req("GET", statusPath());
		expect(s.status).toBe(401);
	});

	it("FAIL-CLOSED: status route with NO ingest token configured → 401 (never fail-open exposing gate state)", async () => {
		await startApp({ ingestToken: undefined });
		const s = await req("GET", statusPath());
		expect(s.status).toBe(401);
	});

	it("SEPARATION: signoff WRITE rejects the Runner's ingest token → 401 (only the api token writes)", async () => {
		threadMessages = [founderMsg("m-annie")];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(INGEST),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(401);
		expect(readSignoff(store, EXEC)).toBeNull();
	});

	it("FAIL-CLOSED: signoff WRITE with NO apiToken configured → 503", async () => {
		await startApp({ apiToken: undefined });
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(503);
	});

	it("FAIL-CLOSED: signoff WRITE when apiToken === ingest token (must be distinct) → 503", async () => {
		await startApp({ apiToken: INGEST, ingestToken: INGEST });
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(INGEST),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(503);
	});

	// ──────────────────── LAYER B STAGE GUARD via REAL /events route ────────────────────

	/** POST a stage_changed→implement event through the real ingest-authed route. */
	function postImplement(
		uxHash?: string,
	): Promise<{ status: number; json: unknown }> {
		return req("POST", "/events", {
			headers: bearer(INGEST),
			body: {
				event_id: `evt-${Math.random().toString(36).slice(2)}`,
				execution_id: EXEC,
				issue_id: ISSUE,
				project_name: PROJECT,
				event_type: "stage_changed",
				source: "flywheel-comm",
				payload:
					uxHash === undefined
						? { stage: "implement" }
						: { stage: "implement", ux_hash: uxHash },
			},
		});
	}

	it("GATE: founder-facing + enforce + implement WITHOUT a sign-off → 409 FOUNDER_UX_SIGNOFF_REQUIRED", async () => {
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		await startApp();
		const r = await postImplement(UX_HASH);
		expect(r.status).toBe(409);
		expect(r.json).toMatchObject({ error: "FOUNDER_UX_SIGNOFF_REQUIRED" });
	});

	it("GATE: founder-facing + enforce + implement WITHOUT ux_hash → 409 (fail-closed on missing brief)", async () => {
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		await startApp();
		const r = await postImplement(undefined);
		expect(r.status).toBe(409);
		expect(r.json).toMatchObject({ error: "FOUNDER_UX_SIGNOFF_REQUIRED" });
	});

	it("GATE: founder-facing + enforce + implement with a VALID current-brief sign-off → passes (not 409)", async () => {
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		// Record a real, verified sign-off via the privileged route first.
		threadMessages = [founderMsg("m-annie")];
		await startApp();
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-annie"),
		});
		expect(w.status).toBe(200);

		const r = await postImplement(UX_HASH);
		expect(r.status).not.toBe(409);
		expect(store.getSession(EXEC)?.session_stage).toBe("implement");
	});

	it("GATE: founder-facing + enforce + implement with a STALE sign-off (different brief) → 409", async () => {
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		threadMessages = [founderMsg("m-annie")];
		await startApp();
		// Sign off for OTHER_HASH, then enter implement asserting UX_HASH.
		const w = await req("POST", "/api/founder-ux/signoff", {
			headers: bearer(API),
			body: signoffBody("m-annie", OTHER_HASH),
		});
		expect(w.status).toBe(200);
		const r = await postImplement(UX_HASH);
		expect(r.status).toBe(409);
	});

	it("AUDIT_ONLY: founder-facing + implement WITHOUT a sign-off → NOT blocked (records implement)", async () => {
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "audit_only",
		});
		await startApp();
		const r = await postImplement(UX_HASH);
		expect(r.status).not.toBe(409);
		expect(store.getSession(EXEC)?.session_stage).toBe("implement");
	});

	it("BYTE-COMPAT: founder-facing + mode off + implement WITHOUT a sign-off → passes (no gate)", async () => {
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "off",
		});
		await startApp();
		const r = await postImplement(UX_HASH);
		expect(r.status).not.toBe(409);
		expect(store.getSession(EXEC)?.session_stage).toBe("implement");
	});

	it("SCOPE: NON-founder-facing run + enforce + implement → gate does not apply (passes)", async () => {
		// founder_facing_ux left 0; mode enforce should be irrelevant.
		store.patchSessionMetadata(EXEC, { founder_ux_gate_mode: "enforce" });
		await startApp();
		const r = await postImplement(UX_HASH);
		expect(r.status).not.toBe(409);
		expect(store.getSession(EXEC)?.session_stage).toBe("implement");
	});

	// ──────────── FLY-900 kill-switch OFF (default): whole gate retired ────────────
	// Prove BOTH enforcement surfaces (the status route B and the stage-guard C)
	// go fully permissive through the REAL createBridgeApp when the kill-switch is
	// disabled — this is what unblocks a founder-facing issue's implement.

	it("FLY-900 OFF: status route is approved:true with NO sign-off (Layer A retired)", async () => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "0"); // override beforeEach "1"
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		await startApp();
		const s = await req("GET", statusPath(), { headers: bearer(INGEST) });
		expect(s.status).toBe(200);
		expect(s.json).toEqual({ approved: true });
	});

	it("FLY-900 OFF: founder-facing + enforce + implement WITHOUT a sign-off → NOT 409 (Layer B retired)", async () => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "0");
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		await startApp();
		const r = await postImplement(UX_HASH);
		expect(r.status).not.toBe(409);
		expect(store.getSession(EXEC)?.session_stage).toBe("implement");
	});

	it("FLY-900 OFF: founder-facing + enforce + implement WITHOUT ux_hash → NOT 409 (missing-brief fail-close also retired)", async () => {
		vi.stubEnv("FLYWHEEL_FOUNDER_UX_GATE_ENABLED", "0");
		store.patchSessionMetadata(EXEC, {
			founder_facing_ux: 1,
			founder_ux_gate_mode: "enforce",
		});
		await startApp();
		const r = await postImplement(undefined);
		expect(r.status).not.toBe(409);
		expect(store.getSession(EXEC)?.session_stage).toBe("implement");
	});
});
