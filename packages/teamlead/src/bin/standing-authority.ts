import { createHash } from "node:crypto";

export const STANDING_AUTHORITY_ENTRY_IDS = [
	"raya-carrier-follow-main/v1",
	"lead-closeout-restart/v1",
] as const;
export type StandingAuthorityEntryId =
	(typeof STANDING_AUTHORITY_ENTRY_IDS)[number];
export type StandingAuthorityBackend = "claude-code" | "codex-app-server";

export interface StandingAuthorityManifest {
	schemaVersion: 1;
	entryId: StandingAuthorityEntryId;
	entryDigest: string;
	extractionVersion: "entry-extraction/v1";
	mechanismVersion: string;
	scope: {
		repository: string;
		project: string;
		leadClass: "engineering-lead";
		action: string;
		transport: string;
	};
	revision: number;
	status: "pending" | "active" | "revoked";
	founderApproval: {
		receiptId: string;
		channelId: string;
		messageId: string;
		authorId: string;
		approvedAt: string;
		contentDigest: string;
		approvedPrHead: string;
		entryDigest: string;
		confirmerIdentity: "flywheel-cos-lead";
	};
	contractLandedCommit: string;
	enforcementDeployment: {
		commit: string;
		packageDigest: string;
		immutableRoot: string;
		deploymentReceiptId: string;
	};
	verificationReceipt: {
		receiptId: string;
		entryId: StandingAuthorityEntryId;
		mechanismVersion: string;
		executionPackageDigest: string;
		positiveDigest: string;
		negativeDigest: string;
		attributionDigest: string;
		sourceDigest: string;
		authorIdentity: string;
		implementationIdentity: string;
	};
	liveBundleReceipt: {
		leadIdentity: string;
		backend: StandingAuthorityBackend;
		instanceId: string;
		threadId: string;
		turnId: string;
		rulesDigest: string;
		entryDigest: string;
		observedAt: string;
		sourceReceiptId: string;
	};
	independentConfirmation: {
		identity: "flywheel-cos-lead";
		receiptId: string;
		confirmedAt: string;
		evidenceBodyDigest: string;
	} | null;
	revocation: {
		revokedAt: string;
		receiptId: string;
		sourceDigest: string;
	} | null;
}

export interface StandingAuthorityObservedEvidence {
	contractBytes: Buffer;
	contractCommit: string;
	deployment: {
		commit: string;
		packageDigest: string;
		immutableRoot: string;
		receiptId: string;
	};
	verificationReceipt: StandingAuthorityManifest["verificationReceipt"];
	liveBundleReceipt: StandingAuthorityManifest["liveBundleReceipt"];
	confirmationReceipt: {
		identity: string;
		receiptId: string;
		confirmedAt: string;
		evidenceBody: string;
	};
}

export type StandingAuthorityPreconfirmationEvidence = Omit<
	StandingAuthorityObservedEvidence,
	"confirmationReceipt"
>;

export interface StandingAuthorityConfirmationReceipt {
	identity: "flywheel-cos-lead";
	receiptId: string;
	confirmedAt: string;
	evidenceBody: string;
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;
const SAFE_VERSION = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function fail(reason: string): never {
	throw new Error(`standing-authority-${reason}`);
}

function object(
	value: unknown,
	reason = "shape-invalid",
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
	return value as Record<string, unknown>;
}

function exactKeys(
	value: unknown,
	keys: readonly string[],
	reason = "shape-invalid",
) {
	const actual = Object.keys(object(value, reason)).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	)
		fail(reason);
}

function nonempty(value: unknown, max = 2_000): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!value.includes("\0")
	);
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, stable(item)]),
	);
}

