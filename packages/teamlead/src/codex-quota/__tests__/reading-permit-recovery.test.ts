import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyCodexAuth } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexInstallAccountKey } from "flywheel-claude-runner/bin/codex-account-install.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCodexStandbyRun,
	quotaWall,
	rawDb,
} from "../../__tests__/helpers/codex-quota-standby-fixture.js";
import { StateStore } from "../../StateStore.js";
import { CodexQuotaCoordinator } from "../coordinator.js";
import { createCodexQuotaRunRecovery } from "../run-recovery.js";

const NOW = "2026-09-26T23:00:00.000Z";
const pool = {
	version: 2 as const,
	primary: "business",
	profiles: [
		{
			name: "business",
			email: "fixture@example.test",
			role: "primary" as const,
		},
	],
	slots: [],
	problems: [],
};
const auth = JSON.stringify({
	tokens: {
		id_token: `x.${Buffer.from(
			JSON.stringify({
				email: "fixture@example.test",
				"https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
			}),
		).toString("base64url")}.x`,
		refresh_token: "fixture",
	},
});
const digest = createHash("sha256").update(auth).digest("hex");
const account = codexInstallAccountKey(identifyCodexAuth(auth, pool));
const stores = new Set<StateStore>();
const paths: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const store of stores) store.close();
	stores.clear();
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

