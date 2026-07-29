import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import {
	armCutoverAuthority,
	publishLiveCutoverAuthority,
	seedPreCutoverAuthority,
} from "../cutover-authority.js";
import {
	openExistingKernel,
	publishMigrationCompleteMarker,
	validateExistingDatabase,
} from "../database-contract.js";
import { MIGRATIONS } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";

const WINDOW = "window-a";
const EPOCH = 7;
const NOW = "2026-07-28T00:00:00.000Z";

describe("open-existing database contract", () => {
	let dir: string | undefined;

	function fixture() {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-existing-"));
		const stateDir = join(dir, ".flywheel");
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const target = {
			dbPath: join(stateDir, "flywheel-v2.db"),
			markerPath: join(stateDir, "flywheel-v2.migration-complete.json"),
			authorityPath: join(stateDir, "v2-cutover-authority.json"),
			armedPath: join(stateDir, "v2-cutover-armed"),
		};
		seedPreCutoverAuthority({
			...target,
			windowId: WINDOW,
			epoch: EPOCH,
			nowIso: NOW,
		});
		armCutoverAuthority({
			...target,
			windowId: WINDOW,
			epoch: EPOCH,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		const db = openKernelDb({ path: target.dbPath });
		runMigrations(db);
		db.prepare(
			`INSERT INTO meta(key,value,updated_at)
			 VALUES ('cutover_window_id',@window,@now),
			        ('cutover_epoch',@epoch,@now),
			        ('cutover_authority_state','cutover',@now),
			        ('external_effect_intent_count','0',@now),
			        ('rollback_state','clear',@now)`,
		).run({ window: WINDOW, epoch: String(EPOCH), now: NOW });
		db.close();
		publishMigrationCompleteMarker({
			...target,
			expectedWindowId: WINDOW,
			expectedEpoch: EPOCH,
			nowIso: "2026-07-28T00:02:00.000Z",
		});
		return target;
	}

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("validates exact authority, metadata, ordered migrations, marker, and permissions", () => {
		const target = fixture();
		expect(
			validateExistingDatabase({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["cutover"],
			}),
		).toMatchObject({
			windowId: WINDOW,
			epoch: EPOCH,
			migrationCount: MIGRATIONS.length,
		});
		const kernel = openExistingKernel({
			...target,
			expectedWindowId: WINDOW,
			expectedEpoch: EPOCH,
			allowedAuthorityStates: ["cutover"],
		});
		kernel.close();
	});

	it("never creates a missing production database", () => {
		const target = fixture();
		unlinkSync(target.dbPath);
		expect(() =>
			openExistingKernel({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["cutover"],
			}),
		).toThrow(/database.*missing/i);
		expect(existsSync(target.dbPath)).toBe(false);
	});

	it("rejects a database whose ordered migration manifest stops at 0008", () => {
		const target = fixture();
		unlinkSync(target.dbPath);
		const db = openKernelDb({ path: target.dbPath });
		runMigrations(db, MIGRATIONS.slice(0, 8));
		db.prepare(
			`INSERT INTO meta(key,value,updated_at)
			 VALUES ('cutover_window_id',@window,@now),
			        ('cutover_epoch',@epoch,@now)`,
		).run({ window: WINDOW, epoch: String(EPOCH), now: NOW });
		db.close();

		expect(() =>
			validateExistingDatabase({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["cutover"],
			}),
		).toThrow(/migration manifest/i);
	});

	it.each([
		["window", "window-b", EPOCH],
		["epoch", WINDOW, EPOCH + 1],
	] as const)("rejects a mismatched %s", (_name, window, epoch) => {
		const target = fixture();
		expect(() =>
			validateExistingDatabase({
				...target,
				expectedWindowId: window,
				expectedEpoch: epoch,
				allowedAuthorityStates: ["cutover"],
			}),
		).toThrow();
	});

	it("rejects wrong permissions and marker tampering", () => {
		const target = fixture();
		chmodSync(target.dbPath, 0o644);
		expect(() =>
			validateExistingDatabase({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["cutover"],
			}),
		).toThrow(/0600/);
		chmodSync(target.dbPath, 0o600);

		const marker = JSON.parse(readFileSync(target.markerPath, "utf8")) as {
			migration_manifest_digest: string;
		};
		marker.migration_manifest_digest = "0".repeat(64);
		writeFileSync(target.markerPath, `${JSON.stringify(marker)}\n`, "utf8");
		expect(() =>
			validateExistingDatabase({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["cutover"],
			}),
		).toThrow(/marker.*manifest/i);
	});

	it("requires an allowed armed state and can explicitly allow live", () => {
		const target = fixture();
		publishLiveCutoverAuthority({
			...target,
			windowId: WINDOW,
			epoch: EPOCH,
			nowIso: "2026-07-28T00:03:00.000Z",
		});
		expect(() =>
			validateExistingDatabase({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["cutover"],
			}),
		).toThrow(/state.*live/i);
		expect(
			validateExistingDatabase({
				...target,
				expectedWindowId: WINDOW,
				expectedEpoch: EPOCH,
				allowedAuthorityStates: ["live"],
			}).epoch,
		).toBe(EPOCH);
	});
});
