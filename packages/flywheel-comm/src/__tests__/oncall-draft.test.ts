import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runOncallDraftCommand } from "../commands/oncall-draft.js";
import { OncallReceiptStore } from "../oncall-receipts.js";

const compliantRunbook = `## 现象
The alert names the affected service.

## 去哪看 log 还原
Read the log location from service startup configuration.

## 做了什么
Restart the failed worker after preserving its error context.

## 怎么确认好了
Confirm the worker resumed processing in its configured log.

## 该找谁
Use the contact book entry for this alert kind.`;

function harness(root: string, overrides: Record<string, unknown> = {}) {
	let stdout = "";
	let stderr = "";
	return {
		opts: {
			env: {
				FLYWHEEL_STATE_DIR: root,
				FLYWHEEL_LEAD_ID: "lead-a",
			},
			writeStdout: (text: string) => {
				stdout += text;
			},
			writeStderr: (text: string) => {
				stderr += text;
			},
			lookupAlert: vi.fn(async () => ({
				lane: "mailbox" as const,
				correlationKey: "machine|fleet|bridge_abnormal_exit|",
				eventId: "event-1",
				kind: "bridge_abnormal_exit",
				ref: "alert-ticket lookup --event-id event-1",
			})),
			readDraftBody: () => compliantRunbook,
			...overrides,
		},
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

describe("oncall-draft", () => {
	it.each([
		["/Users/operator/private.log", "local_user_path"],
		["read /home/operator/private.log", "local_user_path"],
		["read $HOME/private.log", "local_user_path"],
		["channel 123456789012345678", "snowflake"],
		["Authorization: Bearer secret", "credential"],
		["email operator@example.com", "email"],
	])("rejects non-generic content containing %s", async (body, reason) => {
		const state = mkdtempSync(join(tmpdir(), "oncall-draft-guard-"));
		const h = harness(state, { readDraftBody: () => body });
		expect(
			await runOncallDraftCommand(
				["add", "--book", "runbook", "--event-id", "event-1", "--file", "-"],
				h.opts,
			),
		).toBe(3);
		expect(h.stderr()).toContain(reason);
		expect(h.stderr()).toContain("line 1");
	});

	it("adds a verified runbook draft with complete provenance", async () => {
		const state = mkdtempSync(join(tmpdir(), "oncall-draft-runbook-"));
		const h = harness(state);
		expect(
			await runOncallDraftCommand(
				["add", "--book", "runbook", "--event-id", "event-1", "--file", "-"],
				h.opts,
			),
		).toBe(0);
		const store = new OncallReceiptStore(join(state, "oncall-drafts"));
		const pending = store.list("pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.receipt).toMatchObject({
			book: "runbook",
			lane: "mailbox",
			correlationKey: "machine|fleet|bridge_abnormal_exit|",
			eventId: "event-1",
			kind: "bridge_abnormal_exit",
			author: "lead-a",
			ref: "alert-ticket lookup --event-id event-1",
			body: compliantRunbook,
		});
		expect(h.stdout().trim()).toBe(pending[0]?.draftId);
	});

	it("requires an owed receipt before adding a contact-book draft", async () => {
		const state = mkdtempSync(join(tmpdir(), "oncall-draft-contact-"));
		const body =
			"This alert belongs to the runtime owner in the project roster.";
		const missing = harness(state, { readDraftBody: () => body });
		expect(
			await runOncallDraftCommand(
				[
					"add",
					"--book",
					"contact-book",
					"--event-id",
					"old-event",
					"--to",
					"lead-b",
					"--file",
					"-",
				],
				missing.opts,
			),
		).toBe(4);
		expect(missing.opts.lookupAlert).not.toHaveBeenCalled();

		const store = new OncallReceiptStore(join(state, "oncall-drafts"));
		store.writeOwedReceipt({
			book: "contact-book",
			lane: "thread",
			correlationKey: "old|episode|key|",
			eventId: "old-event",
			kind: "unknown_owner",
		});
		const h = harness(state, { readDraftBody: () => body });
		expect(
			await runOncallDraftCommand(
				[
					"add",
					"--book",
					"contact-book",
					"--event-id",
					"old-event",
					"--to",
					"lead-b",
					"--file",
					"-",
				],
				h.opts,
			),
		).toBe(0);
		expect(h.opts.lookupAlert).not.toHaveBeenCalled();
		expect(store.list("pending")[0]?.receipt).toMatchObject({
			correlationKey: "old|episode|key|",
			eventId: "old-event",
			to: "lead-b",
		});
	});

	it("lists debt as JSON", async () => {
		const state = mkdtempSync(join(tmpdir(), "oncall-draft-list-"));
		const store = new OncallReceiptStore(join(state, "oncall-drafts"));
		store.writeOwedReceipt({
			book: "contact-book",
			lane: "mailbox",
			correlationKey: "ck",
			eventId: "event-owed",
			kind: "owner_missing",
		});
		const h = harness(state);
		expect(await runOncallDraftCommand(["list", "--json"], h.opts)).toBe(0);
		expect(JSON.parse(h.stdout())).toEqual({
			owed: ["owner_missing"],
			pending: 0,
			landed: 0,
		});
	});

	it("harvests both books, preserves idempotent markers, and supports dry-run", async () => {
		const state = mkdtempSync(join(tmpdir(), "oncall-draft-harvest-"));
		const repo = mkdtempSync(join(tmpdir(), "oncall-draft-repo-"));
		mkdirSync(join(repo, "doc", "oncall", "runbooks"), { recursive: true });
		writeFileSync(
			join(repo, "doc", "oncall", "contact-book.md"),
			"# Contacts\n\n| 类别 | 找谁 | 这类问题是什么 |\n|---|---|---|\n| `unknown_owner` | Tadashi | old |\n",
		);
		const store = new OncallReceiptStore(join(state, "oncall-drafts"));
		store.writePendingDraft({
			book: "runbook",
			lane: "mailbox",
			correlationKey: "ck-runbook",
			eventId: "event-runbook",
			kind: "bridge_abnormal_exit",
			author: "lead-a",
			body: compliantRunbook,
			ref: "alert-ticket lookup --event-id event-runbook",
		});
		store.writeOwedReceipt({
			book: "contact-book",
			lane: "thread",
			correlationKey: "ck-contact",
			eventId: "event-contact",
			kind: "unknown_owner",
		});
		store.promoteOwedToPending({
			eventId: "event-contact",
			to: "lead-b",
			author: "lead-a",
			body: "The owning service Lead handles this alert kind.",
		});
		const dry = harness(state);
		expect(
			await runOncallDraftCommand(
				["harvest", "--repo", repo, "--dry-run"],
				dry.opts,
			),
		).toBe(0);
		expect(store.list("pending")).toHaveLength(2);
		expect(
			readFileSync(join(repo, "doc", "oncall", "contact-book.md"), "utf8"),
		).toContain("| `unknown_owner` | Tadashi | old |");

		const live = harness(state);
		expect(
			await runOncallDraftCommand(["harvest", "--repo", repo], live.opts),
		).toBe(0);
		expect(store.list("pending")).toHaveLength(0);
		expect(store.list("landed")).toHaveLength(2);
		expect(
			readFileSync(
				join(repo, "doc", "oncall", "runbooks", "bridge_abnormal_exit.md"),
				"utf8",
			),
		).toContain("<!-- backfill:event-runbook -->");
		const contact = readFileSync(
			join(repo, "doc", "oncall", "contact-book.md"),
			"utf8",
		);
		expect(contact).toContain("| `unknown_owner` | lead-b |");
		expect(contact).toContain("<!-- backfill:event-contact -->");
	});

	it.each(["runbook", "contact-book"] as const)(
		"recovers %s harvesting after the page write but before receipt landing",
		async (book) => {
			const state = mkdtempSync(
				join(tmpdir(), `oncall-harvest-crash-${book}-`),
			);
			const repo = mkdtempSync(join(tmpdir(), `oncall-harvest-repo-${book}-`));
			mkdirSync(join(repo, "doc", "oncall", "runbooks"), { recursive: true });
			writeFileSync(
				join(repo, "doc", "oncall", "contact-book.md"),
				"# Contacts\n\n| 类别 | 找谁 | 这类问题是什么 |\n|---|---|---|\n",
			);
			const store = new OncallReceiptStore(join(state, "oncall-drafts"));
			if (book === "runbook") {
				store.writePendingDraft({
					book,
					lane: "mailbox",
					correlationKey: "ck-crash",
					eventId: "event-crash",
					kind: "crash_loop",
					author: "lead-a",
					body: compliantRunbook,
					ref: "alert-ticket lookup --event-id event-crash",
				});
			} else {
				store.writeOwedReceipt({
					book,
					lane: "thread",
					correlationKey: "ck-crash",
					eventId: "event-crash",
					kind: "crash_owner",
				});
				store.promoteOwedToPending({
					eventId: "event-crash",
					to: "lead-b",
					author: "lead-a",
					body: "The runtime owner handles this class.",
				});
			}
			let crash = true;
			const first = harness(state, {
				afterPageWrite: () => {
					if (crash) {
						crash = false;
						throw new Error("simulated_crash");
					}
				},
			});
			expect(
				await runOncallDraftCommand(["harvest", "--repo", repo], first.opts),
			).toBe(5);
			expect(store.list("pending")).toHaveLength(1);
			const target =
				book === "runbook"
					? join(repo, "doc", "oncall", "runbooks", "crash_loop.md")
					: join(repo, "doc", "oncall", "contact-book.md");
			const afterCrash = readFileSync(target, "utf8");

			const retry = harness(state);
			expect(
				await runOncallDraftCommand(["harvest", "--repo", repo], retry.opts),
			).toBe(0);
			expect(readFileSync(target, "utf8")).toBe(afterCrash);
			expect(store.list("pending")).toHaveLength(0);
			expect(store.list("landed")).toHaveLength(1);
		},
	);
});
