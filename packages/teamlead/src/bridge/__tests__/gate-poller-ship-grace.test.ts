/**
 * FLY-945 Fix A — ship-gate grace at the GatePoller layer.
 *
 * The 10min FLY-605 founder-reply grace exists so the Lead can relay first;
 * an approve_to_ship gate's answer is founder-only (Lead relay is forbidden),
 * so both founder channels (text + ✅-reaction) must clear after the short
 * ship grace (default 15s, env FLYWHEEL_SHIP_GATE_GRACE_MS).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";

type Priv = {
	shipGateGraceMs(): number;
	checkpointGraceMsFor(checkpoint: string | null): number;
	founderReactionApprovalPass(): Promise<void>;
	founderReplyDeliverPass(): Promise<void>;
};

function makePoller(over: Partial<GatePollerConfig> = {}) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		store: {} as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
		...over,
	});
}

describe("FLY-945 Fix A: ship-gate grace resolution", () => {
	let envBak: string | undefined;
	beforeEach(() => {
		envBak = process.env.FLYWHEEL_SHIP_GATE_GRACE_MS;
		delete process.env.FLYWHEEL_SHIP_GATE_GRACE_MS;
	});
	afterEach(() => {
		if (envBak === undefined) delete process.env.FLYWHEEL_SHIP_GATE_GRACE_MS;
		else process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = envBak;
	});

	it("defaults to 15s", () => {
		expect((makePoller() as unknown as Priv).shipGateGraceMs()).toBe(15_000);
	});

	it("env FLYWHEEL_SHIP_GATE_GRACE_MS wins over config (kill-switch: set 600000 to restore old behavior)", () => {
		process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = "600000";
		const poller = makePoller({ shipGateGraceMs: 5_000 });
		expect((poller as unknown as Priv).shipGateGraceMs()).toBe(600_000);
	});

	it("config shipGateGraceMs used when env unset; garbage env ignored", () => {
		const poller = makePoller({ shipGateGraceMs: 5_000 });
		expect((poller as unknown as Priv).shipGateGraceMs()).toBe(5_000);
		process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = "not-a-number";
		expect((poller as unknown as Priv).shipGateGraceMs()).toBe(5_000);
		process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = "-1";
		expect((poller as unknown as Priv).shipGateGraceMs()).toBe(5_000);
	});

	it("checkpointGraceMsFor: approve_to_ship → ship grace; everything else → 10min FLY-605 grace", () => {
		const poller = makePoller() as unknown as Priv;
		expect(poller.checkpointGraceMsFor("approve_to_ship")).toBe(15_000);
		expect(poller.checkpointGraceMsFor("brainstorm")).toBe(10 * 60_000);
		expect(poller.checkpointGraceMsFor(null)).toBe(10 * 60_000);
	});
});

describe("FLY-945 Fix A ⑦: reaction pass clears after ship grace (Codex R1 #6)", () => {
	let tmp: string;
	let envBak: Record<string, string | undefined>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly945-ship-grace-"));
		envBak = {
			FLYWHEEL_COMM_DIR: process.env.FLYWHEEL_COMM_DIR,
			FLYWHEEL_SHIP_GATE_GRACE_MS: process.env.FLYWHEEL_SHIP_GATE_GRACE_MS,
		};
		process.env.FLYWHEEL_COMM_DIR = tmp;
		delete process.env.FLYWHEEL_SHIP_GATE_GRACE_MS;
	});
	afterEach(() => {
		for (const [k, v] of Object.entries(envBak)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(tmp, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function seedShipGate(projectName: string, leadId: string): string {
		const db = new CommDB(join(tmp, projectName, "comm.db"));
		const qid = db.insertQuestion(
			"exec-945",
			leadId,
			"PR ready: ship?",
			{ checkpoint: "approve_to_ship" }, // created_at = now → 30s-old scale
		);
		db.close();
		return qid;
	}

	function pollerWith(tryReaction: ReturnType<typeof vi.fn>) {
		const store = {
			getSession: vi.fn(() => ({
				execution_id: "exec-945",
				issue_id: "FLY-945",
				project_name: "flywheel",
			})),
			getChatThreadByIssue: vi.fn(() => ({ thread_id: "T945" })),
		} as unknown as GatePollerConfig["store"];
		return makePoller({
			store,
			projects: [
				{
					projectName: "flywheel",
					leads: [{ agentId: "test-lead", botToken: "bot", chatChannel: "C1" }],
				},
			] as unknown as GatePollerConfig["projects"],
			tryFounderReactionApproval:
				tryReaction as unknown as GatePollerConfig["tryFounderReactionApproval"],
		});
	}

	it("a fresh (seconds-old) ship gate IS reaction-checked (15s grace elapses fast — simulated via 0)", async () => {
		process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = "0"; // deterministic: no 15s sleep in tests
		seedShipGate("flywheel", "test-lead");
		const tryReaction = vi.fn(async () => null);
		const poller = pollerWith(tryReaction);
		await (poller as unknown as Priv).founderReactionApprovalPass();
		expect(tryReaction).toHaveBeenCalledTimes(1);
	});

	it("reverse-compat: FLYWHEEL_SHIP_GATE_GRACE_MS=600000 → fresh gate NOT reaction-checked (old 10min behavior)", async () => {
		process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = "600000";
		seedShipGate("flywheel", "test-lead");
		const tryReaction = vi.fn(async () => null);
		const poller = pollerWith(tryReaction);
		await (poller as unknown as Priv).founderReactionApprovalPass();
		expect(tryReaction).not.toHaveBeenCalled();
	});
});
