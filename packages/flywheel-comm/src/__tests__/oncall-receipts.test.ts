import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftIdForIdentity, OncallReceiptStore } from "../oncall-receipts.js";

function identity(overrides: Record<string, string> = {}) {
	return {
		book: "runbook" as const,
		lane: "mailbox" as const,
		correlationKey: "machine|fleet|bridge_abnormal_exit|",
		eventId: "event-1",
		kind: "bridge_abnormal_exit",
		...overrides,
	};
}

describe("OncallReceiptStore", () => {
	it("keeps the kind in the digest when readable prefixes collide", () => {
		const punctuationA = draftIdForIdentity(
			identity({ kind: "swap/pressure" }),
		);
		const punctuationB = draftIdForIdentity(
			identity({ kind: "swap:pressure" }),
		);
		const longA = draftIdForIdentity(identity({ kind: `${"x".repeat(45)}a` }));
		const longB = draftIdForIdentity(identity({ kind: `${"x".repeat(45)}b` }));

		expect(punctuationA.split("--").at(1)).toBe(punctuationB.split("--").at(1));
		expect(punctuationA).not.toBe(punctuationB);
		expect(longA.split("--").at(1)).toBe(longB.split("--").at(1));
		expect(longA).not.toBe(longB);
	});

	it("publishes idempotently but fails closed on a manufactured digest collision", () => {
		const root = mkdtempSync(join(tmpdir(), "oncall-receipts-collision-"));
		const store = new OncallReceiptStore(root, {
			digest: () => "0".repeat(16),
		});
		const first = store.writePendingDraft({
			...identity({ kind: "kind-a" }),
			author: "lead-a",
			body: "Generic recovery steps.",
			ref: "alert-ticket lookup --event-id event-1",
		});
		expect(
			store.writePendingDraft({
				...identity({ kind: "kind-a" }),
				author: "lead-a",
				body: "Generic recovery steps.",
				ref: "alert-ticket lookup --event-id event-1",
			}).draftId,
		).toBe(first.draftId);

		expect(() =>
			store.writePendingDraft({
				...identity({ kind: "kind:a" }),
				author: "lead-a",
				body: "Different recovery steps.",
				ref: "alert-ticket lookup --event-id event-1",
			}),
		).toThrowError("receipt_conflict");
		expect(readFileSync(first.path, "utf8")).toContain(
			"Generic recovery steps.",
		);
	});

	it("rejects traversal, absolute ids, sibling prefixes, and symlinks", () => {
		const parent = mkdtempSync(join(tmpdir(), "oncall-receipts-safe-"));
		const root = join(parent, "drafts");
		const store = new OncallReceiptStore(root);
		store.writePendingDraft({
			...identity(),
			author: "lead-a",
			body: "Generic recovery steps.",
			ref: "alert-ticket lookup --event-id event-1",
		});
		for (const unsafe of ["../escape", "/tmp/escape", "drafts-sibling/file"]) {
			expect(() => store.readDraftReceipt(unsafe)).toThrowError(
				"unsafe_receipt_path",
			);
		}

		const outside = join(parent, "outside");
		mkdirSync(outside);
		const symlinkRoot = join(parent, "symlink-root");
		symlinkSync(outside, symlinkRoot);
		expect(() => new OncallReceiptStore(symlinkRoot)).toThrowError(
			"unsafe_receipt_symlink",
		);

		const pendingLink = join(root, "pending", "linked.md");
		writeFileSync(join(outside, "target.md"), "unsafe");
		symlinkSync(join(outside, "target.md"), pendingLink);
		expect(() => store.readDraftReceipt("linked")).toThrowError(
			"unsafe_receipt_symlink",
		);
	});

	it("moves owed to pending to landed and reports backfill debt", () => {
		const root = mkdtempSync(join(tmpdir(), "oncall-receipts-flow-"));
		const store = new OncallReceiptStore(root);
		const owed = store.writeOwedReceipt({
			...identity({ book: "contact-book", kind: "unknown_owner" }),
			book: "contact-book",
		});
		expect(store.writeOwedReceipt(owed.receipt).draftId).toBe(owed.draftId);
		expect(store.readBackfillDebt()).toEqual({
			owed: ["unknown_owner"],
			pending: 0,
			landed: 0,
		});

		const pending = store.promoteOwedToPending({
			eventId: "event-1",
			to: "lead-a",
			author: "lead-a",
			body: "Escalate incidents of this shape to the owning service Lead.",
		});
		expect(pending.receipt).toMatchObject({
			book: "contact-book",
			to: "lead-a",
			body: "Escalate incidents of this shape to the owning service Lead.",
		});
		expect(store.readBackfillDebt()).toEqual({
			owed: [],
			pending: 1,
			landed: 0,
		});

		const landed = store.landPending(pending.draftId);
		expect(landed.receipt.landedAt).toEqual(expect.any(String));
		expect(store.readBackfillDebt()).toEqual({
			owed: [],
			pending: 0,
			landed: 1,
		});
	});

	it.each([
		["owed_to_pending", "promoteOwedToPending"],
		["pending_to_landed", "landPending"],
	] as const)(
		"recovers after %s links the target before source unlink",
		(op) => {
			const root = mkdtempSync(join(tmpdir(), `oncall-receipts-crash-${op}-`));
			let crash = true;
			const store = new OncallReceiptStore(root, {
				afterTargetLink: (operation) => {
					if (crash && operation === op) {
						crash = false;
						throw new Error("simulated_crash");
					}
				},
			});
			const owed = store.writeOwedReceipt({
				...identity({ book: "contact-book" }),
				book: "contact-book",
			});
			const promote = () =>
				store.promoteOwedToPending({
					eventId: "event-1",
					to: "lead-a",
					author: "lead-a",
					body: "Generic ownership rule.",
				});
			if (op === "owed_to_pending") {
				expect(promote).toThrowError("simulated_crash");
				expect(promote().receipt.body).toBe("Generic ownership rule.");
				expect(store.list("owed")).toHaveLength(0);
				expect(store.list("pending")).toHaveLength(1);
				return;
			}
			const pending = promote();
			expect(() => store.landPending(pending.draftId)).toThrowError(
				"simulated_crash",
			);
			expect(store.landPending(pending.draftId).receipt.landedAt).toEqual(
				expect.any(String),
			);
			expect(store.list("pending")).toHaveLength(0);
			expect(store.list("landed")).toHaveLength(1);
			expect(owed.draftId).toBe(pending.draftId);
		},
	);

	it("never replaces the winning body when two writers share an identity", () => {
		const root = mkdtempSync(join(tmpdir(), "oncall-receipts-winner-"));
		const firstStore = new OncallReceiptStore(root);
		const secondStore = new OncallReceiptStore(root);
		const winner = firstStore.writePendingDraft({
			...identity(),
			author: "lead-a",
			body: "Winner body.",
			ref: "alert-ticket lookup --event-id event-1",
		});
		expect(() =>
			secondStore.writePendingDraft({
				...identity(),
				author: "lead-b",
				body: "Losing body.",
				ref: "alert-ticket lookup --event-id event-1",
			}),
		).toThrowError("receipt_conflict");
		expect(readFileSync(winner.path, "utf8")).toContain("Winner body.");
		expect(readFileSync(winner.path, "utf8")).not.toContain("Losing body.");
	});
});
