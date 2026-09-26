/**
 * FLY-871 R2/C5 — POST /api/account-switch route: validation, cross-provider
 * gating, atomic claim (409 idempotent), execute+audit+post, byte-compat off.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepairDisposition } from "../account-heal/account-switch-repair.js";
import {
	type PendingSwitch,
	pendingKey,
	writePending,
} from "../account-heal/pending-store.js";
import {
	type AccountSwitchRuntime,
	createAccountSwitchRouter,
} from "../bridge/account-switch-route.js";

function request(
	app: express.Application,
	path: string,
	body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((done) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			const data = JSON.stringify(body);
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(data),
					},
				},
				(res: {
					statusCode: number;
					on: (e: string, cb: (c?: Buffer) => void) => void;
				}) => {
					let out = "";
					res.on("data", (c) => {
						out += c;
					});
					res.on("end", () => {
						server.close();
						done({ status: res.statusCode, body: out ? JSON.parse(out) : {} });
					});
				},
			);
			req.write(data);
			req.end();
		});
	});
}

const ALERT = "alert-1";
const ACCOUNT = "school";
const GEN = 3;

/** A valid body whose (sourceAlertId, observedAccount, generation) matches the seed. */
function validBody(overrides: Record<string, unknown> = {}) {
	return {
		provider: "claude",
		observedAccount: ACCOUNT,
		observedGeneration: GEN,
		scope: "5h",
		resetAt: "2026-07-05T00:00:00Z",
		sourceAlertId: ALERT,
		actorBotId: "codex-infra-bot",
		actorBackend: "codex",
		...overrides,
	};
}

function seededRecord(overrides: Partial<PendingSwitch> = {}): PendingSwitch {
	return {
		key: pendingKey(ALERT, ACCOUNT, GEN),
		provider: "claude",
		sourceAlertId: ALERT,
		observedAccount: ACCOUNT,
		observedGeneration: GEN,
		scope: "5h",
		resetAt: "2026-07-05T00:00:00Z",
		deadlineAt: "2999-01-01T00:00:00Z",
		createdAt: "2026-07-04T00:00:00Z",
		...overrides,
	};
}

