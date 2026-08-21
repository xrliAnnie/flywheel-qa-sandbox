import { describe, expect, it, vi } from "vitest";
import {
	CmuxWatcherPatrol,
	type CmuxWatcherSnapshot,
	classifyCmuxWatcher,
	parseCmuxWatcherOwner,
} from "../cmux-watcher-patrol.js";

const NOW = 2_000_000;
const OWNER = {
	pid: 42,
	incarnation: "Thu Aug 20 10:00:00 2026",
	nonce: "nonce-a",
	startedAtMs: 1_900_000,
	tuple: "42|Thu Aug 20 10:00:00 2026|watch|nonce-a",
};

function snapshot(
	overrides: Partial<CmuxWatcherSnapshot> = {},
): CmuxWatcherSnapshot {
	return {
		nowMs: NOW,
		rolloutAnchorMs: 1_800_000,
		job: { ok: true, identity: "gui/501/com.flywheel.cmux-watcher" },
		ownerState: "valid",
		owner: OWNER,
		heartbeat: { ageMs: 10_000, key: "hb:1" },
		event: null,
		park: null,
		ownerlessAgeMs: 0,
		jobAbsentAgeMs: 0,
		eventBacklogAgeMs: 0,
		...overrides,
	};
}

describe("FLY-1944 cmux watcher judgement matrix", () => {
	it.each([
		{
			name: "job absent outranks stale owner evidence and never recovers",
			input: snapshot({
				job: { ok: false, identity: "gui/501/com.flywheel.cmux-watcher" },
				heartbeat: { ageMs: 900_000, key: "hb:old" },
			}),
			branch: "job_absent",
			alert: true,
			recover: false,
		},
		{
			name: "a maintenance park suppresses recovery",
			input: snapshot({
				park: { ageMs: 60_000, key: "park:1", path: "maintenance" },
				heartbeat: { ageMs: 900_000, key: "hb:old" },
			}),
			branch: "parked",
			alert: false,
			recover: false,
		},
		{
			name: "an expired maintenance park alerts but is never removed or recovered",
			input: snapshot({
				park: { ageMs: 1_900_000, key: "park:2", path: "qa-teardown" },
			}),
			branch: "parked_expired",
			alert: true,
			recover: false,
		},
		{
			name: "loaded without owner stays silent during startup grace",
			input: snapshot({
				ownerState: "missing",
				owner: undefined,
				ownerlessAgeMs: 119_000,
				heartbeat: null,
			}),
			branch: "owner_starting",
			alert: false,
			recover: false,
		},
		{
			name: "loaded without owner alerts after startup grace but does not kill",
			input: snapshot({
				ownerState: "malformed",
				owner: undefined,
				ownerlessAgeMs: 121_000,
				heartbeat: null,
			}),
			branch: "owner_missing",
			alert: true,
			recover: false,
		},
		{
			name: "pre-rollout owner without heartbeat is a silent legacy watcher",
			input: snapshot({
				rolloutAnchorMs: 1_950_000,
				heartbeat: null,
			}),
			branch: "legacy_no_heartbeat",
			alert: false,
			recover: false,
		},
		{
			name: "post-rollout owner without heartbeat alerts but is not killed blind",
			input: snapshot({ heartbeat: null }),
			branch: "heartbeat_missing",
			alert: true,
			recover: false,
		},
		{
			name: "stale heartbeat recovers only with queryable job and verified owner",
			input: snapshot({ heartbeat: { ageMs: 301_000, key: "hb:stale" } }),
			branch: "stalled",
			alert: true,
			recover: true,
		},
		{
			name: "stale non-empty event backlog alerts without killing a live watcher",
			input: snapshot({ event: { ageMs: 121_000, key: "event:stale" } }),
			branch: "event_backlog",
			alert: true,
			recover: false,
		},
		{
			name: "fresh complete evidence is healthy",
			input: snapshot(),
			branch: "healthy",
			alert: false,
			recover: false,
		},
	])("$name", ({ input, branch, alert, recover }) => {
		const result = classifyCmuxWatcher(input);
		expect(result).toMatchObject({ branch, alert, recover });
	});
});

describe("FLY-1944 owner tuple parser", () => {
	it("accepts only an exact live-incarnation watch tuple", () => {
		const incarnation = "Thu Aug 20 10:00:00 2026";
		expect(
			parseCmuxWatcherOwner(`42|${incarnation}|watch|nonce-a\n`, incarnation),
		).toMatchObject({ pid: 42, incarnation, nonce: "nonce-a" });
		for (const malformed of [
			`42|${incarnation}|once|nonce-a\n`,
			`42|${incarnation}|watch|bad nonce\n`,
			`42|wrong|watch|nonce-a\n`,
			`42|${incarnation}|watch|nonce-a\nextra\n`,
		]) {
			expect(parseCmuxWatcherOwner(malformed, incarnation)).toBeNull();
		}
	});
});

