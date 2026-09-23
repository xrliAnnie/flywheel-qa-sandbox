import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
	extractStandingAuthorityEntry,
	type StandingAuthorityManifest,
	standingAuthorityManifestDigest,
} from "./standing-authority.js";
import {
	confirmStandingAuthorityCandidate,
	loadVerifiedStandingAuthority,
	stageStandingAuthorityCandidate,
} from "./standing-authority-activation-store.js";
import {
	readStandingAuthorityConfirmationRecord,
	resolveStandingAuthorityLedgerPath,
	resolveStandingAuthorityStateDir,
	STANDING_AUTHORITY_CONFIRMATION_DDL,
	STANDING_AUTHORITY_CONFIRMATION_TRIGGERS,
	type StandingAuthorityConfirmationRecord,
} from "./standing-authority-confirmation-ledger.js";
import { buildStandingAuthorityPackageManifest } from "./standing-authority-package.js";

const dirs: string[] = [];
const sha = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Stand-in for the Bridge StateStore ledger the confirm route writes. */
function ledgerFixture(path: string) {
	const db = new Database(path);
	db.exec(STANDING_AUTHORITY_CONFIRMATION_DDL);
	for (const trigger of STANDING_AUTHORITY_CONFIRMATION_TRIGGERS)
		db.exec(trigger);
	db.close();
	return {
		path,
		record(row: StandingAuthorityConfirmationRecord) {
			const open = new Database(path);
			open
				.prepare(
					`INSERT INTO standing_authority_confirmation
					 (receipt_id, entry_id, revision, manifest_digest, evidence_body_digest,
					  package_digest, confirmer_identity, confirmer_identity_digest,
					  carrier_claim, confirmed_at, recorded_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					row.receiptId,
					row.entryId,
					row.revision,
					row.manifestDigest,
					row.evidenceBodyDigest,
					row.packageDigest,
					row.confirmerIdentity,
					row.confirmerIdentityDigest,
					row.carrierClaim,
					row.confirmedAt,
					row.recordedAt,
				);
			open.close();
		},
	};
}

it("confirms a staged candidate once and switches the active package last", () => {
	const stateRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2654-activation-store-")),
	);
	dirs.push(stateRoot);
	const packageRoot = join(stateRoot, "release");
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	writeFileSync(
		join(packageRoot, "scripts", "update-flywheel.sh"),
		"runtime\n",
	);
	const packageManifest = buildStandingAuthorityPackageManifest({
		root: packageRoot,
		sourceCommit: "c".repeat(40),
	});
	writeFileSync(
		join(packageRoot, "standing-authority-package.json"),
		`${JSON.stringify(packageManifest)}\n`,
	);
	chmodSync(join(packageRoot, "scripts", "update-flywheel.sh"), 0o444);
	// Rebuild after freezing so the declared mode is exact.
	const frozenPackageManifest = buildStandingAuthorityPackageManifest({
		root: packageRoot,
		sourceCommit: "c".repeat(40),
	});
	writeFileSync(
		join(packageRoot, "standing-authority-package.json"),
		`${JSON.stringify(frozenPackageManifest)}\n`,
	);
	const contractBytes = readFileSync(
		new URL("../../lead-rules-base/founder-only-authority.md", import.meta.url),
	);
	const entryId = "raya-carrier-follow-main/v1" as const;
	const entryDigest = sha(
		extractStandingAuthorityEntry(contractBytes, entryId),
	);
	const manifest: StandingAuthorityManifest = {
		schemaVersion: 1,
		entryId,
		entryDigest,
		extractionVersion: "entry-extraction/v1",
		mechanismVersion: "standing-authority/v1",
		scope: {
			repository: "xrliAnnie/raya",
			project: "raya",
			leadClass: "engineering-lead",
			action: "follow-approved-main",
			transport: "com.flywheel.updater",
		},
		revision: 1,
		status: "pending",
		founderApproval: {
			receiptId: "approval",
			channelId: "12345678901234567",
			messageId: "22345678901234567",
			authorId: "32345678901234567",
			approvedAt: "2026-09-20T00:00:00.000Z",
			contentDigest: sha("approval"),
			approvedPrHead: "a".repeat(40),
			entryDigest,
			confirmerIdentity: "flywheel-cos-lead",
		},
		contractLandedCommit: "b".repeat(40),
		enforcementDeployment: {
			commit: "c".repeat(40),
			packageDigest: frozenPackageManifest.packageDigest,
			immutableRoot: packageRoot,
			deploymentReceiptId: "deployment",
		},
		verificationReceipt: {
			receiptId: "verification",
			entryId,
			mechanismVersion: "standing-authority/v1",
			executionPackageDigest: frozenPackageManifest.packageDigest,
			positiveDigest: sha("positive"),
			negativeDigest: sha("negative"),
			attributionDigest: sha("attribution"),
			sourceDigest: sha("source"),
			authorIdentity: "flywheel-eng-lead",
			implementationIdentity: "implement:FLY-2654",
		},
		liveBundleReceipt: {
			leadIdentity: "flywheel-eng-lead",
			backend: "codex-app-server",
			instanceId: "instance",
			threadId: "thread",
			turnId: "turn",
			rulesDigest: sha(contractBytes),
			entryDigest,
			observedAt: "2026-09-20T00:05:00.000Z",
			sourceReceiptId: "loaded",
		},
		independentConfirmation: null,
		revocation: null,
	};
	stageStandingAuthorityCandidate(stateRoot, {
		manifest,
		contractBytes,
		contractCommit: manifest.contractLandedCommit,
		deployment: {
			commit: manifest.enforcementDeployment.commit,
			packageDigest: manifest.enforcementDeployment.packageDigest,
			immutableRoot: packageRoot,
			receiptId: manifest.enforcementDeployment.deploymentReceiptId,
		},
		verificationReceipt: manifest.verificationReceipt,
		liveBundleReceipt: manifest.liveBundleReceipt,
	});
	const ledger = ledgerFixture(join(stateRoot, "teamlead.db"));
	const confirmInput = {
		root: stateRoot,
		entryId,
		revision: 1,
		pendingManifestDigest: standingAuthorityManifestDigest(manifest),
		authenticatedIdentity: "flywheel-cos-lead",
		authenticatedIdentityDigest: "1".repeat(64),
		carrierClaim: "carrier-claim",
		confirmedAt: "2026-09-20T00:10:00.000Z",
		authority: ledger,
	};
	const result = confirmStandingAuthorityCandidate(confirmInput);
	expect(result.status).toBe("active");
	// The authoritative row is written through the authenticated route before
	// any local file, and it binds the exact manifest/evidence/package digests.
	const recorded = readStandingAuthorityConfirmationRecord(
		ledger.path,
		result.receiptId,
	);
	expect(recorded).toMatchObject({
		receiptId: result.receiptId,
		entryId,
		revision: 1,
		manifestDigest: result.manifestDigest,
		packageDigest: result.packageDigest,
		confirmerIdentity: "flywheel-cos-lead",
		confirmerIdentityDigest: "1".repeat(64),
		carrierClaim: "carrier-claim",
	});
	const pointer = JSON.parse(
		readFileSync(join(stateRoot, "active-package.json"), "utf8"),
	);
	expect(pointer.packageDigest).toBe(frozenPackageManifest.packageDigest);
	expect(
		loadVerifiedStandingAuthority(stateRoot, entryId, {
			ledgerPath: ledger.path,
		}).verification,
	).toMatchObject({
		entryId,
		packageDigest: frozenPackageManifest.packageDigest,
	});
	expect(confirmStandingAuthorityCandidate(confirmInput)).toEqual(result);

	// Negative 1 (review R7 HIGH): a complete, self-consistent local file set
	// whose confirmation never went through the Bridge has no authoritative
	// row and must not verify.
	const filesOnly = ledgerFixture(join(stateRoot, "files-only.db"));
	expect(() =>
		loadVerifiedStandingAuthority(stateRoot, entryId, {
			ledgerPath: filesOnly.path,
		}),
	).toThrow("standing-authority-activation-authority-record-missing");
	expect(() =>
		loadVerifiedStandingAuthority(stateRoot, entryId, {
			ledgerPath: join(stateRoot, "absent.db"),
		}),
	).toThrow("standing-authority-activation-authority-ledger-unavailable");

	// Negative 2: the row exists but its digests describe a different
	// manifest/package than the local files present.
	const drifted = ledgerFixture(join(stateRoot, "drifted.db"));
	drifted.record({
		...recorded!,
		manifestDigest: "f".repeat(64),
	});
	expect(() =>
		loadVerifiedStandingAuthority(stateRoot, entryId, {
			ledgerPath: drifted.path,
		}),
	).toThrow("standing-authority-activation-authority-record-mismatch");
	const driftedPackage = ledgerFixture(join(stateRoot, "drifted-package.db"));
	driftedPackage.record({
		...recorded!,
		packageDigest: "e".repeat(64),
	});
	expect(() =>
		loadVerifiedStandingAuthority(stateRoot, entryId, {
			ledgerPath: driftedPackage.path,
		}),
	).toThrow("standing-authority-activation-authority-record-mismatch");
});

it("records the Bridge confirmation row idempotently and refuses a conflicting rewrite", async () => {
	const { StateStore } = await import("../StateStore.js");
	const home = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2654-confirmation-ledger-")),
	);
	dirs.push(home);
	const store = await StateStore.create(join(home, "teamlead.db"));
	try {
		const row: StandingAuthorityConfirmationRecord = {
			receiptId: "a".repeat(64),
			entryId: "lead-closeout-restart/v1",
			revision: 2,
			manifestDigest: "b".repeat(64),
			evidenceBodyDigest: "c".repeat(64),
			packageDigest: "d".repeat(64),
			confirmerIdentity: "flywheel-cos-lead",
			confirmerIdentityDigest: "e".repeat(64),
			carrierClaim: "carrier-claim",
			confirmedAt: "2026-09-21T00:00:00.000Z",
			recordedAt: "2026-09-21T00:00:01.000Z",
		};
		store.recordStandingAuthorityConfirmation(row);
		store.recordStandingAuthorityConfirmation(row);
		expect(
			readStandingAuthorityConfirmationRecord(
				join(home, "teamlead.db"),
				row.receiptId,
			),
		).toEqual(row);
		expect(() =>
			store.recordStandingAuthorityConfirmation({
				...row,
				manifestDigest: "f".repeat(64),
			}),
		).toThrow("standing-authority-activation-authority-record-conflict");
		expect(() =>
			store.recordStandingAuthorityConfirmation({
				...row,
				receiptId: "not-a-digest",
			}),
		).toThrow("standing-authority-activation-authority-record-invalid");
	} finally {
		store.close();
	}
	// Review R7 round 2: the ledger is immutable at the database level.
	const raw = new Database(join(home, "teamlead.db"));
	try {
		expect(() =>
			raw
				.prepare(
					"UPDATE standing_authority_confirmation SET package_digest = ? WHERE receipt_id = ?",
				)
				.run("f".repeat(64), "a".repeat(64)),
		).toThrow("immutable");
		expect(() =>
			raw
				.prepare(
					"DELETE FROM standing_authority_confirmation WHERE receipt_id = ?",
				)
				.run("a".repeat(64)),
		).toThrow("immutable");
	} finally {
		raw.close();
	}
});

it("resolves the ledger through the same TEAMLEAD_DB_PATH override the Bridge writer uses", () => {
	expect(resolveStandingAuthorityLedgerPath("/home/x", {})).toBe(
		"/home/x/.flywheel/teamlead.db",
	);
	expect(
		resolveStandingAuthorityLedgerPath("/home/x", {
			TEAMLEAD_DB_PATH: "/srv/bridge/teamlead.db",
		}),
	).toBe("/srv/bridge/teamlead.db");
	expect(
		resolveStandingAuthorityLedgerPath("/home/x", { TEAMLEAD_DB_PATH: "" }),
	).toBe("/home/x/.flywheel/teamlead.db");
});

it("resolves the activation state root through the same FLYWHEEL_STANDING_AUTHORITY_STATE_DIR the Bridge and shell fences use", () => {
	expect(resolveStandingAuthorityStateDir("/home/x", {})).toBe(
		"/home/x/.flywheel/state/standing-authority",
	);
	expect(
		resolveStandingAuthorityStateDir("/home/x", {
			FLYWHEEL_STANDING_AUTHORITY_STATE_DIR: "/srv/slot/standing",
		}),
	).toBe("/srv/slot/standing");
	expect(
		resolveStandingAuthorityStateDir("/home/x", {
			FLYWHEEL_STANDING_AUTHORITY_STATE_DIR: "",
		}),
	).toBe("/home/x/.flywheel/state/standing-authority");
});
