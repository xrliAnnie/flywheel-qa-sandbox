import { randomUUID } from "node:crypto";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { LeadConfigService } from "../bridge/lead-config-service.js";
import { CodexLeadInboxRejectedError } from "../lead-backends/codex/CodexLeadInboxSocket.js";
import type { LeadTurnObservation } from "../lead-backends/codex/lead-turn-evidence.js";
import type { LeadConfigRegistryIntent } from "../lead-config-registry.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
async function fixture() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	let wrongReceipt = false;
	let driftOnApply = false;
	let observation: LeadTurnObservation | undefined;
	let actual = { model: "gpt-6-astra", effort: "high", drifted: false };
	let commitHook: (() => Promise<void>) | undefined;
	let recoverCount = 0;
	let readHook: (() => Promise<void>) | undefined;
	let applyError: Error | undefined;
	let supported = true,
		online = true,
		current = true,
		applyCount = 0,
		commitCount = 0;
	const lease = {
		projectName: "raya",
		leadKey: "raya-raya",
		identityDigest: "identity",
		carrierId: "carrier",
		ownerEpoch: "epoch",
		runtimeGeneration: "runtime",
		threadId: "thread",
		artifactBuildSha: "a".repeat(40),
		bootstrapBuildSha: "a".repeat(40),
		capabilities: ["lead_runtime_config_v1", "registry_tuning_v1"],
		online: true,
	};
	const writer = {
		plan: (input: { operationId: string; reason: string; patch?: unknown }) => {
			const body = {
				operationId: input.operationId,
				projectName: "raya",
				leadId: "raya",
				leadKey: "raya-raya",
				identityDigest: "identity",
				summaryAssignmentDigest: "summary",
				actor: "bridge-local-operator",
				reason: input.reason,
				preProjectsSha: "before",
				postProjectsSha: "after",
				preimage: { model: "gpt-6-astra", effort: "low" },
				postimage: { model: "gpt-6-astra", effort: "high" },
				resolved: { model: "gpt-6-astra", effort: "high" },
				sourceReceiptSha: "receipt",
				configDigest: "config",
				modelRegistryRevision: "models",
			};
			return { ...body, requestDigest: canonicalSubmissionDigest(body) };
		},
		commit: async (input: LeadConfigRegistryIntent) => {
			commitCount++;
			store.prepareLeadConfigOperation(input);
			await commitHook?.();
			return store.transitionLeadConfigOperation(
				input.operationId,
				"prepared",
				"registry_committed",
				{},
			);
		},
		recover: async (id: string) => {
			recoverCount++;
			return store.getLeadConfigOperation(id)!;
		},
		assertCurrent: () => {
			if (!current) throw new Error("source_changed");
		},
	};
	const service = new LeadConfigService({
		store,
		writer,
		tokens: new ConfirmTokenStore(),
		runtimeBuildSha: "a".repeat(40),
		runtime: {
			preflight: async () => ({
				...lease,
				capabilities: supported ? lease.capabilities : [],
				online,
			}),
			apply: async (target) => {
				applyCount++;
				if (applyError) throw applyError;
				if (driftOnApply)
					return {
						status: "drifted" as const,
						operationId: target.operationId,
					};
				return {
					...target,
					threadId: wrongReceipt ? "stale-thread" : target.threadId,
					status: "applied" as const,
					appliedAt: new Date().toISOString(),
				};
			},
			read: async () => {
				const hook = readHook;
				readHook = undefined;
				await hook?.();
				return { ...actual, ...(observation ? { observation } : {}) };
			},
		},
	});
	return {
		store,
		service,
		sessionDrift: () => {
			actual = { ...actual, effort: "low", drifted: true };
		},
		restorePair: () => {
			actual = { ...actual, effort: "high" };
		},
		observe: (id: string, stale = false) => {
			const receipt = JSON.parse(
				store
					.listLeadConfigAudit(id)
					.find(
						(row) =>
							row.from_status === "pending_runtime" &&
							row.to_status === "applied",
					)!.detail,
			).receipt;
			const {
				status: _status,
				appliedAt,
				readback: _readback,
				...target
			} = receipt;
			observation = {
				target: { ...target, ...(stale ? { carrierId: "stale" } : {}) },
				source: "registry_hot",
				observedAt: new Date().toISOString(),
				evidence: {
					threadId: target.threadId,
					turnId: "turn",
					model: target.model,
					effort: target.effort,
					recordedAt: appliedAt,
					source: "rollout_turn_context",
					recordDigest: "a".repeat(64),
				},
			};
		},
		request: () => ({
			operationId: randomUUID(),
			projectName: "raya",
			leadId: "raya",
			reason: "test",
			effort: "high",
		}),
		driftOnApply: () => {
			driftOnApply = true;
		},
		rotate: () => {
			lease.carrierId = "new-carrier";
			lease.ownerEpoch = "new-owner";
			lease.runtimeGeneration = "new-runtime";
			lease.threadId = "new-thread";
		},
		wrongReceipt: () => {
			wrongReceipt = true;
		},
		rejectApply: (reason: string) => {
			applyError = new CodexLeadInboxRejectedError(reason);
		},
		duringCommit: (hook: () => Promise<void>) => {
			commitHook = hook;
		},
		recoverCount: () => recoverCount,
		whenRead: (hook: () => Promise<void>) => {
			readHook = hook;
		},
		unsupported: () => {
			supported = false;
		},
		offline: () => {
			online = false;
		},
		sourceChanged: () => {
			current = false;
		},
		counts: () => ({ applyCount, commitCount }),
	};
}
it("refuses old runtime capabilities before recording or writing", async () => {
	const f = await fixture();
	f.unsupported();
	await expect(f.service.stage(f.request())).rejects.toThrow(
		"runtime_hot_config_unsupported",
	);
	expect(f.counts()).toEqual({ applyCount: 0, commitCount: 0 });
});
it("binds confirmation to content and records applied only after the matching runtime receipt", async () => {
	const f = await fixture();
	const stage = await f.service.stage(f.request());
	await expect(
		f.service.apply({
			...stage,
			canonical: {
				...stage.canonical,
				intent: { ...stage.canonical.intent, reason: "tampered" },
			},
		}),
	).rejects.toThrow();
	expect(f.counts().commitCount).toBe(0);
	const good = await f.service.stage(f.request());
	const result = await f.service.apply(good);
	expect(result.operation.status).toBe("applied");
	expect(f.counts()).toEqual({ applyCount: 1, commitCount: 1 });
	expect(
		(await f.service.apply({ ...good, confirmToken: "consumed" })).operation
			.status,
	).toBe("applied");
	expect(f.counts().commitCount).toBe(1);
});
it("keeps an offline supported runtime pending after a durable file commit", async () => {
	const f = await fixture();
	f.offline();
	const result = await f.service.apply(await f.service.stage(f.request()));
	expect(result.operation.status).toBe("pending_runtime");
	expect(f.counts()).toEqual({ applyCount: 0, commitCount: 1 });
});
it("shows source invalidation as unavailable without erasing historical applied evidence", async () => {
	const f = await fixture();
	const stage = await f.service.stage(f.request());
	await f.service.apply(stage);
	f.sourceChanged();
	const result = await f.service.status(stage.canonical.intent.operationId);
	expect(result.operation.status).toBe("applied");
	expect(result.effectiveStatus).toBe("unavailable");
});
it("supersedes the older committed generation before applying a newer explicit set", async () => {
	const f = await fixture();
	const first = await f.service.apply(await f.service.stage(f.request()));
	const second = await f.service.apply(await f.service.stage(f.request()));
	expect(second.operation.status).toBe("applied");
	expect(
		f.store.getLeadConfigOperation(first.operation.input.operationId)?.status,
	).toBe("superseded");
});

