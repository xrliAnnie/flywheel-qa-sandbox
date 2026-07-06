import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";

// Mock node:child_process to control osascript / tmux invocations.
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

// Mock tmux-lookup so we can drive isTmuxWindowAlive responses.
vi.mock("../bridge/tmux-lookup.js", () => ({
	isTmuxWindowAlive: vi.fn(),
}));

import { execFile, execFileSync } from "node:child_process";
import { reapTerminalTabs } from "../bridge/terminal-tab-reaper.js";
import { isTmuxWindowAlive } from "../bridge/tmux-lookup.js";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockExecFileSync = execFileSync as unknown as ReturnType<typeof vi.fn>;
const mockIsAlive = isTmuxWindowAlive as ReturnType<typeof vi.fn>;

function setOsascriptList(titles: string[]) {
	mockExecFile.mockImplementation(
		(
			_cmd: string,
			_args: string[],
			_optsOrCb: unknown,
			cb?: (err: Error | null, stdout?: string, stderr?: string) => void,
		) => {
			// Support 3-arg and 4-arg forms (with and without options object)
			const callback =
				typeof _optsOrCb === "function" ? (_optsOrCb as typeof cb) : cb;
			callback?.(null, `${titles.join("\n")}\n`, "");
		},
	);
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

async function makeStore(): Promise<StateStore> {
	const dir = mkdtempSync(join(tmpdir(), "fly116-reaper-"));
	tempDirs.push(dir);
	return await StateStore.create(join(dir, "state.db"));
}

function seed(
	store: StateStore,
	executionId: string,
	status: string,
	role?: string,
) {
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-116",
		project_name: "flywheel",
		status,
		session_role: role,
	});
}

describe("reapTerminalTabs (FLY-116)", () => {
	let store: StateStore;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		store = await makeStore();
		mockExecFileSync.mockImplementation(() => "");
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

	it("closes tabs whose StateStore status is in AUTO_CLOSE_STATES", async () => {
		seed(store, "exec_a", "completed");
		setOsascriptList([
			"flywheel:runner:runner-flywheel:flywheel:exec_a:@10:engineer",
		]);
		mockIsAlive.mockResolvedValue(false);

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(1);
		expect(result.preserved).toBe(0);
	});

	it("PRESERVES failed/blocked tabs even when tmux window is dead (Codex Round 2 #7)", async () => {
		seed(store, "exec_b", "failed");
		seed(store, "exec_c", "blocked");
		setOsascriptList([
			"flywheel:runner:runner-flywheel:flywheel:exec_b:@11:engineer",
			"flywheel:runner:runner-flywheel:flywheel:exec_c:@12:qa",
		]);
		mockIsAlive.mockResolvedValue(false); // tmux dead — would close non-preserve tabs

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(2);
		expect(result.preserved).toBe(2);
		expect(result.closed).toBe(0);
	});

	it("preserves running session (no AUTO_CLOSE, tmux alive) — leaves tab alone", async () => {
		seed(store, "exec_d", "running");
		setOsascriptList(["flywheel:runner:runner-flywheel:flywheel:exec_d:@13"]);
		mockIsAlive.mockResolvedValue(true);

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(0);
		expect(result.preserved).toBe(0);
	});

	it("orphan path: no StateStore row + tmux dead → close (true orphan)", async () => {
		// Don't seed any session. Reaper finds tab → no row → tmux dead → close.
		setOsascriptList([
			"flywheel:runner:runner-flywheel:flywheel:exec_orphan:@99:engineer",
		]);
		mockIsAlive.mockResolvedValue(false);

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(1);
	});

	it("orphan with tmux alive — does NOT close (might be a different lifecycle)", async () => {
		setOsascriptList([
			"flywheel:runner:runner-flywheel:flywheel:exec_orphan2:@100",
		]);
		mockIsAlive.mockResolvedValue(true);

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(0);
	});

	it("uses parsed sessionName from title (not reconstructed) — Codex Round 2 #6", async () => {
		// Title says "retry-geoforge3d", project says "geoforge3d".
		// Reaper must check tmux window with parsed sessionName, NOT
		// reconstruct as `runner-${project}`.
		seed(store, "exec_e", "completed");
		setOsascriptList([
			"flywheel:runner:retry-geoforge3d:geoforge3d:exec_e:@77:engineer",
		]);
		mockIsAlive.mockResolvedValue(false);

		await reapTerminalTabs(store);

		// isTmuxWindowAlive must be called with the parsed prefix.
		expect(mockIsAlive).toHaveBeenCalledWith("retry-geoforge3d:@77");
	});

	it("returns empty result when osascript enumeration fails (e.g. Terminal not running)", async () => {
		mockExecFile.mockImplementation(
			(
				_cmd: string,
				_args: string[],
				_optsOrCb: unknown,
				cb?: (err: Error | null, stdout?: string, stderr?: string) => void,
			) => {
				const callback =
					typeof _optsOrCb === "function" ? (_optsOrCb as typeof cb) : cb;
				callback?.(new Error("Terminal not running"));
			},
		);

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(0);
		expect(result.closed).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	it("ignores titles that don't match the FLY-116 prefix", async () => {
		seed(store, "exec_a", "completed");
		setOsascriptList([
			"random-tab-title",
			"flywheel:runner:runner-flywheel:flywheel:exec_a:@10",
		]);
		mockIsAlive.mockResolvedValue(false);

		const result = await reapTerminalTabs(store);

		expect(result.scanned).toBe(2);
		expect(result.closed).toBe(1);
	});
});
