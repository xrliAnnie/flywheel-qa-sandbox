/**
 * FLY-1501 QA — injection shim failure paths that the primary suite skips.
 *
 * `injection-shims.test.ts` always injects a fake `connect`, so two things were
 * never executed: (a) the production default constructor, whose `connect`
 * resolves `ws` from a *different* workspace package (`flywheel-claude-runner`)
 * — a resolution that silently breaks if the dependency edge is dropped; and
 * (b) the connect-failure branch, which happens outside `deliver`'s try/finally
 * and is by far the most common real failure (daemon not running).
 */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxWriteError } from "flywheel-agent-team-transport";
import { describe, expect, it, vi } from "vitest";
import { ClaudeInjectionShim, CodexInjectionShim } from "../index.js";
import { encodeInjectionEnvelope } from "../injection/envelope.js";

/** Mirrors MAX_MAILBOX_CONTENT_BYTES in the shim and the adapter's own cap. */
const CAP = 1_000_000;

const MESSAGE = {
	messageUid: "message-1",
	attemptUid: "message-1#1",
	payload: '{"task":"repair"}',
} as const;

function codexRef(socketPath: string): string {
	return JSON.stringify({
		v: 1,
		backend: "codex",
		socketPath,
		threadId: "thread-1",
	});
}

describe("Codex injection shim failure paths", () => {
	it("uses the real default transport and rejects retryably when the daemon is down", async () => {
		// No injected `connect`: this exercises `connectDaemonTransport` for real.
		const shim = new CodexInjectionShim({ connectTimeoutMs: 2000 });
		const socketPath = join(
			mkdtempSync(join(tmpdir(), "fly1501-codex-absent-")),
			"daemon.sock",
		);

		const error = await shim
			.deliver(codexRef(socketPath), MESSAGE)
			.then(() => null)
			.catch((err: Error) => err);

		expect(error).toBeInstanceOf(Error);
		// A resolution failure would surface as ERR_MODULE_NOT_FOUND instead of a
		// socket error — that distinction is the point of this assertion.
		expect((error as NodeJS.ErrnoException).code).toBeUndefined();
		expect(error?.message).toMatch(/daemon WS connect failed|ENOENT/);
	}, 30_000);

	it("propagates a connect failure without constructing a client or a turn", async () => {
		const connect = vi.fn(async () => {
			throw new Error("daemon socket refused");
		});
		const shim = new CodexInjectionShim({ connect });

		await expect(
			shim.deliver(codexRef("/tmp/flywheel-codex.sock"), MESSAGE),
		).rejects.toThrow(/daemon socket refused/);
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("closes the transport when client construction fails before any RPC", async () => {
		// `new CodexDaemonClient(...)` subscribes to the transport; if that throws,
		// only the raw transport exists and it must still be closed exactly once.
		let closeCalls = 0;
		const shim = new CodexInjectionShim({
			connect: async () => ({
				send() {
					throw new Error("unreachable");
				},
				onMessage() {
					throw new Error("transport rejected subscription");
				},
				onClose() {},
				close() {
					closeCalls++;
				},
			}),
		});

		await expect(
			shim.deliver(codexRef("/tmp/flywheel-codex.sock"), MESSAGE),
		).rejects.toThrow();
		expect(closeCalls).toBe(1);
	});

	it("hint stays a pure no-op that never opens a connection", async () => {
		const connect = vi.fn(async () => {
			throw new Error("hint must not connect");
		});
		const shim = new CodexInjectionShim({ connect });

		await expect(
			shim.hint(codexRef("/tmp/flywheel-codex.sock")),
		).resolves.toBeUndefined();
		expect(connect).not.toHaveBeenCalled();
	});
});

describe("Claude injection shim failure paths", () => {
	it("caps the encoded envelope at exactly the adapter ceiling", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1501-claude-cap-"));
		try {
			const shim = new ClaudeInjectionShim();
			const inboxPath = join(root, "inbox.json");
			const ref = JSON.stringify({
				v: 1,
				backend: "claude",
				inboxPath,
				sidecarPath: join(root, "sidecar.jsonl"),
				toAgent: "runner-a",
			});

			// The cap applies to the encoded envelope, not the raw payload, so size
			// the payload from a real measurement rather than guessing the overhead.
			// "x" is 1:1 under JSON escaping, so the adjustment is exact.
			const probe = { ...MESSAGE, payload: "x".repeat(1000) };
			const overhead =
				Buffer.byteLength(encodeInjectionEnvelope(probe), "utf-8") - 1000;
			const atCap = { ...MESSAGE, payload: "x".repeat(CAP - overhead) };
			const overCap = { ...MESSAGE, payload: "x".repeat(CAP - overhead + 1) };
			expect(Buffer.byteLength(encodeInjectionEnvelope(atCap), "utf-8")).toBe(
				CAP,
			);
			expect(Buffer.byteLength(encodeInjectionEnvelope(overCap), "utf-8")).toBe(
				CAP + 1,
			);

			// One byte over is refused, with the adapter's own error type...
			await expect(shim.deliver(ref, overCap)).rejects.toBeInstanceOf(
				MailboxWriteError,
			);
			await expect(shim.deliver(ref, overCap)).rejects.toThrow(
				/exceeds adapter cap/,
			);
			// ...and nothing was written, not even a partial entry. The sidecar
			// matters as much as the inbox: writeMailboxEntry touches it first, so
			// checking only the inbox would miss a rejection that already wrote.
			expect(existsSync(inboxPath)).toBe(false);
			expect(existsSync(join(root, "sidecar.jsonl"))).toBe(false);

			// ...while exactly at the cap still goes through. Without this the
			// rejection above could equally be an off-by-one or a broken write path.
			await shim.deliver(ref, atCap);
			expect(
				JSON.parse(readFileSync(inboxPath, "utf8")) as unknown[],
			).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("appends distinct messageUids and surfaces an unwritable inbox", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1501-claude-fail-"));
		try {
			const shim = new ClaudeInjectionShim();
			const goodRef = JSON.stringify({
				v: 1,
				backend: "claude",
				inboxPath: join(root, "inbox.json"),
				sidecarPath: join(root, "sidecar.jsonl"),
				toAgent: "runner-a",
			});

			await shim.deliver(goodRef, MESSAGE);
			await shim.deliver(goodRef, { ...MESSAGE, messageUid: "message-2" });
			// Dedupe is keyed on the message/attempt pair, so two distinct message
			// uids must both land (FLY-1503 item 10).
			expect(
				JSON.parse(readFileSync(join(root, "inbox.json"), "utf8")),
			).toHaveLength(2);

			// A regular file cannot host a subdirectory: the write must reject
			// loudly rather than report a silent success to the engine.
			const blocker = join(root, "blocker");
			writeFileSync(blocker, "not a directory");
			const badRef = JSON.stringify({
				v: 1,
				backend: "claude",
				inboxPath: join(blocker, "nested", "inbox.json"),
				sidecarPath: join(blocker, "nested", "sidecar.jsonl"),
				toAgent: "runner-a",
			});
			await expect(shim.deliver(badRef, MESSAGE)).rejects.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
