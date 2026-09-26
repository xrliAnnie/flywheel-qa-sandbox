import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { createCodexQuotaMaintenance } from "../maintenance.js";

function store() {
	return {
		codexQuota: {
			backfillHistoricalQuotaFailures: vi.fn(),
			listIncidents: vi.fn(() => []),
			handoffIncidentManual: vi.fn(),
		},
	} as unknown as StateStore;
}
const automatic = async () => ({
	mode: "automatic" as const,
	reasons: [],
	revision: 1,
	checkedAt: "2026-09-25T00:00:00.000Z",
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("FLY-2869 — canonical reconciliation without the auto-switch runtime", () => {
	it("reconciles once per tick only while the runtime is absent", async () => {
		const reconcileCanonical = vi.fn(async () => {});
		const tick = vi.fn(async () => {});
		const holder: { runtime?: { tick(): Promise<void> } } = {};
		const maintenance = createCodexQuotaMaintenance({
			store: store(),
			refreshAvailability: automatic,
			runtime: () => holder.runtime,
			flushOutbox: async () => {},
			projectAudit: async () => {},
			reconcileCanonical,
		});
		await maintenance.tick();
		await maintenance.tick();
		expect(reconcileCanonical).toHaveBeenCalledTimes(2);
		holder.runtime = { tick };
		await maintenance.tick();
		expect(reconcileCanonical).toHaveBeenCalledTimes(2);
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it("isolates a failing reconciliation: flush and audit still run and the next tick retries", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const reconcileCanonical = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("quota_installation_pending"))
			.mockResolvedValue(undefined);
		const flushOutbox = vi.fn(async () => {});
		const projectAudit = vi.fn(async () => {});
		const maintenance = createCodexQuotaMaintenance({
			store: store(),
			refreshAvailability: automatic,
			runtime: () => undefined,
			flushOutbox,
			projectAudit,
			reconcileCanonical,
		});
		await expect(maintenance.tick()).resolves.toBeUndefined();
		expect(flushOutbox).toHaveBeenCalledTimes(1);
		expect(projectAudit).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[Bridge] Codex canonical reconciliation failed",
			"quota_installation_pending",
		);
		await maintenance.tick();
		expect(reconcileCanonical).toHaveBeenCalledTimes(2);
	});

	it("still reconciles when the availability refresh itself fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const reconcileCanonical = vi.fn(async () => {});
		const flushOutbox = vi.fn(async () => {});
		const maintenance = createCodexQuotaMaintenance({
			store: store(),
			refreshAvailability: async () => {
				throw new Error("collector down");
			},
			runtime: () => undefined,
			flushOutbox,
			projectAudit: async () => {},
			reconcileCanonical,
		});
		await expect(maintenance.tick()).rejects.toThrow("collector down");
		expect(reconcileCanonical).toHaveBeenCalledTimes(1);
		expect(flushOutbox).toHaveBeenCalledTimes(1);
	});
});
