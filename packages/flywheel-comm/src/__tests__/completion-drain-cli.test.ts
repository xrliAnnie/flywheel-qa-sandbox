import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeCompletionDrain,
	readCompletionDrainPage,
	renderConsumePendingMail,
} from "../commands/completion-drain.js";
import { sha256Utf8 } from "../completion-obligations.js";
import { CommDB } from "../db.js";

const READ_ID = `read_${"b".repeat(32)}`;

function answer(status: number, body: unknown) {
	return { status, text: async () => JSON.stringify(body) };
}

describe("FLY-2373 completion-drain CLI", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env.FLYWHEEL_BRIDGE_URL = "http://bridge.test";
		process.env.FLYWHEEL_INGEST_TOKEN = "ingest-secret";
		delete process.env.FLYWHEEL_WORKFLOW_ACTIVATION_ID;
		delete process.env.FLYWHEEL_COMM_DB;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("posts the ACK for the calling runner with the ingest token and reports success", async () => {
		const fetchImpl = vi.fn(async () =>
			answer(200, { ok: true, accepted: 2, rejected: [] }),
		);
		const result = await acknowledgeCompletionDrain({
			executionId: "exec-1",
			readId: READ_ID,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({
			ok: true,
			output: `[inbox] acknowledged 2 item(s) of read ${READ_ID}. Rerun your complete command now.`,
		});
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://bridge.test/events/completion-drain/ack");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer ingest-secret",
		});
		expect(JSON.parse(String(init.body))).toEqual({
			execution_id: "exec-1",
			read_id: READ_ID,
		});
	});

	it.each([
		["runner_ship_carrier", "carrierActivation"],
		["qa", "workflowActivation"],
	])("sends the runner's %s activation as %s", async (kind, field) => {
		const dir = mkdtempSync(join(tmpdir(), "fly2373-cli-activation-"));
		try {
			const dbPath = join(dir, "comm.db");
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "win:1", "flywheel", "FLY-2373", "lead");
			db.grantTurn("FLY-2373", "exec-1", "implement", 1_700_000_000_000, {
				project: "flywheel",
				sourceEventId: `turn:${kind}`,
				targetRunId: "run-1",
				activation: {
					activationId: "activation-7",
					runId: "run-1",
					nodeId: "implement",
					attempt: 1,
					context: { kind },
				},
			});
			db.close();
			process.env.FLYWHEEL_COMM_DB = dbPath;
			const fetchImpl = vi.fn(async () =>
				answer(200, { ok: true, accepted: 1, rejected: [] }),
			);
			await acknowledgeCompletionDrain({
				executionId: "exec-1",
				readId: READ_ID,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			const [, init] = fetchImpl.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			const body = JSON.parse(String(init.body));
			expect(body[field]).toMatchObject({ activationId: "activation-7" });
			expect(Object.keys(body)).not.toContain(
				field === "carrierActivation"
					? "workflowActivation"
					: "carrierActivation",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tells the runner exactly which pages it still has to read", async () => {
		const fetchImpl = vi.fn(async () =>
			answer(409, {
				error: "pages_not_read",
				readId: READ_ID,
				missingPages: [2, 3],
			}),
		);
		const result = await acknowledgeCompletionDrain({
			executionId: "exec-1",
			readId: READ_ID,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.output).toContain(
			`node "$FLYWHEEL_COMM_CLI" inbox --drain-page ${READ_ID} --page 2`,
		);
		expect(result.output).toContain(`--page 3`);
	});

	it("reports refused subjects instead of pretending the read was acknowledged", async () => {
		const fetchImpl = vi.fn(async () =>
			answer(409, {
				ok: false,
				accepted: 1,
				rejected: [{ subjectId: "delivery-2", reason: "content_changed" }],
			}),
		);
		const result = await acknowledgeCompletionDrain({
			executionId: "exec-1",
			readId: READ_ID,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toMatchObject({ ok: false });
		expect(result.output).toContain("delivery-2 (content_changed)");
	});

	it("rejects a malformed read id without calling the Bridge", async () => {
		const fetchImpl = vi.fn();
		const result = await acknowledgeCompletionDrain({
			executionId: "exec-1",
			readId: "read_;rm -rf",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("prints a page only when its digest matches its text", async () => {
		const text = "=== BEGIN [1/1] body part 2\n=== END [1/1]\n";
		const good = vi.fn(async () =>
			answer(200, {
				ok: true,
				page: { index: 2, count: 3, sha256: sha256Utf8(text), text },
			}),
		);
		const served = await readCompletionDrainPage({
			executionId: "exec-1",
			readId: READ_ID,
			page: 2,
			fetchImpl: good as unknown as typeof fetch,
		});
		expect(served.ok).toBe(true);
		expect(served.output).toContain("body part 2");
		expect(served.output).toContain("--page 3");

		const forged = vi.fn(async () =>
			answer(200, {
				ok: true,
				page: { index: 2, count: 3, sha256: sha256Utf8("other"), text },
			}),
		);
		const refused = await readCompletionDrainPage({
			executionId: "exec-1",
			readId: READ_ID,
			page: 2,
			fetchImpl: forged as unknown as typeof fetch,
		});
		expect(refused.ok).toBe(false);
		expect(refused.output).not.toContain("body part 2");
	});

	it("retries a Bridge 5xx before giving up", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(answer(503, { error: "drain_ack_unavailable" }))
			.mockResolvedValueOnce(answer(200, { ok: true, accepted: 1 }));
		const result = await acknowledgeCompletionDrain({
			executionId: "exec-1",
			readId: READ_ID,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("never renders a non-v2 or tampered 409 as readable content", () => {
		expect(
			renderConsumePendingMail({ reason: "consume_pending_mail" }, "retry"),
		).toBeUndefined();
		expect(
			renderConsumePendingMail(
				{
					protocolVersion: 2,
					readId: READ_ID,
					page: { index: 1, count: 1, sha256: "0".repeat(64), text: "x" },
				},
				"retry",
			),
		).toBeUndefined();
	});
});
