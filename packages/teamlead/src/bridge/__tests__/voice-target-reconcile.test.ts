import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { readVoiceTargetTerminalProof } from "../voice-target-reconcile.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
it("accepts a matching durable success, never an unknown receipt or a current-value observation", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "voice-reconcile-"));
	roots.push(stateDir);
	const sessionId = "10000000-0000-4000-8000-000000000001";
	const root = join(stateDir, "voice-capability", sessionId);
	mkdirSync(root, { recursive: true });
	const journal = new SqliteJournalStore(join(root, "journal.db"));
	const receipt = {
		projectName: "flywheel",
		leadId: "eng",
		operationId: "linear.issue.update",
		requestId: "20000000-0000-4000-8000-000000000001",
		activationId: `voice:${sessionId}`,
		targetKey: "flywheel:linear:fly-2886",
		inputDigest: "a".repeat(64),
		now: 1000,
	};
	const lock = { ...receipt, holderActivation: receipt.activationId };
	try {
		journal.operationReceipts.prepare(receipt);
		journal.operationReceipts.transition({
			...receipt,
			from: "prepared",
			to: "dispatched",
		});
		journal.operationReceipts.transition({
			...receipt,
			from: "dispatched",
			to: "unknown",
		});
		expect(readVoiceTargetTerminalProof(stateDir, lock)).toBeNull();
		journal.operationReceipts.transition({
			...receipt,
			from: "unknown",
			to: "succeeded",
			providerRef: "issue:123",
		});
		expect(readVoiceTargetTerminalProof(stateDir, lock)).toMatchObject({
			outcome: "succeeded",
			operationId: receipt.operationId,
			providerRef: "issue:123",
		});
		expect(
			readVoiceTargetTerminalProof(stateDir, {
				...lock,
				requestId: "30000000-0000-4000-8000-000000000001",
			}),
		).toBeNull();
		expect(
			readVoiceTargetTerminalProof(stateDir, {
				...lock,
				targetKey: "flywheel:linear:other",
			}),
		).toBeNull();
		expect(
			readVoiceTargetTerminalProof(stateDir, {
				...lock,
				holderActivation: "voice:../../other",
			}),
		).toBeNull();
	} finally {
		journal.close();
	}
});

it("accepts a late Bridge inner receipt only for the original voice activation and target", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "voice-inner-reconcile-"));
	roots.push(stateDir);
	const journal = new SqliteJournalStore(join(stateDir, "bridge.db"));
	const receipt = {
		projectName: "flywheel",
		leadId: "eng",
		operationId: "github.pr.comment",
		requestId: "20000000-0000-4000-8000-000000000001",
		activationId: "voice:10000000-0000-4000-8000-000000000001",
		targetKey: "flywheel:github:x/repo#12",
		inputDigest: "a".repeat(64),
		now: 1000,
	};
	const lock = { ...receipt, holderActivation: receipt.activationId };
	try {
		journal.operationReceipts.prepare(receipt);
		journal.operationReceipts.transition({
			...receipt,
			from: "prepared",
			to: "dispatched",
		});
		journal.operationReceipts.transition({
			...receipt,
			from: "dispatched",
			to: "unknown",
		});
		expect(
			readVoiceTargetTerminalProof(stateDir, lock, journal.operationReceipts),
		).toBeNull();
		journal.operationReceipts.transition({
			...receipt,
			from: "unknown",
			to: "succeeded",
			providerRef: "github:comment:123",
		});
		expect(
			readVoiceTargetTerminalProof(stateDir, lock, journal.operationReceipts),
		).toMatchObject({
			outcome: "succeeded",
			operationId: receipt.operationId,
			providerRef: "github:comment:123",
		});
		for (const changed of [
			{ targetKey: "flywheel:github:x/repo#13" },
			{ holderActivation: "voice:30000000-0000-4000-8000-000000000001" },
			{ requestId: "40000000-0000-4000-8000-000000000001" },
		])
			expect(
				readVoiceTargetTerminalProof(
					stateDir,
					{ ...lock, ...changed },
					journal.operationReceipts,
				),
			).toBeNull();
	} finally {
		journal.close();
	}
});
