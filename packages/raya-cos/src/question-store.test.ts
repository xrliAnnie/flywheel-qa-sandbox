import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionStore, type StoredLeadQuestion } from "./question-store.js";

const roots: string[] = [];

function fixture(): { root: string; store: QuestionStore } {
	const root = mkdtempSync(join(tmpdir(), "raya-questions-"));
	roots.push(root);
	return { root, store: new QuestionStore(root, () => 1234) };
}

const question: StoredLeadQuestion = {
	askId: "3f0ca3af-4c83-493b-9253-2bc3978a5f74",
	status: "answer_observed",
	to: { project: "flywheel", leadId: "flywheel-eng-lead" },
	recipientUserId: "12345678901234567",
	displayName: "Flywheel Eng Lead",
	question: "Who owns this release?",
	sourceMessageId: "22345678901234567",
	createdAt: "2026-09-08T20:00:00.000Z",
	postedMessageId: "32345678901234567",
	answerMessageId: "42345678901234567",
	answerAuthorLeadId: "flywheel-eng-lead",
	answerReceiptMessageId: "52345678901234567",
	transportUnavailableReason: "lead_transport_not_available",
};

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("QuestionStore", () => {
	it("preserves lifecycle and known receipts without private thread state", () => {
		const { root, store } = fixture();
		store.write([question]);

		expect(store.read()).toEqual([question]);
		const path = join(root, "lead-questions", "questions.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toContain("threadId");
	});

	it("quarantines corrupt state and rejects event content", () => {
		const { root, store } = fixture();
		const path = join(root, "lead-questions", "questions.json");
		writeFileSync(path, "not-json", "utf8");
		expect(store.read()).toEqual([]);
		expect(existsSync(`${path}.corrupt-1234`)).toBe(true);
		expect(() =>
			store.appendEvent({
				at: "2026-09-08T20:00:00.000Z",
				kind: "asked",
				text: "secret",
			}),
		).toThrow("metadata-only");
	});
});
