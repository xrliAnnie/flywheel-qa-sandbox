/**
 * FLY-1188 M3 — pane progress renderer (T-1) + tee/flush completion order.
 *
 * Renderer contract: fail-open decoration on the SAME byte stream the JSONL
 * file gets. Event vocabulary from the real codex 0.144.1 --json probe
 * (research.md §4/§7). The file side is byte-authoritative; the done-marker
 * may only appear AFTER the file finished flushing (atomic temp+rename).
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodexCycleState,
	CodexJsonlRenderer,
	codexResume,
} from "../commands/codex-resume.js";

const THREAD_ID = "019e9006-0b8e-72b0-bb80-9100d85473cf";

/** Probe-vocabulary fixture lines (codex 0.144.1 --json). */
const FIXTURE_EVENTS = [
	{ type: "thread.started", thread_id: THREAD_ID },
	{ type: "turn.started" },
	{
		type: "item.started",
		item: { type: "command_execution", command: "pnpm --filter x test" },
	},
	{
		type: "item.completed",
		item: {
			type: "command_execution",
			command: "pnpm --filter x test",
			aggregated_output: "ok\n",
			exit_code: 0,
			status: "completed",
		},
	},
	{
		type: "item.completed",
		item: {
			type: "file_change",
			path: "src/index.ts",
			kind: "update",
			status: "completed",
		},
	},
	{
		type: "item.completed",
		item: {
			type: "agent_message",
			text: "Implemented the feature.\nAll tests pass.",
		},
	},
	{ type: "turn.completed" },
];

