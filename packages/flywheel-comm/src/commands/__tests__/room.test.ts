import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommDB } from "../../db.js";
import { runRoomCommand } from "../room.js";

const HEAD = "a".repeat(40);
const EXEC = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";

function room(status = "ready") {
	return {
		ok: true,
		room_id: ROOM,
		operation_id: OPERATION,
		status,
		status_reason: null,
		roomInfo: null,
		evidence_dir: "/tmp/room-evidence",
		residue_check: null,
		log_tail: "",
		queue_reason: null,
		load1: 1,
		threshold: 8,
		owner_terminal: false,
		recovery_hint: null,
	};
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function harness() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let clock = 0;
	const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(room()));
	const sleepImpl = vi.fn(async (ms: number) => {
		clock += ms;
	});
	const randomId = vi.fn(() => REQUEST);
	return {
		stdout,
		stderr,
		fetchImpl,
		sleepImpl,
		randomId,
		opts: {
			env: {
				FLYWHEEL_EXEC_ID: EXEC,
				FLYWHEEL_INGEST_TOKEN: "ingest-secret",
				FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "submission-secret",
			},
			fetchImpl,
			sleepImpl,
			randomId,
			now: () => clock,
			stdout: (line: string) => stdout.push(line),
			stderr: (line: string) => stderr.push(line),
		},
	};
}

describe("room command registration", () => {
	it("registers the room command and documents its five subcommands", () => {
		const index = readFileSync(
			new URL("../../index.ts", import.meta.url),
			"utf8",
		);
		expect(index.includes('from "./commands/room.js"')).toBe(true);
		expect(index.includes('case "room":')).toBe(true);
		expect(index.includes("deploy|teardown|status|wait|list")).toBe(true);
	});
});