describe("FLY-1944 cmux watcher patrol episodes", () => {
	it("emits and recovers once per episode, then re-arms after true health", async () => {
		let current = snapshot({ heartbeat: { ageMs: 301_000, key: "hb:a" } });
		const recover = vi
			.fn()
			.mockResolvedValue({ ok: true, detail: "fresh owner" });
		const alert = vi.fn().mockResolvedValue(undefined);
		const patrol = new CmuxWatcherPatrol({
			readSnapshot: async () => current,
			recover,
			alert,
		});

		await patrol.tick();
		await patrol.tick();
		expect(recover).toHaveBeenCalledTimes(1);
		expect(alert).toHaveBeenCalledTimes(1);

		current = snapshot();
		await patrol.tick();
		current = snapshot({
			owner: { ...OWNER, incarnation: "new", tuple: "42|new|watch|nonce-b" },
			heartbeat: { ageMs: 301_000, key: "hb:b" },
		});
		await patrol.tick();
		expect(recover).toHaveBeenCalledTimes(2);
		expect(alert).toHaveBeenCalledTimes(2);
	});

	it("contains overlapping ticks with one single-flight pass", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const readSnapshot = vi.fn(async () => {
			await blocked;
			return snapshot();
		});
		const patrol = new CmuxWatcherPatrol({
			readSnapshot,
			recover: vi.fn(),
			alert: vi.fn(),
		});
		const a = patrol.tick();
		const b = patrol.tick();
		release();
		await Promise.all([a, b]);
		expect(readSnapshot).toHaveBeenCalledTimes(1);
	});

	it("does not duplicate an unresolved stalled episode across another alert branch", async () => {
		let current = snapshot({ heartbeat: { ageMs: 301_000, key: "hb:a" } });
		const recover = vi
			.fn()
			.mockResolvedValue({ ok: false, detail: "restart failed" });
		const alert = vi.fn().mockResolvedValue(undefined);
		const patrol = new CmuxWatcherPatrol({
			readSnapshot: async () => current,
			recover,
			alert,
		});

		await patrol.tick();
		current = snapshot({
			job: { ok: false, identity: "gui/501/com.flywheel.cmux-watcher" },
			heartbeat: { ageMs: 400_000, key: "hb:a" },
		});
		await patrol.tick();
		current = snapshot({ heartbeat: { ageMs: 500_000, key: "hb:a" } });
		await patrol.tick();

		expect(recover).toHaveBeenCalledTimes(2);
		expect(alert).toHaveBeenCalledTimes(2);
		expect(alert.mock.calls.map(([verdict]) => verdict.branch)).toEqual([
			"stalled",
			"job_absent",
		]);

		current = snapshot();
		await patrol.tick();
		current = snapshot({ heartbeat: { ageMs: 301_000, key: "hb:a" } });
		await patrol.tick();
		expect(recover).toHaveBeenCalledTimes(3);
		expect(alert).toHaveBeenCalledTimes(3);
	});

	it("gives each resolved job-absent episode a new durable alert key", async () => {
		let current = snapshot({
			nowMs: NOW,
			job: { ok: false, identity: "gui/501/com.flywheel.cmux-watcher" },
		});
		const alert = vi.fn().mockResolvedValue(undefined);
		const patrol = new CmuxWatcherPatrol({
			readSnapshot: async () => current,
			recover: vi.fn(),
			alert,
		});

		await patrol.tick();
		current = snapshot({ nowMs: NOW + 60_000 });
		await patrol.tick();
		current = snapshot({
			nowMs: NOW + 120_000,
			job: { ok: false, identity: "gui/501/com.flywheel.cmux-watcher" },
		});
		await patrol.tick();

		expect(alert).toHaveBeenCalledTimes(2);
		const episodeKeys = alert.mock.calls.map(([verdict]) => verdict.episodeKey);
		expect(episodeKeys[0]).not.toBe(episodeKeys[1]);
	});

	it("keeps an event-backlog episode stable across owner restarts and re-arms only after progress", async () => {
		let current = snapshot({
			nowMs: NOW,
			event: { ageMs: 121_000, key: "event:a" },
		});
		const recover = vi.fn();
		const alert = vi.fn().mockResolvedValue(undefined);
		const patrol = new CmuxWatcherPatrol({
			readSnapshot: async () => current,
			recover,
			alert,
		});

		await patrol.tick();
		current = snapshot({
			owner: { ...OWNER, incarnation: "new", tuple: "42|new|watch|nonce-b" },
			event: { ageMs: 300_000, key: "event:b" },
		});
		await patrol.tick();
		expect(recover).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledTimes(1);

		current = snapshot({
			nowMs: NOW + 60_000,
			event: { ageMs: 10_000, key: "event:fresh" },
		});
		await patrol.tick();
		current = snapshot({
			nowMs: NOW + 120_000,
			event: { ageMs: 121_000, key: "event:stale-again" },
		});
		await patrol.tick();
		expect(alert).toHaveBeenCalledTimes(2);
		const episodeKeys = alert.mock.calls.map(([verdict]) => verdict.episodeKey);
		expect(episodeKeys[0]).not.toBe(episodeKeys[1]);
	});
});