describe("POST /api/account-switch", () => {
	let dir: string;
	let pendingPath: string;
	let executeSwitch: ReturnType<typeof vi.fn>;
	let postResult: ReturnType<typeof vi.fn>;
	let audit: ReturnType<typeof vi.fn>;

	function makeApp(
		runtimeOverride?: AccountSwitchRuntime | undefined | "none",
	) {
		const runtime: AccountSwitchRuntime | undefined =
			runtimeOverride === "none"
				? undefined
				: (runtimeOverride ?? {
						repair: { executeSwitch },
						postResult,
						audit,
						pendingPath,
						pendingLockPath: `${pendingPath}.lock`,
						// pass-through lock so tests don't touch a real mkdir lock
						withLock: async (_lp, fn) => fn(),
					});
		const app = express();
		app.use(express.json());
		app.use(
			"/api/account-switch",
			createAccountSwitchRouter({ getRuntime: () => runtime }),
		);
		return app;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly871-c5-"));
		pendingPath = join(dir, "pending.json");
		writePending([seededRecord()], pendingPath);
		executeSwitch = vi.fn(
			async (): Promise<RepairDisposition> => ({
				outcome: "attempted",
				action: "account_switch",
				detail: "🔧 已切机器 Claude 账号 school→personal",
			}),
		);
		postResult = vi.fn(async () => {});
		audit = vi.fn();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("400 when a required field is missing", async () => {
		const b = validBody();
		delete (b as Record<string, unknown>).sourceAlertId;
		const r = await request(makeApp(), "/api/account-switch", b);
		expect(r.status).toBe(400);
		expect(audit).not.toHaveBeenCalled();
		expect(executeSwitch).not.toHaveBeenCalled();
	});

	it("400 when observedGeneration is not an integer", async () => {
		const r = await request(
			makeApp(),
			"/api/account-switch",
			validBody({ observedGeneration: "3" }),
		);
		expect(r.status).toBe(400);
	});

	it("400 on an unknown scope", async () => {
		const r = await request(
			makeApp(),
			"/api/account-switch",
			validBody({ scope: "daily" }),
		);
		expect(r.status).toBe(400);
	});

	it("400 for a non-claude provider (MVP claude-only)", async () => {
		const r = await request(
			makeApp(),
			"/api/account-switch",
			validBody({ provider: "codex", actorBackend: "claude" }),
		);
		expect(r.status).toBe(400);
	});

	// FLY-871 R3/W5: a successful switch fires the post-switch rescue sweep hook.
	it("fires onSwitchSuccess after a successful switch (best-effort, a throw doesn't 500)", async () => {
		const onSwitchSuccess = vi.fn(async () => {});
		const runtime: AccountSwitchRuntime = {
			repair: { executeSwitch },
			postResult,
			audit,
			pendingPath,
			pendingLockPath: `${pendingPath}.lock`,
			withLock: async (_lp, fn) => fn(),
			onSwitchSuccess,
		};
		const r = await request(
			makeApp(runtime),
			"/api/account-switch",
			validBody(),
		);
		expect(r.status).toBe(200);
		expect(onSwitchSuccess).toHaveBeenCalledOnce();

		// A throwing sweep must NOT fail the (already-committed) switch request.
		onSwitchSuccess.mockRejectedValueOnce(new Error("sweep boom"));
		writePending([seededRecord()], pendingPath); // re-seed (prior claim consumed it)
		const r2 = await request(
			makeApp(runtime),
			"/api/account-switch",
			validBody(),
		);
		expect(r2.status).toBe(200);
	});

	it("403 when actorBackend === provider (self-repair)", async () => {
		const r = await request(
			makeApp(),
			"/api/account-switch",
			validBody({ actorBackend: "claude" }),
		);
		expect(r.status).toBe(403);
		expect(audit).not.toHaveBeenCalled();
		expect(executeSwitch).not.toHaveBeenCalled();
	});

	it("byte-compat: 409 needs_human when self-heal is off (no runtime bound)", async () => {
		const r = await request(
			makeApp("none"),
			"/api/account-switch",
			validBody(),
		);
		expect(r.status).toBe(409);
		expect(r.body.reason).toBe("self_heal_disabled");
	});

	it("200 success: claims, executes, audits before+after, posts result", async () => {
		const r = await request(makeApp(), "/api/account-switch", validBody());
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.outcome).toBe("attempted");
		// executed against the SEEDED record (server-recorded, not bot-supplied scope)
		expect(executeSwitch).toHaveBeenCalledTimes(1);
		expect(executeSwitch.mock.calls[0][0]).toMatchObject({
			key: pendingKey(ALERT, ACCOUNT, GEN),
			observedAccount: ACCOUNT,
			observedGeneration: GEN,
		});
		// audit before + after
		expect(audit).toHaveBeenCalledTimes(2);
		expect(audit.mock.calls[0][0]).toMatchObject({ phase: "request" });
		expect(audit.mock.calls[1][0]).toMatchObject({
			phase: "result",
			outcome: "attempted",
		});
		// FLY-929 (Codex code R1 HIGH): the FULL disposition must ride along as
		// the second argument — the plugin's shared postSwitchResult reads
		// notifySuccess (W6 digest) and outcome (A5 owner mention) from it, so a
		// detail-only call on the bot-claimed path silently loses both.
		expect(postResult).toHaveBeenCalledWith(
			expect.stringContaining("已切"),
			expect.objectContaining({ outcome: "attempted" }),
		);
	});

	it("409 when there is no pending record for the key (claim miss)", async () => {
		const r = await request(
			makeApp(),
			"/api/account-switch",
			validBody({ sourceAlertId: "no-such-alert" }),
		);
		expect(r.status).toBe(409);
		expect(r.body.outcome).toBe("already_claimed_or_missing");
		expect(executeSwitch).not.toHaveBeenCalled();
	});

	it("409 idempotent: a second identical request finds the record already resolved", async () => {
		const app = makeApp();
		const r1 = await request(app, "/api/account-switch", validBody());
		expect(r1.status).toBe(200);
		// executeSwitch (real one resolves the pending record); our fake does not, so
		// simulate resolution by re-seeding as claimed to prove the no-steal path.
		// Instead: seed already-claimed and assert 409 on a fresh app.
		writePending([seededRecord({ claimedBy: "someone-else" })], pendingPath);
		const r2 = await request(app, "/api/account-switch", validBody());
		expect(r2.status).toBe(409);
	});

	it("200 with outcome needs_human when the executor cannot switch", async () => {
		executeSwitch.mockResolvedValueOnce({
			outcome: "needs_human",
			action: "none",
			detail: "所有 Claude 账号都已用尽",
		} satisfies RepairDisposition);
		const r = await request(makeApp(), "/api/account-switch", validBody());
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(false);
		expect(r.body.outcome).toBe("needs_human");
		// FLY-929: the needs_human disposition also rides along so the A5
		// owner-mention routing sees the outcome on the bot-claimed path.
		expect(postResult).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ outcome: "needs_human" }),
		);
	});

	it("still 200 when the result post fails (best-effort, switch already committed)", async () => {
		postResult.mockRejectedValueOnce(new Error("discord 500"));
		const r = await request(makeApp(), "/api/account-switch", validBody());
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
	});

	it("500 fail-loud when the executor throws unexpectedly", async () => {
		executeSwitch.mockRejectedValueOnce(new Error("lock timeout"));
		const r = await request(makeApp(), "/api/account-switch", validBody());
		expect(r.status).toBe(500);
	});
});
