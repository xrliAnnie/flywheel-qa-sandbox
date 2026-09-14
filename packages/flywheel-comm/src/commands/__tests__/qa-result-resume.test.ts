vi.mock("../../bridge-pressure-snapshot.js", () => ({
	printBridgePressure: vi.fn(),
}));

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qaResult } from "../qa-result.js";

let home: string;
let markerPath: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fly1956-qa-resume-"));
	for (const [key, value] of Object.entries({
		HOME: home,
		FLYWHEEL_COMM_DB: join(home, "comm.db"),
		FLYWHEEL_EXEC_ID: "qa-resume",
		FLYWHEEL_ISSUE_ID: "FLY-1956",
		FLYWHEEL_PROJECT_NAME: "flywheel",
		FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
		FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "test-credential",
		FLYWHEEL_RUNNER_MEMORY_DIR: "",
		FLYWHEEL_RUNNER_MEMORY_SNAPSHOT: "",
	}))
		vi.stubEnv(key, value);
	const dir = join(home, ".flywheel", "state", "qa-result-failed");
	mkdirSync(dir, { recursive: true });
	markerPath = join(dir, "qa-resume.json");
	writeFileSync(
		markerPath,
		JSON.stringify({
			execution_id: "qa-resume",
			client_request_id: "persisted-request",
			phase: "in_flight",
			recoverable_verdict: {
				executionId: "qa-resume",
				targetExecutionId: "impl",
				issueId: "FLY-1956",
				projectName: "flywheel",
				clientRequestId: "persisted-request",
				status: "pass",
				summary: "original summary",
			},
		}),
	);
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

it("reuses the write-ahead request and original summary on a later invocation", async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 1,
					serverSeq: 2,
					idempotentReplay: true,
				}),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	await expect(
		qaResult({ status: "pass", targetExec: "impl", summary: "edited summary" }),
	).resolves.toMatchObject({ exitCode: 0 });
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
		client_request_id: "persisted-request",
		summary: "original summary",
	});
	expect(existsSync(markerPath)).toBe(false);
	expect(console.log).toHaveBeenCalledWith(
		"[qa-result] RECEIPT landed=true replay=true claimId=1 serverSeq=2",
	);
});

it("keeps a refused marker distinct from an exhausted delivery", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: false, reason: "credential_revoked" }),
					{ status: 409 },
				),
		),
	);
	await expect(
		qaResult({ status: "pass", targetExec: "impl" }),
	).resolves.toMatchObject({ exitCode: 1, label: "refused" });
	expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
		phase: "refused",
		client_request_id: "persisted-request",
	});
});

it("prints a replay instruction and retains an exhausted marker after transient failures", async () => {
	vi.useFakeTimers();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("connection lost");
		}),
	);
	const pending = qaResult({ status: "pass", targetExec: "impl" });
	await vi.runAllTimersAsync();
	await expect(pending).resolves.toMatchObject({
		exitCode: 1,
		label: "deferred",
	});
	expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
		phase: "exhausted",
		client_request_id: "persisted-request",
	});
	expect(console.error).toHaveBeenCalledWith(
		"[qa-result] DEFERRED: rerun the same command; client_request_id=persisted-request is persisted and will be replayed",
	);
});

it.each([
	{ status: "fail", targetExec: "impl" },
	{ status: "pass", targetExec: "another-impl" },
	{ status: "pass", targetExec: "impl", prHeadSha: "b".repeat(40) },
])(
	"refuses conflicting verdict %j without changing evidence or posting",
	async (opts) => {
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		marker.recoverable_verdict.prHeadSha = "a".repeat(40);
		writeFileSync(markerPath, JSON.stringify(marker));
		const before = readFileSync(markerPath, "utf8");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						claimId: 1,
						serverSeq: 2,
						idempotentReplay: true,
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(qaResult(opts)).resolves.toMatchObject({ exitCode: 1 });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readFileSync(markerPath, "utf8")).toBe(before);
	},
);

it("explicit discard preserves old evidence and submits a fresh verdict", async () => {
	const before = readFileSync(markerPath, "utf8");
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					ok: true,
					claimId: 3,
					serverSeq: 4,
					idempotentReplay: false,
				}),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	await expect(
		qaResult({
			status: "fail",
			targetExec: "impl",
			summary: "new verdict",
			discardMarker: true,
		}),
	).resolves.toMatchObject({ exitCode: 0 });
	const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
	expect(body.client_request_id).not.toBe("persisted-request");
	expect(body).toMatchObject({ status: "fail", summary: "new verdict" });
	const discarded = readdirSync(join(markerPath, "..")).filter((name) =>
		name.startsWith("qa-resume.json.discarded-"),
	);
	expect(discarded).toHaveLength(1);
	expect(readFileSync(join(markerPath, "..", discarded[0]), "utf8")).toBe(
		before,
	);
});

it.each([JSON.stringify({ client_request_id: "legacy" }), "{truncated"])(
	"preserves unreadable legacy marker %s before starting a new request",
	async (legacy) => {
		writeFileSync(markerPath, legacy);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: true,
							claimId: 3,
							serverSeq: 4,
							idempotentReplay: false,
						}),
					),
			),
		);
		await expect(
			qaResult({ status: "pass", targetExec: "impl" }),
		).resolves.toMatchObject({ exitCode: 0 });
		const preserved = readdirSync(join(markerPath, "..")).filter((name) =>
			name.startsWith("qa-resume.json.unreadable-"),
		);
		expect(preserved).toHaveLength(1);
		expect(readFileSync(join(markerPath, "..", preserved[0]), "utf8")).toBe(
			legacy,
		);
	},
);
