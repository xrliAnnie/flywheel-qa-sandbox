import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../../db.js";
import {
	buildWorkflowOutputRequest,
	workflowOutput,
} from "../workflow-output.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("workflow-output", () => {
	it("keeps the credential out of the payload artifact while binding a request id", () => {
		expect(
			buildWorkflowOutputRequest({
				credential: "secret-ticket",
				clientRequestId: "request-1",
				payload: '{"result":"ok"}',
			}),
		).toEqual({
			credential: "secret-ticket",
			client_request_id: "request-1",
			payload: '{"result":"ok"}',
		});
	});

	it("uses the output credential frozen for the current TURN activation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1423-output-activation-"));
		try {
			const dbPath = join(dir, "comm.db");
			const payloadPath = join(dir, "payload.json");
			writeFileSync(payloadPath, '{"result":"fixed"}', "utf8");
			const db = new CommDB(dbPath);
			db.registerSession(
				"implement-1",
				"win:1",
				"flywheel",
				"FLY-1423",
				"lead",
			);
			db.grantTurn("FLY-1423", "implement-1", "implement", 1_700_000_000_000, {
				project: "flywheel",
				sourceEventId: "rework:req-1:implement-activation-2",
				targetRunId: "run-1",
				activation: {
					activationId: "implement-activation-2",
					runId: "run-1",
					nodeId: "implement",
					attempt: 2,
					outputCredential: "current-output-credential",
					context: { authority: "qa" },
				},
			});
			db.close();

			vi.stubEnv("FLYWHEEL_COMM_DB", dbPath);
			vi.stubEnv("FLYWHEEL_EXEC_ID", "implement-1");
			vi.stubEnv("FLYWHEEL_BRIDGE_URL", "http://127.0.0.1:9876");
			vi.stubEnv("FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL", "stale-startup");
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ outputId: 42 }),
			});
			vi.stubGlobal("fetch", fetchMock);

			await workflowOutput({
				payloadFile: payloadPath,
				requestId: "request-2",
			});
			const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
			expect(JSON.parse(init.body)).toMatchObject({
				credential: "current-output-credential",
				client_request_id: "request-2",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
