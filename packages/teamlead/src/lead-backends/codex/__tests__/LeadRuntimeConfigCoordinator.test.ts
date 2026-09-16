import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	LeadRuntimeConfigCoordinator,
	type LeadRuntimeConfigTarget,
} from "../LeadRuntimeConfigCoordinator.js";

function fixture(
	beforeUpdate?: (target: LeadRuntimeConfigTarget) => Promise<void>,
) {
	const process = new EventEmitter();
	let pair = { model: "gpt-6-astra", effort: "low" };
	const updateThreadSettings = vi.fn(async () => {});
	const readThreadSettings = vi.fn(async () => ({ ...pair }));
	let authority: LeadRuntimeConfigTarget = {
		projectName: "raya",
		leadKey: "raya-raya",
		identityDigest: "identity",
		carrierId: "carrier",
		ownerEpoch: "owner-1",
		runtimeGeneration: "runtime-1",
		threadId: "thread",
		operationId: "op-1",
		configDigest: "config-1",
		configGeneration: 1,
		modelRegistryRevision: "registry-1",
		model: "gpt-6-astra",
		effort: "high",
	};
	const persist = vi.fn();
	const coordinator = new LeadRuntimeConfigCoordinator({
		process: Object.assign(process, {
			updateThreadSettings,
			readThreadSettings,
		}),
		readAuthority: () => authority,
		persistReceipt: persist,
		beforeUpdate,
		applyTimeoutMs: 20,
	});
	const notify = (
		settings = { model: "gpt-6-astra", effort: "high" },
		threadId = "thread",
	) => {
		pair = { ...settings };
		process.emit("notification", "thread/settings/updated", {
			threadId,
			threadSettings: settings,
		});
	};
	return {
		coordinator,
		updateThreadSettings,
		readThreadSettings,
		persist,
		notify,
		target: authority,
		setPair: (next: { model: string; effort: string }) => {
			pair = { ...next };
		},
		setAuthority: (next: LeadRuntimeConfigTarget) => {
			authority = next;
		},
	};
}
describe("Lead runtime settings application", () => {
	it("refuses incompatible context before native mutation or applied receipt", async () => {
		const f = fixture(async () => {
			throw new Error("context_window_incompatible");
		});
		await expect(f.coordinator.apply(f.target)).rejects.toThrow(
			"context_window_incompatible",
		);
		expect(f.updateThreadSettings).not.toHaveBeenCalled();
		expect(f.persist).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it("rechecks the generation after asynchronous model context admission", async () => {
		const f = fixture(async () => {
			f.setAuthority({ ...f.target, ownerEpoch: "new-owner" });
		});
		await expect(f.coordinator.apply(f.target)).rejects.toThrow(
			"runtime_config_authority_changed",
		);
		expect(f.updateThreadSettings).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it.each(["ownerEpoch", "runtimeGeneration", "projectName"] as const)(
		"rejects stale %s before touching the process",
		async (field) => {
			const f = fixture();
			f.setAuthority({ ...f.target, [field]: "replacement" });
			await expect(f.coordinator.apply(f.target)).rejects.toThrow(
				"runtime_config_authority_changed",
			);
			expect(f.updateThreadSettings).not.toHaveBeenCalled();
			f.coordinator.close();
		},
	);
	it("does not call an earlier match current after another settings change before ACK", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
			f.notify({ model: "gpt-6-astra", effort: "low" });
		});
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "drifted",
		});
		expect(f.persist).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it("retains the single-flight lock while a timed-out RPC is still pending", async () => {
		const f = fixture();
		let finish!: () => void;
		f.updateThreadSettings.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "pending_runtime",
		});
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "pending_runtime",
		});
		expect(f.updateThreadSettings).toHaveBeenCalledTimes(1);
		finish();
		f.coordinator.close();
	});
	it("reuses same-generation receipt only with fresh readback", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
		});
		const first = await f.coordinator.apply(f.target);
		expect(await f.coordinator.apply(f.target)).toEqual(first);
		expect(f.updateThreadSettings).toHaveBeenCalledTimes(1);
		expect(f.persist).toHaveBeenCalledTimes(1);
		f.coordinator.close();
	});
	it("records an already-matching native readback as applied without waiting for a notification", async () => {
		const f = fixture();
		f.setPair({ model: f.target.model, effort: f.target.effort });
		const result = await f.coordinator.apply(f.target);
		expect(result).toMatchObject({
			status: "applied",
			operationId: "op-1",
			readback: {
				source: "native_readback",
				model: f.target.model,
				effort: f.target.effort,
			},
		});
		expect(f.updateThreadSettings).not.toHaveBeenCalled();
		expect(f.persist).toHaveBeenCalledWith(result);
		f.coordinator.close();
	});
	it("falls back to the notification update when native readback is unavailable", async () => {
		const f = fixture();
		f.readThreadSettings.mockRejectedValueOnce(new Error("read unavailable"));
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
		});
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "applied",
			operationId: "op-1",
		});
		expect(f.updateThreadSettings).toHaveBeenCalledTimes(1);
		f.coordinator.close();
	});
	it("does not turn an empty RPC acknowledgement into applied", async () => {
		const f = fixture();
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "pending_runtime",
		});
		expect(f.persist).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it("accepts a matching notification arriving before the RPC response", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
		});
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "applied",
			threadId: "thread",
			configGeneration: 1,
		});
		expect(f.persist).toHaveBeenCalledTimes(1);
		f.coordinator.close();
	});
	it("never persists applied when the RPC failed despite a matching notification", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
			throw new Error("rpc_failed");
		});
		await expect(f.coordinator.apply(f.target)).rejects.toThrow("rpc_failed");
		expect(f.persist).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it("ignores wrong-thread and incomplete notifications", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify(undefined, "other");
			f.notify({ model: "gpt-6-astra", effort: "" });
		});
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "pending_runtime",
		});
		expect(f.persist).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it("rejects carrier rotation during an update", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
			f.setAuthority({ ...f.target, carrierId: "replacement" });
		});
		await expect(f.coordinator.apply(f.target)).rejects.toThrow(
			"runtime_config_authority_changed",
		);
		expect(f.persist).not.toHaveBeenCalled();
		f.coordinator.close();
	});
	it("preserves external session changes until a new explicit generation", async () => {
		const f = fixture();
		f.updateThreadSettings.mockImplementation(async () => {
			f.notify();
		});
		await f.coordinator.apply(f.target);
		f.notify({ model: "gpt-6-astra", effort: "low" });
		expect(await f.coordinator.apply(f.target)).toMatchObject({
			status: "drifted",
		});
		expect(f.updateThreadSettings).toHaveBeenCalledTimes(1);
		const next = { ...f.target, operationId: "op-2", configGeneration: 2 };
		f.setAuthority(next);
		expect(await f.coordinator.apply(next)).toMatchObject({
			status: "applied",
			configGeneration: 2,
		});
		f.coordinator.close();
	});
});
