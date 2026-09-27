import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const roots: string[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function openPair(): Promise<[StateStore, StateStore]> {
	const root = mkdtempSync(join(tmpdir(), "fly2778-apply-claim-"));
	roots.push(root);
	const dbPath = join(root, "teamlead.db");
	const first = await StateStore.create(dbPath);
	const second = await StateStore.create(dbPath);
	stores.push(first, second);
	return [first, second];
}

const baseClaim = {
	effectScope: "stock_worktree_cleanup" as const,
	effectKey: "flywheel:/Users/example/flywheel-FLY-2778:generation-7",
	rootUuid: "11111111-1111-4111-8111-111111111111",
	approvedHash: "approved-hash",
	requestId: "22222222-2222-4222-8222-222222222222",
	targetDigest: "target-digest-a",
	project: "flywheel",
	actor: "flywheel-eng-lead",
};

describe("FLY-2778 scoped lifecycle apply claims", () => {
	it("migrates legacy issue-closeout claims without changing their replay key", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2778-apply-legacy-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const legacy = new BetterSqlite3(dbPath);
		legacy.exec(`
			CREATE TABLE lifecycle_apply_claims (
				root_uuid TEXT NOT NULL,
				approved_hash TEXT NOT NULL,
				status TEXT NOT NULL,
				report_json TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (root_uuid, approved_hash)
			);
			INSERT INTO lifecycle_apply_claims
				(root_uuid, approved_hash, status, report_json)
			VALUES ('root-legacy', 'hash-legacy', 'complete', '{"ok":true}');
		`);
		legacy.close();

		const store = await StateStore.create(dbPath);
		stores.push(store);
		expect(store.getApplyClaim("root-legacy", "hash-legacy")).toEqual({
			status: "complete",
			reportJson: '{"ok":true}',
		});
	});

	it("allows only one request to claim the same stock-cleanup effect", async () => {
		const [first, second] = await openPair();

		const [left, right] = await Promise.all([
			Promise.resolve().then(() => first.claimApplyEffect(baseClaim)),
			Promise.resolve().then(() =>
				second.claimApplyEffect({
					...baseClaim,
					requestId: "33333333-3333-4333-8333-333333333333",
					targetDigest: "target-digest-b",
				}),
			),
		]);

		expect([left.outcome, right.outcome].sort()).toEqual([
			"claimed",
			"conflict",
		]);
		const loser = left.outcome === "conflict" ? left : right;
		expect(loser).toMatchObject({
			outcome: "conflict",
			reason: "effect_already_claimed",
		});
	});

	it("replays only the exact request and rejects request-id content drift", async () => {
		const [store] = await openPair();

		expect(store.claimApplyEffect(baseClaim)).toMatchObject({
			outcome: "claimed",
			claim: {
				effectScope: "stock_worktree_cleanup",
				effectKey: baseClaim.effectKey,
				requestId: baseClaim.requestId,
				targetDigest: baseClaim.targetDigest,
				status: "claimed",
			},
		});
		expect(store.claimApplyEffect(baseClaim)).toMatchObject({
			outcome: "replay",
		});
		expect(
			store.claimApplyEffect({
				...baseClaim,
				targetDigest: "changed-selection",
			}),
		).toEqual({ outcome: "conflict", reason: "request_content_mismatch" });
	});

	it("preserves a rejected receipt while allowing a fresh request to retry the effect", async () => {
		const [store] = await openPair();
		expect(store.claimApplyEffect(baseClaim).outcome).toBe("claimed");
		expect(
			store.casApplyEffect({
				...baseClaim,
				fromStatus: "claimed",
				toStatus: "rejected",
				reportJson: '{"removed":false}',
			}),
		).toBe(true);

		expect(store.claimApplyEffect(baseClaim)).toMatchObject({
			outcome: "replay",
			claim: { status: "rejected", reportJson: '{"removed":false}' },
		});
		expect(
			store.claimApplyEffect({
				...baseClaim,
				approvedHash: "approved-hash-retry",
				requestId: "44444444-4444-4444-8444-444444444444",
				targetDigest: "target-digest-retry",
			}),
		).toMatchObject({ outcome: "claimed", claim: { status: "claimed" } });
	});

	it("CASes the receipt only for the exact winning request and prior state", async () => {
		const [store] = await openPair();
		expect(store.claimApplyEffect(baseClaim).outcome).toBe("claimed");

		expect(
			store.casApplyEffect({
				...baseClaim,
				requestId: "33333333-3333-4333-8333-333333333333",
				fromStatus: "claimed",
				toStatus: "applied",
				reportJson: '{"removed":true}',
			}),
		).toBe(false);
		expect(
			store.casApplyEffect({
				...baseClaim,
				fromStatus: "claimed",
				toStatus: "applied",
				reportJson: '{"removed":true}',
			}),
		).toBe(true);
		expect(
			store.casApplyEffect({
				...baseClaim,
				fromStatus: "claimed",
				toStatus: "rejected",
				reportJson: '{"removed":false}',
			}),
		).toBe(false);
		expect(
			store.getApplyEffect(
				baseClaim.effectScope,
				baseClaim.effectKey,
				baseClaim.approvedHash,
			),
		).toMatchObject({
			status: "applied",
			reportJson: '{"removed":true}',
		});
	});
});
