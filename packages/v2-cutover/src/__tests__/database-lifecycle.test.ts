import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advanceDatabaseAuthorityStateTx,
	Kernel,
	readCutoverAuthority,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	prepareStagingDatabase,
	promoteStagingDatabase,
	publishLiveAuthorityIdempotently,
	stagingDatabasePath,
	validateExistingDatabase,
} from "../index.js";
import {
	type CutoverTargetManifest,
	parseTargetManifest,
} from "../manifest.js";

const roots: string[] = [];

function manifest(): CutoverTargetManifest {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-db-life-"));
	roots.push(root);
	const value: CutoverTargetManifest = {
		v: 1,
		mode: "rehearsal",
		windowId: "window-db",
		epoch: 7,
		homeRoot: join(root, "home"),
		productionHomeRoot: "/Users/founder",
		ledgerDir: join(root, "ledger"),
		evidenceDir: join(root, "evidence"),
		rehearsalEvidencePath: join(root, "evidence", "rehearsal-pass.json"),
		database: {
			finalPath: join(root, "state", "flywheel-v2.db"),
			markerPath: join(root, "state", "migration-complete.json"),
			authorityPath: join(root, "state", "authority.json"),
			armedPath: join(root, "state", "armed.json"),
			rollbackReceiptPath: join(root, "state", "rollback.json"),
		},
		legacy: {
			authoritativeLiveLeadIds: [],
			commDatabases: [],
			jsonInboxRoots: [],
			journalDatabases: [],
			tombstonePaths: [],
			writerProcessPatterns: [],
			launchdLabels: [],
			plistPaths: [],
			stopCommands: [{ apply: ["true"], verify: ["true"] }],
			credentialProbeCommands: [["false"]],
			liveFireCommands: [["false"]],
			rollbackCommands: [{ apply: ["true"], verify: ["true"] }],
		},
		controlPlane: {
			launchdLabelPrefix: "com.flywheel-rehearsal.",
			plistDirectory: join(root, "launchd"),
			tmuxSocket: join(root, "tmux.sock"),
			cmuxTarget: "rehearsal-db",
			wrapperPaths: [],
			credentialPaths: [],
			envKeys: [],
			startCommands: {
				host: {
					apply: ["node", join(root, "host.js")],
					verify: ["true"],
				},
				bridge: {
					apply: ["node", join(root, "bridge.js")],
					verify: ["true"],
				},
				scheduler: {
					apply: ["node", join(root, "scheduler.js")],
					verify: ["true"],
				},
				leads: [],
			},
		},
		founderConfirmations: {
			heldStart: "held-window-db",
			finalGo: "go-window-db",
		},
		githubLaneEvidencePath: join(root, "evidence", "github.json"),
	};
	return parseTargetManifest(value);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("fresh staging and WAL-safe promotion", () => {
	it("creates all migrations only on staging and publishes the marker last", () => {
		const target = manifest();
		const prepared = prepareStagingDatabase(target, {
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		expect(prepared.status).toBe("prepared");
		expect(prepared.path).toBe(stagingDatabasePath(target));
		expect(existsSync(target.database.finalPath)).toBe(false);
		expect(existsSync(target.database.markerPath)).toBe(false);

		expect(
			promoteStagingDatabase(target, {
				nowIso: "2026-07-28T00:01:00.000Z",
			}),
		).toMatchObject({ status: "promoted" });
		expect(existsSync(target.database.markerPath)).toBe(true);
		expect(
			validateExistingDatabase({
				dbPath: target.database.finalPath,
				markerPath: target.database.markerPath,
				authorityPath: target.database.authorityPath,
				armedPath: target.database.armedPath,
				expectedWindowId: target.windowId,
				expectedEpoch: target.epoch,
				allowedAuthorityStates: ["cutover"],
			}),
		).toMatchObject({ migrationCount: 9 });
	});

	it("reconciles a crash after rename by validating final then publishing marker", () => {
		const target = manifest();
		prepareStagingDatabase(target, {
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		expect(() =>
			promoteStagingDatabase(target, {
				nowIso: "2026-07-28T00:01:00.000Z",
				fault(point) {
					if (point === "after_rename") throw new Error("crash");
				},
			}),
		).toThrow("crash");
		expect(existsSync(target.database.finalPath)).toBe(true);
		expect(existsSync(target.database.markerPath)).toBe(false);
		expect(
			promoteStagingDatabase(target, {
				nowIso: "2026-07-28T00:02:00.000Z",
			}),
		).toMatchObject({ status: "reconciled" });
		expect(existsSync(target.database.markerPath)).toBe(true);
	});

	it("reconciles a crash after database live commit and before machine authority publication", () => {
		const target = manifest();
		prepareStagingDatabase(target, {
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		promoteStagingDatabase(target, {
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		const kernel = Kernel.open({ path: target.database.finalPath });
		try {
			kernel.write("test.crash-after-database-live", (tx) => {
				advanceDatabaseAuthorityStateTx(tx, {
					expected: "cutover",
					next: "live",
					nowIso: "2026-07-28T00:02:00.000Z",
				});
			});
		} finally {
			kernel.close();
		}
		expect(
			readCutoverAuthority({
				authorityPath: target.database.authorityPath,
				armedPath: target.database.armedPath,
				expectedWindowId: target.windowId,
				expectedEpoch: target.epoch,
			}),
		).toMatchObject({
			mode: "armed",
			authority: { state: "cutover" },
		});

		expect(
			publishLiveAuthorityIdempotently(target, "2026-07-28T00:03:00.000Z"),
		).toEqual({
			databaseState: "live",
			machineState: "live",
			reconciled: true,
		});
		expect(
			publishLiveAuthorityIdempotently(target, "2026-07-28T00:04:00.000Z"),
		).toEqual({
			databaseState: "live",
			machineState: "live",
			reconciled: false,
		});
	});
});