describe("room CLI", () => {
	it("normalizes the supported deploy flags into the strict wire payload", async () => {
		const h = harness();
		expect(
			await runRoomCommand(
				[
					"deploy",
					"--head",
					HEAD,
					"--slot",
					"2",
					"--mode",
					"slot",
					"--from-branch",
					"topic/qa",
					"--generalized",
					"--codex-runner",
					"--alerts",
					"--alert-duty",
					"--codex-home-reconcile",
					"--extra-lead",
					"3:helper",
					"--extra-lead",
					"4:other",
					"--lead-label",
					"qa",
					"--lead-ready-timeout",
					"90",
					"--lead-channel-timeout-sec",
					"60",
					"--digest",
					"12345678901234567",
					"--env",
					"TEST_REPLY_BY_ISSUE=1",
					"--env",
					"TEST_BRIDGE_DEPT_SCOPE_REJECT=on",
					"--env",
					"TEST_CODEX_LEAD_OUTBOUND_MODE=bridge",
				],
				h.opts,
			),
		).toBe(0);
		const [url, init] = h.fetchImpl.mock.calls[0]!;
		expect(url).toBe("http://127.0.0.1:9876/api/qa-rooms");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer ingest-secret",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			request_id: REQUEST,
			execution_id: EXEC,
			credential: "submission-secret",
			head: HEAD,
			slot: 2,
			mode: "slot",
			from_branch: "topic/qa",
			generalized: true,
			test_discipline: false,
			codex_runner: true,
			stub_runner: false,
			no_lead: false,
			alerts: true,
			alert_duty: true,
			codex_home_reconcile: true,
			extra_leads: [
				{ slot: 3, label: "helper" },
				{ slot: 4, label: "other" },
			],
			lead_label: "qa",
			lead_ready_timeout_sec: 90,
			lead_channel_timeout_sec: 60,
			digest_channel: "12345678901234567",
			env: {
				TEST_REPLY_BY_ISSUE: "1",
				TEST_BRIDGE_DEPT_SCOPE_REJECT: "on",
				TEST_CODEX_LEAD_OUTBOUND_MODE: "bridge",
			},
		});
		expect(JSON.parse(h.stdout[0]!)).toMatchObject(room());
		expect(h.stderr).toEqual([]);
	});

	it("accepts the source-head alias and supplies bounded deploy defaults", async () => {
		const h = harness();
		expect(
			await runRoomCommand(["deploy", "--expect-head", HEAD], h.opts),
		).toBe(0);
		expect(
			JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)),
		).toMatchObject({
			head: HEAD,
			slot: "auto",
			mode: "slot",
			from_branch: "main",
			extra_leads: [],
			env: {},
		});
	});

	it("retains one generated request ID and identical body across transport retries", async () => {
		const h = harness();
		h.fetchImpl
			.mockRejectedValueOnce(new Error("socket reset"))
			.mockRejectedValueOnce(new Error("timeout"));
		expect(await runRoomCommand(["deploy", "--head", HEAD], h.opts)).toBe(0);
		expect(h.fetchImpl).toHaveBeenCalledTimes(3);
		expect(
			new Set(h.fetchImpl.mock.calls.map(([, init]) => init?.body)).size,
		).toBe(1);
		expect(h.randomId).toHaveBeenCalledTimes(1);
		expect(h.sleepImpl.mock.calls).toEqual([[1000], [2000]]);
	});

	it("reuses a caller-provided request ID for a lost teardown response", async () => {
		const h = harness();
		h.fetchImpl.mockResolvedValue(response(room("torn_down")));
		expect(
			await runRoomCommand(
				[
					"teardown",
					"--room",
					ROOM,
					"--request-id",
					REQUEST,
					"--skip-snapshot",
					"--reason",
					" approved skip ",
				],
				h.opts,
			),
		).toBe(0);
		expect(h.fetchImpl.mock.calls[0]![0]).toBe(
			`http://127.0.0.1:9876/api/qa-rooms/${ROOM}/teardown`,
		);
		expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body))).toEqual({
			request_id: REQUEST,
			execution_id: EXEC,
			credential: "submission-secret",
			skip_snapshot: true,
			reason: "approved skip",
		});
		expect(h.randomId).not.toHaveBeenCalled();
	});

	it.each(["status", "wait", "list"])(
		"authenticates runner %s with headers, never URL credentials",
		async (command) => {
			const h = harness();
			if (command === "list")
				h.fetchImpl.mockResolvedValue(response({ ok: true, rooms: [room()] }));
			const args = command === "list" ? [command] : [command, "--room", ROOM];
			expect(await runRoomCommand(args, h.opts)).toBe(0);
			const [url, init] = h.fetchImpl.mock.calls[0]!;
			expect(String(url)).not.toContain("?");
			expect(init?.method).toBe("GET");
			expect(init?.body).toBeUndefined();
			expect(init?.headers).toMatchObject({
				Authorization: "Bearer ingest-secret",
				"X-Flywheel-Execution-Id": EXEC,
				"X-Flywheel-Submission-Credential": "submission-secret",
			});
		},
	);

	it.each([false, true])(
		"authenticates Lead mode (explicit=%s) without runner credentials",
		async (explicit) => {
			const h = harness();
			const env = {
				TEAMLEAD_API_TOKEN: "Bearer lead-secret",
				FLYWHEEL_LEAD_ID: "flywheel",
				...(explicit ? h.opts.env : {}),
			};
			expect(
				await runRoomCommand(
					["deploy", "--head", HEAD, ...(explicit ? ["--lead"] : [])],
					{ ...h.opts, env },
				),
			).toBe(0);
			const init = h.fetchImpl.mock.calls[0]![1]!;
			expect(init.headers).toMatchObject({
				Authorization: "Bearer lead-secret",
				"X-Flywheel-Lead-Id": "flywheel",
			});
			expect(JSON.parse(String(init.body))).not.toHaveProperty("execution_id");
			expect(JSON.parse(String(init.body))).not.toHaveProperty("credential");
		},
	);

	it.each(["deploy", "status"])(
		"authenticates runner %s when no submission credential is available",
		async (action) => {
			const h = harness();
			const credentialResolver = vi.fn(() => undefined);
			const args =
				action === "deploy"
					? [action, "--head", HEAD]
					: [action, "--room", ROOM];
			expect(
				await runRoomCommand(args, { ...h.opts, credentialResolver }),
			).toBe(0);
			expect(credentialResolver).toHaveBeenCalledWith(EXEC, h.opts.env);
			const [url, init] = h.fetchImpl.mock.calls[0]!;
			expect(init?.headers).toMatchObject({
				Authorization: "Bearer ingest-secret",
			});
			expect(init?.headers).not.toHaveProperty(
				"X-Flywheel-Submission-Credential",
			);
			if (action === "deploy") {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					execution_id: EXEC,
				});
				expect(JSON.parse(String(init?.body))).not.toHaveProperty("credential");
			} else {
				expect(init?.headers).toMatchObject({
					"X-Flywheel-Execution-Id": EXEC,
				});
				expect(init?.body).toBeUndefined();
			}
			expect(String(url)).not.toContain("?");
		},
	);

	it("prefers runner identity when Lead credentials are also inherited", async () => {
		const h = harness();
		expect(
			await runRoomCommand(["status", "--room", ROOM], {
				...h.opts,
				env: {
					...h.opts.env,
					TEAMLEAD_API_TOKEN: "lead-secret",
					FLYWHEEL_LEAD_ID: "flywheel",
				},
			}),
		).toBe(0);
		expect(h.fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({
			Authorization: "Bearer ingest-secret",
		});
	});

	it.each(["deploy", "status"])(
		"allows active implement %s with no submission credential and ignores stale startup credentials",
		async (action) => {
			const h = harness();
			const dir = mkdtempSync(join(tmpdir(), "room-activation-"));
			const dbPath = join(dir, "comm.db");
			try {
				const db = new CommDB(dbPath);
				try {
					db.registerSession(EXEC, "win:1", "flywheel", "FLY-2405", "flywheel");
					db.grantTurn("FLY-2405", EXEC, "implement", 1_700_000_000_000, {
						project: "flywheel",
						sourceEventId: "room-implement-activation",
						activation: {
							activationId: OPERATION,
							runId: "run-1",
							nodeId: "implement",
							attempt: 1,
							context: {},
						},
					});
				} finally {
					db.close();
				}
				const args =
					action === "deploy"
						? [action, "--head", HEAD]
						: [action, "--room", ROOM];
				expect(
					await runRoomCommand(args, {
						...h.opts,
						env: { ...h.opts.env, FLYWHEEL_COMM_DB: dbPath },
					}),
				).toBe(0);
				const init = h.fetchImpl.mock.calls[0]![1]!;
				expect(init.headers).not.toHaveProperty(
					"X-Flywheel-Submission-Credential",
				);
				if (init.body)
					expect(JSON.parse(String(init.body))).not.toHaveProperty(
						"credential",
					);
				expect(JSON.stringify(init)).not.toContain("submission-secret");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("refuses stale activation context without sending a request", async () => {
		const h = harness();
		const credentialResolver = () => {
			throw new Error("stale activation with private context");
		};
		expect(
			await runRoomCommand(["deploy", "--head", HEAD], {
				...h.opts,
				credentialResolver,
			}),
		).toBe(1);
		expect(h.fetchImpl).not.toHaveBeenCalled();
		expect(h.stderr.join(" ")).toContain(
			"current workflow submission credential is unavailable",
		);
		expect(h.stderr.join(" ")).not.toContain("private context");
	});

	it("resolves current workflow credentials for an explicit execution override", async () => {
		const h = harness();
		const credentialResolver = vi.fn(() => "current-secret");
		expect(
			await runRoomCommand(["status", "--room", ROOM, "--exec-id", OPERATION], {
				...h.opts,
				credentialResolver,
			}),
		).toBe(0);
		expect(credentialResolver).toHaveBeenCalledWith(OPERATION, h.opts.env);
		expect(h.fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({
			"X-Flywheel-Execution-Id": OPERATION,
			"X-Flywheel-Submission-Credential": "current-secret",
		});
	});

	it.each([
		["deploy"],
		["deploy", "--head", "ABC"],
		["deploy", "--head", HEAD, "--head", HEAD],
		["deploy", "--head", HEAD, "--expect-head", "b".repeat(40)],
		["deploy", "--head", HEAD, "--slot", "0"],
		["deploy", "--head", HEAD, "--slot", "2x"],
		["deploy", "--head", HEAD, "--mode", "prod"],
		["deploy", "--head", HEAD, "--from-branch", "../main"],
		["deploy", "--head", HEAD, "--env", "PATH=/tmp"],
		["deploy", "--head", HEAD, "--env", "TEST_REPLY_BY_ISSUE=yes"],
		[
			"deploy",
			"--head",
			HEAD,
			"--env",
			"TEST_REPLY_BY_ISSUE=1",
			"--env",
			"TEST_REPLY_BY_ISSUE=0",
		],
		["deploy", "--head", HEAD, "--argv", "--anything"],
		["deploy", "--head", HEAD, "--lead-label", "x;touch /tmp/x"],
		["deploy", "--head", HEAD, "--lead-ready-timeout", "3601"],
		["deploy", "--head", HEAD, "--digest", "12"],
		[
			"deploy",
			"--head",
			HEAD,
			...Array(5).fill(["--extra-lead", "2:x"]).flat(),
		],
		["deploy", "--head", HEAD, "--extra-lead", "2:x", "--extra-lead", "2:y"],
		["teardown", "--room", ROOM, "--skip-snapshot"],
		["teardown", "--room", ROOM, "--reason", "no flag"],
		[
			"teardown",
			"--room",
			ROOM,
			"--skip-snapshot",
			"--reason",
			"x".repeat(201),
		],
		["status", "--room", "../../prod"],
		["status", "--room", ROOM, "--head", HEAD],
		["wait", "--room", ROOM, "--timeout-sec", "1801"],
		["list", "--room", ROOM],
		["deploy", "--head", HEAD, "--wait", "--no-wait"],
		["deploy", "--head", HEAD, "--request-id", "bad"],
	])(
		"rejects invalid arguments without making a request: %j",
		async (...args) => {
			const h = harness();
			expect(await runRoomCommand(args, h.opts)).toBe(1);
			expect(h.fetchImpl).not.toHaveBeenCalled();
			expect(h.stderr.length).toBeGreaterThan(0);
		},
	);

	it("does not fall back to Lead credentials for a broken runner identity", async () => {
		const h = harness();
		expect(
			await runRoomCommand(["list"], {
				...h.opts,
				env: {
					...h.opts.env,
					FLYWHEEL_INGEST_TOKEN: "",
					TEAMLEAD_API_TOKEN: "lead-secret",
					FLYWHEEL_LEAD_ID: "flywheel",
				},
			}),
		).toBe(1);
		expect(h.fetchImpl).not.toHaveBeenCalled();
	});

	it("waits on the returned room handle after deploy without creating another room", async () => {
		const h = harness();
		h.fetchImpl
			.mockResolvedValueOnce(response(room("queued"), 202))
			.mockResolvedValueOnce(response(room("deploying")))
			.mockResolvedValueOnce(response(room()));
		expect(await runRoomCommand(["deploy", "--head", HEAD], h.opts)).toBe(0);
		expect(
			h.fetchImpl.mock.calls.map(([url, init]) => [url, init?.method]),
		).toEqual([
			["http://127.0.0.1:9876/api/qa-rooms", "POST"],
			[`http://127.0.0.1:9876/api/qa-rooms/${ROOM}`, "GET"],
			[`http://127.0.0.1:9876/api/qa-rooms/${ROOM}`, "GET"],
		]);
		expect(JSON.parse(h.stdout.at(-1)!)).toMatchObject({
			room_id: ROOM,
			status: "ready",
		});
	});

	it("returns exit 3 and a resumable room ID when its wait deadline expires", async () => {
		const h = harness();
		h.fetchImpl.mockImplementation(async () => response(room("deploying")));
		expect(
			await runRoomCommand(
				["wait", "--room", ROOM, "--timeout-sec", "1"],
				h.opts,
			),
		).toBe(3);
		expect(JSON.parse(h.stdout.at(-1)!)).toMatchObject({
			room_id: ROOM,
			status: "deploying",
		});
		expect(h.sleepImpl.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(1000);
	});

	it.each(["queued", "preparing", "deploying", "tearing_down"])(
		"--no-wait reports %s with exit 3",
		async (status) => {
			const h = harness();
			h.fetchImpl.mockResolvedValue(response(room(status), 202));
			expect(
				await runRoomCommand(["deploy", "--head", HEAD, "--no-wait"], h.opts),
			).toBe(3);
			expect(h.fetchImpl).toHaveBeenCalledTimes(1);
			expect(JSON.parse(h.stdout[0]!)).toMatchObject({ room_id: ROOM, status });
		},
	);

	it.each([
		["ready", 0],
		["torn_down", 0],
		["failed", 1],
		["refused", 1],
		["released", 1],
		["interrupted", 1],
		["teardown_failed", 1],
		["queued", 3],
	])("maps terminal/status state %s to exit %i", async (status, exit) => {
		const h = harness();
		h.fetchImpl.mockResolvedValue(response(room(String(status))));
		expect(await runRoomCommand(["status", "--room", ROOM], h.opts)).toBe(exit);
	});

	it("redacts credentials from successful log/evidence output", async () => {
		const h = harness();
		h.fetchImpl.mockResolvedValue(
			response({
				...room(),
				log_tail: "ingest-secret submission-secret",
				credential: "submission-secret",
			}),
		);
		expect(await runRoomCommand(["status", "--room", ROOM], h.opts)).toBe(0);
		expect(h.stdout.join(" ")).not.toMatch(/ingest-secret|submission-secret/);
		expect(JSON.parse(h.stdout[0]!)).not.toHaveProperty("credential");
	});

	it("preserves token file paths in ready roomInfo while removing secret values", async () => {
		const h = harness();
		const apiTokenPath = "/tmp/qa-room/generalized/api-token";
		const tokenPath = "/tmp/qa-room/report-host/token";
		h.fetchImpl.mockResolvedValue(
			response({
				...room(),
				roomInfo: {
					apiTokenPath,
					apiToken: "private-room-token",
					credential: "private-room-credential",
					reportHost: {
						url: "http://127.0.0.1:19321",
						tokenPath,
						token: "private-report-token",
					},
				},
				log_tail: "ingest-secret submission-secret",
			}),
		);
		expect(await runRoomCommand(["status", "--room", ROOM], h.opts)).toBe(0);
		expect(JSON.parse(h.stdout[0]!).roomInfo).toEqual({
			apiTokenPath,
			reportHost: { url: "http://127.0.0.1:19321", tokenPath },
		});
		expect(h.stdout.join(" ")).not.toMatch(
			/private-room-token|private-room-credential|private-report-token|ingest-secret|submission-secret/,
		);
	});

	it("returns request error 1 without echoing a rejected response body", async () => {
		const h = harness();
		h.fetchImpl.mockResolvedValue(
			response(
				{
					ok: false,
					reason: "ingest-secret submission-secret arbitrary-private-data",
				},
				403,
			),
		);
		expect(await runRoomCommand(["deploy", "--head", HEAD], h.opts)).toBe(1);
		expect(h.stderr.join(" ")).toContain("403");
		expect(h.stderr.join(" ")).not.toMatch(/secret|arbitrary-private-data/);
		expect(h.fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("treats invalid JSON in an HTTP success as a protocol error without raw body leakage", async () => {
		const h = harness();
		h.fetchImpl.mockImplementation(
			async () => new Response("private-non-json-body", { status: 200 }),
		);
		expect(await runRoomCommand(["status", "--room", ROOM], h.opts)).toBe(1);
		expect(h.fetchImpl).toHaveBeenCalledTimes(1);
		expect(h.stderr.join(" ")).not.toContain("private-non-json-body");
	});

	it("exhausts transport failures with exit 2 and the recoverable request ID", async () => {
		const h = harness();
		h.fetchImpl.mockRejectedValue(
			new Error("ingest-secret submission-secret arbitrary-private-data"),
		);
		expect(await runRoomCommand(["deploy", "--head", HEAD], h.opts)).toBe(2);
		expect(h.fetchImpl).toHaveBeenCalledTimes(3);
		expect(h.stderr.join(" ")).toContain(REQUEST);
		expect(h.stderr.join(" ")).not.toMatch(/secret|arbitrary-private-data/);
	});

	it("aborts each stalled request at the per-request timeout", async () => {
		const h = harness();
		h.fetchImpl.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("timeout")),
						{ once: true },
					);
				}),
		);
		expect(
			await runRoomCommand(["status", "--room", ROOM], {
				...h.opts,
				attemptTimeoutMs: 1,
			}),
		).toBe(2);
		expect(h.fetchImpl).toHaveBeenCalledTimes(3);
		expect(
			h.fetchImpl.mock.calls.every(([, init]) => init?.signal?.aborted),
		).toBe(true);
	});

	it.each([
		{ ok: true },
		{ ...room(), status: "unknown" },
		{ ...room(), room_id: REQUEST },
	])("rejects malformed or mismatched room responses", async (body) => {
		const h = harness();
		h.fetchImpl.mockResolvedValue(response(body));
		expect(await runRoomCommand(["status", "--room", ROOM], h.opts)).toBe(1);
		expect(h.stdout).toEqual([]);
	});

	it("prints help without requiring auth or making requests", async () => {
		const h = harness();
		expect(
			await runRoomCommand(["deploy", "--help"], { ...h.opts, env: {} }),
		).toBe(0);
		expect(h.stdout.join(" ")).toContain("--head");
		expect(h.fetchImpl).not.toHaveBeenCalled();
	});
});
