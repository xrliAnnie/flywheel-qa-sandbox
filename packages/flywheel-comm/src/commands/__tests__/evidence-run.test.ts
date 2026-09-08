import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	evidenceRunRecord,
	publishEvidenceRunReceipt,
} from "../evidence-run.js";

const HEAD = "a".repeat(40);
const RECORD_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_URL = `https://fw-reports-test.vercel.app/r/${"b".repeat(32)}/`;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "evidence-run-cli-"));
	dirs.push(dir);
	return dir;
}

function specFile(
	dir: string,
	overrides: Record<string, unknown> = {},
): string {
	const path = join(dir, "rerun.json");
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: 1,
			lane: "generalized_e2e_stub",
			deploy: {},
			driver: { issue: "FLY-2397", timeoutMs: 600000 },
			...overrides,
		}),
	);
	return path;
}

function successBody(recordId = RECORD_ID) {
	return {
		ok: true,
		status: "inserted",
		record: {
			record_id: recordId,
			verdict: "satisfied",
			ran: { status: "satisfied", reason: "ok" },
			record: { status: "satisfied", reason: "ok" },
		},
	};
}

function response(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function baseOptions(dir: string) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		opts: {
			execId: "qa-2397",
			head: HEAD,
			site: "slot_529:2",
			lane: "generalized_e2e_stub",
			driverExitCode: 0,
			recordUrl: RECORD_URL,
			rerunSpecPath: specFile(dir),
			recordId: RECORD_ID,
			stateDir: join(dir, "runner-state"),
			env: {
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
				FLYWHEEL_INGEST_TOKEN: "ingest-secret",
			},
			credentialResolver: () => "submission-secret",
			stdout: (line: string) => stdout.push(line),
			stderr: (line: string) => stderr.push(line),
			sleepImpl: vi.fn(async () => undefined),
		},
		stdout,
		stderr,
	};
}

