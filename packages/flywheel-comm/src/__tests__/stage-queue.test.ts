vi.mock("../bridge-pressure-snapshot.js", () => ({
	printBridgePressure: vi.fn(),
}));

import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMkdirLock } from "flywheel-config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stage } from "../commands/stage.js";
import { enqueueStageEvent, withStageQueueFence } from "../stage-queue.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fly1956-stage-"));
	for (const [key, value] of Object.entries({
		HOME: home,
		FLYWHEEL_EXEC_ID: "stage-exec",
		FLYWHEEL_ISSUE_ID: "FLY-1956",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
		FLYWHEEL_INGEST_TOKEN: "private-token",
	}))
		vi.stubEnv(key, value);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(home, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("retries the new event with the same id after 2s and 5s backoffs", async () => {
	vi.useFakeTimers();
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockRejectedValueOnce(new Error("connection lost"))
		.mockResolvedValueOnce(new Response("busy", { status: 503 }))
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ ok: true, duplicate: true, applied: true }),
			),
		);
	vi.stubGlobal("fetch", fetchMock);
	const pending = stage({ subcommand: "set", stageName: "implement" });
	await vi.advanceTimersByTimeAsync(0);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1999);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(4999);
	expect(fetchMock).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1);
	await pending;
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(
		new Set(
			fetchMock.mock.calls.map(
				(call) => JSON.parse(String(call[1]?.body)).event_id,
			),
		).size,
	).toBe(1);
	expect(
		readdirSync(
			join(home, ".flywheel", "state", "stage-queue", "stage-exec"),
		).filter((name) => name.endsWith(".json")),
	).toHaveLength(0);
});

it.each(["headers", "body"])(
	"bounds stalled %s by the 37-second total budget and retains the event",
	async (part) => {
		vi.useFakeTimers();
		const signals: AbortSignal[] = [];
		const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
			const signal = init!.signal!;
			signals.push(signal);
			const stalled = () =>
				new Promise<never>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					}),
				);
			return part === "headers"
				? stalled()
				: ({ ok: true, text: stalled } as Response);
		});
		vi.stubGlobal("fetch", fetchMock);
		const started = Date.now();
		const pending = stage({ subcommand: "set", stageName: "implement" });
		await vi.advanceTimersByTimeAsync(9999);
		expect(signals[0].aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signals[0].aborted).toBe(true);
		await vi.runAllTimersAsync();
		await pending;
		expect(Date.now() - started).toBe(37_000);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(
			readdirSync(
				join(home, ".flywheel", "state", "stage-queue", "stage-exec"),
			).filter((name) => name.endsWith(".json")),
		).toHaveLength(1);
	},
);

it("publishes the complete credential-free stage event before POST and removes it after acknowledgement", async () => {
	const dir = join(home, ".flywheel", "state", "stage-queue", "stage-exec");
	let persisted: unknown;
	let filename: string | undefined;
	const fetchMock = vi.fn<typeof fetch>(async () => {
		filename = existsSync(dir)
			? readdirSync(dir).find((name) => name.endsWith(".json"))
			: undefined;
		if (filename)
			persisted = JSON.parse(readFileSync(join(dir, filename), "utf8"));
		return new Response(JSON.stringify({ ok: true }));
	});
	vi.stubGlobal("fetch", fetchMock);
	await stage({ subcommand: "set", stageName: "implement" });
	const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
	expect(persisted).toMatchObject({ ...posted, queued_at: expect.any(String) });
	expect(filename).toBe(`000001-${posted.event_id}.json`);
	expect(JSON.stringify(persisted)).not.toContain("private-token");
	expect(existsSync(join(dir, filename!))).toBe(false);
});

it("returns UNRECORDED with zero requests when the event cannot be queued", async () => {
	writeFileSync(join(home, ".flywheel"), "not a directory");
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	const previousExitCode = process.exitCode;
	try {
		await stage({ subcommand: "set", stageName: "implement" });
		expect(process.exitCode).toBe(3);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("UNRECORDED"),
		);
	} finally {
		process.exitCode = previousExitCode;
	}
});