export function canonicalStandingJson(value: unknown): string {
	return JSON.stringify(stable(value));
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function entry(id: unknown): id is StandingAuthorityEntryId {
	return STANDING_AUTHORITY_ENTRY_IDS.includes(id as StandingAuthorityEntryId);
}

export function extractStandingAuthorityEntry(
	bytes: Buffer,
	entryId: StandingAuthorityEntryId,
): Buffer {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail("contract-invalid");
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
		fail("contract-bom");
	if (bytes.includes(Buffer.from("\r"))) fail("contract-line-ending");
	const source = bytes.toString("utf8");
	if (!Buffer.from(source, "utf8").equals(bytes)) fail("contract-utf8");
	const begin = `<!-- FLY-2654-ENTRY-BEGIN ${entryId} -->\n`;
	const end = `<!-- FLY-2654-ENTRY-END ${entryId} -->`;
	const begins = source.split(begin).length - 1;
	const ends = source.split(end).length - 1;
	if (begins !== 1 || ends !== 1) fail("entry-marker-count");
	const start = source.indexOf(begin) + begin.length;
	const finish = source.indexOf(end, start);
	if (finish < start) fail("entry-marker-order");
	const body = source.slice(start, finish);
	if (
		body.includes("<!-- FLY-2654-ENTRY-BEGIN ") ||
		body.includes("<!-- FLY-2654-ENTRY-END ")
	)
		fail("entry-marker-nested");
	return Buffer.from(body, "utf8");
}

function validateManifestShape(
	value: unknown,
): asserts value is StandingAuthorityManifest {
	const manifest = object(value);
	exactKeys(manifest, [
		"schemaVersion",
		"entryId",
		"entryDigest",
		"extractionVersion",
		"mechanismVersion",
		"scope",
		"revision",
		"status",
		"founderApproval",
		"contractLandedCommit",
		"enforcementDeployment",
		"verificationReceipt",
		"liveBundleReceipt",
		"independentConfirmation",
		"revocation",
	]);
	exactKeys(manifest.scope, [
		"repository",
		"project",
		"leadClass",
		"action",
		"transport",
	]);
	exactKeys(manifest.founderApproval, [
		"receiptId",
		"channelId",
		"messageId",
		"authorId",
		"approvedAt",
		"contentDigest",
		"approvedPrHead",
		"entryDigest",
		"confirmerIdentity",
	]);
	exactKeys(manifest.enforcementDeployment, [
		"commit",
		"packageDigest",
		"immutableRoot",
		"deploymentReceiptId",
	]);
	exactKeys(manifest.verificationReceipt, [
		"receiptId",
		"entryId",
		"mechanismVersion",
		"executionPackageDigest",
		"positiveDigest",
		"negativeDigest",
		"attributionDigest",
		"sourceDigest",
		"authorIdentity",
		"implementationIdentity",
	]);
	exactKeys(manifest.liveBundleReceipt, [
		"leadIdentity",
		"backend",
		"instanceId",
		"threadId",
		"turnId",
		"rulesDigest",
		"entryDigest",
		"observedAt",
		"sourceReceiptId",
	]);
	if (manifest.independentConfirmation !== null)
		exactKeys(manifest.independentConfirmation, [
			"identity",
			"receiptId",
			"confirmedAt",
			"evidenceBodyDigest",
		]);
	if (manifest.revocation !== null)
		exactKeys(manifest.revocation, ["revokedAt", "receiptId", "sourceDigest"]);
	const m = manifest as unknown as StandingAuthorityManifest;
	if (
		m.schemaVersion !== 1 ||
		!entry(m.entryId) ||
		!SHA256.test(m.entryDigest) ||
		m.extractionVersion !== "entry-extraction/v1" ||
		!SAFE_VERSION.test(m.mechanismVersion) ||
		!Number.isSafeInteger(m.revision) ||
		m.revision < 1 ||
		!["pending", "active", "revoked"].includes(m.status)
	)
		fail("shape-invalid");
	const strings = [
		m.scope.repository,
		m.scope.project,
		m.scope.action,
		m.scope.transport,
		m.founderApproval.receiptId,
		m.enforcementDeployment.deploymentReceiptId,
		m.verificationReceipt.receiptId,
		m.liveBundleReceipt.leadIdentity,
		m.liveBundleReceipt.instanceId,
		m.liveBundleReceipt.threadId,
		m.liveBundleReceipt.turnId,
		m.liveBundleReceipt.sourceReceiptId,
		m.verificationReceipt.authorIdentity,
		m.verificationReceipt.implementationIdentity,
	];
	if (
		m.scope.leadClass !== "engineering-lead" ||
		strings.some((item) => !nonempty(item) || !SAFE_ID.test(item)) ||
		strings.some((item) => item.includes("*")) ||
		!SNOWFLAKE.test(m.founderApproval.channelId) ||
		!SNOWFLAKE.test(m.founderApproval.messageId) ||
		!SNOWFLAKE.test(m.founderApproval.authorId) ||
		!timestamp(m.founderApproval.approvedAt) ||
		!SHA256.test(m.founderApproval.contentDigest) ||
		!SHA40.test(m.founderApproval.approvedPrHead) ||
		!SHA256.test(m.founderApproval.entryDigest) ||
		m.founderApproval.confirmerIdentity !== "flywheel-cos-lead" ||
		!SHA40.test(m.contractLandedCommit) ||
		!SHA40.test(m.enforcementDeployment.commit) ||
		!SHA256.test(m.enforcementDeployment.packageDigest) ||
		!m.enforcementDeployment.immutableRoot.startsWith("/") ||
		m.enforcementDeployment.immutableRoot.includes("..") ||
		m.verificationReceipt.entryId !== m.entryId ||
		m.verificationReceipt.mechanismVersion !== m.mechanismVersion ||
		[
			m.verificationReceipt.executionPackageDigest,
			m.verificationReceipt.positiveDigest,
			m.verificationReceipt.negativeDigest,
			m.verificationReceipt.attributionDigest,
			m.verificationReceipt.sourceDigest,
			m.liveBundleReceipt.rulesDigest,
			m.liveBundleReceipt.entryDigest,
		].some((item) => !SHA256.test(item)) ||
		!["claude-code", "codex-app-server"].includes(
			m.liveBundleReceipt.backend,
		) ||
		!timestamp(m.liveBundleReceipt.observedAt)
	)
		fail("shape-invalid");
	if (m.independentConfirmation !== null) {
		if (
			m.independentConfirmation.identity !== "flywheel-cos-lead" ||
			!nonempty(m.independentConfirmation.receiptId) ||
			!timestamp(m.independentConfirmation.confirmedAt) ||
			!SHA256.test(m.independentConfirmation.evidenceBodyDigest)
		)
			fail("shape-invalid");
	}
	if (m.revocation !== null) {
		if (
			!timestamp(m.revocation.revokedAt) ||
			!nonempty(m.revocation.receiptId) ||
			!SHA256.test(m.revocation.sourceDigest)
		)
			fail("shape-invalid");
	}
}

export function standingAuthorityManifestDigest(
	manifest: StandingAuthorityManifest,
): string {
	validateManifestShape(manifest);
	const { independentConfirmation: _confirmation, ...body } = manifest;
	return digest(canonicalStandingJson(body));
}

function verifyStandingAuthorityEvidence(
	manifest: StandingAuthorityManifest,
	evidence: StandingAuthorityPreconfirmationEvidence,
): void {
	const extracted = extractStandingAuthorityEntry(
		evidence.contractBytes,
		manifest.entryId,
	);
	if (
		digest(extracted) !== manifest.entryDigest ||
		manifest.founderApproval.entryDigest !== manifest.entryDigest ||
		evidence.contractCommit !== manifest.contractLandedCommit
	)
		fail("contract-mismatch");
	if (
		evidence.deployment.commit !== manifest.enforcementDeployment.commit ||
		evidence.deployment.packageDigest !==
			manifest.enforcementDeployment.packageDigest ||
		evidence.deployment.immutableRoot !==
			manifest.enforcementDeployment.immutableRoot ||
		evidence.deployment.receiptId !==
			manifest.enforcementDeployment.deploymentReceiptId
	)
		fail("deployment-mismatch");
	if (
		canonicalStandingJson(evidence.verificationReceipt) !==
			canonicalStandingJson(manifest.verificationReceipt) ||
		manifest.verificationReceipt.executionPackageDigest !==
			manifest.enforcementDeployment.packageDigest
	)
		fail("verification-mismatch");
	if (
		canonicalStandingJson(evidence.liveBundleReceipt) !==
			canonicalStandingJson(manifest.liveBundleReceipt) ||
		manifest.liveBundleReceipt.entryDigest !== manifest.entryDigest
	)
		fail("loaded-rule-mismatch");
}

/**
 * Performs the only pending -> active transition. The caller cannot supply an
 * actor: the route must pass the identity resolved from the existing Lead
 * carrier authentication boundary.
 */
/**
 * The exact confirmation evidence body for an active manifest. Both the
 * producer (`prepareStandingAuthorityConfirmation`) and every verifier rebuild
 * it from the manifest, so a receipt whose body was rewritten together with
 * the manifest's `evidenceBodyDigest`/`receiptId` (the canonical manifest
 * digest excludes `independentConfirmation`) still fails byte-for-byte.
 */
export function standingAuthorityConfirmationEvidenceBody(
	manifest: StandingAuthorityManifest,
	confirmedAt: string,
): string {
	return canonicalStandingJson({
		schemaVersion: 1,
		kind: "standing-authority-independent-confirmation",
		identity: "flywheel-cos-lead",
		entryId: manifest.entryId,
		entryDigest: manifest.entryDigest,
		manifestDigest: standingAuthorityManifestDigest(manifest),
		mechanismVersion: manifest.mechanismVersion,
		revision: manifest.revision,
		packageDigest: manifest.enforcementDeployment.packageDigest,
		deploymentReceiptId: manifest.enforcementDeployment.deploymentReceiptId,
		verificationReceiptId: manifest.verificationReceipt.receiptId,
		liveBundleReceiptId: manifest.liveBundleReceipt.sourceReceiptId,
		confirmedAt,
	});
}

export function prepareStandingAuthorityConfirmation(input: {
	manifest: StandingAuthorityManifest;
	evidence: StandingAuthorityPreconfirmationEvidence;
	authenticatedIdentity: string;
	confirmedAt: string;
}): {
	manifest: StandingAuthorityManifest;
	receipt: StandingAuthorityConfirmationReceipt;
} {
	validateManifestShape(input.manifest);
	if (
		input.authenticatedIdentity !== "flywheel-cos-lead" ||
		input.authenticatedIdentity !==
			input.manifest.founderApproval.confirmerIdentity ||
		input.authenticatedIdentity ===
			input.manifest.verificationReceipt.authorIdentity ||
		input.authenticatedIdentity ===
			input.manifest.verificationReceipt.implementationIdentity
	)
		fail("confirmer-identity");
	if (!timestamp(input.confirmedAt)) fail("confirmation-time");
	if (
		input.manifest.status !== "pending" ||
		input.manifest.independentConfirmation !== null ||
		input.manifest.revocation !== null
	)
		fail("confirmation-state");
	verifyStandingAuthorityEvidence(input.manifest, input.evidence);
	const active = structuredClone(input.manifest);
	active.status = "active";
	const evidenceBody = standingAuthorityConfirmationEvidenceBody(
		active,
		input.confirmedAt,
	);
	const receipt: StandingAuthorityConfirmationReceipt = {
		identity: "flywheel-cos-lead",
		receiptId: digest(evidenceBody),
		confirmedAt: input.confirmedAt,
		evidenceBody,
	};
	active.independentConfirmation = {
		identity: receipt.identity,
		receiptId: receipt.receiptId,
		confirmedAt: receipt.confirmedAt,
		evidenceBodyDigest: digest(receipt.evidenceBody),
	};
	return { manifest: active, receipt };
}

export function verifyStandingAuthorityManifest(
	value: unknown,
	evidence: StandingAuthorityObservedEvidence,
): {
	entryId: StandingAuthorityEntryId;
	entryDigest: string;
	manifestDigest: string;
	mechanismVersion: string;
	revision: number;
	packageDigest: string;
} {
	validateManifestShape(value);
	const manifest = value;
	if (
		manifest.status !== "active" ||
		manifest.revocation !== null ||
		manifest.independentConfirmation === null
	)
		fail("not-active");
	verifyStandingAuthorityEvidence(manifest, evidence);
	const confirmation = manifest.independentConfirmation;
	if (
		evidence.confirmationReceipt.identity !== confirmation.identity ||
		evidence.confirmationReceipt.receiptId !== confirmation.receiptId ||
		evidence.confirmationReceipt.confirmedAt !== confirmation.confirmedAt ||
		digest(evidence.confirmationReceipt.evidenceBody) !==
			confirmation.evidenceBodyDigest ||
		confirmation.identity !== manifest.founderApproval.confirmerIdentity ||
		confirmation.identity === manifest.verificationReceipt.authorIdentity ||
		confirmation.identity ===
			manifest.verificationReceipt.implementationIdentity
	)
		fail("confirmation-mismatch");
	// Review R7 HIGH: self-consistency between receipt and manifest is not
	// proof. The body must be the exact body this manifest produces.
	const expectedBody = standingAuthorityConfirmationEvidenceBody(
		manifest,
		confirmation.confirmedAt,
	);
	if (
		evidence.confirmationReceipt.evidenceBody !== expectedBody ||
		confirmation.receiptId !== digest(expectedBody) ||
		confirmation.evidenceBodyDigest !== digest(expectedBody)
	)
		fail("confirmation-evidence");
	return {
		entryId: manifest.entryId,
		entryDigest: manifest.entryDigest,
		manifestDigest: standingAuthorityManifestDigest(manifest),
		mechanismVersion: manifest.mechanismVersion,
		revision: manifest.revision,
		packageDigest: manifest.enforcementDeployment.packageDigest,
	};
}