it("persists a diagnostic and stays pending when native application receipt binding is wrong", async () => {
	const f = await fixture();
	f.wrongReceipt();
	const stage = await f.service.stage(f.request());
	const result = await f.service.apply(stage);
	expect(result.operation.status).toBe("pending_runtime");
	expect(
		f.store
			.listLeadConfigAudit(stage.canonical.intent.operationId)
			.map((row) => JSON.parse(row.detail)),
	).toContainEqual({ diagnostic: "runtime_receipt_mismatch" });
});

it("persists a structured sidecar refusal instead of flattening it to unavailable", async () => {
	const f = await fixture();
	f.rejectApply("context_window_incompatible");
	const stage = await f.service.stage(f.request());
	const result = await f.service.apply(stage);
	expect(result.operation.status).toBe("pending_runtime");
	expect(
		f.store
			.listLeadConfigAudit(stage.canonical.intent.operationId)
			.map((row) => JSON.parse(row.detail)),
	).toContainEqual({ diagnostic: "context_window_incompatible" });
});

it("does not return stale applied status if a newer generation commits during native read", async () => {
	const f = await fixture();
	const first = await f.service.apply(await f.service.stage(f.request()));
	f.whenRead(async () => {
		await f.service.apply(await f.service.stage(f.request()));
	});
	const result = await f.service.status(first.operation.input.operationId);
	expect(result.effectiveStatus).toBe("superseded");
	expect(result.operation.status).toBe("superseded");
});

