import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";
import { GOALS_FILE_HEADER, parseGoalsFile } from "../contracts/goals.js";

const roots: string[] = [];
const founder = "111111111111111111",
	message = "222222222222222222",
	channel = "333333333333333333",
	commit = "a".repeat(40);
const source = {
	authorId: founder,
	messageId: message,
	channelId: channel,
	sourceUrl: `https://discord.com/channels/444444444444444444/${channel}/${message}`,
	at: "2026-09-15T04:00:00Z",
	body: "这周先把 Flywheel 的稳定性做好。",
};
const input = {
	schemaVersion: 2,
	kind: "goal_update",
	founderUserId: founder,
	source,
	projects: ["flywheel", "raya"],
	memory: { status: "clean", commit, body: `${GOALS_FILE_HEADER}\n` },
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "goal-round-"));
	roots.push(root);
	return { root, round: new BusinessRound(root) };
}
function record(
	round: BusinessRound,
	view: { operationId: string; revision: number },
	result: object,
) {
	return round.record({
		schemaVersion: 2,
		operationId: view.operationId,
		expectedRevision: view.revision,
		tool: "current_turn",
		callId: `turn-${view.revision}`,
		result,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("conversation goal updates", () => {
	it("extracts an inferred goal from ordinary conversation without marker syntax and freezes scoped provenance", () => {
		const { root, round } = fixture();
		const prepared = round.prepare(input);
		const planned = record(round, prepared, {
			action: "plan",
			decisions: [
				{
					action: "record",
					kind: "inference",
					text: "优先改善稳定性",
					projects: ["flywheel"],
				},
			],
		});
		expect(planned.material).toMatchObject({
			plan: {
				goals: [
					{
						id: "g-20260915-01",
						kind: "inference",
						projects: ["flywheel"],
						sourceUrl: source.sourceUrl,
						operationId: `${message}:record:0`,
						revision: 1,
					},
				],
			},
		});
		const body = String((planned.material?.plan as { body: string }).body);
		expect(body).toContain("- 提炼: 「优先改善稳定性」");
		expect(
			new BusinessRound(root).resume(prepared.operationId).material,
		).toEqual(planned.material);
		expect(() =>
			record(round, planned, { action: "plan", decisions: [] }),
		).toThrow();
	});
	it("rejects non-founder sources, fabricated quotations, dirty bases and foreign project scope", () => {
		const { round } = fixture();
		expect(() =>
			round.prepare({
				...input,
				source: { ...source, authorId: "555555555555555555" },
			}),
		).toThrow(/founder/);
		expect(() =>
			round.prepare({ ...input, memory: { ...input.memory, status: "dirty" } }),
		).toThrow(/clean/);
		const prepared = round.prepare(input);
		for (const decision of [
			{
				action: "record",
				kind: "commitment",
				text: "ship everything",
				projects: ["flywheel"],
			},
			{
				action: "record",
				kind: "inference",
				text: "Focus",
				projects: ["foreign"],
			},
		])
			expect(() =>
				record(round, prepared, { action: "plan", decisions: [decision] }),
			).toThrow();
	});
	it("withdraws the prior goal and links a corrected successor while preserving the old text and identity", () => {
		const { round } = fixture();
		const first = record(round, round.prepare(input), {
			action: "plan",
			decisions: [
				{
					action: "record",
					kind: "inference",
					text: "优先稳定性",
					projects: ["flywheel"],
				},
			],
		});
		const body = String((first.material?.plan as { body: string }).body);
		const nextMessage = "222222222222222223";
		const correction = round.prepare({
			...input,
			source: {
				...source,
				messageId: nextMessage,
				sourceUrl: source.sourceUrl.replace(message, nextMessage),
				body: "改一下，先完成语音。",
			},
			memory: { ...input.memory, body },
		});
		const planned = record(round, correction, {
			action: "plan",
			decisions: [
				{
					action: "correct",
					goalId: "g-20260915-01",
					kind: "inference",
					text: "先完成语音",
					projects: ["raya"],
				},
			],
		});
		const goals = parseGoalsFile(
			String((planned.material?.plan as { body: string }).body),
		);
		expect(goals[0]).toMatchObject({
			id: "g-20260915-01",
			text: "优先稳定性",
			status: "withdrawn",
			withdrawOperationId: `${nextMessage}:withdraw:0`,
		});
		expect(goals[1]).toMatchObject({
			id: "g-20260915-02",
			status: "active",
			supersedes: "g-20260915-01",
			revision: 2,
			projects: ["raya"],
		});
	});
	it("reconciles one frozen goal commit after an unknown result and preserves a failed push", () => {
		const { root, round } = fixture();
		const planned = record(round, round.prepare(input), {
			action: "plan",
			decisions: [
				{
					action: "record",
					kind: "commitment",
					text: source.body,
					projects: ["flywheel"],
				},
			],
		});
		const unknown = record(round, planned, {
			action: "commit",
			outcome: "unknown",
		});
		expect(unknown.next?.arguments.task).toContain("read-only");
		const plan = unknown.material?.plan as {
			bodySha256: string;
			commitMessage: string;
		};
		const receipt = {
			action: "commit",
			outcome: "committed",
			commit: "b".repeat(40),
			parent: commit,
			bodySha256: plan.bodySha256,
			changedPaths: ["goals.md"],
			message: plan.commitMessage,
		};
		expect(() =>
			record(round, unknown, { ...receipt, changedPaths: ["MEMORY.md"] }),
		).toThrow();
		const reopened = new BusinessRound(root);
		const committed = record(reopened, unknown, receipt);
		const failed = record(reopened, committed, {
			action: "push",
			outcome: "failed",
			commit: receipt.commit,
		});
		expect(failed.stage).toBe("committed");
		expect(
			record(reopened, failed, {
				action: "push",
				outcome: "pushed",
				commit: receipt.commit,
			}),
		).toMatchObject({ stage: "complete", next: null });
	});
});
