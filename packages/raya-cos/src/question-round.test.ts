import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusinessRound } from "./business-round.js";
import { OperationStore } from "./operation-store.js";

const roots: string[] = [];
const bot = "12345678901234567",
	parent = "12345678901234568",
	rootMessage = "12345678901234569";
const input = {
	schemaVersion: 2,
	operationId: "question:round-1:pr:42:1",
	kind: "question",
	sourceRefs: ["summary:round-1:pr:42"],
	requestId: "round-1:pr:42",
	requestRevision: 1,
	to: { project: "flywheel", leadId: "eng" },
	body: "Which release owns this?",
	expiresAt: 5000,
	directory: {
		projectsDigest: "a".repeat(64),
		projects: [],
		leads: [
			{
				ref: { project: "flywheel", leadId: "eng" },
				displayName: "Engineering",
				botUserId: bot,
				roundtableChannel: parent,
				external: false,
			},
		],
	},
};
function round() {
	const root = mkdtempSync(join(tmpdir(), "question-round-"));
	roots.push(root);
	return new BusinessRound(root, () => 1000);
}
function sent(revision = 1, engagement = "ready") {
	return {
		schemaVersion: 2,
		operationId: input.operationId,
		expectedRevision: revision,
		tool: "lead_actions.discord_send",
		callId: "send-1",
		result: {
			project: "raya",
			leadId: "raya",
			eventId: `question:${input.requestId}:1`,
			target: "roundtable",
			status: engagement === "ready" ? "sent" : "pending",
			sendStatus: "sent",
			engagement,
			messageId: rootMessage,
			channelId: parent,
			threadId: rootMessage,
		},
	};
}
function answer(revision = 2, extra = {}) {
	return {
		schemaVersion: 2,
		operationId: input.operationId,
		expectedRevision: revision,
		tool: "lead_inbound",
		callId: "inbound:source-1",
		result: {
			messageId: "12345678901234570",
			authorId: bot,
			channelId: rootMessage,
			replyTo: { messageId: rootMessage, channelId: parent },
			body: "The updater release owns it.",
			observedAt: 2000,
			...extra,
		},
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("directed business questions", () => {
	it("prepares from durable round source without a founder message and waits for real engagement", () => {
		const business = round();
		expect(business.prepare(input)).toMatchObject({
			stage: "prepared",
			next: {
				arguments: {
					target: "roundtable",
					text: expect.stringContaining(`<@${bot}>`),
					eventId: "question:round-1:pr:42:1",
				},
			},
		});
		expect(business.record(sent(1, "pending"))).toMatchObject({
			stage: "sent",
			next: { tool: "lead_actions.discord_send" },
		});
		const waiting = business.record(sent(2));
		expect(waiting).toMatchObject({ stage: "awaiting_reply", next: null });
		expect(JSON.stringify(waiting)).not.toContain("deliveryId");
	});
	it("rejects external, missing and ambiguous targets", () => {
		for (const leads of [
			[],
			[...input.directory.leads, ...input.directory.leads],
			[{ ...input.directory.leads[0], external: true }],
			[{ ...input.directory.leads[0], roundtableChannel: undefined }],
		]) {
			expect(() =>
				round().prepare({ ...input, directory: { ...input.directory, leads } }),
			).toThrow();
		}
	});
	it("binds replies to actual author and topic and rejects uncorrelated messages", () => {
		const business = round();
		business.prepare(input);
		business.record(sent());
		expect(() =>
			business.record(answer(2, { authorId: "12345678901234571" })),
		).toThrow(/author/);
		expect(() =>
			business.record(answer(2, { channelId: "12345678901234572" })),
		).toThrow(/channel/);
		expect(() => business.record(answer(2, { replyTo: undefined }))).toThrow(
			/correlation/,
		);
		expect(business.record(answer())).toMatchObject({
			stage: "answered",
			next: null,
		});
	});
	it("records late replies without settling the expired question", () => {
		const business = round();
		business.prepare(input);
		business.record(sent());
		const late = business.record(answer(2, { observedAt: 6000 }));
		expect(late).toMatchObject({ stage: "expired", next: null });
		expect(late.receipts.at(-1)).toMatchObject({ late: true });
	});
	it("accepts an exact request revision correlation within its topic", () => {
		const business = round();
		business.prepare(input);
		business.record(sent());
		expect(() =>
			business.record(
				answer(2, {
					replyTo: undefined,
					requestId: input.requestId,
					requestRevision: 2,
				}),
			),
		).toThrow(/correlation/);
		expect(
			business.record(
				answer(2, {
					replyTo: undefined,
					requestId: input.requestId,
					requestRevision: 1,
				}),
			),
		).toMatchObject({ stage: "answered" });
	});
	it("expires durably on resume and preserves a late reply without reopening", () => {
		const root = mkdtempSync(join(tmpdir(), "question-expiry-"));
		roots.push(root);
		let now = 1000;
		const business = new BusinessRound(root, () => now);
		business.prepare(input);
		business.record(sent());
		now = 6000;
		expect(business.resume(input.operationId)).toMatchObject({
			stage: "expired",
			revision: 3,
			next: null,
		});
		expect(business.prepare(input)).toMatchObject({ stage: "expired" });
		expect(business.record(answer(3, { observedAt: 6000 }))).toMatchObject({
			stage: "expired",
		});
	});
	it("cancels without sending and prevents a late event from reviving the question", () => {
		const business = round();
		business.prepare(input);
		expect(
			business.record({
				schemaVersion: 2,
				operationId: input.operationId,
				expectedRevision: 1,
				tool: "business_decision",
				callId: "current-turn:cancel",
				result: {
					action: "cancel",
					reason: "Founder withdrew this question",
					sourceRef: "founder:message-1",
				},
			}),
		).toMatchObject({ stage: "cancelled", next: null });
		expect(() => business.record(answer())).toThrow();
	});
	it("retains unassociated inbound messages and refuses guessed authors or altered replay bodies", () => {
		const business = round();
		business.prepare(input);
		business.record(sent());
		const source = answer().result;
		const pending = business.prepare({
			schemaVersion: 2,
			kind: "inbound_reply",
			source: { ...source, authorId: "12345678901234571" },
		});
		expect(pending.stage).toBe("pending_association");
		expect(() =>
			business.record({
				schemaVersion: 2,
				operationId: pending.operationId,
				expectedRevision: pending.revision,
				tool: "current_turn",
				callId: "associate-1",
				result: { action: "associate", questionOperationId: input.operationId },
			}),
		).toThrow(/author/);
		expect(business.resume(pending.operationId).stage).toBe(
			"pending_association",
		);
		expect(() =>
			business.prepare({ schemaVersion: 2, kind: "inbound_reply", source }),
		).toThrow(/binding/);
		expect(business.resume(input.operationId).stage).toBe("awaiting_reply");
	});
	it("recovers a reply association after the question was updated without duplicating its receipt", () => {
		const business = round();
		business.prepare(input);
		business.record(sent());
		const pending = business.prepare({
			schemaVersion: 2,
			kind: "inbound_reply",
			source: answer().result,
		});
		const associate = (revision: number) => ({
			schemaVersion: 2,
			operationId: pending.operationId,
			expectedRevision: revision,
			tool: "current_turn",
			callId: "associate-1",
			result: { action: "associate", questionOperationId: input.operationId },
		});
		const original = OperationStore.prototype.commit;
		const fault = vi
			.spyOn(OperationStore.prototype, "commit")
			.mockImplementation(function (value, revision) {
				if (value.kind === "inbound_reply" && value.stage === "associated")
					throw new Error("injected association receipt failure");
				return original.call(this, value, revision);
			});
		try {
			expect(() => business.record(associate(pending.revision))).toThrow(
				/injected/,
			);
		} finally {
			fault.mockRestore();
		}
		expect(business.resume(input.operationId).stage).toBe("answered");
		const reopened = new BusinessRound(
			roots[roots.length - 1] as string,
			() => 1000,
		);
		const resume = reopened.resume(pending.operationId);
		expect(reopened.record(associate(resume.revision)).stage).toBe(
			"associated",
		);
		expect(
			reopened
				.resume(input.operationId)
				.receipts.filter((row) => row.tool === "lead_inbound"),
		).toHaveLength(1);
		expect(
			reopened.prepare({
				schemaVersion: 2,
				kind: "inbound_reply",
				source: answer().result,
			}).next,
		).toBeNull();
	});
	it("keeps a cancelled question cancelled when its genuine reply is associated later", () => {
		const business = round();
		business.prepare(input);
		business.record(sent());
		business.record({
			schemaVersion: 2,
			operationId: input.operationId,
			expectedRevision: 2,
			tool: "business_decision",
			callId: "cancel-2",
			result: {
				action: "cancel",
				reason: "withdrawn",
				sourceRef: "founder:message-1",
			},
		});
		const pending = business.prepare({
			schemaVersion: 2,
			kind: "inbound_reply",
			source: answer().result,
		});
		const associated = business.record({
			schemaVersion: 2,
			operationId: pending.operationId,
			expectedRevision: pending.revision,
			tool: "current_turn",
			callId: "associate-late",
			result: { action: "associate", questionOperationId: input.operationId },
		});
		expect(associated.stage).toBe("late");
		expect(business.resume(input.operationId).stage).toBe("cancelled");
	});
});
