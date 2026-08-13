import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { respond } from "../commands/respond.js";
import { CommDB } from "../db.js";
import { readAskMarker, writeAskMarker } from "../gate-marker.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

describe("respond canonical mailbox write", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	it("writes one Runner response, no runner_phase_wakes mirror, and retires the ask marker", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1572-respond-"));
		roots.push(root);
		const dbPath = join(root, "comm.db");
		const markerDir = join(root, "markers");
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "runner", "flywheel", "issue-1", "lead-a");
		const questionId = db.insertQuestion("exec-1", "lead-a", "question");
		db.close();
		writeAskMarker(markerDir, {
			questionId,
			executionId: "exec-1",
			vendor: "codex",
		});
		const env = createTestLeadIdentityEnvs(root, ["lead-a"])["lead-a"];
		await respond({
			questionId,
			fromAgent: "lead-a",
			answer: "answer",
			dbPath,
			env: { ...env, FLYWHEEL_GATE_MARKER_DIR: markerDir },
		});
		const verify = new CommDB(dbPath);
		try {
			expect(verify.getResponse(questionId)).toMatchObject({
				from_agent: "lead-a",
				to_agent: "exec-1",
				content: "answer",
				delivered_at: null,
			});
			expect(verify.listRunnerPhaseWakes("exec-1")).toEqual([]);
			expect(readAskMarker(markerDir, questionId)).toBeUndefined();
		} finally {
			verify.close();
		}
	});
});
