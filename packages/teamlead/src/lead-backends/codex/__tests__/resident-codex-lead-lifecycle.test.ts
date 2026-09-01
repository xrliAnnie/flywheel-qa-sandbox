import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	const observer = new ResidentCodexLeadLifecycleObserver({
		stateDir,
		threadId: "thread-raya",
		generationId: "generation-1",
		processPid: 4242,
		carrierInstanceId: "carrier-1",
		now: () => new Date(1_800_000_000_000 + tick++ * 1_000).toISOString(),
	});
	return { stateDir, observer };
}

describe("FLY-2216 resident Codex Lead lifecycle", () => {
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
