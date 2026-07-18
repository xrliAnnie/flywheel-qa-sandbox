/**
 * FLY-1082 (Task 2.4): the dirty-exit marker lifecycle — latch before
 * overwrite, clean flip on close, and the two legs' distinct dedup ids over
 * one shared episode signature.
 */
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	abnormalExitEpisodeSignature,
	abnormalExitTicketEventId,
	bridgeMarkerPath,
	buildAbnormalExitAlertContent,
	findWatchdogStallForExit,
	latchPreviousMarker,
	watchdogLogPath,
	writeCleanMarker,
	writeRunningMarker,
} from "../bridge-exit-marker.js";

describe("bridge-exit-marker (Task 2.4)", () => {
	let dir: string;
	let marker: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1082-marker-"));
		marker = join(dir, "bridge-running-marker.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("first boot: no previous marker → latch null, running marker written", () => {
		expect(latchPreviousMarker(marker)).toBeNull();
		writeRunningMarker(marker, 111, 1000);
		expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
			pid: 111,
			bootTs: 1000,
			state: "running",
		});
	});

	it("clean shutdown → next boot latches a CLEAN marker (no dirty signal)", () => {
		writeRunningMarker(marker, 111, 1000);
		writeCleanMarker(marker);
		const prev = latchPreviousMarker(marker);
		expect(prev).toEqual({ pid: 111, bootTs: 1000, state: "clean" });
	});

	it("kill -9 shape: marker stays `running` → next boot latches the dirty evidence BEFORE overwriting", () => {
		writeRunningMarker(marker, 111, 1000);
		// (no clean flip — the process died)
		const prev = latchPreviousMarker(marker);
		expect(prev?.state).toBe("running");
		// New generation writes its own marker AFTER the latch.
		writeRunningMarker(marker, 222, 2000);
		expect(latchPreviousMarker(marker)).toEqual({
			pid: 222,
			bootTs: 2000,
			state: "running",
		});
		// The latched evidence still identifies the DEAD generation.
		expect(prev).toEqual({ pid: 111, bootTs: 1000, state: "running" });
	});

	it("page id and ticket id NEVER collide; both share one episode signature", () => {
		const prev = { pid: 111, bootTs: 1000, state: "running" as const };
		const episode = abnormalExitEpisodeSignature(prev);
		const ticketId = abnormalExitTicketEventId(prev);
		const pageId = `bridge-abnormal-exit-page:${prev.pid}:${prev.bootTs}`; // wrapper leg (shell)
		expect(episode).toBe("bridge-abnormal-exit:111:1000");
		expect(ticketId).toBe("bridge-abnormal-exit-ticket:111:1000");
		expect(ticketId).not.toBe(pageId);
		expect(ticketId).toContain("111:1000");
		expect(pageId).toContain("111:1000");
	});

	it("garbage marker reads as null (fail-quiet)", () => {
		writeFileSync(marker, "not json", "utf-8");
		expect(latchPreviousMarker(marker)).toBeNull();
		writeFileSync(marker, JSON.stringify({ pid: "x", state: "running" }));
		expect(latchPreviousMarker(marker)).toBeNull();
	});

	it("marker path honors the QA override env", () => {
		expect(
			bridgeMarkerPath({
				FLYWHEEL_BRIDGE_MARKER: "/tmp/qa/marker.json",
			} as unknown as NodeJS.ProcessEnv),
		).toBe("/tmp/qa/marker.json");
		expect(
			bridgeMarkerPath({
				FLYWHEEL_STATE_DIR: "/tmp/qa-state",
			} as unknown as NodeJS.ProcessEnv),
		).toBe("/tmp/qa-state/state/bridge-running-marker.json");
	});

	it("attributes a dirty exit only to an exact pid + boot generation inside its lifetime", () => {
		const log = join(dir, "watchdog.log");
		const prev = { pid: 111, bootTs: 1000, state: "running" as const };
		writeFileSync(
			log,
			`${[
				JSON.stringify({
					event: "bridge_event_loop_stall",
					pid: 999,
					bootTs: 900,
					stall_age_ms: 61_000,
					at: new Date(1500).toISOString(),
				}),
				JSON.stringify({
					event: "bridge_event_loop_stall",
					pid: 111,
					bootTs: 1000,
					stall_age_ms: 65_432,
					last_sync_op: "codex-tui:tmux-exec",
					at: new Date(1900).toISOString(),
				}),
				// A later shared/QA record must not hide the exact prior generation.
				JSON.stringify({
					event: "bridge_event_loop_stall",
					pid: 222,
					bootTs: 1950,
					stall_age_ms: 62_000,
					at: new Date(2100).toISOString(),
				}),
			].join("\n")}\n`,
		);

		const stall = findWatchdogStallForExit(log, prev, 2000);
		expect(stall).toMatchObject({
			pid: 111,
			bootTs: 1000,
			stall_age_ms: 65_432,
			last_sync_op: "codex-tui:tmux-exec",
		});
		const alert = buildAbnormalExitAlertContent(prev, stall);
		expect(alert.title).toContain("event loop");
		expect(alert.body).toContain("65432ms");
		expect(alert.body).toContain("codex-tui:tmux-exec");
	});

	it.each([
		["pid mismatch", { pid: 112, bootTs: 1000, at: 1500 }],
		["generation mismatch", { pid: 111, bootTs: 999, at: 1500 }],
		["before prior boot", { pid: 111, bootTs: 1000, at: 999 }],
		["at current boot", { pid: 111, bootTs: 1000, at: 2000 }],
	])("rejects watchdog attribution on %s", (_name, sample) => {
		const log = join(dir, "watchdog.log");
		const prev = { pid: 111, bootTs: 1000, state: "running" as const };
		writeFileSync(
			log,
			`${JSON.stringify({
				event: "bridge_event_loop_stall",
				pid: sample.pid,
				bootTs: sample.bootTs,
				stall_age_ms: 61_000,
				at: new Date(sample.at).toISOString(),
			})}\n`,
		);
		expect(findWatchdogStallForExit(log, prev, 2000)).toBeNull();
		expect(buildAbnormalExitAlertContent(prev, null).title).toBe(
			"Bridge 非正常退出 — 复活对账中",
		);
	});

	it("defensively rejects malformed, symlinked, FIFO, and oversized watchdog logs", () => {
		const prev = { pid: 111, bootTs: 1000, state: "running" as const };
		const log = join(dir, "watchdog.log");
		writeFileSync(log, "not json\n");
		expect(findWatchdogStallForExit(log, prev, 2000)).toBeNull();

		const target = join(dir, "target.log");
		writeFileSync(target, "{}\n");
		rmSync(log, { force: true });
		symlinkSync(target, log);
		expect(findWatchdogStallForExit(log, prev, 2000)).toBeNull();

		rmSync(log, { force: true });
		execFileSync("mkfifo", [log]);
		expect(findWatchdogStallForExit(log, prev, 2000)).toBeNull();

		rmSync(log, { force: true });
		writeFileSync(log, "x".repeat(256 * 1024 + 1));
		expect(findWatchdogStallForExit(log, prev, 2000)).toBeNull();
	});

	it("watchdog log path honors QA isolation", () => {
		expect(
			watchdogLogPath({
				FLYWHEEL_BRIDGE_WATCHDOG_LOG: "/tmp/qa/watchdog.log",
			} as unknown as NodeJS.ProcessEnv),
		).toBe("/tmp/qa/watchdog.log");
	});
});
