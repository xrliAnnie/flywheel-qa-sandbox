import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeFlagStore } from "../../../bridge/flag-store-runtime.js";
import { StateStore } from "../../../StateStore.js";
import * as runtimeModule from "../codex-lead-runtime.js";
import * as rotation from "../codex-lead-thread-rotation.js";
import {
	buildTuiGeneration,
	parseCodexLeadTuiRuntimeConfig,
} from "../codex-lead-tui-runtime.js";
import type { LeadInputRouter } from "../LeadInputRouter.js";
import { LeadJournal } from "../LeadJournal.js";
import { SqliteJournalStore } from "../SqliteJournalStore.js";

const mocks = vi.hoisted(() => ({
	alive: true,
	killOk: true,
	create: vi.fn(),
	kill: vi.fn(),
	router: null as LeadInputRouter | null,
	gatewayStart: vi.fn(async () => {}),
	gatewayStop: vi.fn(async () => {}),
}));
vi.mock("../../../ProjectConfig.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	loadProjects: () => [],
}));
vi.mock("../tui-window.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	ensureTuiWindow: () => {
		mocks.create();
		mocks.alive = true;
		return true;
	},
	isTuiWindowAlive: () => mocks.alive,
	killTuiWindow: () => {
		mocks.kill();
		if (mocks.killOk) mocks.alive = false;
		return mocks.killOk;
	},
}));
vi.mock("../CodexLeadInboxSocket.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	CodexLeadInboxServer: class {
		constructor(options: { router: LeadInputRouter }) {
			mocks.router = options.router;
		}
	},
}));
vi.mock("../CodexDiscordRuntimeOwnership.js", () => ({
	CodexDiscordRuntimeOwnership: class {
		start = mocks.gatewayStart;
		stop = mocks.gatewayStop;
		mailboxReady = () => true;
	},
}));

const OLD = "019eaf5d-a5b7-7a72-b73f-cd1063892aa1";
const NEW = "019eaf5d-a5b7-7a72-b73f-cd1063892aa2";
const NOW = Date.parse("2026-09-15T01:00:00.000Z");
const iso = (n: number) => new Date(n).toISOString();
const baseLedger = (): rotation.RotationLedger => ({
	v: 1,
	currentThreadId: OLD,
	startedAt: iso(NOW - 8 * 86400000),
	previousThreadId: null,
	lastAttemptAt: null,
	lastAttemptOutcome: null,
	pending: null,
	readinessPending: null,
});
let dir: string;
let flagStore: StateStore;
const generations: Array<{ stop(): Promise<void> }> = [];
beforeEach(async () => {
	vi.useFakeTimers({
		toFake: [
			"Date",
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
		],
	});
	vi.setSystemTime(NOW);
	dir = fs.mkdtempSync(join(tmpdir(), "fly2550-runtime-"));
	flagStore = await StateStore.create(join(dir, "teamlead.db"));
	initializeFlagStore(flagStore, {});
	mocks.alive = true;
	mocks.killOk = true;
	mocks.router = null;
	mocks.create.mockClear();
	mocks.kill.mockClear();
	mocks.gatewayStart.mockReset().mockResolvedValue();
	mocks.gatewayStop.mockClear();
});
afterEach(async () => {
	for (const generation of generations.splice(0)) await generation.stop();
	flagStore.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
	fs.rmSync(dir, { recursive: true, force: true });
});

