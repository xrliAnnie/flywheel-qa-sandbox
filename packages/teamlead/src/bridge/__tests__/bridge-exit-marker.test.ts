/**
 * FLY-1082 (Task 2.4): the dirty-exit marker lifecycle — latch before
 * overwrite, clean flip on close, and the two legs' distinct dedup ids over
 * one shared episode signature.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	abnormalExitEpisodeSignature,
	abnormalExitTicketEventId,
	bridgeMarkerPath,
	latchPreviousMarker,
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
});
