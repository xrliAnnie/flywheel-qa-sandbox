import { describe, expect, it, vi } from "vitest";
import {
	notifyModelFamilyUpdated,
	runFableModelSyncCli,
} from "../account-heal/fable-model-sync-cli.js";

describe("Fable model sync CLI", () => {
	it("states that future base-model resume waits for corroborated context metadata", () => {
		const execFile = vi.fn();
		notifyModelFamilyUpdated(
			{
				previousCanonical: "claude-fable-5-1",
				canonical: "claude-fable-5-2",
				source: "anthropic_models_api",
			},
			{ alertBin: "/fixture/lead-alert", execFile: execFile as never },
		);

		const args = execFile.mock.calls[0]?.[1] as string[];
		const body = args[args.indexOf("--body") + 1];
		expect(body).toMatch(/resume.*park/i);
		expect(body).toMatch(/contextWindowTokens.*corroborat/i);
	});

	it("emits one informational alert only after canonical authority advances", async () => {
		const notify = vi.fn();
		const log = vi.fn();

		const exitCode = await runFableModelSyncCli({
			sync: async () => ({
				status: "updated",
				previousCanonical: "claude-fable-5-1",
				canonical: "claude-fable-5-2",
			}),
			notify,
			log,
		});

		expect(exitCode).toBe(0);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith({
			previousCanonical: "claude-fable-5-1",
			canonical: "claude-fable-5-2",
			source: "anthropic_models_api",
		});
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({
				status: "updated",
				previousCanonical: "claude-fable-5-1",
				canonical: "claude-fable-5-2",
			}),
		);
	});

	it("keeps probe and notification failures non-fatal to the updater cycle", async () => {
		const notify = vi.fn(() => {
			throw new Error("transport included a secret that must not be echoed");
		});
		const warn = vi.fn();

		expect(
			await runFableModelSyncCli({
				sync: async () => ({
					status: "updated",
					previousCanonical: "claude-fable-5-1",
					canonical: "claude-fable-5-2",
				}),
				notify,
				warn,
				log: vi.fn(),
			}),
		).toBe(0);
		expect(warn).toHaveBeenCalledWith(
			"[fable-model-sync] authority updated but notification failed",
		);

		notify.mockClear();
		expect(
			await runFableModelSyncCli({
				sync: async () => {
					throw new Error("credential secret");
				},
				notify,
				warn,
				log: vi.fn(),
			}),
		).toBe(0);
		expect(notify).not.toHaveBeenCalled();
		expect(warn).toHaveBeenLastCalledWith(
			"[fable-model-sync] probe failed; retained current authority",
		);
	});

	it("does not notify for normalized, unchanged, or retained authority", async () => {
		for (const status of ["normalized", "unchanged", "retained"] as const) {
			const notify = vi.fn();
			await runFableModelSyncCli({
				sync: async () => ({ status }),
				notify,
				log: vi.fn(),
			});
			expect(notify).not.toHaveBeenCalled();
		}
	});

	it("warns when unsafe authority bytes make every scheduled update ineligible", async () => {
		const warn = vi.fn();
		await runFableModelSyncCli({
			sync: async () => ({
				status: "retained",
				reason: "unsafe_authority",
			}),
			warn,
			log: vi.fn(),
		});
		expect(warn).toHaveBeenCalledWith(
			"[fable-model-sync] authority retained: unsafe_authority",
		);
	});

	it.each(["write_failed", "verification_failed", "unsupported_1m"] as const)(
		"warns when a scheduled update is retained because of %s",
		async (reason) => {
			const warn = vi.fn();
			await runFableModelSyncCli({
				sync: async () => ({ status: "retained", reason }),
				warn,
				log: vi.fn(),
			});
			expect(warn).toHaveBeenCalledWith(
				`[fable-model-sync] authority retained: ${reason}`,
			);
		},
	);
});