function harness(
	options: {
		off?: boolean;
		pending?: boolean;
		saved?: string | null;
		ledger?: rotation.RotationLedger;
		complete?: boolean;
	} = {},
) {
	if (options.off) {
		expect(
			flagStore.applyScopedFlagValueChange({
				name: "codex_lead_thread_rotation",
				scope: "test",
				op: "set",
				rawTo: "0",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "test rotation rollback",
			}),
		).toMatchObject({ ok: true });
	}
	const config = parseCodexLeadTuiRuntimeConfig({
		FLYWHEEL_LEAD_ID: "test",
		FLYWHEEL_PROJECT_NAME: "test",
		FLYWHEEL_LEAD_KEY: "test-test",
		FLYWHEEL_LEAD_BACKEND: "codex-app-server",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		DISCORD_EXPECTED_BOT_USER_ID: "12345678901234567",
		DISCORD_BOT_TOKEN: "unit-token",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chat",
		FLYWHEEL_BRIDGE_URL: "http://invalid.test",
		FLYWHEEL_API_TOKEN: "unit-token",
		FLYWHEEL_CODEX_LEAD_OUTBOUND: "bridge",
		FLYWHEEL_CODEX_LEAD_STATE_DIR: dir,
		FLYWHEEL_CODEX_BIN: "/unit/codex",
		CODEX_HOME: join(dir, "home"),
		FLYWHEEL_COMM_DB: join(dir, "comm.db"),
		FLYWHEEL_CODEX_TUI_CWD: dir,
		TEAMLEAD_DB_PATH: join(dir, "teamlead.db"),
	});
	fs.mkdirSync(join(config.codexHome, "sessions"), { recursive: true });
	for (const id of [OLD, NEW])
		fs.writeFileSync(
			join(
				config.codexHome,
				"sessions",
				`rollout-2026-09-07T01-00-00-${id}.jsonl`,
			),
			"",
		);
	if (options.saved !== null)
		fs.writeFileSync(config.threadIdPath, options.saved ?? OLD);
	const path = join(dir, "thread-rotation.json");
	const ledger = options.ledger ?? baseLedger();
	if (options.pending)
		ledger.pending = {
			fromThreadId: OLD,
			requestedAt: iso(NOW),
			reason: "period",
			attemptStartedAt: null,
		};
	rotation.writeRotationLedger(path, ledger, NOW);
	const store = new SqliteJournalStore(config.journalDbPath);
	if (options.complete !== false)
		store.insertAccepted({
			id: "real",
			idempotencyKey: "real",
			source: "discord",
			payload: "real prior input",
			state: "completed",
			createdAt: NOW - 86400000,
			updatedAt: NOW - 86400000,
		});
	store.close();
	const requests: Array<{ method: string; params: any }> = [];
	let respond: (method: string, params: any) => unknown | Promise<unknown> = (
		method,
	) => {
		if (method === "thread/start" || method === "thread/resume")
			return { thread: { id: method === "thread/start" ? NEW : OLD } };
		if (method === "thread/turns/list")
			return { data: [{ status: "completed" }] };
		if (method === "turn/start") return { turn: { id: "turn-unit" } };
		return {};
	};
	let emit: (method: string, params: unknown) => void = () => {};
	const rebuild = vi.fn(() => true);
	const make = buildTuiGeneration(
		config,
		{ info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		{
			requestRebuild: rebuild,
			createSender: () => ({
				enqueue: async () => "outbox",
				deliver: async () => {},
			}),
			preflight: async () => {},
			connectDaemon: async () => {
				const handlers = new Map<string, Array<(value?: unknown) => void>>();
				const fire = (event: string, value?: unknown) => {
					for (const cb of handlers.get(event) ?? []) cb(value);
				};
				emit = (method, params) =>
					fire("message", JSON.stringify({ method, params }));
				return {
					send(raw: string) {
						const msg = JSON.parse(raw);
						requests.push(msg);
						if (msg.id !== undefined)
							void Promise.resolve().then(async () => {
								try {
									fire(
										"message",
										JSON.stringify({
											id: msg.id,
											result: await respond(msg.method, msg.params),
										}),
									);
									if (msg.method === "turn/start")
										emit("turn/completed", {
											turn: { id: "turn-unit", status: "completed" },
										});
								} catch {
									fire(
										"message",
										JSON.stringify({
											id: msg.id,
											error: { code: -1, message: "injected failure" },
										}),
									);
								}
							});
					},
					close() {
						fire("close");
					},
					terminate() {
						fire("close");
					},
					on(event: string, cb: (value?: unknown) => void) {
						handlers.set(event, [...(handlers.get(event) ?? []), cb]);
					},
				} as never;
			},
		},
	);
	return {
		config,
		path,
		requests,
		rebuild,
		emit: (method: string, params: unknown) => emit(method, params),
		respond: (fn: typeof respond) => {
			respond = fn;
		},
		make() {
			const gen = make();
			generations.push(gen);
			return gen;
		},
		read: () =>
			JSON.parse(fs.readFileSync(path, "utf8")) as rotation.RotationLedger,
		receipts: () =>
			fs.existsSync(join(dir, "thread-rotation.jsonl"))
				? fs
						.readFileSync(join(dir, "thread-rotation.jsonl"), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [],
	};
}

describe("rotation pending and replay", () => {
	it("consumes pending only after terminal proof and a durable attempt marker; never resumes old", async () => {
		const h = harness({ pending: true });
		h.respond((method) => {
			if (method === "thread/turns/list")
				return { data: [{ status: "completed" }] };
			if (method === "thread/start") {
				expect(h.read().pending?.attemptStartedAt).toBe(iso(NOW));
				return { thread: { id: NEW } };
			}
			return {};
		});
		await h.make().start();
		expect(
			h.requests
				.filter((r) => r.method.startsWith("thread/"))
				.map((r) => r.method),
		).toEqual(["thread/turns/list", "thread/start"]);
		expect(
			h.requests.find((r) => r.method === "thread/start")?.params
				.developerInstructions,
		).toBe(rotation.rotationDeveloperNote(NOW, OLD));
		expect(fs.readFileSync(h.config.threadIdPath, "utf8")).toBe(NEW);
		expect(h.read()).toMatchObject({
			currentThreadId: NEW,
			previousThreadId: OLD,
			pending: null,
			readinessPending: null,
			lastAttemptOutcome: "rotated",
		});
		expect(h.receipts().map((r) => r.event)).toEqual([
			"rotated",
			"rotation_bootstrap",
			"rotation_ready",
		]);
	});
	it.each(["W1", "W2", "W3", "W4", "W5"])(
		"%s survives three generations without duplicate thread/start",
		async (cut) => {
			const ledger = baseLedger();
			ledger.pending = {
				fromThreadId: OLD,
				requestedAt: iso(NOW),
				reason: "period",
				attemptStartedAt: cut === "W1" ? null : iso(NOW),
			};
			if (cut === "W4" || cut === "W5")
				Object.assign(ledger, {
					currentThreadId: NEW,
					previousThreadId: OLD,
					pending: null,
					readinessPending: {
						to: NEW,
						requestedAt: iso(NOW),
						degradedAt: null,
					},
				});
			const h = harness({
				ledger,
				saved: ["W3", "W4", "W5"].includes(cut) ? NEW : OLD,
			});
			for (let i = 0; i < 3; i++) {
				const gen = h.make();
				await gen.start();
				await gen.stop();
			}
			expect(
				h.requests.filter((r) => r.method === "thread/start"),
			).toHaveLength(cut === "W1" ? 1 : 0);
			expect(h.read().pending).toBeNull();
			if (cut === "W2")
				expect(h.read().lastAttemptOutcome).toBe(
					"reconciled:pending_attempted",
				);
			if (cut === "W4" || cut === "W5")
				expect(
					h.receipts().filter((r) => r.event === "rotation_ready"),
				).toHaveLength(1);
		},
	);
	it.each([[], [{ status: "inProgress" }], [{ status: "unknown" }], [null]])(
		"ambiguous turns %j cancel pending with durable backoff",
		async (data) => {
			const h = harness({ pending: true });
			h.respond((method) =>
				method === "thread/turns/list" ? { data } : { thread: { id: OLD } },
			);
			await h.make().start();
			expect(h.requests.some((r) => r.method === "thread/start")).toBe(false);
			expect(h.read()).toMatchObject({
				pending: null,
				lastAttemptAt: iso(NOW),
				lastAttemptOutcome: "reconciled:pending_busy",
			});
		},
	);
	it("a flag database read failure preserves pending and starts the existing thread", async () => {
		const h = harness({ pending: true });
		h.config.flagStoreDbPath = join(dir, "missing.db");
		const before = fs.readFileSync(h.path, "utf8");
		await h.make().start();
		expect(fs.existsSync(h.config.flagStoreDbPath)).toBe(false);
		expect(fs.readFileSync(h.path, "utf8")).toBe(before);
		expect(h.receipts()).toEqual([]);
		expect(h.requests.some((r) => r.method === "thread/resume")).toBe(true);
		expect(
			h.requests.some((r) =>
				["thread/start", "thread/turns/list"].includes(r.method),
			),
		).toBe(false);
	});
	it("a store change is read by the next generation before pending consumption", async () => {
		const h = harness({ pending: true, off: true });
		const first = h.make();
		await first.start();
		expect(h.requests.some((r) => r.method === "thread/start")).toBe(false);
		await first.stop();
		expect(
			flagStore.applyScopedFlagValueChange({
				name: "codex_lead_thread_rotation",
				scope: "test",
				op: "clear",
				rawTo: null,
				expectedChangeSeq: flagStore.getFlagValueChangeSeq(
					"codex_lead_thread_rotation",
					"test",
				),
				actor: "fixture",
				reason: "resume rotation",
			}),
		).toMatchObject({ ok: true });
		await h.make().start();
		expect(h.requests.filter((r) => r.method === "thread/start")).toHaveLength(
			1,
		);
	});
	it("off preserves ledger bytes and consumes neither pending nor readiness", async () => {
		const ledger = {
			...baseLedger(),
			readinessPending: { to: OLD, requestedAt: iso(NOW), degradedAt: null },
		};
		const h = harness({ off: true, pending: true, ledger });
		const before = fs.readFileSync(h.path, "utf8");
		await h.make().start();
		await vi.advanceTimersByTimeAsync(8 * 86400000);
		expect(fs.readFileSync(h.path, "utf8")).toBe(before);
		expect(h.receipts()).toEqual([]);
		expect(
			h.requests.some((r) =>
				["thread/start", "thread/turns/list"].includes(r.method),
			),
		).toBe(false);
	});
	it.each(["", "bad-id", "x".repeat(257)])(
		"invalid saved id fails loudly: %s",
		async (saved) => {
			const h = harness({ saved });
			await expect(h.make().start()).rejects.toThrow(/thread-id/);
			expect(h.requests.some((r) => r.method.startsWith("thread/"))).toBe(
				false,
			);
		},
	);
	it.each([
		"thread_start_failed",
		"thread_id_invalid",
		"thread_id_write_failed",
	])("%s resumes old with durable backoff", async (reason) => {
		const h = harness({ pending: true });
		if (reason === "thread_id_write_failed")
			vi.spyOn(runtimeModule, "writeThreadId").mockImplementation(() => {
				throw new Error("disk");
			});
		h.respond((method) => {
			if (method === "thread/turns/list")
				return { data: [{ status: "completed" }] };
			if (method === "thread/start") {
				if (reason === "thread_start_failed") throw new Error("rpc");
				return { thread: { id: reason === "thread_id_invalid" ? "bad" : NEW } };
			}
			return { thread: { id: OLD } };
		});
		await h.make().start();
		expect(fs.readFileSync(h.config.threadIdPath, "utf8")).toBe(OLD);
		expect(h.read()).toMatchObject({
			pending: null,
			lastAttemptAt: iso(NOW),
			lastAttemptOutcome: `rotation_failed:${reason}`,
		});
		expect(h.requests.some((r) => r.method === "thread/resume")).toBe(true);
	});
});

describe("rotation fence", () => {
	it("unknown founder state can pass terminal proof; queued input stays accepted and liveness never recreates during fence", async () => {
		const h = harness();
		await h.make().start();
		const creations = mocks.create.mock.calls.length;
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		expect(h.rebuild).toHaveBeenCalledWith("thread_rotation");
		expect(h.read().pending?.fromThreadId).toBe(OLD);
		const input = mocks.router!.submit({
			source: "discord",
			payload: "during rotation",
			idempotencyKey: "paused",
		});
		await vi.advanceTimersByTimeAsync(3 * 20000);
		expect(mocks.create).toHaveBeenCalledTimes(creations);
		expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
		const store = new SqliteJournalStore(h.config.journalDbPath);
		try {
			expect(store.getById(input.entryId)?.state).toBe("accepted");
		} finally {
			store.close();
		}
	});
	it("no real completed input never rotates", async () => {
		const h = harness({ complete: false });
		await h.make().start();
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS + 60000);
		expect(mocks.kill).not.toHaveBeenCalled();
		expect(h.rebuild).not.toHaveBeenCalled();
	});
	it.each(["pane_kill_unverified", "turns_list_busy", "rebuild_refused"])(
		"%s releases fence and restores pane immediately, backs off",
		async (reason) => {
			const h = harness();
			await h.make().start();
			if (reason === "pane_kill_unverified") mocks.killOk = false;
			if (reason === "turns_list_busy")
				h.respond((method) =>
					method === "thread/turns/list" ? { data: [] } : {},
				);
			if (reason === "rebuild_refused") h.rebuild.mockReturnValue(false);
			await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
			expect(h.read()).toMatchObject({
				pending: null,
				lastAttemptOutcome: `rotation_skipped:${reason}`,
			});
			expect(mocks.alive).toBe(true);
			const kills = mocks.kill.mock.calls.length;
			await vi.advanceTimersByTimeAsync(30 * 60000);
			expect(mocks.kill).toHaveBeenCalledTimes(kills);
			if (reason !== "pane_kill_unverified")
				expect(mocks.create).toHaveBeenCalledTimes(2);
		},
	);
});

describe("rotation persistence failures and readiness", () => {
	it.each([false, true])(
		"attempt marker failure, cleanup also fails=%s",
		async (cleanupFails) => {
			const h = harness({ pending: true });
			const real = rotation.writeRotationLedger;
			let writes = 0;
			vi.spyOn(rotation, "writeRotationLedger").mockImplementation(
				(...args) => {
					writes++;
					if (writes === 1 || (cleanupFails && writes === 2))
						throw new Error("disk");
					return real(...args);
				},
			);
			await h.make().start();
			expect(h.requests.some((r) => r.method === "thread/start")).toBe(false);
			if (cleanupFails) expect(h.read().pending?.attemptStartedAt).toBeNull();
			else
				expect(h.read()).toMatchObject({
					pending: null,
					lastAttemptAt: iso(NOW),
					lastAttemptOutcome: "rotation_failed:attempt_mark_failed",
				});
			await vi.advanceTimersByTimeAsync(30 * 60000);
			expect(h.rebuild).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(rotation.ROTATION_RETRY_BACKOFF_MS);
			expect(h.rebuild.mock.calls.length).toBe(cleanupFails ? 0 : 1);
		},
	);
	it.each([false, true])(
		"fence pending write failure, backoff also fails=%s",
		async (backoffFails) => {
			const h = harness();
			await h.make().start();
			const real = rotation.writeRotationLedger;
			let writes = 0;
			vi.spyOn(rotation, "writeRotationLedger").mockImplementation(
				(...args) => {
					writes++;
					if (writes === 1 || backoffFails) throw new Error("disk");
					return real(...args);
				},
			);
			await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
			expect(mocks.alive).toBe(true);
			expect(h.rebuild).not.toHaveBeenCalled();
			expect(h.receipts().at(-1)).toMatchObject({
				event: "rotation_skipped",
				reason: "pending_write_failed",
			});
			const kills = mocks.kill.mock.calls.length;
			await vi.advanceTimersByTimeAsync(
				rotation.ROTATION_RETRY_BACKOFF_MS + 60000,
			);
			if (backoffFails) expect(mocks.kill).toHaveBeenCalledTimes(kills);
			else expect(h.rebuild).toHaveBeenCalledTimes(1);
		},
	);
	it("rebuild refused with uncleared durable pending keeps the old fence", async () => {
		const h = harness();
		await h.make().start();
		h.rebuild.mockReturnValue(false);
		const real = rotation.writeRotationLedger;
		vi.spyOn(rotation, "writeRotationLedger").mockImplementation((...args) => {
			if (args[1].pending === null) throw new Error("disk");
			return real(...args);
		});
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS + 60000);
		expect(h.read().pending).not.toBeNull();
		expect(mocks.alive).toBe(false);
		expect(mocks.create).toHaveBeenCalledTimes(1);
	});
	it("post-thread-id ledger failure preserves the committed thread across restart", async () => {
		const h = harness({ pending: true });
		const real = rotation.writeRotationLedger;
		const spy = vi
			.spyOn(rotation, "writeRotationLedger")
			.mockImplementation((...args) => {
				if (args[1].currentThreadId === NEW) throw new Error("disk");
				return real(...args);
			});
		const first = h.make();
		await first.start();
		await first.stop();
		spy.mockRestore();
		expect(fs.readFileSync(h.config.threadIdPath, "utf8")).toBe(NEW);
		expect(h.receipts().find((r) => r.event === "rotated")).toMatchObject({
			ledgerWriteFailed: true,
		});
		await h.make().start();
		expect(h.read().currentThreadId).toBe(NEW);
		expect(h.requests.filter((r) => r.method === "thread/start")).toHaveLength(
			1,
		);
	});
	it("readiness-only write failure retries on the next tick without disabling generation", async () => {
		const ledger = {
			...baseLedger(),
			readinessPending: { to: OLD, requestedAt: iso(NOW), degradedAt: null },
		};
		const h = harness({ ledger });
		const real = rotation.writeRotationLedger;
		let writes = 0;
		vi.spyOn(rotation, "writeRotationLedger").mockImplementation((...args) => {
			if (++writes === 1) throw new Error("disk");
			return real(...args);
		});
		await h.make().start();
		expect(h.read().readinessPending).not.toBeNull();
		await vi.advanceTimersByTimeAsync(20000);
		expect(h.read().readinessPending).toBeNull();
		expect(
			h.receipts().filter((r) => r.event === "rotation_ready"),
		).toHaveLength(1);
	});
	it("readiness degrades once across restarts then becomes late ready when gateway starts", async () => {
		const ledger = {
			...baseLedger(),
			readinessPending: {
				to: OLD,
				requestedAt: iso(NOW - 120001),
				degradedAt: null,
			},
		};
		const h = harness({ ledger });
		let finish!: () => void;
		mocks.gatewayStart.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const gen = h.make();
		const starting = gen.start();
		for (let i = 0; i < 40; i++) await Promise.resolve();
		await vi.advanceTimersByTimeAsync(20000);
		expect(
			h.receipts().filter((r) => r.event === "rotation_degraded"),
		).toHaveLength(1);
		finish();
		await starting;
		await gen.stop();
		await h.make().start();
		expect(
			h.receipts().filter((r) => r.event === "rotation_degraded"),
		).toHaveLength(1);
		expect(
			h.receipts().find((r) => r.event === "rotation_ready"),
		).toMatchObject({ late: true });
		expect(h.read().readinessPending).toBeNull();
	});
	it("superseded readiness is cleared visibly", async () => {
		const h = harness({
			ledger: {
				...baseLedger(),
				readinessPending: { to: NEW, requestedAt: iso(NOW), degradedAt: null },
			},
		});
		await h.make().start();
		expect(h.read().readinessPending).toBeNull();
		expect(h.receipts()).toContainEqual(
			expect.objectContaining({
				event: "rotation_degraded",
				reason: "superseded",
				to: NEW,
			}),
		);
	});
	it("pristine startup creates a new thread and seeds ledger", async () => {
		const h = harness({ saved: null });
		fs.unlinkSync(h.path);
		await h.make().start();
		expect(h.read()).toMatchObject({
			currentThreadId: NEW,
			previousThreadId: null,
			pending: null,
			startedAt: iso(NOW),
		});
		expect(h.receipts()).toContainEqual(
			expect.objectContaining({ event: "reconciled", reason: "pristine" }),
		);
	});
	it("router idle timeout releases fence and restores the pane", async () => {
		const h = harness();
		await h.make().start();
		vi.spyOn(mocks.router!, "whenIdle").mockImplementation(
			() => new Promise(() => {}),
		);
		await vi.advanceTimersByTimeAsync(
			rotation.ROTATION_QUIET_MS + rotation.FENCE_IDLE_WAIT_MS,
		);
		expect(h.read().lastAttemptOutcome).toBe("rotation_skipped:router_busy");
		expect(mocks.alive).toBe(true);
	});
	it("an observed founder turn prevents rotation until matching completion and quiet time", async () => {
		const h = harness();
		await h.make().start();
		h.emit("turn/started", { turn: { id: "founder" } });
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		expect(mocks.kill).not.toHaveBeenCalled();
		h.emit("turn/completed", { turn: { id: "other" } });
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		expect(mocks.kill).not.toHaveBeenCalled();
		h.emit("turn/completed", { turn: { id: "founder" } });
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		expect(h.rebuild).toHaveBeenCalledTimes(1);
	});
	it("atomic thread-id replacement does not overwrite a symlink target", () => {
		const target = join(dir, "original");
		const path = join(dir, "thread-id");
		fs.writeFileSync(target, OLD);
		fs.symlinkSync(target, path);
		runtimeModule.writeThreadId(path, NEW);
		expect(fs.lstatSync(path).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(path, "utf8")).toBe(NEW);
		expect(fs.readFileSync(target, "utf8")).toBe(OLD);
	});
});