describe("evidence-run record", () => {
	it("publishes a safe receipt before POST and prints the independent halves", async () => {
		const dir = tempDir();
		const { opts, stdout, stderr } = baseOptions(dir);
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(
					readFileSync(
						join(dir, "runner-state", "evidence-run", `${RECORD_ID}.json`),
						"utf8",
					),
				).toContain(RECORD_ID);
				const body = JSON.parse(String(init?.body));
				expect(body).not.toHaveProperty("schemaVersion");
				expect(body).toMatchObject({
					credential: "submission-secret",
					record_id: RECORD_ID,
					recorder_execution_id: "qa-2397",
					head: HEAD,
					site: "slot_529:2",
					lane: "generalized_e2e_stub",
					driver_exit_code: 0,
					record_url: RECORD_URL,
				});
				expect(init?.headers).toMatchObject({
					Authorization: "Bearer ingest-secret",
				});
				return response(200, successBody());
			},
		);

		expect(await evidenceRunRecord({ ...opts, fetchImpl })).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(stdout).toEqual([
			`strength-two: verdict=satisfied ran=satisfied/ok record=satisfied/ok record_id=${RECORD_ID}`,
		]);
		expect(stderr).toEqual([]);
		const receiptDir = join(dir, "runner-state", "evidence-run");
		const receiptPath = join(receiptDir, `${RECORD_ID}.json`);
		const receipt = readFileSync(receiptPath, "utf8");
		expect(receipt).not.toContain("submission-secret");
		expect(receipt).not.toContain("ingest-secret");
		expect(lstatSync(receiptDir).mode & 0o777).toBe(0o700);
		expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
	});

	it("fails local validation without publishing or posting", async () => {
		const dir = tempDir();
		const { opts, stderr } = baseOptions(dir);
		const fetchImpl = vi.fn<typeof fetch>();
		expect(
			await evidenceRunRecord({
				...opts,
				lane: "generalized_e2e_real",
				fetchImpl,
			}),
		).toBe(1);
		expect(stderr.join(" ")).toContain("rerun_spec_invalid:lane_mismatch");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses a conflicting local receipt without POST or overwrite", async () => {
		const dir = tempDir();
		const { opts } = baseOptions(dir);
		expect(
			await evidenceRunRecord({
				...opts,
				fetchImpl: vi.fn(async () => response(200, successBody())),
			}),
		).toBe(0);
		const receiptPath = join(
			dir,
			"runner-state",
			"evidence-run",
			`${RECORD_ID}.json`,
		);
		const before = readFileSync(receiptPath, "utf8");
		const secondFetch = vi.fn<typeof fetch>();
		expect(
			await evidenceRunRecord({
				...opts,
				head: "c".repeat(40),
				fetchImpl: secondFetch,
			}),
		).toBe(1);
		expect(secondFetch).not.toHaveBeenCalled();
		expect(readFileSync(receiptPath, "utf8")).toBe(before);
	});

	it.each([
		[404, { reason: "not_found" }, 1, 1],
		[422, { reason: "evidence_run_rejected:head_authority_mismatch" }, 1, 1],
		[409, { reason: "record_conflict" }, 1, 1],
	])(
		"does not retry terminal HTTP %s",
		async (status, body, exitCode, calls) => {
			const dir = tempDir();
			const { opts } = baseOptions(dir);
			const fetchImpl = vi.fn(async () => response(status, body));
			expect(await evidenceRunRecord({ ...opts, fetchImpl })).toBe(exitCode);
			expect(fetchImpl).toHaveBeenCalledTimes(calls);
		},
	);

	it("retries 429 and succeeds with the same record id", async () => {
		const dir = tempDir();
		const { opts } = baseOptions(dir);
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(429, { reason: "busy" }))
			.mockResolvedValueOnce(response(200, successBody()));
		expect(await evidenceRunRecord({ ...opts, fetchImpl })).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(opts.sleepImpl).toHaveBeenCalledWith(1_000);
		for (const call of fetchImpl.mock.calls) {
			expect(JSON.parse(String(call[1]?.body)).record_id).toBe(RECORD_ID);
		}
	});

	it("exhausts three retryable attempts without sleeping after the last", async () => {
		const dir = tempDir();
		const { opts, stderr } = baseOptions(dir);
		const fetchImpl = vi.fn(async () =>
			response(503, { reason: "unavailable" }),
		);
		expect(await evidenceRunRecord({ ...opts, fetchImpl })).toBe(2);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(opts.sleepImpl.mock.calls).toEqual([[1_000], [2_000]]);
		expect(stderr.join(" ")).toContain(`--record-id ${RECORD_ID}`);
	});

	it("redacts both credentials from a terminal server rejection", async () => {
		const dir = tempDir();
		const { opts, stdout, stderr } = baseOptions(dir);
		const fetchImpl = vi.fn(async () =>
			response(401, {
				reason: "submission-secret and ingest-secret must never print",
			}),
		);
		expect(await evidenceRunRecord({ ...opts, fetchImpl })).toBe(1);
		expect(`${stdout.join(" ")} ${stderr.join(" ")}`).not.toMatch(
			/submission-secret|ingest-secret/,
		);
	});
});

describe("publishEvidenceRunReceipt", () => {
	it("allows identical concurrent publishers and rejects different payloads", () => {
		const dir = tempDir();
		const payload = { schemaVersion: 1, record_id: RECORD_ID, head: HEAD };
		expect(
			publishEvidenceRunReceipt({
				stateDir: dir,
				recordId: RECORD_ID,
				payload,
			}),
		).toMatchObject({
			ok: true,
			status: "published",
		});
		expect(
			publishEvidenceRunReceipt({
				stateDir: dir,
				recordId: RECORD_ID,
				payload,
			}),
		).toMatchObject({
			ok: true,
			status: "reused",
		});
		expect(
			publishEvidenceRunReceipt({
				stateDir: dir,
				recordId: RECORD_ID,
				payload: { ...payload, head: "c".repeat(40) },
			}),
		).toEqual({ ok: false, reason: "receipt_conflict" });
	});

	it("refuses symlink and non-0600 destinations", () => {
		const dir = tempDir();
		const evidenceDir = join(dir, "evidence-run");
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		const target = join(dir, "target.json");
		writeFileSync(target, "{}", { mode: 0o600 });
		const dest = join(evidenceDir, `${RECORD_ID}.json`);
		symlinkSync(target, dest);
		expect(
			publishEvidenceRunReceipt({
				stateDir: dir,
				recordId: RECORD_ID,
				payload: {},
			}),
		).toEqual({ ok: false, reason: "receipt_unsafe" });
		rmSync(dest);
		writeFileSync(dest, "{}", { mode: 0o600 });
		chmodSync(dest, 0o644);
		expect(
			publishEvidenceRunReceipt({
				stateDir: dir,
				recordId: RECORD_ID,
				payload: {},
			}),
		).toEqual({ ok: false, reason: "receipt_unsafe" });
	});
});
