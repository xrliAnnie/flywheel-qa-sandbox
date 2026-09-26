/**
 * FLY-368: shared audited Lead resume-menu Enter. Mirrors the runner-nudge
 * safety contract: audit-before-send, fail-closed on audit failure, and the
 * narrow resume-menu gate.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	attemptLeadResumeEnter,
	type LeadResumeEnterDeps,
} from "../bridge/lead-resume-enter.js";
import { StateStore } from "../StateStore.js";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"lead-panes",
);
const fx = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf-8");

describe("attemptLeadResumeEnter (FLY-368)", () => {
	let store: StateStore;
	let sendEnter: ReturnType<typeof vi.fn>;

	function deps(
		pane: string,
		over: Partial<LeadResumeEnterDeps> = {},
	): LeadResumeEnterDeps {
		return {
			store,
			locateWindowFn: async () => ({ windowId: "@9", windowName: "w" }),
			captureFn: async () => pane,
			sendEnter: sendEnter as unknown as LeadResumeEnterDeps["sendEnter"],
			...over,
		};
	}
	const input = {
		actor: "auto-repair-bot",
		projectName: "geoforge3d",
		leadId: "cos-lead",
		correlationKey: "geoforge3d|cos-lead|pane_hash_stuck|",
		eventId: "evt-1",
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		sendEnter = vi.fn(async () => ({ sent: true }));
	});

	it("sends Enter for the safe resume menu and audits attempt+sent", async () => {
		const out = await attemptLeadResumeEnter(
			input,
			deps(fx("freeze-resume-menu.txt")),
		);
		expect(out.sent).toBe(true);
		expect(sendEnter).toHaveBeenCalledWith("@9");
	});

	it("REFUSES the compact prompt (Enter would start compaction)", async () => {
		const out = await attemptLeadResumeEnter(
			input,
			deps(fx("freeze-compact-prompt.txt")),
		);
		expect(out.sent).toBe(false);
		expect(sendEnter).not.toHaveBeenCalled();
	});

	it("REFUSES an idle pane (no resume menu)", async () => {
		const out = await attemptLeadResumeEnter(
			input,
			deps(fx("idle-cos-lead.txt")),
		);
		expect(out.sent).toBe(false);
		expect(sendEnter).not.toHaveBeenCalled();
	});

	it("FAIL-CLOSED: audit 'attempt' write failure → no Enter sent", async () => {
		const realRecord = store.recordAlertRepairAttempt.bind(store);
		vi.spyOn(store, "recordAlertRepairAttempt").mockImplementation((row) => {
			if (row.result === "attempt") return false;
			return realRecord(row);
		});
		const out = await attemptLeadResumeEnter(
			input,
			deps(fx("freeze-resume-menu.txt")),
		);
		expect(out.sent).toBe(false);
		expect(sendEnter).not.toHaveBeenCalled();
	});

	it("REFUSES when no tmux window is found", async () => {
		const out = await attemptLeadResumeEnter(input, {
			...deps(fx("freeze-resume-menu.txt")),
			locateWindowFn: async () => null,
		});
		expect(out.sent).toBe(false);
		expect(sendEnter).not.toHaveBeenCalled();
	});
});