describe("rotation fence handoff cuts", () => {
	it("a journal exception after pending releases the fence and records failure backoff", async () => {
		const h = harness();
		const original = LeadJournal.prototype.countCompletedSince;
		vi.spyOn(LeadJournal.prototype, "countCompletedSince").mockImplementation(
			function (this: LeadJournal, since: number) {
				if (h.read().pending)
					throw new Error("injected journal failure after pending");
				return original.call(this, since);
			},
		);
		await h.make().start();
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		expect(h.read()).toMatchObject({
			pending: null,
			lastAttemptOutcome: "rotation_failed:fence_error",
			lastAttemptAt: iso(NOW + rotation.ROTATION_QUIET_MS),
		});
		expect(mocks.router?.isIdle()).toBe(true);
		expect(mocks.alive).toBe(true);
		expect(h.rebuild).not.toHaveBeenCalled();
		const killed = mocks.kill.mock.calls.length;
		await vi.advanceTimersByTimeAsync(
			rotation.ROTATION_RETRY_BACKOFF_MS - rotation.ROTATION_CHECK_INTERVAL_MS,
		);
		expect(mocks.kill).toHaveBeenCalledTimes(killed);
		mocks.router!.submit({
			source: "discord",
			payload: "after fence failure",
			idempotencyKey: "after-failure",
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(h.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
	});

	it("replays only accepted input on the new thread after a real W1 fence", async () => {
		const h = harness();
		const first = h.make();
		await first.start();
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		mocks.router!.submit({
			source: "discord",
			payload: "survives cut",
			idempotencyKey: "cut-input",
		});
		expect(h.read().pending?.attemptStartedAt).toBeNull();
		await first.stop();
		for (let i = 0; i < 3; i++) {
			const gen = h.make();
			await gen.start();
			await gen.stop();
		}
		expect(h.requests.filter((r) => r.method === "thread/start")).toHaveLength(
			1,
		);
		const turns = h.requests.filter((r) => r.method === "turn/start");
		expect(turns).toHaveLength(1);
		expect(turns[0]!.params.threadId).toBe(NEW);
	});
	it("a delayed terminal response after generation stop cannot write pending or recreate pane", async () => {
		const h = harness();
		const gen = h.make();
		await gen.start();
		let respond!: (value: unknown) => void;
		h.respond((method) =>
			method === "thread/turns/list"
				? new Promise((resolve) => {
						respond = resolve;
					})
				: {},
		);
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		await gen.stop();
		respond({ data: [{ status: "completed" }] });
		await vi.advanceTimersByTimeAsync(60000);
		expect(h.read().pending).toBeNull();
		expect(h.rebuild).not.toHaveBeenCalled();
		expect(mocks.create).toHaveBeenCalledTimes(1);
	});
	it("founder starts during fence idle wait: cancel and restore pane", async () => {
		const h = harness();
		await h.make().start();
		let idle!: () => void;
		vi.spyOn(mocks.router!, "whenIdle").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					idle = resolve;
				}),
		);
		await vi.advanceTimersByTimeAsync(rotation.ROTATION_QUIET_MS);
		h.emit("turn/started", { turn: { id: "founder-during-fence" } });
		idle();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.read().lastAttemptOutcome).toBe(
			"rotation_skipped:founder_turn_active",
		);
		expect(mocks.alive).toBe(true);
	});
	it("new-thread bootstrap is recorded as completed; a surviving rollout prevents another bootstrap", async () => {
		const h = harness({ pending: true });
		const rollout = join(
			h.config.codexHome,
			"sessions",
			`rollout-2026-09-07T01-00-00-${NEW}.jsonl`,
		);
		fs.unlinkSync(rollout);
		const gen = h.make();
		await gen.start();
		await gen.stop();
		fs.writeFileSync(rollout, "");
		await h.make().start();
		expect(
			h.receipts().filter((r) => r.event === "rotation_bootstrap"),
		).toEqual([expect.objectContaining({ to: NEW, outcome: "completed" })]);
		expect(h.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
	});
	it("turnless self-heal updates the ledger without a pending rotation", async () => {
		const h = harness();
		const proto = await import("../CodexLeadProcess.js");
		vi.spyOn(
			proto.CodexLeadProcess.prototype,
			"resumeThread",
		).mockRejectedValueOnce(
			new proto.CodexLeadProcessError("no rollout found", "protocol", -32600),
		);
		await h.make().start();
		expect(h.read()).toMatchObject({
			currentThreadId: NEW,
			previousThreadId: OLD,
			pending: null,
		});
		expect(h.receipts()).toContainEqual(
			expect.objectContaining({
				event: "reconciled",
				reason: "thread_changed_turnless",
			}),
		);
	});
});
