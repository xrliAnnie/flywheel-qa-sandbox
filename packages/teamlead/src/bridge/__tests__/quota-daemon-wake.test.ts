import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createQuotaDaemonWaker,
	shouldWakeQuotaDaemon,
} from "../quota-daemon-wake.js";

const UID = process.getuid?.() ?? 0;
let dir: string;
let pidfile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1252-wake-"));
	pidfile = join(dir, "quota-monitor.pid");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(overrides: Record<string, unknown> = {}): void {
	writeFileSync(
		pidfile,
		JSON.stringify({
			pid: 123,
			uid: UID,
			processStartTime: "Mon Jul 14 12:00:00 2026",
			wakeProtocol: 1,
			...overrides,
		}),
		{ mode: 0o600 },
	);
}

describe("quota daemon wake capability", () => {
	it("signals only a capability-advertising pid with matching uid and process start", () => {
		record();
		const kill = vi.fn();
		const wake = createQuotaDaemonWaker({
			pidfilePath: pidfile,
			uid: UID,
			readProcessStartTime: () => "Mon Jul 14 12:00:00 2026",
			kill,
			now: () => 100_000,
		});

		expect(wake()).toBe("signaled");
		expect(kill).toHaveBeenCalledWith(123, "SIGUSR1");
		expect(wake()).toBe("throttled");
		expect(kill).toHaveBeenCalledTimes(1);
	});

	it("never signals old daemons without wakeProtocol", () => {
		record({ wakeProtocol: undefined });
		const raw = JSON.stringify({
			pid: 123,
			uid: UID,
			processStartTime: "Mon Jul 14 12:00:00 2026",
		});
		writeFileSync(pidfile, raw, { mode: 0o600 });
		const kill = vi.fn();
		const wake = createQuotaDaemonWaker({
			pidfilePath: pidfile,
			uid: UID,
			readProcessStartTime: () => "Mon Jul 14 12:00:00 2026",
			kill,
		});

		expect(wake()).toBe("unsupported");
		expect(kill).not.toHaveBeenCalled();
	});

	it("noops on identity mismatch", () => {
		record();
		const kill = vi.fn();
		const mismatch = createQuotaDaemonWaker({
			pidfilePath: pidfile,
			uid: UID,
			readProcessStartTime: () => "different",
			kill,
		});
		expect(mismatch()).toBe("identity_mismatch");
		expect(kill).not.toHaveBeenCalled();
	});

	it("recognizes both usage-limit alert trigger shapes", () => {
		expect(shouldWakeQuotaDaemon({ eventType: "usage_limit" })).toBe(true);
		expect(
			shouldWakeQuotaDaemon({
				eventType: "runner_stuck",
				metadata: { accountLimit: {} },
			}),
		).toBe(true);
		expect(shouldWakeQuotaDaemon({ eventType: "runner_stuck" })).toBe(false);
	});
});
