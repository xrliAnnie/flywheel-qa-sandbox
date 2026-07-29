import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Kernel,
	readCutoverAuthority,
	readRollbackFence,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
	archiveAndTombstoneLegacyPath,
	type CutoverTargetManifest,
	prepareStagingDatabase,
	promoteStagingDatabase,
	type RollbackT1FaultPoint,
	rollbackT1,
} from "../index.js";

const roots: string[] = [];
const now = () => new Date("2026-07-28T12:00:00.000Z");

function fixture(): {
	target: CutoverTargetManifest;
	sources: Array<{ path: string; bytes: string; archive: string }>;
	commandCount: string;
	commandMarker: string;
} {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-rollback-t1-"));
	roots.push(root);
	const state = join(root, "state");
	const commandCount = join(root, "rollback-command-count");
	const commandMarker = join(root, "rollback-command-applied");
	const sources = ["comm", "inbox"].map((name) => {
		const parent = join(root, "legacy", name);
		const path = join(parent, "source");
		const archive = join(root, "archive", name);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		const bytes = `legacy-${name}`;
		writeFileSync(path, bytes, { mode: 0o600 });
		return { path, bytes, archive };
	});
	const target: CutoverTargetManifest = {
		v: 1,
		mode: "rehearsal",
		windowId: "rollback-window",
		epoch: 9,
		homeRoot: join(root, "home"),
		productionHomeRoot: "/Users/founder",
		ledgerDir: join(state, "ledger"),
		evidenceDir: join(state, "evidence"),
		rehearsalEvidencePath: join(state, "evidence", "rehearsal.json"),
		database: {
			finalPath: join(state, "flywheel-v2.db"),
			markerPath: join(state, "migration-complete.json"),
			authorityPath: join(state, "authority.json"),
			armedPath: join(state, "armed"),
			rollbackReceiptPath: join(state, "rollback-receipt.json"),
		},
		legacy: {
			authoritativeLiveLeadIds: [],
			commDatabases: [],
			jsonInboxRoots: [],
			journalDatabases: [],
			tombstonePaths: sources.map((entry) => entry.path),
			writerProcessPatterns: [],
			launchdLabels: [],
			plistPaths: [],
			stopCommands: [{ apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] }],
			credentialProbeCommands: [["/usr/bin/false"]],
			liveFireCommands: [["/usr/bin/false"]],
			rollbackCommands: [
				{
					apply: [
						"/bin/sh",
						"-c",
						'printf x >> "$1"; : > "$2"',
						"rollback-command",
						commandCount,
						commandMarker,
					],
					verify: ["/bin/test", "-f", commandMarker],
				},
			],
		},
		controlPlane: {
			launchdLabelPrefix: "com.flywheel.rehearsal.",
			plistDirectory: join(root, "launchd"),
			tmuxSocket: join(root, "tmux.sock"),
			cmuxTarget: "rollback-rehearsal",
			wrapperPaths: [],
			credentialPaths: [],
			envKeys: [],
			startCommands: {
				host: { apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				bridge: { apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				scheduler: { apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] },
				leads: [],
			},
		},
		founderConfirmations: {
			heldStart: "held-rollback-window",
			finalGo: "go-rollback-window",
		},
		githubLaneEvidencePath: join(state, "github.json"),
	};

	prepareStagingDatabase(target, {
		nowIso: "2026-07-28T11:00:00.000Z",
	});
	promoteStagingDatabase(target, {
		nowIso: "2026-07-28T11:01:00.000Z",
	});
	const receipts = sources.map((source) =>
		archiveAndTombstoneLegacyPath({
			sourcePath: source.path,
			archivePath: source.archive,
		}),
	);
	mkdirSync(target.evidenceDir, { recursive: true, mode: 0o700 });
	const receiptPath = join(target.evidenceDir, "archive-receipts.json");
	writeFileSync(
		receiptPath,
		`${JSON.stringify({ v: 1, receipts }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	chmodSync(receiptPath, 0o600);
	return { target, sources, commandCount, commandMarker };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("T1 rollback crash reconciliation", () => {
	it.each([
		"after_gate_cas",
		"after_archive_restore",
		"after_rollback_command",
		"after_receipt_write",
		"after_authority_publish",
		"after_evidence_write",
	] satisfies RollbackT1FaultPoint[])(
		"resumes after %s without duplicating a primitive",
		async (faultPoint) => {
			const { target, sources, commandCount, commandMarker } = fixture();
			let tripped = false;
			await expect(
				rollbackT1(target, {
					now,
					fault(point) {
						if (!tripped && point === faultPoint) {
							tripped = true;
							throw new Error(`crash:${point}`);
						}
					},
				}),
			).rejects.toThrow(`crash:${faultPoint}`);

			await rollbackT1(target, { now });
			await rollbackT1(target, { now });

			for (const source of sources) {
				expect(readFileSync(source.path, "utf8")).toBe(source.bytes);
				expect(existsSync(source.archive)).toBe(false);
			}
			expect(readFileSync(commandCount, "utf8")).toBe("x");
			expect(existsSync(commandMarker)).toBe(true);
			expect(
				readCutoverAuthority({
					authorityPath: target.database.authorityPath,
					armedPath: target.database.armedPath,
					expectedWindowId: target.windowId,
					expectedEpoch: target.epoch,
				}),
			).toMatchObject({
				mode: "armed",
				authority: {
					state: "pre",
					rollback_receipt: {
						path: target.database.rollbackReceiptPath,
					},
				},
			});
			const kernel = Kernel.open({ path: target.database.finalPath });
			try {
				expect(readRollbackFence(kernel)).toMatchObject({
					effectIntentCount: 0,
					rollbackState: "rollback_started",
				});
			} finally {
				kernel.close();
			}
			expect(
				JSON.parse(
					readFileSync(join(target.evidenceDir, "rollback-t1.json"), "utf8"),
				),
			).toMatchObject({ status: "rolled_back" });
		},
	);
});