describe("CodexJsonlRenderer (FLY-1188 T-1)", () => {
	function render(chunks: Array<string | Buffer>): string[] {
		const lines: string[] = [];
		const r = new CodexJsonlRenderer((l) => lines.push(l), "fresh");
		for (const c of chunks) r.feed(c);
		r.flush();
		return lines;
	}

	it("renders the probe vocabulary into human progress lines", () => {
		const input = `${FIXTURE_EVENTS.map((e) => JSON.stringify(e)).join("\n")}\n`;
		const lines = render([input]);
		expect(lines).toEqual([
			`── codex thread ${THREAD_ID.slice(0, 8)} (fresh) ──`,
			"── turn started (fresh) ──",
			"▶ pnpm --filter x test",
			"▶ pnpm --filter x test (exit 0)",
			"✎ src/index.ts (update)",
			"💬 Implemented the feature. All tests pass.",
			expect.stringMatching(/^── turn completed in \d+s ──$/),
		]);
	});

	it("is chunk-boundary safe: lines split across arbitrary feeds render identically", () => {
		const input = `${FIXTURE_EVENTS.map((e) => JSON.stringify(e)).join("\n")}\n`;
		const whole = render([input]);
		// feed 7 bytes at a time
		const chunks: string[] = [];
		for (let i = 0; i < input.length; i += 7)
			chunks.push(input.slice(i, i + 7));
		expect(render(chunks)).toEqual(whole);
	});

	it("renders a trailing line WITHOUT a newline via flush()", () => {
		const lines = render([JSON.stringify({ type: "turn.started" })]); // no \n
		expect(lines).toEqual(["── turn started (fresh) ──"]);
	});

	it("skips bad JSON and unknown event/item types silently (fail-open)", () => {
		const lines = render([
			[
				"not json at all",
				'{"type":"turn.started"}',
				'{"type":"totally.unknown","x":1}',
				'{"type":"item.completed","item":{"type":"mystery_item"}}',
				'{"type":"item.completed"}', // missing item
				"[1,2,3]", // non-object JSON
				"",
			].join("\n"),
		]);
		expect(lines).toEqual(["── turn started (fresh) ──"]);
	});

	it("caps runaway lines at 1MiB (discard-to-newline) and keeps rendering after", () => {
		const giant = "x".repeat(2 * 1_048_576); // a 2MiB non-JSON line
		const lines = render([
			`${giant.slice(0, 1_500_000)}`, // first chunk of the giant line (no newline yet)
			`${giant.slice(1_500_000)}\n`, // rest + newline
			`${JSON.stringify({ type: "turn.completed" })}\n`,
		]);
		expect(lines).toEqual([expect.stringMatching(/^── turn completed/)]);
	});

	it("truncates long commands/messages to one line", () => {
		const longCmd = `echo ${"a".repeat(500)}`;
		const lines = render([
			`${JSON.stringify({
				type: "item.started",
				item: { type: "command_execution", command: longCmd },
			})}\n`,
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.length).toBeLessThanOrEqual(130);
		expect(lines[0]).toMatch(/…$/);
	});

	it("tolerates a changes[] list shape for file_change", () => {
		const lines = render([
			`${JSON.stringify({
				type: "item.completed",
				item: {
					type: "file_change",
					changes: [
						{ path: "a.ts", kind: "add" },
						{ path: "b.ts", kind: "delete" },
					],
				},
			})}\n`,
		]);
		expect(lines).toEqual(["✎ a.ts (add)", "✎ b.ts (delete)"]);
	});

	it("UTF-8 safe across chunk boundaries: a multi-byte char split mid-sequence renders intact (M3 review LOW-1)", () => {
		const line = `${JSON.stringify({
			type: "item.completed",
			item: { type: "agent_message", text: "中文 🚀 done" },
		})}\n`;
		const bytes = Buffer.from(line, "utf-8");
		// split INSIDE the first multi-byte character (中 starts at the value
		// of "text":" — find its byte offset and cut one byte into it)
		const zhOffset = bytes.indexOf(Buffer.from("中", "utf-8"));
		expect(zhOffset).toBeGreaterThan(0);
		const lines = render([
			bytes.subarray(0, zhOffset + 1), // 1 byte into 中's 3-byte sequence
			bytes.subarray(zhOffset + 1),
		]);
		expect(lines).toEqual(["💬 中文 🚀 done"]);
	});

	it("renderer misbehavior can never throw out of feed/flush", () => {
		const r = new CodexJsonlRenderer(() => {
			throw new Error("pane write exploded");
		}, "resume");
		expect(() => {
			r.feed(`${JSON.stringify({ type: "turn.started" })}\n`);
			r.flush();
		}).not.toThrow();
	});
});

describe("codexResume tee/flush completion order (FLY-1188)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1188-resume-render-"));
		vi.restoreAllMocks();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makeState(): { statePath: string; state: CodexCycleState } {
		const promptPath = join(dir, "prompt.txt");
		writeFileSync(promptPath, "render this", { mode: 0o600 });
		const state: CodexCycleState = {
			version: 1,
			mode: "resume",
			threadId: THREAD_ID,
			promptPath,
			cwd: dir,
			jsonlPath: join(dir, "out.jsonl"),
			lastMessagePath: join(dir, "last.txt"),
			doneMarkerPath: join(dir, "done.json"),
		};
		const statePath = join(dir, "state.json");
		writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
		return { statePath, state };
	}

	/** Fake codex that emits N JSONL event lines + a large payload, then exits. */
	function writeEmittingBin(lineCount: number): {
		bin: string;
		expectedBytes: number;
	} {
		const bin = join(dir, "fake-codex.mjs");
		const line = `${JSON.stringify({
			type: "item.completed",
			item: { type: "command_execution", command: "ls", exit_code: 0 },
		})}\n`;
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"import { readFileSync } from 'node:fs';",
				"readFileSync(0, 'utf-8');",
				`const line = ${JSON.stringify(line)};`,
				`for (let i = 0; i < ${lineCount}; i++) process.stdout.write(line);`,
				// NO process.exit(): a hard exit discards the child's own pending
				// piped-stdout buffer — node drains stdout on natural exit.
			].join("\n"),
			{ mode: 0o755 },
		);
		return { bin, expectedBytes: Buffer.byteLength(line) * lineCount };
	}

	it("JSONL open/write failure → cycle FAILS CLOSED (non-zero marker + fileError), never a success marker (M3 review HIGH-1)", async () => {
		const { bin } = writeEmittingBin(3);
		const { statePath, state } = makeState();
		// point jsonlPath at a DIRECTORY → createWriteStream errors (EISDIR)
		const { mkdirSync } = await import("node:fs");
		rmSync(state.jsonlPath, { force: true });
		mkdirSync(state.jsonlPath, { recursive: true });
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const code = await codexResume({
			statePath,
			env: { ...process.env, FLYWHEEL_CODEX_BIN: bin },
		});
		stdoutSpy.mockRestore();
		// the child itself exited 0 — but the file side failed, so the cycle
		// must NOT report success
		expect(code).not.toBe(0);
		const marker = JSON.parse(readFileSync(state.doneMarkerPath, "utf-8"));
		expect(marker.exitCode).not.toBe(0);
		expect(String(marker.fileError)).toMatch(/EISDIR|illegal operation/i);
	});

	it("spawn failure (ENOENT) → stable 127, never overwritten by the trailing close event (M3 review MEDIUM-2)", async () => {
		const { statePath, state } = makeState();
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const code = await codexResume({
			statePath,
			env: {
				...process.env,
				FLYWHEEL_CODEX_BIN: join(dir, "no-such-binary"),
			},
		});
		expect(code).toBe(127);
		const marker = JSON.parse(readFileSync(state.doneMarkerPath, "utf-8"));
		expect(marker.exitCode).toBe(127);
	});

	it("resolves ONLY after the JSONL file is fully flushed; marker is atomic (no .tmp residue)", async () => {
		// large output (~6MB) — the old pipe+resolve-on-close shape could
		// return with the write stream still flushing.
		const { bin, expectedBytes } = writeEmittingBin(80_000);
		const { statePath, state } = makeState();
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		const code = await codexResume({
			statePath,
			env: { ...process.env, FLYWHEEL_CODEX_BIN: bin },
		});
		expect(code).toBe(0);
		// the INSTANT codexResume resolves, the file must already be complete
		expect(statSyncSize(state.jsonlPath)).toBe(expectedBytes);
		expect(existsSync(state.doneMarkerPath)).toBe(true);
		expect(existsSync(`${state.doneMarkerPath}.tmp`)).toBe(false);
		const marker = JSON.parse(readFileSync(state.doneMarkerPath, "utf-8"));
		expect(marker.exitCode).toBe(0);
		stdoutSpy.mockRestore();
	});

	it("renders progress lines to the helper stdout (= pane) while writing the identical bytes to the JSONL file", async () => {
		const { bin, expectedBytes } = writeEmittingBin(3);
		const { statePath, state } = makeState();
		let paneOut = "";
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			paneOut += chunk.toString();
			return true;
		}) as typeof process.stdout.write);

		const code = await codexResume({
			statePath,
			env: { ...process.env, FLYWHEEL_CODEX_BIN: bin },
		});
		stdoutSpy.mockRestore();
		expect(code).toBe(0);
		// pane: three human progress lines
		expect(paneOut.match(/▶ ls \(exit 0\)/g)?.length).toBe(3);
		// file: byte-identical JSONL (renderer never mutates the file side)
		expect(statSyncSize(state.jsonlPath)).toBe(expectedBytes);
		const fileLines = readFileSync(state.jsonlPath, "utf-8").trim().split("\n");
		expect(fileLines).toHaveLength(3);
		for (const l of fileLines) expect(() => JSON.parse(l)).not.toThrow();
	});
});

function statSyncSize(p: string): number {
	return readFileSync(p).byteLength;
}
