import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentCodexLeadLifecycleObserver } from "../resident-codex-lead-lifecycle.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const stateDir = mkdtempSync(join(tmpdir(), "fly2216-brain-"));
	roots.push(stateDir);
	let tick = 0;
	const startedAt = Date.now();
	const observer = new ResidentCodexLeadLifecycleObserver({
		stateDir,
		threadId: "thread-raya",
		generationId: "generation-1",
		processPid: 4242,
		carrierInstanceId: "carrier-1",
		now: () => new Date(startedAt + tick++ * 1_000).toISOString(),
	});
	return { stateDir, observer };
}

describe("FLY-2216 resident Codex Lead lifecycle", () => {
	it("rotates an existing oversized log without dropping the new failure or changing private modes", () => {
		const { stateDir, observer } = fixture();
		const root = join(stateDir, "brain");
		mkdirSync(root);
		const old = `${JSON.stringify({ event: "old", detail: "x".repeat(2_000_000) })}\n`;
		writeFileSync(join(root, "lifecycle.jsonl"), old, { mode: 0o600 });
		observer.pollResult({
			ok: false,
			channelId: "a",
			failureClass: "auth",
			status: 401,
		});
		expect(readFileSync(join(root, "lifecycle.jsonl.1"), "utf8")).toBe(old);
		expect(
			JSON.parse(readFileSync(join(root, "lifecycle.jsonl"), "utf8")),
		).toMatchObject({ event: "gateway_poll_failed", status: 401 });
		expect(lstatSync(root).mode & 0o777).toBe(0o700);
		for (const name of [
			"heartbeat.json",
			"lifecycle.jsonl",
			"lifecycle.jsonl.1",
		])
			expect(lstatSync(join(root, name)).mode & 0o777).toBe(0o600);
	});

	it("keeps heartbeat fresh when the lifecycle path is unsafe", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2361-unsafe-"));
		roots.push(stateDir);
		mkdirSync(join(stateDir, "brain"));
		writeFileSync(join(stateDir, "target"), "do-not-touch");
		symlinkSync(
			join(stateDir, "target"),
			join(stateDir, "brain/lifecycle.jsonl"),
		);
		const errors: string[] = [];
		const observer = new ResidentCodexLeadLifecycleObserver({
			stateDir,
			threadId: "t",
			generationId: "g",
			processPid: 4242,
			carrierInstanceId: "c",
			log: (message) => errors.push(message),
		});
		observer.pollResult({ ok: false, channelId: "a", failureClass: "network" });
		expect(
			JSON.parse(readFileSync(join(stateDir, "brain/heartbeat.json"), "utf8")),
		).toMatchObject({ lastGatewayPollStatus: "failed" });
		expect(readFileSync(join(stateDir, "target"), "utf8")).toBe("do-not-touch");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("lifecycle write failed");
	});

	it("aggregates repeat polls while retaining every failure and per-channel recovery", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2361-summary-"));
		roots.push(stateDir);
		let time = Date.now();
		const start = time;
		const observer = new ResidentCodexLeadLifecycleObserver({
			stateDir,
			threadId: "thread",
			generationId: "generation",
			processPid: 4242,
			carrierInstanceId: "carrier",
			now: () => new Date(time).toISOString(),
		});
		observer.online();
		for (let i = 0; i < 300; i++) {
			time = start + i * 1000;
			observer.pollAttempt("a");
			observer.pollResult({ ok: true, channelId: "a" });
		}
		const events = () =>
			readFileSync(join(stateDir, "brain/lifecycle.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		expect(events().map((row) => row.event)).toEqual([
			"online",
			"gateway_poll_attempt",
			"gateway_poll_ok",
		]);
		expect(
			JSON.parse(readFileSync(join(stateDir, "brain/heartbeat.json"), "utf8")),
		).toMatchObject({
			lastGatewayPollAttemptAt: new Date(time).toISOString(),
			lastGatewayPollResultAt: new Date(time).toISOString(),
			lastLifecycleEvent: "gateway_poll_ok",
			updatedAt: new Date(time).toISOString(),
		});
		time = start + 300_000;
		observer.pollAttempt("a");
		for (let i = 0; i < 2; i++)
			observer.pollResult({
				ok: false,
				channelId: "a",
				failureClass: "network",
			});
		observer.pollResult({ ok: true, channelId: "b" });
		observer.pollResult({ ok: true, channelId: "a" });
		observer.pollResult({ ok: true, channelId: "a" });
		observer.shutdown();
		const rows = events();
		expect(
			rows.filter((row) => row.event === "gateway_poll_failed"),
		).toHaveLength(2);
		expect(
			rows
				.filter((row) => row.event === "gateway_poll_ok")
				.map((row) => row.channelId),
		).toEqual(["a", "b", "a"]);
		expect(
			rows.filter((row) => row.event === "gateway_poll_summary"),
		).toMatchObject([
			{
				attempt: 300,
				ok: 300,
				fail: 0,
				start: new Date(start).toISOString(),
				end: new Date(time).toISOString(),
			},
			{ attempt: 1, ok: 3, fail: 2 },
		]);
		expect(rows.at(-1).event).toBe("shutdown");
	});

	it("does not interpret assistant output as a lifecycle signal", () => {
		const { observer } = fixture();
		expect("assistantCompleted" in observer).toBe(false);
	});

	it("writes append-only events and an atomic current heartbeat without content", () => {
		const { stateDir, observer } = fixture();
		observer.online();
		observer.pollAttempt("channel-1");
		observer.pollResult({ ok: true, channelId: "channel-1" });
		observer.messageConsumed({
			channelId: "channel-1",
			messageId: "message-1",
			cursorPersisted: true,
		});
		observer.turnStarted("turn-1");
		observer.turnFinished("turn-1", "completed");

		const root = join(stateDir, "brain");
		const lines = readFileSync(join(root, "lifecycle.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((line) => line.event)).toEqual([
			"online",
			"gateway_poll_attempt",
			"gateway_poll_ok",
			"message_consumed",
			"turn_started",
			"turn_completed",
		]);
		const heartbeat = JSON.parse(
			readFileSync(join(root, "heartbeat.json"), "utf8"),
		);
		expect(heartbeat).toMatchObject({
			v: 1,
			generationId: "generation-1",
			threadId: "thread-raya",
			processPid: 4242,
			carrierInstanceId: "carrier-1",
			lastGatewayPollStatus: "ok",
			lastConsumedMessage: {
				channelId: "channel-1",
				messageId: "message-1",
				cursorPersisted: true,
			},
			activeTurn: null,
			lastTurn: { turnId: "turn-1", status: "completed" },
		});
		expect(readFileSync(join(root, "lifecycle.jsonl"), "utf8")).not.toContain(
			"secret message body",
		);
	});

	it("records closed poll failure classes and never stores an error message", () => {
		const { stateDir, observer } = fixture();
		observer.pollAttempt("channel-1");
		observer.pollResult({
			ok: false,
			channelId: "channel-1",
			failureClass: "unknown",
			status: 520,
		});
		const heartbeat = JSON.parse(
			readFileSync(join(stateDir, "brain", "heartbeat.json"), "utf8"),
		);
		expect(heartbeat).toMatchObject({
			lastGatewayPollStatus: "failed",
			lastGatewayPollFailureClass: "unknown",
			lastGatewayPollStatusCode: 520,
		});
	});
});
