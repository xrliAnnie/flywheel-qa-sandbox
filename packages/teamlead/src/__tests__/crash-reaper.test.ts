/**
 * FLY-720: unit coverage for the liveness-based crash reaper. Uses a real
 * in-memory StateStore; the projected-death reader is injected here. Its actual
 * generation/identity and cross-store proof are covered by body-death tests.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CrashReapDeps,
	defaultWriteCrashLog,
	reapCrashedRunners,
} from "../bridge/crash-reaper.js";
import type { TmuxTargetLookup } from "../bridge/tmux-lookup.js";
import { StateStore } from "../StateStore.js";

function minutesAgoSqlite(n: number): string {
	return new Date(Date.now() - n * 60_000)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

const FOUND: (w: string) => TmuxTargetLookup = (tmuxWindow) => ({
	kind: "found",
	target: { tmuxWindow, sessionName: tmuxWindow.split(":")[0] },
});

describe("reapCrashedRunners (FLY-2919 display cleanup)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());
	function seed(status = "failed", stale = 0) {
		store.upsertSession({
			execution_id: "z1",
			issue_id: "i-z1",
			project_name: "geo",
			status,
			heartbeat_at: minutesAgoSqlite(stale),
		});
	}
	function baseDeps(over: Partial<CrashReapDeps> = {}): CrashReapDeps {
		return {
			enabled: true,
			nowMs: Date.now(),
			store,
			candidates: ["z1"],
			readCurrentDeath: (id) =>
				store.getSession(id)?.status === "failed"
					? { obligationId: `body_death:${id}:1`, disposition: "failed" }
					: undefined,
			isSuppressed: () => false,
			hasPendingCompleteMarker: () => false,
			lookupTmuxTarget: () => FOUND("geo:@1"),
			inspectWindow: async () => "owned",
			captureScrollback: vi.fn(async () => ({
				ok: true as const,
				text: "CRASH",
			})),
			writeCrashLog: vi.fn(() => ({ path: "/tmp/crash.log" })),
			killCmuxLinkedSession: vi.fn(async () => ({ killed: true })),
			killTmuxWindow: vi.fn(async () => ({ killed: true })),
			closeTerminalView: vi.fn(async () => {}),
			archiveThread: vi.fn(async () => {}),
			log: () => {},
			...over,
		};
	}
	it.each(["unknown", "absent"] as const)(
		"FLY-2919 %s window ownership never kills a recycled target",
		async (verdict) => {
			seed();
			const deps = baseDeps({ inspectWindow: async () => verdict });
			const result = await reapCrashedRunners(deps);
			expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
			expect(deps.killTmuxWindow).not.toHaveBeenCalled();
			expect(result.reaped).toBe(verdict === "absent" ? 1 : 0);
		},
	);

	it.each(["capture", "cmux"])(
		"window reassignment during %s stops the next destructive effect",
		async (boundary) => {
			seed();
			let owned = true;
			const deps = baseDeps({
				inspectWindow: async () => (owned ? "owned" : "unknown"),
				captureScrollback: vi.fn(async () => {
					if (boundary === "capture") owned = false;
					return { ok: true as const, text: "trace" };
				}),
				killCmuxLinkedSession: vi.fn(async () => {
					owned = false;
					return { killed: true };
				}),
			});
			expect((await reapCrashedRunners(deps)).cleanupPending).toBe(1);
			expect(deps.killTmuxWindow).not.toHaveBeenCalled();
			if (boundary === "capture")
				expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
			expect(store.getSession("z1")?.status).toBe("failed");
		},
	);

	it("FLY-2919 retries display cleanup after committed death even with a fresh heartbeat", async () => {
		seed();
		const deps = baseDeps({
			killTmuxWindow: vi.fn(async () => ({ killed: false, error: "busy" })),
		});
		expect((await reapCrashedRunners(deps)).cleanupPending).toBe(1);
		expect(store.getSession("z1")?.status).toBe("failed");
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getEventsByExecution("z1")).toHaveLength(0);
		deps.killTmuxWindow = vi.fn(async () => ({ killed: true }));
		expect((await reapCrashedRunners(deps)).reaped).toBe(1);
		expect(store.getSession("z1")?.status).toBe("failed");
		expect(store.getEventsByExecution("z1")[0]?.event_id).toBe(
			"body_death:z1:1:ui-cleaned",
		);
	});
	it("FLY-2919 a dead window cannot authorize cleanup of a live body", async () => {
		seed("running", 120);
		const deps = baseDeps();
		expect((await reapCrashedRunners(deps)).reaped).toBe(0);
		expect(store.getSession("z1")?.status).toBe("running");
		expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
	});
	it("FLY-2900 never cleans a Codex quota standby body", async () => {
		seed();
		vi.spyOn(store, "isCodexQuotaStandby").mockReturnValue(true);
		const deps = baseDeps();

		const result = await reapCrashedRunners(deps);

		expect(result.reaped).toBe(0);
		expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
		expect(deps.killTmuxWindow).not.toHaveBeenCalled();
	});
	it("FLY-1238 pending CommDB projection cannot authorize cleanup or archive", async () => {
		seed();
		const deps = baseDeps({ readCurrentDeath: () => undefined });
		expect((await reapCrashedRunners(deps)).reaped).toBe(0);
		expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("failed");
	});
	it.each(["completion_preserved", "terminal_preserved", "standby"] as const)(
		"%s retains its existing closeout policy",
		async (disposition) => {
			seed();
			const deps = baseDeps({
				readCurrentDeath: () => ({
					obligationId: "body_death:z1:1",
					disposition,
				}),
			});
			expect((await reapCrashedRunners(deps)).reaped).toBe(0);
			expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		},
	);
	it.each(["mutex", "capture", "cmux", "window", "terminal"])(
		"completion arriving during %s stops further cleanup",
		async (boundary) => {
			seed();
			let pending = false;
			const arrive = (at: string) => {
				if (boundary === at) pending = true;
			};
			const deps = baseDeps({
				hasPendingCompleteMarker: () => pending,
				reconcileCompletionBeforeDeath: async () => {
					if (!pending) return false;
					store.upsertSession({
						execution_id: "z1",
						issue_id: "i-z1",
						project_name: "geo",
						status: "awaiting_review",
						decision_route: "needs_review",
					});
					pending = false;
					return true;
				},
				lifecycleMutex: {
					resolveLockKeys: (id) => [id],
					withIssueMutex: async (_keys, fn) => {
						arrive("mutex");
						return fn();
					},
				},
				captureScrollback: vi.fn(async () => {
					arrive("capture");
					return { ok: true as const, text: "CRASH" };
				}),
				killCmuxLinkedSession: vi.fn(async () => {
					arrive("cmux");
					return { killed: true };
				}),
				killTmuxWindow: vi.fn(async () => {
					arrive("window");
					return { killed: true };
				}),
				closeTerminalView: vi.fn(async () => {
					arrive("terminal");
				}),
			});
			expect((await reapCrashedRunners(deps)).reaped).toBe(0);
			expect(store.getSession("z1")?.decision_route).toBe("needs_review");
			expect(deps.archiveThread).not.toHaveBeenCalled();
			if (["mutex", "capture"].includes(boundary))
				expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
			if (["mutex", "capture", "cmux"].includes(boundary))
				expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		},
	);
	it.each(["mutex", "capture", "cmux", "window", "terminal", "archive"])(
		"generation or managed-policy change during %s fences the next effect and receipt",
		async (boundary) => {
			seed();
			let current = true;
			const arrive = (at: string) => {
				if (boundary === at) current = false;
			};
			const deps = baseDeps({
				readCurrentDeath: () =>
					current
						? { obligationId: "body_death:z1:1", disposition: "failed" }
						: undefined,
				lifecycleMutex: {
					resolveLockKeys: (id) => [id],
					withIssueMutex: async (_keys, fn) => {
						arrive("mutex");
						return fn();
					},
				},
				captureScrollback: vi.fn(async () => {
					arrive("capture");
					return { ok: true as const, text: "CRASH" };
				}),
				killCmuxLinkedSession: vi.fn(async () => {
					arrive("cmux");
					return { killed: true };
				}),
				killTmuxWindow: vi.fn(async () => {
					arrive("window");
					return { killed: true };
				}),
				closeTerminalView: vi.fn(async () => {
					arrive("terminal");
				}),
				archiveThread: vi.fn(async () => {
					arrive("archive");
				}),
			});
			expect((await reapCrashedRunners(deps)).reaped).toBe(0);
			expect(store.getEventsByExecution("z1")).toHaveLength(0);
			if (["mutex", "capture"].includes(boundary))
				expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
			if (["mutex", "capture", "cmux"].includes(boundary))
				expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		},
	);
	it.each(["read_error", "replay_error", "held", "pending"])(
		"%s completion evidence vetoes cleanup",
		async (mode) => {
			seed();
			const deps = baseDeps({
				hasPendingCompleteMarker: () => {
					if (mode === "read_error") throw new Error("EACCES");
					return mode === "pending";
				},
				reconcileCompletionBeforeDeath: async () => {
					if (mode === "replay_error") throw new Error("busy");
					return mode === "held";
				},
			});
			expect((await reapCrashedRunners(deps)).reaped).toBe(0);
			expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
		},
	);
	it.each(["reconcile", "microtask"])(
		"synchronous marker fence after %s await",
		async (mode) => {
			seed();
			let pending = false;
			const deps = baseDeps({
				hasPendingCompleteMarker: () => {
					if (mode === "microtask")
						queueMicrotask(() => {
							pending = true;
						});
					return pending;
				},
				reconcileCompletionBeforeDeath: async () => {
					if (mode === "reconcile") pending = true;
					return false;
				},
			});
			expect((await reapCrashedRunners(deps)).reaped).toBe(0);
			expect(deps.killCmuxLinkedSession).not.toHaveBeenCalled();
		},
	);
	it("preserves forensic capture then cmux then window ordering after death", async () => {
		seed();
		const order: string[] = [];
		const deps = baseDeps({
			captureScrollback: vi.fn(async () => {
				order.push("capture");
				expect(store.getSession("z1")?.status).toBe("failed");
				return { ok: true as const, text: "trace" };
			}),
			killCmuxLinkedSession: vi.fn(async () => {
				order.push("cmux");
				return { killed: true };
			}),
			killTmuxWindow: vi.fn(async () => {
				order.push("window");
				return { killed: true };
			}),
		});
		expect((await reapCrashedRunners(deps)).reaped).toBe(1);
		expect(order).toEqual(["capture", "cmux", "window"]);
	});
	it("cmux failure preserves its window locator for retry without reviving the dead body", async () => {
		seed();
		const deps = baseDeps({
			killCmuxLinkedSession: vi.fn(async () => ({
				killed: false,
				error: "busy",
			})),
		});
		expect((await reapCrashedRunners(deps)).cleanupPending).toBe(1);
		expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("failed");
	});
	it.each(["pending", "error"])(
		"%s window lookup leaves cleanup pending, not the body running",
		async (kind) => {
			seed();
			const deps = baseDeps({
				lookupTmuxTarget: () =>
					kind === "pending"
						? FOUND("geo:pending")
						: { kind: "error", error: "busy" },
			});
			expect((await reapCrashedRunners(deps)).cleanupPending).toBe(1);
			expect(deps.killTmuxWindow).not.toHaveBeenCalled();
			expect(store.getSession("z1")?.status).toBe("failed");
		},
	);
	it("missing display target is already clean after independently proven body death", async () => {
		seed();
		const deps = baseDeps({ lookupTmuxTarget: () => ({ kind: "gone" }) });
		expect((await reapCrashedRunners(deps)).reaped).toBe(1);
		expect(deps.killTmuxWindow).not.toHaveBeenCalled();
	});
	it.each(["capture", "terminal"])(
		"best-effort %s failure does not block cleanup",
		async (boundary) => {
			seed();
			const deps = baseDeps(
				boundary === "capture"
					? {
							captureScrollback: vi.fn(async () => {
								throw new Error("capture failed");
							}),
						}
					: {
							closeTerminalView: vi.fn(async () => {
								throw new Error("view failed");
							}),
						},
			);
			expect((await reapCrashedRunners(deps)).reaped).toBe(1);
			if (boundary === "capture")
				expect(store.getEventsByExecution("z1")[0]?.payload).toMatchObject({
					dumpError: "capture failed",
				});
		},
	);
	it("concurrent terminal completion preserves its status and archive authority", async () => {
		seed();
		const deps = baseDeps({
			killTmuxWindow: vi.fn(async () => {
				store.forceStatus("z1", "completed", minutesAgoSqlite(0));
				return { killed: true };
			}),
		});
		expect((await reapCrashedRunners(deps)).transitionSkipped).toBe(1);
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("completed");
	});
	it.each(["disabled", "held"])(
		"%s defers only display cleanup",
		async (mode) => {
			seed();
			const deps = baseDeps({
				enabled: mode !== "disabled",
				isSuppressed: () => mode === "held",
			});
			expect((await reapCrashedRunners(deps)).reaped).toBe(0);
			expect(deps.killTmuxWindow).not.toHaveBeenCalled();
			expect(store.getSession("z1")?.status).toBe("failed");
		},
	);
});

describe("defaultWriteCrashLog (FLY-720)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly720-crashlog-home-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes the crash log 0600 with the captured text (atomic rename)", () => {
		// Point HOME at a temp dir so the log lands under a hermetic location.
		const prevHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const r = defaultWriteCrashLog(
				"exec-1/weird",
				"trace-body",
				1730000000000,
			);
			expect(r.error).toBeUndefined();
			expect(r.path).toBeDefined();
			const path = r.path as string;
			// sanitized execId (no slash) + stamp
			expect(path).toContain("exec-1_weird-1730000000000.log");
			expect(readFileSync(path, "utf8")).toBe("trace-body");
			const mode = statSync(path).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			process.env.HOME = prevHome;
		}
	});
});
