import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";
import {
	applyLegacyQuestions,
	planLegacyQuestions,
} from "./legacy-questions.js";
import { OperationStore } from "./operation-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "legacy-questions-"));
	roots.push(root);
	const path = join(root, "state/lead-questions/questions.json");
	mkdirSync(join(root, "state/lead-questions"), { recursive: true });
	const question = {
		askId: "original-ask",
		status: "posting",
		to: { project: "flywheel", leadId: "eng" },
		recipientUserId: "333333333333333333",
		displayName: "工程",
		question: "当前交付风险？",
		sourceMessageId: "111111111111111111",
		createdAt: "2026-09-08T00:00:00Z",
	};
	writeFileSync(path, JSON.stringify({ v: 1, questions: [question] }));
	return { root, path, question };
}
it("preserves source bytes and missing receipt uncertainty through import and replay", () => {
	const { root, path } = fixture(),
		raw = readFileSync(path, "utf8");
	const plan = planLegacyQuestions(root);
	expect(plan.questions[0]).toMatchObject({
		askId: "original-ask",
		action: "reconcile",
	});
	const identity = { flywheelSha: "a".repeat(40), rayaSha: "b".repeat(40) };
	const imported = applyLegacyQuestions(root, plan.digest, identity);
	expect(imported.operations).toEqual(["legacy-question:original-ask"]);
	const view = new BusinessRound(root).resume(imported.operations[0]);
	expect(view).toMatchObject({
		stage: "legacy_reconciliation",
		needsReconciliation: true,
		material: { legacy: { askId: "original-ask", status: "posting" } },
	});
	expect(view.next?.arguments.action).toBe("reconcile_legacy_question");
	expect(applyLegacyQuestions(root, plan.digest, identity)).toEqual(imported);
	expect(readFileSync(path, "utf8")).toBe(raw);
});
it("does not turn corrupt or duplicate identity state into an empty inventory", () => {
	const { root, path, question } = fixture();
	writeFileSync(
		path,
		JSON.stringify({ v: 1, questions: [question, question] }),
	);
	expect(() => planLegacyQuestions(root)).toThrow(/duplicate/);
	writeFileSync(path, "{broken");
	expect(() => planLegacyQuestions(root)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("{broken");
});
it("rejects stale inventory before import", () => {
	const { root, path, question } = fixture(),
		plan = planLegacyQuestions(root);
	writeFileSync(
		path,
		JSON.stringify({
			v: 1,
			questions: [
				{
					...question,
					status: "posted",
					postedMessageId: "444444444444444444",
				},
			],
		}),
	);
	expect(() =>
		applyLegacyQuestions(root, plan.digest, {
			flywheelSha: "a".repeat(40),
			rayaSha: "b".repeat(40),
		}),
	).toThrow(/changed/);
});

it("exposes plan and apply through the packaged CLI protocol", async () => {
	const { root } = fixture();
	const { runCoSCommand } = await import("./cli.js");
	const lines: string[] = [];
	await runCoSCommand(
		["legacy-questions-plan"],
		{ write: (line) => lines.push(line) },
		root,
	);
	const plan = JSON.parse(lines[0]);
	expect(
		await runCoSCommand(
			[
				"legacy-questions-apply",
				"--digest",
				plan.digest,
				"--flywheel-sha",
				"a".repeat(40),
				"--raya-sha",
				"b".repeat(40),
			],
			{ write: (line) => lines.push(line) },
			root,
		),
	).toBe(0);
	expect(JSON.parse(lines[1]).operations).toEqual([
		"legacy-question:original-ask",
	]);
});

function recoverable(extra = {}) {
	const f = fixture();
	writeFileSync(
		f.path,
		JSON.stringify({
			v: 1,
			questions: [
				{
					...f.question,
					transportUnavailableReason: "lead_transport_not_available",
					...extra,
				},
			],
		}),
	);
	applyLegacyQuestions(f.root, planLegacyQuestions(f.root).digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	const round = new BusinessRound(f.root, () => 1000);
	const receipt = {
		schemaVersion: 2,
		operationId: "legacy-question:original-ask",
		expectedRevision: 1,
		tool: "current_turn",
		callId: "original-metadata-1",
		result: {
			action: "recover_unavailable_question",
			metadataSourceRef: "original-event:ask-1",
			original: {
				askId: f.question.askId,
				revision: 3,
				to: f.question.to,
				body: f.question.question,
				expiresAt: 5000,
			},
			directory: {
				projectsDigest: "a".repeat(64),
				leads: [
					{
						ref: f.question.to,
						displayName: "Engineering",
						botUserId: f.question.recipientUserId,
						roundtableChannel: "222222222222222222",
						external: false,
					},
				],
			},
		},
	};
	return { ...f, round, receipt };
}
it("recovers original identity into ordinary question flow and resumes after restart without a second request", () => {
	const { root, round, receipt } = recoverable();
	const recovered = round.record(receipt);
	expect(recovered.next?.arguments.action).toBe("prepare");
	const input = recovered.next?.arguments.input;
	const prepared = new BusinessRound(root, () => 1000).prepare(input);
	expect(
		(
			new OperationStore(root).read(prepared.operationId)?.material as {
				question: unknown;
			}
		).question,
	).toMatchObject({
		requestId: "original-ask",
		requestRevision: 3,
		body: "当前交付风险？",
		expiresAt: 5000,
	});
	expect(prepared.next?.tool).toBe("lead_actions.discord_send");
	expect(round.prepare(input)).toEqual(prepared);
	expect(round.resume(receipt.operationId).next?.arguments).toMatchObject({
		action: "resume",
		operationId: prepared.operationId,
	});
	expect(() =>
		round.prepare({ ...(input as object), operationId: "another-question" }),
	).toThrow(/legacy|binding/);
	const sent = round.record({
		schemaVersion: 2,
		operationId: prepared.operationId,
		expectedRevision: prepared.revision,
		tool: "lead_actions.discord_send",
		callId: "send-1",
		result: {
			project: "raya",
			leadId: "raya",
			eventId: "question:original-ask:3",
			target: "roundtable",
			status: "sent",
			sendStatus: "sent",
			engagement: "ready",
			messageId: "444444444444444444",
			channelId: "222222222222222222",
			threadId: "444444444444444444",
		},
	});
	expect(sent.stage).toBe("awaiting_reply");
	const answered = new BusinessRound(root, () => 1000).record({
		schemaVersion: 2,
		operationId: sent.operationId,
		expectedRevision: sent.revision,
		tool: "lead_inbound",
		callId: "reply-1",
		result: {
			messageId: "555555555555555555",
			authorId: "333333333333333333",
			channelId: "444444444444444444",
			requestId: "original-ask",
			requestRevision: 3,
			body: "交付风险已核对。",
			observedAt: 2000,
		},
	});
	expect(answered.stage).toBe("answered");
	expect(round.prepare(input).stage).toBe("answered");
});
it("requires original metadata and rejects ambiguous delivery or terminal requests", () => {
	for (const extra of [
		{ postedMessageId: "444444444444444444" },
		{ postedAt: "2026-09-08" },
		{ answerMessageId: "444444444444444444" },
		{ deliveredMessageIds: ["444444444444444444"] },
		{ status: "expired" },
		{ status: "delivered" },
	]) {
		const { round, receipt } = recoverable(extra);
		expect(() => round.record(receipt)).toThrow(/legacy|terminal|delivery/);
	}
	const { round, receipt } = recoverable();
	for (const original of [
		{ ...receipt.result.original, revision: undefined },
		{ ...receipt.result.original, body: "new question" },
		{ ...receipt.result.original, expiresAt: 1000 },
	]) {
		expect(() =>
			round.record({ ...receipt, result: { ...receipt.result, original } }),
		).toThrow();
	}
	expect(() =>
		round.record({
			...receipt,
			result: { ...receipt.result, metadataSourceRef: "" },
		}),
	).toThrow();
});
