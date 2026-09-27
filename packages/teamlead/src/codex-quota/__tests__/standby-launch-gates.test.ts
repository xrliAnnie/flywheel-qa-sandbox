import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexQuotaResumeAuthorization } from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCodexStandbyRun,
	quotaWall,
	rawDb,
} from "../../__tests__/helpers/codex-quota-standby-fixture.js";
import { StateStore } from "../../StateStore.js";
import {
	CodexQuotaLaunchPausedError,
	createCodexQuotaLaunchBinder,
} from "../launch-binding.js";
import {
	type CodexQuotaDispatcherWiring,
	wireCodexQuotaDispatcher,
} from "../runtime.js";

const ROOT = "root-canonical";
const ACCOUNT = "a".repeat(64);
const cleanups: string[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	for (const path of cleanups.splice(0))
		await rm(path, { recursive: true, force: true });
});

/**
 * A parked execution with a claimed permit and every historical fence at once:
 * a FLY-2465 casualty target, a root safety guard and an open root incident.
 */
async function claimedWithEveryFence() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuotaStandbyEnabled = () => true;
	const ids = createCodexStandbyRun(store, { cleanups });
	store.codexQuota.initializeRoot({
		rootKey: ROOT,
		accountKey: ACCOUNT,
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding({
		bindingId: "bind-0",
		executionId: ids.executionId,
		runId: ids.runId,
		purpose: "runner",
		accountKey: ACCOUNT,
		profile: "business",
		generation: 1,
		credentialRootKey: ROOT,
	});
	store.recordEnrolledTerminalSignal({
		...quotaWall(ids.executionId),
		quotaSignal: {
			version: 1,
			vendor: "codex",
			source: "goal_ended",
			sourceEventId: "wall-1",
			bindingId: "bind-0",
			evidence: "usageLimited",
			observedAt: "2026-09-25T00:10:00.000Z",
		},
	});
	const nowMs = Date.now();
	expect(
		store.codexQuota.issueReadingConfirmedPermit({
			rootKey: ROOT,
			expectedGeneration: 1,
			authDigest: "d".repeat(64),
			reading: {
				name: "business",
				identityKey: ACCOUNT,
				observedAt: new Date(nowMs - 10_000).toISOString(),
				fiveH: { usedPercent: 1, resetAt: null },
				weekly: { usedPercent: 2, resetAt: null },
				requestSeq: store.codexQuota.allocateCausalSeq(),
			},
			activeAccount: "business",
			nowMs,
		}),
	).toMatchObject({ outcome: "issued" });
	const db = rawDb(store);
	db.prepare(
		"INSERT OR IGNORE INTO codex_quota_incident(incident_id,root_key,generation,state,first_seen_at) VALUES('codex:root-canonical:2',?,2,'retry_wait','t')",
	).run(ROOT);
	db.prepare(
		"INSERT OR REPLACE INTO codex_quota_target(incident_id,target_kind,target_id,run_id,node_id,attempt,old_execution_id,state,start_key) VALUES('codex:root-canonical:2','runner','x',?,'implement',1,?,'starting','k')",
	).run(ids.runId, ids.executionId);
	const claimed = store.claimCodexQuotaResume({
		executionId: ids.executionId,
		ownerClaimId: "bridge:1:boot:c1",
		now: new Date(nowMs).toISOString(),
	});
	if (!claimed.ok) throw new Error(claimed.reason);
	expect(store.codexQuota.isExecutionPaused(ids.executionId)).toBe(true);
	expect(store.codexQuota.hasRootSafetyGuard(ROOT)).toBe(true);
	return { store, ...ids, authorization: claimed.authorization, claimed };
}

function wire(
	store: StateStore,
	enabled: boolean,
	runtimeBind?: (
		home: string,
		executionId: string,
		authorization?: CodexQuotaResumeAuthorization,
	) => Promise<unknown>,
) {
	const dispatcher = {} as Required<CodexQuotaDispatcherWiring>;
	const report = vi.fn();
	wireCodexQuotaDispatcher(
		dispatcher,
		store,
		runtimeBind
			? ({ beforeCodexDaemonStart: runtimeBind } as never)
			: undefined,
		ROOT,
		{ enabled: () => enabled, report },
	);
	return { dispatcher, report };
}

describe("FLY-2900 C5 — the explicit authorization rides every quota gate", () => {
	for (const enabled of [true, false]) {
		it(`admission and the daemon-start gate authorize a valid claim past every fence (auto-switch ${enabled ? "on" : "off"})`, async () => {
			const t = await claimedWithEveryFence();
			const runtimeBind = vi.fn(async () => ({
				bindingId: "runtime-binding",
				executionId: t.executionId,
				runId: t.runId,
				purpose: "runner" as const,
				accountKey: ACCOUNT,
				profile: "business",
				generation: 2,
				credentialRootKey: ROOT,
			}));
			const { dispatcher } = wire(t.store, enabled, runtimeBind);
			expect(
				dispatcher.codexQuotaAdmission({
					projectName: "flywheel",
					executionId: t.executionId,
					authorization: t.authorization,
				}),
			).toBeUndefined();
			const binding = await dispatcher.beforeCodexDaemonStart(
				"/fixture/home",
				t.executionId,
				t.authorization,
			);
			if (enabled) {
				expect(runtimeBind).toHaveBeenCalledWith(
					"/fixture/home",
					t.executionId,
					t.authorization,
				);
				expect(binding).toMatchObject({ bindingId: "runtime-binding" });
			} else {
				// Auto-switch off: no probe/bind; the relaunch reuses the binding
				// minted by the claim so a later wall is attributed to it.
				expect(runtimeBind).not.toHaveBeenCalled();
				expect(binding).toMatchObject({
					bindingId: t.claimed.bindingId,
					executionId: t.executionId,
				});
			}
		});

		it(`refuses every invalid authorization and never falls back (auto-switch ${enabled ? "on" : "off"})`, async () => {
			const t = await claimedWithEveryFence();
			const runtimeBind = vi.fn(async () => null);
			const { dispatcher } = wire(t.store, enabled, runtimeBind);
			for (const bad of [
				{ ...t.authorization, claimId: "bridge:9:boot:x" },
				{ ...t.authorization, entrySeq: 7 },
				{ ...t.authorization, resumeAttempt: 2 },
				{ ...t.authorization, executionId: "someone-else" },
			]) {
				await expect(
					dispatcher.beforeCodexDaemonStart(
						"/fixture/home",
						t.executionId,
						bad,
					),
				).rejects.toBeInstanceOf(CodexQuotaLaunchPausedError);
				expect(
					dispatcher.codexQuotaAdmission({
						projectName: "flywheel",
						executionId: t.executionId,
						authorization: bad,
					}),
				).toMatchObject({ rootKey: ROOT });
			}
			expect(runtimeBind).not.toHaveBeenCalled();
		});
	}

	it("fails closed when the binder of an authorized resume throws; an ordinary launch keeps the historical fail-open", async () => {
		const t = await claimedWithEveryFence();
		const { dispatcher, report } = wire(t.store, true, async () => {
			throw new Error("codex_home_not_shared");
		});
		await expect(
			dispatcher.beforeCodexDaemonStart(
				"/fixture/home",
				t.executionId,
				t.authorization,
			),
		).rejects.toThrow("codex_home_not_shared");
		expect(report).toHaveBeenCalledWith(
			"quota_runtime_bind_failed",
			expect.any(Error),
		);

		const healthy = await StateStore.create(":memory:");
		stores.push(healthy);
		const ordinary = wire(healthy, true, async () => {
			throw new Error("codex_home_not_shared");
		});
		await expect(
			ordinary.dispatcher.beforeCodexDaemonStart("/fixture/home", "fresh-exec"),
		).resolves.toBeNull();
	});

	it("re-checks after the awaited bind: a claim lost mid-bind is paused", async () => {
		const t = await claimedWithEveryFence();
		const { dispatcher } = wire(t.store, true, async () => {
			t.store.failCodexQuotaResume({
				authorization: t.authorization,
				kind: "mechanical",
				detailCode: "thread_resume_failed",
				continueDetermined: false,
				now: new Date().toISOString(),
			});
			return null;
		});
		await expect(
			dispatcher.beforeCodexDaemonStart(
				"/fixture/home",
				t.executionId,
				t.authorization,
			),
		).rejects.toBeInstanceOf(CodexQuotaLaunchPausedError);
	});

	it("an ordinary launch without an authorization is still paused by the same fences", async () => {
		const t = await claimedWithEveryFence();
		const { dispatcher } = wire(t.store, true, async () => null);
		await expect(
			dispatcher.beforeCodexDaemonStart("/fixture/home", t.executionId),
		).rejects.toBeInstanceOf(CodexQuotaLaunchPausedError);
		expect(
			dispatcher.codexQuotaAdmission({
				projectName: "flywheel",
				executionId: t.executionId,
			}),
		).toMatchObject({ rootKey: ROOT });
	});

	it("auto-switch off: an ordinary healthy launch makes no binder or runtime call", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const runtimeBind = vi.fn(async () => null);
		const { dispatcher } = wire(store, false, runtimeBind);
		await expect(
			dispatcher.beforeCodexDaemonStart("/fixture/home", "fresh-exec"),
		).resolves.toBeNull();
		expect(runtimeBind).not.toHaveBeenCalled();
		expect(
			dispatcher.codexQuotaAdmission({
				projectName: "flywheel",
				executionId: "fresh-exec",
			}),
		).toBeUndefined();
		expect(store.codexQuota.getRoot(ROOT)).toBeUndefined();
	});

	it("the launch binder honours the authorization on both of its pause checks", async () => {
		const t = await claimedWithEveryFence();
		const root = await mkdtemp(join(tmpdir(), "fly2900-binder-"));
		cleanups.push(root);
		const canonical = join(root, "canonical");
		const home = join(root, "home");
		await mkdir(canonical, { recursive: true });
		await mkdir(home, { recursive: true });
		await writeFile(join(canonical, "auth.json"), "business", { mode: 0o600 });
		await symlink(join(canonical, "auth.json"), join(home, "auth.json"));
		const bind = createCodexQuotaLaunchBinder({
			store: t.store,
			canonicalHome: canonical,
			identify: () => ({ profile: "business", accountKey: ACCOUNT }),
		});
		await expect(bind(home, t.executionId)).rejects.toBeInstanceOf(
			CodexQuotaLaunchPausedError,
		);
		// The binder derives the root from the real canonical path; align the
		// claimed row's fences with that root so only authorization decides.
		const rootKey = (await import("node:crypto"))
			.createHash("sha256")
			.update(await (await import("node:fs/promises")).realpath(canonical))
			.digest("hex");
		expect(
			t.store.codexQuotaLaunchDecision(t.executionId, rootKey, t.authorization),
		).toBe("authorized");
		const binding = await bind(home, t.executionId, t.authorization);
		expect(binding).toMatchObject({
			executionId: t.executionId,
			purpose: "runner",
		});
	});
});