async function readingRecovery() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "reading-proof-")));
	paths.push(home);
	writeFileSync(join(home, "auth.json"), auth);
	const dbPath = join(home, "fixture.db");
	let store = await StateStore.create(dbPath);
	stores.add(store);
	store.codexQuotaStandbyEnabled = () => true;
	createCodexStandbyRun(store, {
		executionId: "carrier",
		runId: "run",
		cleanups: paths,
	});
	const root = createHash("sha256").update(home).digest("hex");
	const incident = `codex:${root}:4`;
	store.codexQuota.initializeRoot({
		rootKey: root,
		accountKey: account,
		profile: "business",
		generation: 4,
	});
	store.codexQuota.registerBinding({
		bindingId: "binding",
		executionId: "carrier",
		runId: "run",
		purpose: "runner",
		accountKey: account,
		profile: "business",
		generation: 4,
		credentialRootKey: root,
	});
	store.recordEnrolledTerminalSignal({
		...quotaWall("carrier", "wall", { now: NOW }),
		quotaSignal: {
			version: 1,
			vendor: "codex",
			source: "goal_ended",
			sourceEventId: "wall",
			bindingId: "binding",
			evidence: "usageLimited",
			observedAt: NOW,
		},
	});
	store.codexQuota.setIncidentState(
		incident,
		"pool_exhausted",
		"pool_exhausted",
	);
	store.codexQuota.reserveLegacyStart({
		startKey: "queued",
		executionId: "next-exec",
		projectName: "fixture",
		issueId: "FLY-WAIT",
		requestDigest: "request",
		requestContext: JSON.stringify({
			idempotencyKey: "queued",
			issueId: "FLY-WAIT",
			projectName: "fixture",
			role: "implement",
			vendor: "codex",
		}),
	});
	store.codexQuota.enqueueLegacyAdmissionWait({
		startKey: "queued",
		rootKey: root,
		generation: 4,
	});
	expect(
		store.codexQuota.issueReadingConfirmedPermit({
			rootKey: root,
			expectedGeneration: 4,
			authDigest: digest,
			activeAccount: "business",
			nowMs: Date.parse(NOW),
			reading: {
				name: "business",
				identityKey: account,
				observedAt: NOW,
				fiveH: { usedPercent: 10, resetAt: null },
				weekly: { usedPercent: 20, resetAt: null },
				requestSeq: store.codexQuota.allocateCausalSeq(),
			},
		}),
	).toMatchObject({ outcome: "issued" });
	const post = vi.fn(async () => {
		store.upsertSession({
			execution_id: "next-exec",
			issue_id: "FLY-WAIT",
			project_name: "fixture",
			status: "running",
		});
		store.codexQuota.registerBinding({
			bindingId: "next-binding",
			runId: null,
			executionId: "next-exec",
			purpose: "runner",
			accountKey: account,
			profile: "business",
			generation: 5,
			credentialRootKey: root,
		});
		return new Response(
			JSON.stringify({ success: true, executionId: "next-exec" }),
			{ status: 200 },
		);
	});
	vi.stubGlobal("fetch", post);
	const tick = () => {
		const recovery = createCodexQuotaRunRecovery({
			store,
			canonicalHome: home,
			pool: () => pool,
			bridgeUrl: "http://127.0.0.1:12345",
			apiToken: "fixture",
			readiness: async () => true,
			verifyLiveness: async () => "alive",
		});
		return new CodexQuotaCoordinator({
			store: store.codexQuota,
			now: () => Date.parse(NOW),
			autoEnabled: () => true,
			availability: async () => ({
				mode: "automatic",
				reasons: [],
				revision: 1,
				checkedAt: NOW,
			}),
			readiness: async () => true,
			observe: async () => {
				throw new Error("no_probe_evidence");
			},
			rotate: async () => ({ ok: false }),
			recover: recovery.recover,
		}).tick();
	};
	const claim = (owner = "bridge:1:boot:c1", withDigest = true) => {
		const result = store.claimCodexQuotaResume({
			executionId: "carrier",
			ownerClaimId: owner,
			now: NOW,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(
			store.markCodexQuotaResumeIdentityVerified(result.authorization, NOW, {
				sessionId: "thread",
				...(withDigest ? { authDigest: digest } : {}),
			}),
		).toBe(true);
		return result.authorization;
	};
	const succeed = (authorization: ReturnType<typeof claim>) => {
		expect(
			store.markCodexQuotaContinueStarted(authorization, "turn", NOW),
		).toBe(true);
		return store.settleCodexQuotaResumeSuccess({
			authorization,
			turnId: "turn",
			now: NOW,
		});
	};
	return {
		get store() {
			return store;
		},
		root,
		incident,
		home,
		post,
		tick,
		claim,
		succeed,
		restart: async () => {
			store.close();
			stores.delete(store);
			store = await StateStore.create(dbPath);
			stores.add(store);
			store.codexQuotaStandbyEnabled = () => true;
		},
	};
}

describe("FLY-2900 reading recovery and the auto-switch coordinator", () => {
	it.each([false, true])(
		"keeps the waiter pending without aborting (carrier settled=%s)",
		async (carrierSettled) => {
			const f = await readingRecovery();
			if (carrierSettled)
				for (const target of f.store.codexQuota.listTargets(f.incident))
					f.store.codexQuota.updateTarget(
						f.incident,
						String(target.target_kind),
						String(target.target_id),
						{ state: "recovered" },
					);
			await expect(f.tick()).resolves.toBeUndefined();
			expect(f.store.codexQuota.getIncident(f.incident)?.state).not.toBe(
				"settled",
			);
			expect(f.store.getCodexQuotaRecoveryPermit(f.incident)).toBeUndefined();
			expect(f.store.codexQuota.getAdmissionWait("queued")?.state).toBe(
				"waiting",
			);
			expect(f.post).not.toHaveBeenCalled();
		},
	);
	it("persists successful output proof across restart and releases the existing waiter exactly once", async () => {
		const f = await readingRecovery();
		expect(f.succeed(f.claim())).toBe(true);
		expect(f.store.codexQuota.getIncident(f.incident)).toMatchObject({
			state: "settled",
			probe_result: null,
		});
		expect(f.store.getCodexQuotaRecoveryPermit(f.incident)).toMatchObject({
			recovery_proof_kind: "resume_output",
			installed_generation: 5,
			installed_auth_digest: digest,
		});
		expect(
			f.store.codexQuota.getInstallationMaterial(f.incident),
		).toBeUndefined();
		await f.restart();
		await f.tick();
		expect(f.store.codexQuota.getAdmissionWait("queued")?.state).toBe(
			"released",
		);
		expect(f.post).toHaveBeenCalledTimes(1);
		await f.tick();
		expect(f.post).toHaveBeenCalledTimes(1);
	});
	it("restart before first output preserves waiting and rejects the abandoned claim", async () => {
		const f = await readingRecovery();
		const claim = f.claim();
		f.store.markCodexQuotaContinueStarted(claim, "turn", NOW);
		await f.restart();
		f.store.codexQuota.recoverAbandonedClaims("bridge:2:boot", NOW);
		expect(
			f.store.settleCodexQuotaResumeSuccess({
				authorization: claim,
				turnId: "turn",
				now: NOW,
			}),
		).toBe(false);
		await f.tick();
		expect(f.store.getCodexQuotaRecoveryPermit(f.incident)).toBeUndefined();
		expect(f.store.codexQuota.getAdmissionWait("queued")?.state).toBe(
			"waiting",
		);
		expect(f.post).not.toHaveBeenCalled();
	});
	it("failed first output never releases a waiter", async () => {
		const f = await readingRecovery();
		const authorization = f.claim();
		f.store.reconcileCodexQuotaContinue({
			authorization,
			now: NOW,
			outcome: { kind: "failed_before_output", usageLimited: false },
		});
		await f.restart();
		await f.tick();
		expect(f.store.getCodexQuotaRecoveryPermit(f.incident)).toBeUndefined();
		expect(f.store.codexQuota.getAdmissionWait("queued")?.state).toBe(
			"waiting",
		);
		expect(f.post).not.toHaveBeenCalled();
	});
	it.each(["generation", "signal", "identity"])(
		"rejects a success callback after a newer %s",
		async (fence) => {
			const f = await readingRecovery();
			const authorization = f.claim();
			f.store.markCodexQuotaContinueStarted(authorization, "turn", NOW);
			if (fence === "generation")
				rawDb(f.store)
					.prepare("UPDATE codex_quota_root SET generation=6 WHERE root_key=?")
					.run(f.root);
			else if (fence === "identity")
				rawDb(f.store)
					.prepare("UPDATE codex_quota_root SET account_key=? WHERE root_key=?")
					.run("b".repeat(64), f.root);
			else
				f.store.codexQuota.recordSignal({
					executionId: "other",
					source: "runner_terminal",
					sourceEventId: "new-wall",
					now: NOW,
				});
			expect(
				f.store.settleCodexQuotaResumeSuccess({
					authorization,
					turnId: "turn",
					now: NOW,
				}),
			).toBe(false);
			expect(f.store.getCodexQuotaRecoveryPermit(f.incident)).toBeUndefined();
		},
	);
	it("does not promote a successful carrier with no observed credential digest", async () => {
		const f = await readingRecovery();
		expect(f.succeed(f.claim("bridge:1:boot:c1", false))).toBe(true);
		await f.tick();
		expect(f.store.getCodexQuotaRecoveryPermit(f.incident)).toBeUndefined();
		expect(f.post).not.toHaveBeenCalled();
	});
	it("old unprobed settled rows cannot abort later incidents", async () => {
		const f = await readingRecovery();
		rawDb(f.store)
			.prepare(
				"UPDATE codex_quota_incident SET state='settled' WHERE incident_id=?",
			)
			.run(f.incident);
		rawDb(f.store)
			.prepare(
				"INSERT INTO codex_quota_incident(incident_id,root_key,generation,state,first_seen_at) VALUES('later',?,3,'prepared',?)",
			)
			.run(f.root, NOW);
		await expect(f.tick()).resolves.toBeUndefined();
		expect(f.post).not.toHaveBeenCalled();
	});
});
