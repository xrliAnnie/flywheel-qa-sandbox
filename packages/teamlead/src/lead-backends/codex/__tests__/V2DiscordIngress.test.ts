import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { V2DiscordIngress } from "../V2DiscordIngress.js";

describe("v2 Discord ingress", () => {
	it("writes the canonical Discord key only through flywheel-v2 enqueue", () => {
		const run = vi.fn(() => ({
			pid: 1,
			output: [null, '{"status":"enqueued","messageUid":"mail-1"}\n', ""],
			stdout: '{"status":"enqueued","messageUid":"mail-1"}\n',
			stderr: "",
			status: 0,
			signal: null,
		})) as unknown as typeof import("node:child_process").spawnSync;
		const ingress = new V2DiscordIngress({
			v2CliBin: "/opt/flywheel-v2",
			socketPath: "/tmp/v2/host.sock",
			secretPath: "/tmp/v2/host.secret",
			leadId: "v2-tadashi",
			run,
		});

		expect(
			ingress.submit({
				idempotencyKey: "1234567890",
				source: "discord",
				payload: "founder request",
			}),
		).toEqual({ accepted: true, entryId: "mail-1" });
		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0]?.[1]).toEqual([
			"enqueue",
			"--socket",
			"/tmp/v2/host.sock",
			"--secret",
			"/tmp/v2/host.secret",
			"--source-kind",
			"discord",
			"--source-id",
			"1234567890",
			"--payload",
			"founder request",
			"--to-agent",
			"v2-tadashi",
			"--kind",
			"instruction",
			"--retention",
			"business",
		]);
	});

	it("fails closed on host rejection and treats canonical replay as accepted", () => {
		const rejected = new V2DiscordIngress({
			v2CliBin: "flywheel-v2",
			socketPath: "/tmp/v2/host.sock",
			secretPath: "/tmp/v2/host.secret",
			leadId: "v2-tadashi",
			run: (() =>
				({
					status: 1,
					signal: null,
					stdout: "",
					stderr: "FenceViolation: held",
				}) as SpawnSyncReturns<string>) as typeof import("node:child_process").spawnSync,
		});
		expect(() =>
			rejected.submit({
				idempotencyKey: "1",
				source: "discord",
				payload: "held",
			}),
		).toThrow(/held/);

		const replay = new V2DiscordIngress({
			v2CliBin: "flywheel-v2",
			socketPath: "/tmp/v2/host.sock",
			secretPath: "/tmp/v2/host.secret",
			leadId: "v2-tadashi",
			run: (() =>
				({
					status: 0,
					signal: null,
					stdout: '{"status":"duplicate","messageUid":"mail-existing"}\n',
					stderr: "",
				}) as SpawnSyncReturns<string>) as typeof import("node:child_process").spawnSync,
		});
		expect(
			replay.submit({
				idempotencyKey: "1",
				source: "discord",
				payload: "same",
			}),
		).toEqual({ accepted: false, entryId: "mail-existing" });
	});
});
