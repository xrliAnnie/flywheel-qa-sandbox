/**
 * FLY-754: one-shot Bridge startup sweep for leaked `viewer-<execId>` tmux
 * sessions (the FLY-116 Terminal.app viewer's linked sessions that were never
 * destroyed). See viewer-session-reaper.ts for the kill rules.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { sanitizeTmuxName } from "flywheel-core";
import {
	deriveOwnedBaseSessions,
	reapViewerSessions,
} from "../bridge/viewer-session-reaper.js";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

/** Drive `tmux ls` output + record kill-session calls. */
function setTmuxLs(
	lines: string[],
	opts?: { lsError?: Error; killErrorFor?: string },
) {
	mockExecFile.mockImplementation(
		(
			_cmd: string,
			args: string[],
			_optsOrCb: unknown,
			maybeCb?: (err: Error | null, stdout?: string, stderr?: string) => void,
		) => {
			const callback = (
				typeof _optsOrCb === "function" ? _optsOrCb : maybeCb
			) as (err: Error | null, stdout?: string, stderr?: string) => void;
			if (args[0] === "ls") {
				if (opts?.lsError) callback(opts.lsError, "", "no server running");
				else callback(null, `${lines.join("\n")}\n`, "");
				return;
			}
			if (args[0] === "kill-session") {
				const target = args[2] ?? "";
				if (opts?.killErrorFor && target === opts.killErrorFor) {
					callback(new Error(`can't find session: ${target}`), "", "");
					return;
				}
				callback(null, "", "");
				return;
			}
			callback(null, "", "");
		},
	);
}

function killCalls(): string[] {
	return mockExecFile.mock.calls
		.filter((c) => (c[1] as string[])[0] === "kill-session")
		.map((c) => (c[1] as string[])[2]);
}

const tempDirs: string[] = [];

async function makeStore(): Promise<StateStore> {
	const dir = mkdtempSync(join(tmpdir(), "fly754-reaper-"));
	tempDirs.push(dir);
	return await StateStore.create(join(dir, "state.db"));
}

function seed(store: StateStore, executionId: string, status: string) {
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-754",
		project_name: "flywheel",
		status,
	});
}

const OWNED = new Set(["runner-flywheel"]);

describe("reapViewerSessions (FLY-754)", () => {
	let store: StateStore;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		store = await makeStore();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (tempDirs.length) {
			const d = tempDirs.pop();
			if (d) {
				try {
					rmSync(d, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		}
	});

	it("kills a 0-client viewer whose session is in a terminal outcome state + writes audit event", async () => {
		seed(store, "exec-done", "completed");
		setTmuxLs(["viewer-exec-done|runner-flywheel|0"]);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.scanned).toBe(1);
		expect(r.killed).toBe(1);
		expect(killCalls()).toEqual(["=viewer-exec-done"]);
		const events = store.getEventsByExecution("exec-done");
		expect(events.some((e) => e.event_type === "viewer_session_reaped")).toBe(
			true,
		);
	});

	it("kills for every outcome status EXCEPT approved_to_ship", async () => {
		const killable = [
			"completed",
			"approved",
			"blocked",
			"failed",
			"rejected",
			"deferred",
			"shelved",
			"terminated",
		];
		const lines: string[] = [];
		for (const s of killable) {
			seed(store, `exec-${s}`, s);
			lines.push(`viewer-exec-${s}|runner-flywheel|0`);
		}
		seed(store, "exec-approved_to_ship", "approved_to_ship");
		lines.push("viewer-exec-approved_to_ship|runner-flywheel|0");
		setTmuxLs(lines);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.killed).toBe(killable.length);
		expect(r.skippedActive).toBe(1);
		expect(killCalls()).not.toContain("=viewer-exec-approved_to_ship");
	});

	it("skips live sessions (running / pending / awaiting_review)", async () => {
		for (const s of ["running", "pending", "awaiting_review"]) {
			seed(store, `exec-${s}`, s);
		}
		setTmuxLs([
			"viewer-exec-running|runner-flywheel|0",
			"viewer-exec-pending|runner-flywheel|0",
			"viewer-exec-awaiting_review|runner-flywheel|0",
		]);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.killed).toBe(0);
		expect(r.skippedActive).toBe(3);
		expect(killCalls()).toEqual([]);
	});

	it("kills a no-row orphan ONLY when its group belongs to this Bridge", async () => {
		setTmuxLs([
			"viewer-orphan-ours|runner-flywheel|0",
			"viewer-orphan-foreign|runner-test-slot-3|0",
		]);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.killed).toBe(1);
		expect(r.skippedForeign).toBe(1);
		expect(killCalls()).toEqual(["=viewer-orphan-ours"]);
	});

	it("never kills an attached viewer (someone is watching)", async () => {
		seed(store, "exec-done", "completed");
		setTmuxLs(["viewer-exec-done|runner-flywheel|1"]);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.killed).toBe(0);
		expect(r.skippedAttached).toBe(1);
		expect(killCalls()).toEqual([]);
	});

	it("ignores non-viewer sessions entirely", async () => {
		seed(store, "exec-done", "completed");
		setTmuxLs([
			"runner-flywheel|runner-flywheel|0",
			"cmux-FLY-754-claude-something|runner-flywheel|1",
			"flywheel|flywheel|1",
		]);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.scanned).toBe(0);
		expect(r.killed).toBe(0);
		expect(killCalls()).toEqual([]);
	});

	it("tmux ls failure (no server) is benign — empty result, no throw", async () => {
		setTmuxLs([], { lsError: new Error("no server running on /tmp/tmux") });

		const r = await reapViewerSessions(store, OWNED);

		expect(r.scanned).toBe(0);
		expect(r.killed).toBe(0);
		expect(r.errors).toEqual([]);
	});

	it("one kill failure is recorded and does not stop the rest", async () => {
		seed(store, "exec-a", "completed");
		seed(store, "exec-b", "completed");
		setTmuxLs(
			["viewer-exec-a|runner-flywheel|0", "viewer-exec-b|runner-flywheel|0"],
			{ killErrorFor: "=viewer-exec-a" },
		);

		const r = await reapViewerSessions(store, OWNED);

		expect(r.killed).toBe(1);
		expect(r.errors).toHaveLength(1);
		expect(killCalls()).toContain("=viewer-exec-b");
	});
});

describe("deriveOwnedBaseSessions (FLY-754)", () => {
	it("matches run-infra's base session derivation byte-for-byte", () => {
		const names = [
			"flywheel",
			"test-slot-3",
			"My Project With Spaces",
			"weird:chars.here",
			"a-very-long-project-name-that-should-exceed-the-tmux-name-length-cap-somewhere",
		];
		const derived = deriveOwnedBaseSessions(names);
		for (const n of names) {
			expect(derived.has(sanitizeTmuxName(`runner-${n}`))).toBe(true);
		}
		expect(derived.size).toBe(names.length);
	});
});