it("stops at an unsettled older event and drains it before later events on retry", async () => {
	await enqueueStageEvent({
		event_id: "old-event",
		execution_id: "stage-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: "plan" },
	});
	const fetchMock = vi.fn<typeof fetch>(
		async () => new Response(JSON.stringify({ ok: false }), { status: 503 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	await stage({ subcommand: "set", stageName: "implement" });
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).event_id).toBe(
		"old-event",
	);
	const dir = join(home, ".flywheel", "state", "stage-queue", "stage-exec");
	expect(
		readdirSync(dir).filter((name) => name.endsWith(".json")),
	).toHaveLength(2);
	fetchMock.mockClear();
	fetchMock.mockImplementation(
		async () => new Response(JSON.stringify({ ok: true, applied: true })),
	);
	await stage({ subcommand: "set", stageName: "test" });
	expect(
		fetchMock.mock.calls.map(
			(call) => JSON.parse(String(call[1]?.body)).payload.stage,
		),
	).toEqual(["plan", "implement", "test"]);
	expect(
		readdirSync(dir).filter((name) => name.endsWith(".json")),
	).toHaveLength(0);
});

it.each([
	{ ok: true, duplicate: true },
	{ ok: true, duplicate: true, applied: false, pending: ["proofshot"] },
	{ ok: true, applied: false, pending: ["codex_trigger"] },
	{ ok: true, warning: "projection not settled" },
	{ ok: false },
])(
	"retains the event when the receipt is insufficient: %j",
	async (receipt) => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(receipt))),
		);
		const pending = stage({ subcommand: "set", stageName: "implement" });
		await vi.runAllTimersAsync();
		await pending;
		const dir = join(home, ".flywheel", "state", "stage-queue", "stage-exec");
		expect(
			readdirSync(dir).filter((name) => name.endsWith(".json")),
		).toHaveLength(1);
		expect(console.log).not.toHaveBeenCalled();
	},
);

it("preserves deterministic rejection evidence and continues past the refused head", async () => {
	await enqueueStageEvent({
		event_id: "refused-event",
		execution_id: "stage-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: "plan" },
	});
	const fetchMock = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ ok: false, reason: "stage_event_payload_conflict" }),
				{ status: 409 },
			),
		)
		.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
	vi.stubGlobal("fetch", fetchMock);
	await stage({ subcommand: "set", stageName: "implement" });
	expect(fetchMock).toHaveBeenCalledTimes(2);
	const dir = join(home, ".flywheel", "state", "stage-queue", "stage-exec");
	expect(
		readdirSync(dir).filter((name) => name.endsWith(".json")),
	).toHaveLength(0);
	expect(
		readdirSync(dir).filter((name) =>
			name.startsWith("000001-refused-event.json.rejected-"),
		),
	).toHaveLength(1);
});

it("runs the gate mutation only after the stage queue settles and while holding its lock", async () => {
	await enqueueStageEvent({
		event_id: "pending-event",
		execution_id: "stage-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: "plan" },
	});
	const transport = { bridgeUrl: "http://bridge.invalid", headers: {} };
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response(JSON.stringify({ ok: true, duplicate: true })),
		),
	);
	const mutation = vi.fn(async () => {
		expect(
			existsSync(
				join(home, ".flywheel", "state", "stage-queue", "stage-exec", ".lock"),
			),
		).toBe(true);
		return "gate-written";
	});
	await expect(
		withStageQueueFence("stage-exec", transport, mutation),
	).resolves.toMatchObject({ settled: false });
	expect(mutation).not.toHaveBeenCalled();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: true, duplicate: true, applied: true }),
				),
		),
	);
	await expect(
		withStageQueueFence("stage-exec", transport, mutation),
	).resolves.toEqual({ settled: true, value: "gate-written" });
	expect(mutation).toHaveBeenCalledOnce();
	expect(
		existsSync(
			join(home, ".flywheel", "state", "stage-queue", "stage-exec", ".lock"),
		),
	).toBe(false);
});

