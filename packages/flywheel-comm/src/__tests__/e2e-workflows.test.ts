import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../dist/index.js");
let leadEnvs: Record<string, NodeJS.ProcessEnv> = {};

function runCli(args: string[], env?: Record<string, string>): string {
	const identityFlag =
		args[0] === "respond"
			? "--lead"
			: args[0] === "send"
				? "--from"
				: undefined;
	const identityIndex = identityFlag ? args.indexOf(identityFlag) : -1;
	const leadId = identityIndex >= 0 ? args[identityIndex + 1] : undefined;
	return execFileSync("node", [CLI_PATH, ...args], {
		encoding: "utf-8",
		env: {
			...process.env,
			TEAMLEAD_DB_PATH: `${args[args.indexOf("--db") + 1]}.absent`,
			...(leadId ? leadEnvs[leadId] : {}),
			...env,
		},
	}).trim();
}

describe("E2E workflows", { timeout: 20000 }, () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-e2e-"));
		dbPath = join(tmpDir, "comm.db");
		leadEnvs = createTestLeadIdentityEnvs(tmpDir, ["product-lead", "ops-lead"]);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function bindRunner(execId: string, leadId: string): void {
		const db = new CommDB(dbPath);
		db.registerSession(execId, "runner", "test", `issue-${execId}`, leadId);
		db.close();
	}

	it("should complete full Q&A workflow via CLI (JSON mode)", () => {
		bindRunner("ab1ae58b-41f1-5b25-ac3d-d2986b1fb848", "product-lead");
		// Runner asks a question
		const askResult = JSON.parse(
			runCli([
				"ask",
				"--lead",
				"product-lead",
				"--exec-id",
				"ab1ae58b-41f1-5b25-ac3d-d2986b1fb848",
				"--db",
				dbPath,
				"--json",
				"Should I use REST or GraphQL?",
			]),
		);
		expect(askResult.question_id).toBeTruthy();
		const qId = askResult.question_id;

		// Check: not yet answered
		const checkPending = JSON.parse(
			runCli(["check", "--db", dbPath, "--json", qId]),
		);
		expect(checkPending.status).toBe("pending");

		// Lead sees pending question
		const pendingResult = JSON.parse(
			runCli(["pending", "--lead", "product-lead", "--db", dbPath, "--json"]),
		);
		expect(pendingResult).toHaveLength(1);
		expect(pendingResult[0].id).toBe(qId);
		expect(pendingResult[0].from_agent).toBe(
			"ab1ae58b-41f1-5b25-ac3d-d2986b1fb848",
		);

		// Lead responds
		const respondResult = JSON.parse(
			runCli([
				"respond",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"--json",
				qId,
				"Use REST for simplicity.",
			]),
		);
		expect(respondResult.status).toBe("ok");

		// Check: now answered
		const checkAnswered = JSON.parse(
			runCli(["check", "--db", dbPath, "--json", qId]),
		);
		expect(checkAnswered.status).toBe("answered");
		expect(checkAnswered.content).toBe("Use REST for simplicity.");

		// No more pending
		const pendingAfter = JSON.parse(
			runCli(["pending", "--lead", "product-lead", "--db", dbPath, "--json"]),
		);
		expect(pendingAfter).toHaveLength(0);
	});

	it("should complete full instruction workflow via CLI (JSON mode)", () => {
		bindRunner("b5b57436-de83-50a4-86e7-e9e8abcd653a", "product-lead");
		// Lead sends instruction
		const sendResult = JSON.parse(
			runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"b5b57436-de83-50a4-86e7-e9e8abcd653a",
				"--db",
				dbPath,
				"--json",
				"Switch to GEO-999 immediately",
			]),
		);
		expect(sendResult.instruction_id).toBeTruthy();

		// Runner checks inbox
		const inboxResult = JSON.parse(
			runCli([
				"inbox",
				"--exec-id",
				"b5b57436-de83-50a4-86e7-e9e8abcd653a",
				"--db",
				dbPath,
				"--json",
			]),
		);
		expect(inboxResult).toHaveLength(1);
		expect(inboxResult[0].content).toBe("Switch to GEO-999 immediately");
		expect(inboxResult[0].from_agent).toBe("product-lead");

		// Inbox is now empty (instructions marked as read)
		const inboxAfter = JSON.parse(
			runCli([
				"inbox",
				"--exec-id",
				"b5b57436-de83-50a4-86e7-e9e8abcd653a",
				"--db",
				dbPath,
				"--json",
			]),
		);
		expect(inboxAfter).toHaveLength(0);
	});

	it("should handle mixed Q&A + instructions on same DB", () => {
		bindRunner("7524cbeb-ce3f-52a5-8119-b2096c55f6ea", "product-lead");
		// Q&A flow
		const askResult = JSON.parse(
			runCli([
				"ask",
				"--lead",
				"product-lead",
				"--exec-id",
				"7524cbeb-ce3f-52a5-8119-b2096c55f6ea",
				"--db",
				dbPath,
				"--json",
				"Which approach?",
			]),
		);

		// Instruction flow (concurrent)
		runCli([
			"send",
			"--from",
			"product-lead",
			"--to",
			"7524cbeb-ce3f-52a5-8119-b2096c55f6ea",
			"--db",
			dbPath,
			"Priority change: do X first",
		]);

		// Runner can see instruction
		const inboxResult = JSON.parse(
			runCli([
				"inbox",
				"--exec-id",
				"7524cbeb-ce3f-52a5-8119-b2096c55f6ea",
				"--db",
				dbPath,
				"--json",
			]),
		);
		expect(inboxResult).toHaveLength(1);
		expect(inboxResult[0].content).toBe("Priority change: do X first");

		// Question is still pending
		const pendingResult = JSON.parse(
			runCli(["pending", "--lead", "product-lead", "--db", dbPath, "--json"]),
		);
		expect(pendingResult).toHaveLength(1);
		expect(pendingResult[0].id).toBe(askResult.question_id);

		// Answer the question
		runCli([
			"respond",
			"--lead",
			"product-lead",
			"--db",
			dbPath,
			askResult.question_id,
			"Use approach B",
		]);

		const checkResult = JSON.parse(
			runCli(["check", "--db", dbPath, "--json", askResult.question_id]),
		);
		expect(checkResult.status).toBe("answered");
		expect(checkResult.content).toBe("Use approach B");
	});

	it("should handle multi-lead Q&A with independent chains", () => {
		bindRunner("beb93a8f-8aef-5c7b-9192-e9e250a925ce", "product-lead");
		bindRunner("888e5dd7-01c0-5cc6-9007-3e888231b55a", "ops-lead");
		// Runner asks product-lead
		const q1 = JSON.parse(
			runCli([
				"ask",
				"--lead",
				"product-lead",
				"--exec-id",
				"beb93a8f-8aef-5c7b-9192-e9e250a925ce",
				"--db",
				dbPath,
				"--json",
				"Product question?",
			]),
		).question_id;

		// Runner asks ops-lead
		const q2 = JSON.parse(
			runCli([
				"ask",
				"--lead",
				"ops-lead",
				"--exec-id",
				"888e5dd7-01c0-5cc6-9007-3e888231b55a",
				"--db",
				dbPath,
				"--json",
				"Ops question?",
			]),
		).question_id;

		// Each lead sees only their own pending
		const productPending = JSON.parse(
			runCli(["pending", "--lead", "product-lead", "--db", dbPath, "--json"]),
		);
		expect(productPending).toHaveLength(1);
		expect(productPending[0].content).toBe("Product question?");

		const opsPending = JSON.parse(
			runCli(["pending", "--lead", "ops-lead", "--db", dbPath, "--json"]),
		);
		expect(opsPending).toHaveLength(1);
		expect(opsPending[0].content).toBe("Ops question?");

		// Product-lead responds
		runCli([
			"respond",
			"--lead",
			"product-lead",
			"--db",
			dbPath,
			q1,
			"Product answer",
		]);

		// Ops still has pending question
		const opsStillPending = JSON.parse(
			runCli(["pending", "--lead", "ops-lead", "--db", dbPath, "--json"]),
		);
		expect(opsStillPending).toHaveLength(1);

		// Both answers retrievable independently
		const answer1 = JSON.parse(runCli(["check", "--db", dbPath, "--json", q1]));
		expect(answer1.status).toBe("answered");
		expect(answer1.content).toBe("Product answer");

		const answer2 = JSON.parse(runCli(["check", "--db", dbPath, "--json", q2]));
		expect(answer2.status).toBe("pending");
	});
});
