import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyResidentCodexLead,
	type ResidentCodexLeadHeartbeatValue,
} from "../../../bridge/resident-codex-lead-patrol.js";
import { ResidentCodexLeadLifecycleObserver } from "../resident-codex-lead-lifecycle.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const stateDir = mkdtempSync(join(tmpdir(), "fly2361-retention-"));
	roots.push(stateDir);
	let time = Date.now();
	const start = time;
	const options = {
		stateDir,
		threadId: "thread",
		generationId: "generation",
		processPid: 4242,
		carrierInstanceId: "carrier",
		now: () => new Date(time).toISOString(),
	};
	const observer = new ResidentCodexLeadLifecycleObserver(options);
	const root = join(stateDir, "brain");
	return {
		observer,
		options,
		root,
		start,
		setTime: (value: number) => {
			time = value;
		},
		heartbeat: () =>
			JSON.parse(readFileSync(join(root, "heartbeat.json"), "utf8")),
		logs: () =>
			readdirSync(root)
				.filter((name) => /^lifecycle\.jsonl(?:\.\d+)?$/.test(name))
				.sort()
				.reverse()
				.map((name) => readFileSync(join(root, name), "utf8")),
	};
}

describe("FLY-2361 retention and consumer compatibility", () => {
	it("retains a burst of failures in order across size rotation", async () => {
		const f = fixture();
		const observer = new ResidentCodexLeadLifecycleObserver({
			...f.options,
			threadId: "t".repeat(256),
			generationId: "g".repeat(256),
		});
		for (let i = 0; i < 3500; i++) {
			if (i % 100 === 0)
				await new Promise<void>((resolve) => setImmediate(resolve));
			f.setTime(f.start + i);
			observer.pollResult({
				ok: false,
				channelId: "a",
				failureClass: "server",
				status: 503,
			});
		}
		const logs = f.logs();
		expect(logs.length).toBeGreaterThan(1);
		const rows = logs.flatMap((log) =>
			log
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		expect(rows).toHaveLength(3500);
		for (let i = 0; i < rows.length; i++)
			expect(rows[i]).toMatchObject({
				event: "gateway_poll_failed",
				at: new Date(f.start + i).toISOString(),
				failureClass: "server",
				status: 503,
			});
	}, 120_000);

	it("writes less than 2 MB over 24h of one-second polls with every failure and state change retained", async () => {
		const f = fixture();
		f.observer.online();
		for (let second = 0; second < 86_400; second++) {
			// Keep Vitest's RPC alive during real filesystem I/O on busy hosts.
			if (second % 300 === 0)
				await new Promise<void>((resolve) => setImmediate(resolve));
			f.setTime(f.start + second * 1000);
			f.observer.pollAttempt("channel");
			if (second % 10_000 === 9999)
				f.observer.pollResult({
					ok: false,
					channelId: "channel",
					failureClass: "server",
					status: 503,
				});
			else f.observer.pollResult({ ok: true, channelId: "channel" });
			if (second % 173 === 0)
				f.observer.messageConsumed({
					channelId: "channel",
					messageId: String(second),
					cursorPersisted: true,
				});
		}
		f.setTime(f.start + 86_400_000);
		f.observer.shutdown();
		const logs = f.logs();
		const bytes = logs.reduce(
			(total, log) => total + Buffer.byteLength(log),
			0,
		);
		const rows = logs.flatMap((log) =>
			log
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		expect(bytes).toBeLessThan(2_000_000);
		expect(
			rows.filter((row) => row.event === "gateway_poll_attempt"),
		).toHaveLength(1);
		expect(
			rows.filter((row) => row.event === "gateway_poll_failed"),
		).toHaveLength(8);
		expect(rows.filter((row) => row.event === "gateway_poll_ok")).toHaveLength(
			9,
		);
		expect(rows.filter((row) => row.event === "message_consumed")).toHaveLength(
			500,
		);
		expect(rows.filter((row) => row.event === "online")).toHaveLength(1);
		expect(rows.filter((row) => row.event === "shutdown")).toHaveLength(1);
		const summaries = rows.filter(
			(row) => row.event === "gateway_poll_summary",
		);
		expect(summaries).toHaveLength(288);
		expect(summaries.reduce((sum, row) => sum + row.attempt, 0)).toBe(86_400);
		expect(summaries.reduce((sum, row) => sum + row.ok, 0)).toBe(86_392);
		expect(summaries.reduce((sum, row) => sum + row.fail, 0)).toBe(8);
		console.info(
			`FLY-2361 simulated 24h: ${bytes} bytes across ${logs.length} files, ${rows.length} events`,
		);
	}, 600_000);

	it("flushes a generation boundary and starts a fresh restart window without replaying old counters", () => {
		const f = fixture();
		f.observer.online();
		f.observer.pollAttempt("a");
		f.observer.pollResult({ ok: true, channelId: "a" });
		f.observer.generationLost();
		const restarted = new ResidentCodexLeadLifecycleObserver({
			...f.options,
			generationId: "next",
		});
		restarted.online();
		restarted.pollAttempt("a");
		restarted.pollResult({ ok: true, channelId: "a" });
		restarted.shutdown();
		const rows = f.logs().flatMap((log) =>
			log
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		expect(
			rows.filter((row) => row.event === "gateway_poll_summary"),
		).toMatchObject([
			{ generationId: "generation", attempt: 1, ok: 1, fail: 0 },
			{ generationId: "next", attempt: 1, ok: 1, fail: 0 },
		]);
		expect(rows.filter((row) => row.event === "gateway_poll_ok")).toHaveLength(
			2,
		);
		expect(f.heartbeat()).toMatchObject({
			generationId: "next",
			state: "shutdown",
		});
	});

	it("preserves legacy heartbeat values and actual patrol RED/GREEN decisions across polling and stalls", () => {
		const f = fixture();
		const iso = (offset: number) => new Date(f.start + offset).toISOString();
		// The baseline 26ebc4931 heartbeat contract, independent of JSONL sampling.
		const legacy: ResidentCodexLeadHeartbeatValue & Record<string, unknown> = {
			v: 1,
			generationId: "generation",
			threadId: "thread",
			processPid: 4242,
			carrierInstanceId: "carrier",
			state: "online",
			onlineAt: iso(0),
			activeTurn: null,
			updatedAt: iso(0),
			lastLifecycleEvent: "online",
		};
		const decide = (value: ResidentCodexLeadHeartbeatValue, nowMs: number) =>
			classifyResidentCodexLead({
				nowMs,
				identity: {
					state: "exact",
					pid: 4242,
					lstart: "same-start",
					startedAtMs: f.start - 3_600_000,
					argv: [],
					codexHome: "/test",
					label: "test",
					wrapper: "test",
				},
				heartbeat: { state: "valid", value },
				observed: {
					pid: 4242,
					lstart: "same-start",
					generationId: "generation",
					carrierInstanceId: "carrier",
					observedAt: iso(0),
				},
				controlledWave: null,
			});
		const compare = (offset: number, branch: string) => {
			expect(f.heartbeat()).toEqual(legacy);
			const actual = decide(f.heartbeat(), f.start + offset);
			expect(actual).toEqual(decide(legacy, f.start + offset));
			expect(actual.branch).toBe(branch);
		};
		f.observer.online();
		compare(0, "poll_loop_stalled");
		for (let i = 1; i <= 4; i++) {
			const offset = i * 1000;
			f.setTime(f.start + offset);
			f.observer.pollAttempt("a");
			Object.assign(legacy, {
				lastGatewayPollAttemptAt: iso(offset),
				updatedAt: iso(offset),
				lastLifecycleEvent: "gateway_poll_attempt",
			});
			compare(offset, i === 4 ? "upstream_unavailable" : "healthy");
			if (i === 3) {
				f.observer.pollResult({
					ok: false,
					channelId: "a",
					failureClass: "auth",
					status: 401,
				});
				Object.assign(legacy, {
					lastGatewayPollResultAt: iso(offset),
					lastGatewayPollStatus: "failed",
					lastGatewayPollFailureClass: "auth",
					lastGatewayPollStatusCode: 401,
					lastLifecycleEvent: "gateway_poll_failed",
				});
				compare(offset, "upstream_unavailable");
			} else {
				f.observer.pollResult({ ok: true, channelId: "a" });
				Object.assign(legacy, {
					lastGatewayPollResultAt: iso(offset),
					lastGatewayPollStatus: "ok",
					lastLifecycleEvent: "gateway_poll_ok",
				});
				delete legacy.lastGatewayPollFailureClass;
				delete legacy.lastGatewayPollStatusCode;
				compare(offset, "healthy");
			}
		}
		compare(125_000, "poll_loop_stalled");
		compare(185_000, "heartbeat_stalled");
		f.setTime(f.start + 185_000);
		f.observer.turnStarted("turn");
		Object.assign(legacy, {
			activeTurn: { turnId: "turn", startedAt: iso(185_000) },
			updatedAt: iso(185_000),
			lastLifecycleEvent: "turn_started",
		});
		compare(185_000, "poll_loop_stalled");
		f.setTime(f.start + 2_000_000);
		f.observer.pollAttempt("a");
		Object.assign(legacy, {
			lastGatewayPollAttemptAt: iso(2_000_000),
			updatedAt: iso(2_000_000),
			lastLifecycleEvent: "gateway_poll_attempt",
		});
		compare(2_000_000, "turn_stalled");
		f.observer.turnFinished("turn", "completed");
		Object.assign(legacy, {
			activeTurn: null,
			lastTurn: { turnId: "turn", status: "completed", at: iso(2_000_000) },
			lastLifecycleEvent: "turn_completed",
		});
		compare(2_000_000, "healthy");
	});
});