it.each(["event_id", "stage", "credential"])(
	"keeps a corrupted %s record and refuses the gate without sending it",
	async (field) => {
		const path = await enqueueStageEvent({
			event_id: "original-event",
			execution_id: "stage-exec",
			issue_id: "FLY-1956",
			project_name: "flywheel",
			event_type: "stage_changed",
			source: "flywheel-comm",
			payload: { stage: "plan" },
		});
		const row = JSON.parse(readFileSync(path, "utf8"));
		if (field === "stage") row.payload.stage = "not-a-stage";
		else row[field] = "tampered-value";
		writeFileSync(path, JSON.stringify(row));
		const before = readFileSync(path, "utf8");
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ ok: true })),
		);
		vi.stubGlobal("fetch", fetchMock);
		const action = vi.fn(async () => "written");
		await expect(
			withStageQueueFence(
				"stage-exec",
				{ bridgeUrl: "http://bridge.invalid", headers: {} },
				action,
			),
		).resolves.toEqual({ settled: false });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(before);
	},
);

it("cleans old unpublished temps under ownership while preserving fresh files and sequence evidence", async () => {
	const event = {
		event_id: "initial",
		execution_id: "stage-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: "plan" },
	};
	await enqueueStageEvent(event);
	const dir = join(home, ".flywheel", "state", "stage-queue", "stage-exec");
	const oldTemp = join(dir, ".2.123.deadbeef.tmp");
	const freshTemp = join(dir, ".2.124.feedface.tmp");
	const refused = join(dir, "000008-old.json.rejected-evidence");
	for (const path of [oldTemp, freshTemp, refused])
		writeFileSync(path, "partial");
	const old = new Date(Date.now() - 3_600_001);
	utimesSync(oldTemp, old, old);
	utimesSync(refused, old, old);
	const next = await enqueueStageEvent({ ...event, event_id: "next" });
	expect(existsSync(oldTemp)).toBe(false);
	expect(existsSync(freshTemp)).toBe(true);
	expect(readFileSync(refused, "utf8")).toBe("partial");
	expect(next.endsWith("000009-next.json")).toBe(true);
});

it.each([
	[{ ok: true, duplicate: true, applied: true }, "replayed"],
	[{ ok: true, duplicate: true, superseded: true }, "superseded"],
] as const)("reports a confirmed %j receipt as %s", async (receipt, label) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(receipt))),
	);
	await stage({ subcommand: "set", stageName: "implement" });
	expect(console.log).toHaveBeenCalledWith(`Stage: implement (${label})`);
	const next = await enqueueStageEvent({
		event_id: "after-clear",
		execution_id: "stage-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: "test" },
	});
	expect(next.endsWith("000001-after-clear.json")).toBe(true);
});

it("refuses publishers and gate fences while a live process owns the queue lock", async () => {
	await enqueueStageEvent({
		event_id: "first",
		execution_id: "stage-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: "plan" },
	});
	const dir = join(home, ".flywheel/state/stage-queue/stage-exec");
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	await withMkdirLock(join(dir, ".lock"), async () => {
		let clock = Date.now();
		const now = vi.spyOn(Date, "now").mockImplementation(() => {
			clock += 10_001;
			return clock;
		});
		const previousExitCode = process.exitCode;
		try {
			await stage({ subcommand: "set", stageName: "test" });
			expect(process.exitCode).toBe(3);
			const mutation = vi.fn(async () => "written");
			expect(
				await withStageQueueFence(
					"stage-exec",
					{ bridgeUrl: "http://bridge.invalid", headers: {} },
					mutation,
				),
			).toEqual({ settled: false });
			expect(mutation).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(existsSync(join(dir, ".lock"))).toBe(true);
			expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual(
				["000001-first.json"],
			);
		} finally {
			now.mockRestore();
			process.exitCode = previousExitCode;
		}
	});
});
