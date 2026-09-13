import { expect, it } from "vitest";
import {
	executeBackendMigration,
	MIGRATION_STEPS,
	MigrationActivationPreflightError,
	type MigrationExecutionReceipt,
	type MigrationExecutorDeps,
} from "../lead-backend-migration-executor.js";

function fixture() {
	let receipt: MigrationExecutionReceipt | null = null;
	const events: string[] = [];
	const applied = new Set<string>();
	const deps: MigrationExecutorDeps = {
		captureSourceCarrier: async () => ({ pid: 42, start: "source-start" }),
		verifyWindow: async () => {
			events.push("window");
		},
		load: () => receipt,
		save: (next) => {
			events.push(`save:${next.pending ?? next.status}`);
			receipt = structuredClone(next);
		},
		observe: async (step) => {
			events.push(`observe:${step}`);
			return {
				state: applied.has(step) ? "post" : "pre",
				proofSha: "a".repeat(64),
			};
		},
		apply: async (step) => {
			events.push(`apply:${step}`);
			applied.add(step);
		},
	};
	return { deps, events, applied, receipt: () => receipt };
}
it("writes each step intent before effects and returns at deployed_unverified", async () => {
	const f = fixture();
	const result = await executeBackendMigration("b".repeat(64), f.deps);
	expect(result.status).toBe("deployed_unverified");
	for (const step of MIGRATION_STEPS)
		expect(f.events.indexOf(`save:${step}`)).toBeLessThan(
			f.events.indexOf(`apply:${step}`),
		);
	expect(f.events.filter((x) => x.startsWith("apply:"))).toEqual(
		MIGRATION_STEPS.map((x) => `apply:${x}`),
	);
});
it("persists the source carrier before stop and retains it across interrupted stop", async () => {
	const f = fixture();
	const apply = f.deps.apply;
	f.deps.apply = async (step) => {
		if (step === "stop") {
			expect(f.receipt()?.sourceCarrier).toEqual({
				pid: 42,
				start: "source-start",
			});
			throw new Error("stop interrupted");
		}
		await apply(step);
	};
	await expect(executeBackendMigration("b".repeat(64), f.deps)).rejects.toThrow(
		"stop interrupted",
	);
	f.deps.captureSourceCarrier = async () => {
		throw new Error("must not recapture another owner");
	};
	f.deps.apply = apply;
	expect(
		(await executeBackendMigration("b".repeat(64), f.deps)).sourceCarrier,
	).toEqual({ pid: 42, start: "source-start" });
});
it("denied window performs no receipt or control-plane write", async () => {
	const f = fixture();
	f.deps.verifyWindow = async () => {
		throw new Error("R4 unavailable");
	};
	await expect(executeBackendMigration("b".repeat(64), f.deps)).rejects.toThrow(
		"R4",
	);
	expect(f.events).toEqual([]);
	expect(f.receipt()).toBeNull();
});
it.each(MIGRATION_STEPS)(
	"recovers a lost %s completion receipt from actual postimage",
	async (crashStep) => {
		const f = fixture();
		const apply = f.deps.apply;
		f.deps.apply = async (step) => {
			await apply(step);
			if (step === crashStep) throw new Error("process interrupted");
		};
		await expect(
			executeBackendMigration("b".repeat(64), f.deps),
		).rejects.toThrow();
		expect(f.receipt()?.status).toBe("held");
		f.deps.apply = apply;
		const result = await executeBackendMigration("b".repeat(64), f.deps);
		expect(result.status).toBe("deployed_unverified");
		expect(f.events.filter((x) => x === `apply:${crashStep}`)).toHaveLength(1);
	},
);
it("unknown artifacts hold before another effect, without automatic rollback", async () => {
	const f = fixture();
	const observe = f.deps.observe;
	f.deps.observe = async (step) =>
		step === "configure"
			? { state: "conflict", proofSha: "c".repeat(64) }
			: observe(step);
	await expect(executeBackendMigration("b".repeat(64), f.deps)).rejects.toThrow(
		"conflict",
	);
	expect(f.receipt()?.status).toBe("held");
	expect(f.applied.has("configure")).toBe(false);
	expect(f.applied.has("activate")).toBe(false);
});
it("rechecks completed deployment without repeating effects", async () => {
	const f = fixture();
	await executeBackendMigration("b".repeat(64), f.deps);
	f.events.length = 0;
	await executeBackendMigration("b".repeat(64), f.deps);
	expect(f.events.filter((x) => x.startsWith("apply:"))).toEqual([]);
	expect(f.events.filter((x) => x.startsWith("observe:"))).toHaveLength(
		MIGRATION_STEPS.length,
	);
});
it("a receipt cannot authorize replay for a different intent", async () => {
	const f = fixture();
	await executeBackendMigration("b".repeat(64), f.deps);
	f.events.length = 0;
	await expect(executeBackendMigration("c".repeat(64), f.deps)).rejects.toThrow(
		"intent",
	);
	expect(f.events.filter((x) => x.startsWith("apply:"))).toEqual([]);
});

it("durably requests source restoration when activation preflight fails", async () => {
	const f = fixture();
	const apply = f.deps.apply;
	f.deps.apply = async (step) => {
		if (step === "activate") throw new MigrationActivationPreflightError();
		await apply(step);
	};
	f.deps.restoreSource = async () => {
		expect(f.receipt()?.recovery?.state).toBe("pending");
		f.events.push("restore");
		return "d".repeat(64);
	};
	const result = await executeBackendMigration("b".repeat(64), f.deps);
	expect(result.status).toBe("failed");
	expect(result.recovery).toEqual({
		reason: "activation_preflight_failed",
		state: "restored",
		proofSha: "d".repeat(64),
	});
	expect(f.applied.has("activate")).toBe(false);
	expect(f.events.filter((x) => x === "restore")).toHaveLength(1);
});
it("retries interrupted restoration before any forward migration effect", async () => {
	const f = fixture();
	const apply = f.deps.apply;
	f.deps.apply = async (step) => {
		if (step === "activate") throw new MigrationActivationPreflightError();
		await apply(step);
	};
	f.deps.restoreSource = async () => {
		throw new Error("restore interrupted");
	};
	await expect(executeBackendMigration("b".repeat(64), f.deps)).rejects.toThrow(
		"restore interrupted",
	);
	expect(f.receipt()?.recovery?.state).toBe("pending");
	f.events.length = 0;
	f.deps.restoreSource = async () => "d".repeat(64);
	expect((await executeBackendMigration("b".repeat(64), f.deps)).status).toBe(
		"failed",
	);
	expect(f.events.filter((x) => x.startsWith("apply:"))).toEqual([]);
});
it("does not use automatic restoration for arbitrary activation failures", async () => {
	const f = fixture();
	const apply = f.deps.apply;
	let restored = false;
	f.deps.apply = async (step) => {
		if (step === "activate") throw new Error("spawn failure");
		await apply(step);
	};
	f.deps.restoreSource = async () => {
		restored = true;
		return "d".repeat(64);
	};
	await expect(executeBackendMigration("b".repeat(64), f.deps)).rejects.toThrow(
		"spawn failure",
	);
	expect(restored).toBe(false);
});
