import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeInjectionShim } from "../injection/claude-shim.js";

/**
 * FLY-1503 item 10 — the injection sidecar deduped on the bare messageUid.
 *
 * The real inbox and sidecar paths are per-agent
 * (.../teams/v2-<agent>/inboxes/<agent>.json[.flywheel.jsonl]), shared by every
 * activation and generation of that agent. So once a messageUid was finalized,
 * redelivering that same message to a *new* terminal hit the sidecar, the write
 * was skipped, and writeMailboxEntry reported idempotent success -- the new
 * terminal silently never received it.
 */
const tempRoots: string[] = [];
afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function harness() {
	const root = mkdtempSync(join(tmpdir(), "fly1503-injection-"));
	tempRoots.push(root);
	const inboxPath = join(root, "inboxes", "runner-a.json");
	const sidecarPath = join(root, "inboxes", "runner-a.json.flywheel.jsonl");
	const sessionRef = JSON.stringify({
		v: 1,
		backend: "claude",
		inboxPath,
		sidecarPath,
		toAgent: "runner-a",
	});
	return {
		inboxPath,
		sidecarPath,
		sessionRef,
		shim: new ClaudeInjectionShim(),
	};
}

function inboxRows(inboxPath: string): unknown[] {
	return JSON.parse(readFileSync(inboxPath, "utf8")) as unknown[];
}

describe("FLY-1503 item 10 — sidecar dedup must not swallow a new terminal", () => {
	it("still dedupes a genuine replay of the same delivery attempt", async () => {
		const { inboxPath, sessionRef, shim } = harness();
		const message = {
			messageUid: "message-1",
			attemptUid: "message-1#2",
			payload: '{"task":"repair"}',
		};
		await shim.hint(sessionRef);
		await shim.deliver(sessionRef, message);
		await shim.deliver(sessionRef, message);
		expect(inboxRows(inboxPath)).toHaveLength(1);
	});

	it("redelivers the same message to a new terminal generation", async () => {
		const { inboxPath, sessionRef, shim } = harness();
		await shim.hint(sessionRef);
		await shim.deliver(sessionRef, {
			messageUid: "message-1",
			attemptUid: "message-1#2",
			payload: '{"task":"repair"}',
		});
		// The runner died and was replaced; the engine re-delivers the same mailbox
		// message to the new generation, which is a distinct delivery attempt.
		await shim.deliver(sessionRef, {
			messageUid: "message-1",
			attemptUid: "message-1#3",
			payload: '{"task":"repair"}',
		});

		// RED before the fix: the sidecar keyed on messageUid alone, so this second
		// delivery was skipped and reported as idempotent success -- the new
		// terminal never saw the assignment.
		expect(inboxRows(inboxPath)).toHaveLength(2);
	});
});