it("does not run crash recovery against an actively committing operation", async () => {
	const f = await fixture();
	f.duringCommit(async () => {
		await f.service.reconcile();
	});
	const result = await f.service.apply(await f.service.stage(f.request()));
	expect(result.operation.status).toBe("applied");
	expect(f.recoverCount()).toBe(0);
});

it("reconciles applied sessions and audits drift once without pushing over external settings", async () => {
	const f = await fixture();
	const applied = await f.service.apply(await f.service.stage(f.request()));
	const id = applied.operation.input.operationId;
	f.sessionDrift();
	await f.service.reconcile();
	await f.service.reconcile();
	expect(
		f.store
			.listLeadConfigAudit(id)
			.filter(
				(row) =>
					JSON.parse(row.detail).diagnostic === "external_session_settings",
			),
	).toHaveLength(1);
	expect(f.counts().applyCount).toBe(1);
	expect((await f.service.status(id)).effectiveStatus).toBe("drifted");
	f.restorePair();
	expect((await f.service.status(id)).effectiveStatus).toBe("drifted");
	expect(f.store.getLeadConfigOperation(id)?.status).toBe("applied");
});

it("advances applied only with a matching actual-turn observation and persists its evidence once", async () => {
	const f = await fixture();
	const result = await f.service.apply(await f.service.stage(f.request()));
	const id = result.operation.input.operationId;
	expect(result.effectiveStatus).toBe("applied");
	f.observe(id, true);
	await f.service.status(id);
	expect(f.store.getLeadConfigOperation(id)?.status).toBe("applied");
	f.observe(id);
	await f.service.reconcile();
	const observed = await f.service.status(id);
	expect(observed.effectiveStatus).toBe("observed");
	const rows = f.store
		.listLeadConfigAudit(id)
		.filter((row) => row.to_status === "observed");
	expect(rows).toHaveLength(1);
	expect(JSON.parse(rows[0].detail).observation.evidence.turnId).toBe("turn");
});

it("projects requested, historical applied, actual and observed evidence without claiming stale runtime success", async () => {
	const f = await fixture();
	expect(await f.service.viewForLead("raya-raya")).toBeUndefined();
	const applied = await f.service.apply(await f.service.stage(f.request()));
	const id = applied.operation.input.operationId;
	f.observe(id);
	const view = await f.service.viewForLead("raya-raya");
	expect(view).toMatchObject({
		operationId: id,
		effectiveStatus: "observed",
		requested: { model: "gpt-6-astra", effort: "high" },
		applied: { effort: "high" },
		observed: { turnId: "turn", effort: "high" },
		actual: { effort: "high" },
	});
	expect(view).not.toHaveProperty("input");
	f.sourceChanged();
	const unavailable = await f.service.viewForLead("raya-raya");
	expect(unavailable?.effectiveStatus).toBe("unavailable");
	expect(unavailable?.applied?.effort).toBe("high");
	expect(unavailable?.actual).toBeUndefined();
});

it("reapplies after owner rotation without a second registry commit or reusing observed evidence", async () => {
	const f = await fixture();
	const first = await f.service.apply(await f.service.stage(f.request()));
	const id = first.operation.input.operationId;
	f.observe(id);
	expect((await f.service.status(id)).effectiveStatus).toBe("observed");
	f.rotate();
	expect((await f.service.status(id)).effectiveStatus).toBe("pending_runtime");
	await f.service.reconcile();
	expect(f.counts()).toEqual({ applyCount: 2, commitCount: 1 });
	expect((await f.service.status(id)).effectiveStatus).toBe("applied");
	const view = await f.service.viewForLead("raya-raya");
	expect(view?.applied?.threadId).toBe("new-thread");
	expect(view?.observed?.turnId).toBe("turn"); // historical observation survives
	expect(
		f.store
			.listLeadConfigAudit(id)
			.filter((row) => row.to_status === "pending_runtime"),
	).toHaveLength(2);
});

it("keeps the native drift barrier visible when a rotated owner refuses automatic reapplication", async () => {
	const f = await fixture();
	const first = await f.service.apply(await f.service.stage(f.request()));
	f.rotate();
	f.driftOnApply();
	await f.service.reconcile();
	const result = await f.service.status(first.operation.input.operationId);
	expect(result.operation.status).toBe("pending_runtime");
	expect(result.effectiveStatus).toBe("drifted");
	const count = f.counts().applyCount;
	await f.service.reconcile();
	expect(f.counts().applyCount).toBe(count);
	expect(f.counts().commitCount).toBe(1);
});
