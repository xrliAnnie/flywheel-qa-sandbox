import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	prepareStandingAuthorityConfirmation,
	type StandingAuthorityEntryId,
	type StandingAuthorityManifest,
	type StandingAuthorityPreconfirmationEvidence,
	standingAuthorityManifestDigest,
	verifyStandingAuthorityManifest,
} from "./standing-authority.js";
import {
	assertStandingAuthorityConfirmationRecord,
	readStandingAuthorityConfirmationRecord,
	type StandingAuthorityConfirmationRecord,
} from "./standing-authority-confirmation-ledger.js";
import {
	type StandingAuthorityPackageManifest,
	verifyStandingAuthorityPackage,
} from "./standing-authority-package.js";

/**
 * The Bridge-owned authoritative confirmation sink (StateStore). The confirm
 * route records the row through the confirmer's authenticated channel BEFORE
 * any activation file is written, so a local file set that never passed the
 * route has no row and cannot verify.
 */
export interface StandingAuthorityConfirmationAuthority {
	record(row: StandingAuthorityConfirmationRecord): void;
}

export interface StandingAuthorityCandidate
	extends StandingAuthorityPreconfirmationEvidence {
	manifest: StandingAuthorityManifest;
}

export interface StandingAuthorityActivationResult {
	status: "active";
	entryId: StandingAuthorityEntryId;
	revision: number;
	manifestDigest: string;
	receiptId: string;
	packageDigest: string;
}

const MAX_JSON = 256 * 1024;
const MAX_CONTRACT = 512 * 1024;
const slug = (entryId: StandingAuthorityEntryId) =>
	entryId.replaceAll("/", "--");
const fail = (reason: string): never => {
	throw new Error(`standing-authority-activation-${reason}`);
};

function atomicWrite(path: string, value: string | Buffer, mode = 0o600) {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, value, { mode, flag: "wx" });
	renameSync(temporary, path);
}

function readRegular(path: string, limit: number): Buffer {
	const item = lstatSync(path);
	if (
		!item.isFile() ||
		item.isSymbolicLink() ||
		item.nlink !== 1 ||
		item.size > limit
	)
		fail("evidence-file-invalid");
	return readFileSync(path);
}

function readJson<T>(path: string): T {
	try {
		return JSON.parse(readRegular(path, MAX_JSON).toString("utf8")) as T;
	} catch (error) {
		if ((error as Error).message.startsWith("standing-authority-")) throw error;
		return fail("evidence-json-invalid");
	}
}

function candidatePaths(root: string, entryId: StandingAuthorityEntryId) {
	const dir = join(root, "pending", slug(entryId));
	return {
		dir,
		candidate: join(dir, "candidate.json"),
		contract: join(dir, "contract.bin"),
	};
}

/** Trusted deployment/handoff producer. This does not activate authority. */
export function stageStandingAuthorityCandidate(
	root: string,
	candidate: StandingAuthorityCandidate,
): void {
	if (
		candidate.manifest.status !== "pending" ||
		candidate.manifest.independentConfirmation !== null ||
		candidate.manifest.revocation !== null
	)
		fail("candidate-state");
	// Shape validation is intentionally reused from the canonical digest producer.
	standingAuthorityManifestDigest(candidate.manifest);
	const paths = candidatePaths(root, candidate.manifest.entryId);
	mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	const json = `${JSON.stringify({
		manifest: candidate.manifest,
		contractCommit: candidate.contractCommit,
		deployment: candidate.deployment,
		verificationReceipt: candidate.verificationReceipt,
		liveBundleReceipt: candidate.liveBundleReceipt,
	})}\n`;
	for (const [path, bytes] of [
		[paths.candidate, Buffer.from(json)],
		[paths.contract, candidate.contractBytes],
	] as const) {
		if (existsSync(path)) {
			if (!readFileSync(path).equals(bytes)) fail("candidate-conflict");
		} else atomicWrite(path, bytes);
	}
}

function loadCandidate(
	root: string,
	entryId: StandingAuthorityEntryId,
): StandingAuthorityCandidate {
	const paths = candidatePaths(root, entryId);
	const stored = readJson<Omit<StandingAuthorityCandidate, "contractBytes">>(
		paths.candidate,
	);
	return {
		...stored,
		contractBytes: readRegular(paths.contract, MAX_CONTRACT),
	};
}

