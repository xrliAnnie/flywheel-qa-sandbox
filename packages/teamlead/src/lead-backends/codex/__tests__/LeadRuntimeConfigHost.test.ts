import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LeadRuntimeConfigTarget } from "../LeadRuntimeConfigCoordinator.js";
import {
	admitLeadTurn,
	LeadRuntimeConfigHost,
} from "../LeadRuntimeConfigHost.js";

const roots: string[] = [];
const hosts: LeadRuntimeConfigHost[] = [];
afterEach(() => {
	for (const h of hosts.splice(0)) h.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(
	hooks: {
		beforeUpdate?: (target: LeadRuntimeConfigTarget) => Promise<void>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "runtime-config-host-"));
	roots.push(root);
	const target: LeadRuntimeConfigTarget = {
		projectName: "raya",
		leadKey: "raya-raya",
		identityDigest: "identity",
		carrierId: "carrier",
		ownerEpoch: "owner",
		runtimeGeneration: "runtime",
		threadId: "thread",
		operationId: "op1",
		configDigest: "digest",
		configGeneration: 1,
		modelRegistryRevision: "registry",
		model: "gpt-6-astra",
		effort: "high",
	};
	let source = {
		model: target.model,
		reasoningEffort: target.effort,
		configDigest: target.configDigest,
		modelRegistryRevision: target.modelRegistryRevision,
	};
	let current = true;
	let pair = { model: target.model, effort: "low" };
	const admissionFailures: string[] = [];
	const proc = Object.assign(new EventEmitter(), {
		updateThreadSettings: vi.fn(
			async (value: { threadId: string; model: string; effort: string }) => {
				pair = { model: value.model, effort: value.effort };
				proc.emit("notification", "thread/settings/updated", {
					threadId: value.threadId,
					threadSettings: { ...pair },
				});
			},
		),
		readThreadSettings: vi.fn(async () => ({ ...pair })),
	});
	const path = join(root, "runtime-config.json");
	const make = () => {
		const h = new LeadRuntimeConfigHost({
			process: proc,
			beforeUpdate: hooks.beforeUpdate,
			statePath: path,
			identity: () => ({
				...target,
				artifactBuildSha: "a".repeat(40),
				bootstrapBuildSha: "a".repeat(40),
			}),
			isCurrentOwner: () => current,
			readSource: () => source,
			onAdmissionFailure: (code) => admissionFailures.push(code),
		});
		hosts.push(h);
		return h;
	};
	return {
		target,
		proc,
		path,
		make,
		setSource: (s: typeof source) => {
			source = s;
		},
		source,
		setCurrent: (v: boolean) => {
			current = v;
		},
		admissionFailures,
	};
}
it("durably records native application and recovers same-owner idempotency", async () => {
	const f = fixture();
	const h = f.make();
	expect(await h.apply(f.target)).toMatchObject({ status: "applied" });
	expect(JSON.parse(readFileSync(f.path, "utf8")).receipt).toMatchObject({
		operationId: "op1",
		status: "applied",
	});
	h.close();
	expect(await f.make().apply(f.target)).toMatchObject({ status: "applied" });
	expect(f.proc.updateThreadSettings).toHaveBeenCalledTimes(1);
});
it("rejects source and owner mismatches before native mutation", async () => {
	const f = fixture();
	const h = f.make();
	f.setSource({ ...f.source, configDigest: "changed" });
	await expect(h.apply(f.target)).rejects.toThrow(
		"runtime_config_source_changed",
	);
	f.setSource(f.source);
	f.setCurrent(false);
	await expect(h.apply(f.target)).rejects.toThrow(
		"runtime_config_owner_changed",
	);
	expect(f.proc.updateThreadSettings).not.toHaveBeenCalled();
});
it("rejects a late lower generation even when its model/effort matches", async () => {
	const f = fixture();
	const h = f.make();
	await h.apply({ ...f.target, configGeneration: 2, operationId: "op2" });
	await expect(h.apply(f.target)).rejects.toThrow(
		"runtime_config_generation_stale",
	);
	expect(f.proc.updateThreadSettings).toHaveBeenCalledTimes(1);
});
it("does not overwrite external settings on a replay or after host reconstruction", async () => {
	const f = fixture();
	const h = f.make();
	await h.apply(f.target);
	f.proc.emit("notification", "thread/settings/updated", {
		threadId: "thread",
		threadSettings: { model: "gpt-6-astra", effort: "low" },
	});
	expect(await h.apply(f.target)).toMatchObject({ status: "drifted" });
	h.close();
	expect(await f.make().apply(f.target)).toMatchObject({ status: "drifted" });
	expect(f.proc.updateThreadSettings).toHaveBeenCalledTimes(1);
});
it("revalidates registry evidence after a native ACK and never persists stale applied", async () => {
	const f = fixture();
	const h = f.make();
	f.proc.updateThreadSettings.mockImplementation(async () => {
		f.proc.emit("notification", "thread/settings/updated", {
			threadId: "thread",
			threadSettings: { model: f.target.model, effort: f.target.effort },
		});
		f.setSource({ ...f.source, configDigest: "replaced" });
	});
	await expect(h.apply(f.target)).rejects.toThrow(
		"runtime_config_source_changed",
	);
	expect(JSON.parse(readFileSync(f.path, "utf8")).receipt).toBeUndefined();
});
it("pins verified applied tuning at turn admission but leaves external settings untouched", async () => {
	const f = fixture();
	const h = f.make();
	expect(await h.beforeTurn()).toBeUndefined();
	await h.apply(f.target);
	const admitted = await h.beforeTurn();
	expect(admitted).toMatchObject({ model: "gpt-6-astra", effort: "high" });
	admitted!.assertCurrent!();
	f.proc.emit("notification", "thread/settings/updated", {
		threadId: "thread",
		threadSettings: { model: "gpt-6-astra", effort: "low" },
	});
	expect(admitted!.assertCurrent!()).toBe(false);
	expect(f.admissionFailures).toContain("runtime_config_admission_changed");
	expect(await h.beforeTurn()).not.toHaveProperty("model");
	expect(await h.read(f.target)).toMatchObject({
		model: "gpt-6-astra",
		effort: "high",
		drifted: true,
	});
	expect(f.proc.updateThreadSettings).toHaveBeenCalledTimes(1);
	f.setSource({ ...f.source, configDigest: "new desired" });
	expect(await h.beforeTurn()).not.toHaveProperty("model");
	expect(f.admissionFailures).toContain("runtime_config_source_changed");
});
it("keeps turns live when an admitted update cannot pass runtime validation", async () => {
	const f = fixture({
		beforeUpdate: async () => {
			throw new Error("context_window_incompatible");
		},
	});
	const h = f.make();
	await expect(h.apply(f.target)).rejects.toThrow(
		"context_window_incompatible",
	);
	expect(await h.beforeTurn()).toEqual({});
	expect(f.admissionFailures).toContain("context_window_incompatible");
});
it("drops a stale override when the final admission guard cannot revalidate", () => {
	expect(
		admitLeadTurn(
			{ prompt: "continue", model: "startup-model", effort: "low" },
			{
				model: "gpt-6-astra",
				effort: "high",
				assertCurrent: () => false,
			},
		),
	).toEqual({ prompt: "continue" });
});
it("binds observed evidence to applied generation, rejecting older turns and stale sources", async () => {
	const f = fixture();
	const h = f.make();
	expect(h.observationTarget()).toBeUndefined();
	await h.apply(f.target);
	const target = h.observationTarget()!;
	const receipt = JSON.parse(readFileSync(f.path, "utf8")).receipt;
	const evidence = {
		threadId: "thread",
		turnId: "turn",
		model: target.model,
		effort: target.effort,
		source: "rollout_turn_context" as const,
		recordedAt: receipt.appliedAt,
		recordDigest: "a".repeat(64),
	};
	h.recordObservation(target, {
		...evidence,
		recordedAt: "2000-01-01T00:00:00Z",
	});
	expect((await h.read(target)).observation).toBeUndefined();
	h.recordObservation(target, evidence);
	expect((await h.read(target)).observation).toMatchObject({
		target,
		source: "registry_hot",
		evidence,
	});
	f.proc.emit("notification", "thread/settings/updated", {
		threadId: "thread",
		threadSettings: { model: target.model, effort: "low" },
	});
	h.recordObservation(target, {
		...evidence,
		turnId: "external",
		effort: "low",
	});
	expect((await h.read(target)).observation).toMatchObject({
		source: "external_session_settings",
		evidence: { effort: "low" },
	});
	f.setSource({ ...f.source, configDigest: "new" });
	expect(() => h.recordObservation(target, evidence)).toThrow(
		"runtime_config_source_changed",
	);
});
