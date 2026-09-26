import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	HeadlessClaudeBrain,
	parseStreamLine,
} from "../brain/HeadlessClaudeBrain.js";
import type { VoiceError } from "../types.js";
import { type FakeProcessHandle, FakeProcessRunner } from "./fakes.js";

const cleanup: string[] = [];
afterEach(() => {
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
	cleanup.length = 0;
});

function identityFile(
	content = "You are Tadashi. SECRET_PERSONA_MARKER.",
): string {
	const dir = mkdtempSync(join(tmpdir(), "voice-identity-"));
	cleanup.push(dir);
	const p = join(dir, "identity.md");
	writeFileSync(p, content);
	return p;
}

async function drain(iter: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

const deltaLine = (text: string) =>
	`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } })}\n`;

describe("parseStreamLine (S0.1 stream-json shape)", () => {
	it("reads text_delta from a stream_event", () => {
		const r = parseStreamLine(deltaLine("Hi").trim());
		expect(r.recognized).toBe(true);
		expect(r.text).toBe("Hi");
	});
	it("recognizes thinking_delta but yields no text", () => {
		const line = JSON.stringify({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				delta: { type: "thinking_delta", thinking: "hmm" },
			},
		});
		expect(parseStreamLine(line)).toMatchObject({ recognized: true, text: "" });
	});
	it("captures session_id", () => {
		const line = JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: "sess-123",
		});
		expect(parseStreamLine(line)).toMatchObject({
			recognized: true,
			sessionId: "sess-123",
		});
	});
	it("returns not-recognized for plain text", () => {
		expect(parseStreamLine("just text").recognized).toBe(false);
	});
});

describe("HeadlessClaudeBrain", () => {
	it("streams text_delta chunks; first turn uses zero-tools + append-system-prompt + stdin prompt", async () => {
		let handle: FakeProcessHandle | undefined;
		const runner = new FakeProcessRunner(undefined, (h) => {
			handle = h;
			setTimeout(() => {
				h.emitStdout(
					`${JSON.stringify({ type: "system", session_id: "s-1" })}\n`,
				);
				h.emitStdout(deltaLine("你好"));
				h.emitStdout(deltaLine("，Annie"));
				h.emitExit(0);
			}, 0);
		});
		const idFile = identityFile();
		const brain = new HeadlessClaudeBrain({
			claudeBin: "claude",
			identityFile: idFile,
			runner,
		});
		const chunks = await drain(
			brain.respond(
				{ text: "hi", history: [] },
				{ signal: new AbortController().signal },
			),
		);
		expect(chunks.join("")).toBe("你好，Annie");
		const argv = runner.spawnCalls[0].args;
		// S0.1 zero-tools = --tools "" --strict-mcp-config; streaming flags; persona file
		expect(argv).toContain("--strict-mcp-config");
		expect(argv).toContain("--include-partial-messages");
		expect(argv).toContain("--append-system-prompt-file");
		expect(argv).toContain(idFile);
		// prompt via stdin (end), never argv
		expect(handle?.ended).toBe(true);
		expect(handle?.written.join("")).toContain("hi");
		expect(argv.join(" ")).not.toContain("hi");
		expect(argv.join(" ")).not.toContain("SECRET_PERSONA_MARKER");
	});

	it("captures session_id and resumes on the next turn (re-sending tool-disable flags)", async () => {
		const runner = new FakeProcessRunner(undefined, (h) =>
			setTimeout(() => {
				h.emitStdout(
					`${JSON.stringify({ type: "system", session_id: "sess-42" })}\n`,
				);
				h.emitStdout(deltaLine("ok"));
				h.emitExit(0);
			}, 0),
		);
		const brain = new HeadlessClaudeBrain({
			claudeBin: "claude",
			identityFile: identityFile(),
			runner,
		});
		await drain(
			brain.respond(
				{ text: "one", history: [] },
				{ signal: new AbortController().signal },
			),
		);
		await drain(
			brain.respond(
				{ text: "two", history: [] },
				{ signal: new AbortController().signal },
			),
		);
		const second = runner.spawnCalls[1].args;
		expect(second).toContain("--resume");
		expect(second).toContain("sess-42");
		expect(second).toContain("--strict-mcp-config"); // re-sent (not session-persistent)
		expect(second).not.toContain("--append-system-prompt-file"); // persona retained by session
	});

	it("falls back to a single flush for plain output", async () => {
		const runner = new FakeProcessRunner(undefined, (h) =>
			setTimeout(() => {
				h.emitStdout("plain one\nplain two\n");
				h.emitExit(0);
			}, 0),
		);
		const brain = new HeadlessClaudeBrain({
			claudeBin: "claude",
			identityFile: identityFile(),
			runner,
		});
		const chunks = await drain(
			brain.respond(
				{ text: "hi", history: [] },
				{ signal: new AbortController().signal },
			),
		);
		expect(chunks.join(" ")).toContain("plain one");
	});

	it("fails fast when identity file is missing", async () => {
		const brain = new HeadlessClaudeBrain({
			claudeBin: "claude",
			identityFile: "/no/such/id.md",
			runner: new FakeProcessRunner(),
		});
		const err = await drain(
			brain.respond(
				{ text: "hi", history: [] },
				{ signal: new AbortController().signal },
			),
		).catch((e) => e);
		expect((err as VoiceError).code).toBe("component-missing");
	});

	it("abort kills the child (SIGKILL) and throws cancelled", async () => {
		let handle: FakeProcessHandle | undefined;
		const runner = new FakeProcessRunner(undefined, (h) => {
			handle = h; // hangs
		});
		const brain = new HeadlessClaudeBrain({
			claudeBin: "claude",
			identityFile: identityFile(),
			runner,
		});
		const ctrl = new AbortController();
		const p = drain(
			brain.respond({ text: "hi", history: [] }, { signal: ctrl.signal }),
		);
		await new Promise((r) => setTimeout(r, 5));
		ctrl.abort();
		const err = await p.catch((e) => e);
		expect((err as VoiceError).code).toBe("cancelled");
		expect(handle?.killedWith).toBe("SIGKILL");
	});

	it("throws subprocess-failed on non-zero exit", async () => {
		const runner = new FakeProcessRunner(undefined, (h) =>
			setTimeout(() => h.emitExit(2), 0),
		);
		const brain = new HeadlessClaudeBrain({
			claudeBin: "claude",
			identityFile: identityFile(),
			runner,
		});
		const err = await drain(
			brain.respond(
				{ text: "hi", history: [] },
				{ signal: new AbortController().signal },
			),
		).catch((e) => e);
		expect((err as VoiceError).code).toBe("subprocess-failed");
	});
});