export function confirmStandingAuthorityCandidate(input: {
	root: string;
	entryId: StandingAuthorityEntryId;
	revision: number;
	pendingManifestDigest: string;
	authenticatedIdentity: string;
	authenticatedIdentityDigest: string;
	carrierClaim: string;
	confirmedAt: string;
	authority: StandingAuthorityConfirmationAuthority;
}): StandingAuthorityActivationResult {
	const candidate = loadCandidate(input.root, input.entryId);
	if (
		candidate.manifest.entryId !== input.entryId ||
		candidate.manifest.revision !== input.revision ||
		standingAuthorityManifestDigest(candidate.manifest) !==
			input.pendingManifestDigest
	)
		fail("candidate-cas");
	const activeDir = join(input.root, "active", slug(input.entryId));
	const resultPath = join(activeDir, "result.json");
	if (existsSync(resultPath)) {
		const prior = readJson<StandingAuthorityActivationResult>(resultPath);
		if (prior.entryId === input.entryId && prior.revision === input.revision)
			return prior;
		fail("active-revision-conflict");
	}
	const packageManifest = readJson<StandingAuthorityPackageManifest>(
		join(
			candidate.manifest.enforcementDeployment.immutableRoot,
			"standing-authority-package.json",
		),
	);
	const verifiedPackage = verifyStandingAuthorityPackage(
		candidate.manifest.enforcementDeployment.immutableRoot,
		packageManifest,
	);
	if (
		verifiedPackage.packageDigest !==
		candidate.manifest.enforcementDeployment.packageDigest
	)
		fail("package-mismatch");
	const confirmed = prepareStandingAuthorityConfirmation({
		manifest: candidate.manifest,
		evidence: candidate,
		authenticatedIdentity: input.authenticatedIdentity,
		confirmedAt: input.confirmedAt,
	});
	const result: StandingAuthorityActivationResult = {
		status: "active",
		entryId: input.entryId,
		revision: input.revision,
		manifestDigest: standingAuthorityManifestDigest(confirmed.manifest),
		receiptId: confirmed.receipt.receiptId,
		packageDigest: verifiedPackage.packageDigest,
	};
	// Authoritative row first (review R7 HIGH / plan §4): if this throws,
	// nothing local exists and no verifier can ever read an activation.
	const record: StandingAuthorityConfirmationRecord = {
		receiptId: confirmed.receipt.receiptId,
		entryId: input.entryId,
		revision: input.revision,
		manifestDigest: result.manifestDigest,
		evidenceBodyDigest:
			confirmed.manifest.independentConfirmation!.evidenceBodyDigest,
		packageDigest: verifiedPackage.packageDigest,
		confirmerIdentity: confirmed.receipt.identity,
		confirmerIdentityDigest: input.authenticatedIdentityDigest,
		carrierClaim: input.carrierClaim,
		confirmedAt: confirmed.receipt.confirmedAt,
		recordedAt: input.confirmedAt,
	};
	assertStandingAuthorityConfirmationRecord(record);
	input.authority.record(record);
	mkdirSync(activeDir, { recursive: true, mode: 0o700 });
	const receiptDir = join(input.root, "confirmation-receipts");
	mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
	atomicWrite(
		join(receiptDir, `${confirmed.receipt.receiptId}.json`),
		`${JSON.stringify(confirmed.receipt)}\n`,
	);
	atomicWrite(
		join(activeDir, "manifest.json"),
		`${JSON.stringify(confirmed.manifest)}\n`,
	);
	atomicWrite(resultPath, `${JSON.stringify(result)}\n`);
	// The updater consults this pointer. Writing it last prevents an active
	// package from appearing before the independently confirmed manifest.
	atomicWrite(
		join(input.root, "active-package.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			packageDigest: verifiedPackage.packageDigest,
			immutableRoot: candidate.manifest.enforcementDeployment.immutableRoot,
			sourceCommit: packageManifest.sourceCommit,
			activatedByReceiptId: confirmed.receipt.receiptId,
		})}\n`,
	);
	return result;
}

/**
 * Consumer-side proof. No active file, package pointer, or receipt file is
 * trusted alone: the confirmation must also be read back from the Bridge
 * ledger (`ledgerPath`, the StateStore database) and match every digest.
 */
export function loadVerifiedStandingAuthority(
	root: string,
	entryId: StandingAuthorityEntryId,
	authority: { ledgerPath: string },
) {
	const candidate = loadCandidate(root, entryId);
	const activeDir = join(root, "active", slug(entryId));
	const manifest = readJson<StandingAuthorityManifest>(
		join(activeDir, "manifest.json"),
	);
	if (
		manifest.entryId !== entryId ||
		manifest.independentConfirmation === null ||
		manifest.revision !== candidate.manifest.revision
	)
		fail("active-manifest-mismatch");
	const confirmation = manifest.independentConfirmation!;
	const receipt = readJson<{
		identity: string;
		receiptId: string;
		confirmedAt: string;
		evidenceBody: string;
	}>(join(root, "confirmation-receipts", `${confirmation.receiptId}.json`));
	const packageManifest = readJson<StandingAuthorityPackageManifest>(
		join(
			manifest.enforcementDeployment.immutableRoot,
			"standing-authority-package.json",
		),
	);
	const packageProof = verifyStandingAuthorityPackage(
		manifest.enforcementDeployment.immutableRoot,
		packageManifest,
	);
	const pointer = readJson<{
		packageDigest: string;
		immutableRoot: string;
		activatedByReceiptId: string;
	}>(join(root, "active-package.json"));
	if (
		pointer.packageDigest !== packageProof.packageDigest ||
		pointer.immutableRoot !== manifest.enforcementDeployment.immutableRoot ||
		pointer.activatedByReceiptId !== receipt.receiptId
	)
		fail("active-package-mismatch");
	const verification = verifyStandingAuthorityManifest(manifest, {
		contractBytes: candidate.contractBytes,
		contractCommit: candidate.contractCommit,
		deployment: candidate.deployment,
		verificationReceipt: candidate.verificationReceipt,
		liveBundleReceipt: candidate.liveBundleReceipt,
		confirmationReceipt: receipt,
	});
	const record = readStandingAuthorityConfirmationRecord(
		authority.ledgerPath,
		receipt.receiptId,
	);
	if (
		record.entryId !== entryId ||
		record.revision !== verification.revision ||
		record.manifestDigest !== verification.manifestDigest ||
		record.evidenceBodyDigest !== confirmation.evidenceBodyDigest ||
		record.packageDigest !== verification.packageDigest ||
		record.confirmerIdentity !== confirmation.identity ||
		record.confirmedAt !== confirmation.confirmedAt
	)
		fail("authority-record-mismatch");
	return { manifest, verification, record };
}
