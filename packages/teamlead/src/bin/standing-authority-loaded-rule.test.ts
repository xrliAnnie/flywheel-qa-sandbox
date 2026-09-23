import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	buildStandingAuthorityLoadedRuleReceipts,
	recordStandingAuthorityLoadedRuleReceipts,
	writeStandingAuthorityLoadedRuleReceipts,
} from "./standing-authority-loaded-rule.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const rules = [
	"prefix",
	"<!-- FLY-2654-ENTRY-BEGIN raya-carrier-follow-main/v1 -->",
	"raya body",
	"<!-- FLY-2654-ENTRY-END raya-carrier-follow-main/v1 -->",
	"<!-- FLY-2654-ENTRY-BEGIN lead-closeout-restart/v1 -->",
	"restart body",
	"<!-- FLY-2654-ENTRY-END lead-closeout-restart/v1 -->",
	"suffix",
	"",
].join("\n");

it("binds Codex receipts to the actual accepted thread and turn", () => {
	const receipts = buildStandingAuthorityLoadedRuleReceipts({
		baseInstructions: rules,
		leadIdentity: "flywheel-eng-lead",
		backend: "codex-app-server",
		instanceId: "instance-1",
		threadId: "thread-1",
		turnId: "turn-1",
		observedAt: "2026-09-20T01:00:00.000Z",
	});
	expect(receipts).toHaveLength(2);
	expect(receipts[0]).toMatchObject({
		leadIdentity: "flywheel-eng-lead",
		backend: "codex-app-server",
		instanceId: "instance-1",
		threadId: "thread-1",
		turnId: "turn-1",
	});
	expect(receipts[0]?.sourceReceiptId).toMatch(/^[a-f0-9]{64}$/);
});

it("writes immutable per-turn evidence plus an atomic latest pointer", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2654-loaded-rule-"));
	dirs.push(root);
	const receipts = buildStandingAuthorityLoadedRuleReceipts({
		baseInstructions: rules,
		leadIdentity: "flywheel-eng-lead",
		backend: "codex-app-server",
		instanceId: "instance-1",
		threadId: "thread-1",
		turnId: "turn-1",
		observedAt: "2026-09-20T01:00:00.000Z",
	});
	const paths = writeStandingAuthorityLoadedRuleReceipts(root, receipts);
	expect(paths).toHaveLength(2);
	for (const { archivePath, latestPath } of paths) {
		expect(readFileSync(archivePath)).toEqual(readFileSync(latestPath));
	}
	expect(() =>
		writeStandingAuthorityLoadedRuleReceipts(root, [
			{ ...receipts[0]!, entryDigest: "f".repeat(64) },
		]),
	).toThrow("standing-authority-loaded-receipt-conflict");
});

it("returns no receipts when the governed entries are absent and rejects partial rules", () => {
	expect(
		buildStandingAuthorityLoadedRuleReceipts({
			baseInstructions: "unrelated rules",
			leadIdentity: "lead",
			backend: "codex-app-server",
			instanceId: "instance",
			threadId: "thread",
			turnId: "turn",
			observedAt: "2026-09-20T01:00:00.000Z",
		}),
	).toEqual([]);
	expect(() =>
		buildStandingAuthorityLoadedRuleReceipts({
			baseInstructions: rules.replace(
				/<!-- FLY-2654-ENTRY-BEGIN lead-closeout-restart\/v1 -->[\s\S]*<!-- FLY-2654-ENTRY-END lead-closeout-restart\/v1 -->\n/,
				"",
			),
			leadIdentity: "lead",
			backend: "codex-app-server",
			instanceId: "instance",
			threadId: "thread",
			turnId: "turn",
			observedAt: "2026-09-20T01:00:00.000Z",
		}),
	).toThrow("standing-authority-loaded-rules-partial");
});

const partialRules = [
	"<!-- FLY-2654-ENTRY-BEGIN raya-carrier-follow-main/v1 -->",
	"raya body",
	"<!-- FLY-2654-ENTRY-END raya-carrier-follow-main/v1 -->",
	"",
].join("\n");

const receiptInput = (baseInstructions: string) => ({
	baseInstructions,
	leadIdentity: "flywheel-eng-lead",
	backend: "codex-app-server" as const,
	instanceId: "instance-1",
	threadId: "thread-1",
	turnId: "turn-1",
	observedAt: "2026-09-20T01:00:00.000Z",
});

it("records loaded-rule evidence best-effort so a live turn never fails on it", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2654-loaded-rule-"));
	dirs.push(root);
	const warn = vi.fn();
	const recorded = recordStandingAuthorityLoadedRuleReceipts({
		root,
		input: receiptInput(rules),
		warn,
	});
	expect(recorded).toEqual({
		status: "recorded",
		receipts: 2,
	});
	expect(warn).not.toHaveBeenCalled();

	// A revoked entry whose block was removed leaves exactly one marker. The
	// evidence path must report and continue instead of throwing into startTurn.
	const partial = recordStandingAuthorityLoadedRuleReceipts({
		root,
		input: receiptInput(partialRules),
		warn,
	});
	expect(partial).toEqual({
		status: "skipped",
		reason: "standing-authority-loaded-rules-partial",
	});
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls[0]?.[0]).toContain(
		"standing-authority-loaded-rules-partial",
	);

	// A conflicting archive (same receipt id, different bytes) is a write failure,
	// not a turn failure.
	const receipts = buildStandingAuthorityLoadedRuleReceipts(
		receiptInput(rules),
	);
	const slug = receipts[0]!.entryId.replaceAll("/", "--");
	writeFileSync(
		join(root, slug, `${receipts[0]!.sourceReceiptId}.json`),
		'{"tampered":true}\n',
	);
	const conflict = recordStandingAuthorityLoadedRuleReceipts({
		root,
		input: receiptInput(rules),
		warn,
	});
	expect(conflict).toEqual({
		status: "skipped",
		reason: "standing-authority-loaded-receipt-conflict",
	});
	expect(warn).toHaveBeenCalledTimes(2);
});

it("keeps the Codex startTurn wrapper on the best-effort recorder only", () => {
	const runtime = readFileSync(
		join(__dirname, "../lead-backends/codex/codex-lead-runtime.ts"),
		"utf8",
	);
	const wrapper = runtime.slice(
		runtime.indexOf("startTurn: async (args) => {"),
		runtime.indexOf("const executor = new CodexTurnExecutor("),
	);
	expect(wrapper).toContain("recordStandingAuthorityLoadedRuleReceipts(");
	expect(wrapper).not.toContain("buildStandingAuthorityLoadedRuleReceipts(");
	expect(wrapper).not.toContain("writeStandingAuthorityLoadedRuleReceipts(");
	expect(runtime).not.toMatch(
		/import \{[^}]*(buildStandingAuthorityLoadedRuleReceipts|writeStandingAuthorityLoadedRuleReceipts)[^}]*\} from "\.\.\/\.\.\/bin\/standing-authority-loaded-rule\.js"/,
	);
});
