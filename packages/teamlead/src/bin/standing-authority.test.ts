import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	canonicalStandingJson,
	extractStandingAuthorityEntry,
	prepareStandingAuthorityConfirmation,
	type StandingAuthorityManifest,
	standingAuthorityConfirmationEvidenceBody,
	standingAuthorityManifestDigest,
	verifyStandingAuthorityManifest,
} from "./standing-authority.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const entryId = "raya-carrier-follow-main/v1" as const;
const body = "exact standing entry\n";
const contract = [
	"preamble",
	`<!-- FLY-2654-ENTRY-BEGIN ${entryId} -->`,
	body.trimEnd(),
	`<!-- FLY-2654-ENTRY-END ${entryId} -->`,
	"tail",
	"",
].join("\n");

function fixture(): {
	manifest: StandingAuthorityManifest;
	evidence: Parameters<typeof verifyStandingAuthorityManifest>[1];
} {
	const entryDigest = sha(body);
	const packageDigest = sha("package");
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
		status: "active",
		founderApproval: {
			receiptId: "approval-receipt",
			channelId: "123456789012345678",
			messageId: "223456789012345678",
			authorId: "323456789012345678",
			approvedAt: "2026-09-20T00:00:00.000Z",
			contentDigest: sha("approval"),
			approvedPrHead: "a".repeat(40),
			entryDigest,
			confirmerIdentity: "flywheel-cos-lead",
		},
		contractLandedCommit: "b".repeat(40),
		enforcementDeployment: {
			commit: "c".repeat(40),
			packageDigest,
			immutableRoot: "/opt/flywheel/standing-authority/releases/c".concat(
				"c".repeat(39),
			),
			deploymentReceiptId: "deployment-receipt",
		},
		verificationReceipt: {
			receiptId: "verification-receipt",
			entryId,
			mechanismVersion: "standing-authority/v1",
			executionPackageDigest: packageDigest,
			positiveDigest: sha("positive"),
			negativeDigest: sha("negative"),
			attributionDigest: sha("attribution"),
			sourceDigest: sha("sources"),
			authorIdentity: "flywheel-eng-lead",
			implementationIdentity: "implement:FLY-2654",
		},
		liveBundleReceipt: {
			leadIdentity: "flywheel-eng-lead",
			backend: "claude-code",
			instanceId: "lead-instance",
			threadId: "thread-1",
			turnId: "turn-1",
			rulesDigest: sha(contract),
			entryDigest,
			observedAt: "2026-09-20T00:10:00.000Z",
			sourceReceiptId: "bundle-receipt",
		},
		independentConfirmation: null,
		revocation: null,
	};
	// The only body a verifier accepts is the one this manifest produces.
	const confirmationBody = standingAuthorityConfirmationEvidenceBody(
		manifest,
		"2026-09-20T00:11:00.000Z",
	);
	manifest.independentConfirmation = {
		identity: "flywheel-cos-lead",
		receiptId: sha(confirmationBody),
		confirmedAt: "2026-09-20T00:11:00.000Z",
		evidenceBodyDigest: sha(confirmationBody),
	};
	return {
		manifest,
		evidence: {
			contractBytes: Buffer.from(contract),
			contractCommit: manifest.contractLandedCommit,
			deployment: {
				commit: manifest.enforcementDeployment.commit,
				packageDigest,
				immutableRoot: manifest.enforcementDeployment.immutableRoot,
				receiptId: manifest.enforcementDeployment.deploymentReceiptId,
			},
			verificationReceipt: { ...manifest.verificationReceipt },
			liveBundleReceipt: { ...manifest.liveBundleReceipt },
			confirmationReceipt: {
				identity: "flywheel-cos-lead",
				receiptId: sha(confirmationBody),
				confirmedAt: "2026-09-20T00:11:00.000Z",
				evidenceBody: confirmationBody,
			},
		},
	};
}

it("extracts exact LF bytes without trimming or normalization", () => {
	expect(
		extractStandingAuthorityEntry(Buffer.from(contract), entryId).toString(),
	).toBe(body);
	for (const invalid of [
		Buffer.from(contract.replace("preamble\n", "\ufeffpreamble\n")),
		Buffer.from(contract.replaceAll("\n", "\r\n")),
		Buffer.from(`${contract}<!-- FLY-2654-ENTRY-BEGIN ${entryId} -->\n`),
	]) {
		expect(() => extractStandingAuthorityEntry(invalid, entryId)).toThrow();
	}
});

it("accepts one active manifest only when every observed receipt matches", () => {
	const { manifest, evidence } = fixture();
	expect(verifyStandingAuthorityManifest(manifest, evidence)).toEqual({
		entryId,
		entryDigest: manifest.entryDigest,
		manifestDigest: standingAuthorityManifestDigest(manifest),
		mechanismVersion: "standing-authority/v1",
		revision: 1,
		packageDigest: manifest.enforcementDeployment.packageDigest,
	});
	// The canonical digest deliberately excludes the confirmation object.
	const changed = structuredClone(manifest);
	changed.independentConfirmation!.confirmedAt = "2026-09-20T00:12:00.000Z";
	expect(standingAuthorityManifestDigest(changed)).toBe(
		standingAuthorityManifestDigest(manifest),
	);
});

it("creates the confirmation from authenticated identity instead of a caller actor", () => {
	const { manifest, evidence } = fixture();
	manifest.status = "pending";
	manifest.independentConfirmation = null;
	const confirmed = prepareStandingAuthorityConfirmation({
		manifest,
		evidence: {
			contractBytes: evidence.contractBytes,
			contractCommit: evidence.contractCommit,
			deployment: evidence.deployment,
			verificationReceipt: evidence.verificationReceipt,
			liveBundleReceipt: evidence.liveBundleReceipt,
		},
		authenticatedIdentity: "flywheel-cos-lead",
		confirmedAt: "2026-09-20T00:11:00.000Z",
	});
	expect(confirmed.manifest.status).toBe("active");
	expect(confirmed.manifest.independentConfirmation).toMatchObject({
		identity: "flywheel-cos-lead",
		receiptId: confirmed.receipt.receiptId,
	});
	expect(confirmed.receipt.evidenceBody).toContain(
		standingAuthorityManifestDigest(confirmed.manifest),
	);
	expect(
		verifyStandingAuthorityManifest(confirmed.manifest, {
			...evidence,
			confirmationReceipt: confirmed.receipt,
		}),
	).toMatchObject({ entryId });
	expect(() =>
		prepareStandingAuthorityConfirmation({
			manifest,
			evidence,
			authenticatedIdentity: "flywheel-eng-lead",
			confirmedAt: "2026-09-20T00:11:00.000Z",
		}),
	).toThrow("standing-authority-confirmer-identity");
});

it.each([
	"pending",
	"revoked",
	"mixed-entry",
	"self-confirmed",
	"fake-deployment",
	"fake-loaded-rule",
	"fake-confirmation",
])("fails closed for %s evidence", (failure) => {
	const { manifest, evidence } = fixture();
	if (failure === "pending") {
		manifest.status = "pending";
		manifest.independentConfirmation = null;
	}
	if (failure === "revoked") {
		manifest.status = "revoked";
		manifest.revocation = {
			revokedAt: "2026-09-20T01:00:00.000Z",
			receiptId: "revocation-receipt",
			sourceDigest: sha("revoked"),
		};
	}
	if (failure === "mixed-entry")
		manifest.verificationReceipt.entryId = "lead-closeout-restart/v1";
	if (failure === "self-confirmed")
		manifest.independentConfirmation!.identity =
			manifest.verificationReceipt.authorIdentity;
	if (failure === "fake-deployment")
		evidence.deployment.packageDigest = sha("fake");
	if (failure === "fake-loaded-rule")
		evidence.liveBundleReceipt.entryDigest = sha("fake");
	if (failure === "fake-confirmation")
		evidence.confirmationReceipt.evidenceBody = "fake";
	expect(() => verifyStandingAuthorityManifest(manifest, evidence)).toThrow();
});

it("rejects a rewritten evidence body even when its digests are self-consistent", () => {
	// Review R7 HIGH: a same-uid writer can rewrite the receipt AND the
	// manifest's evidenceBodyDigest/receiptId together (the canonical manifest
	// digest excludes independentConfirmation). The body must therefore be
	// rebuilt from the manifest and compared byte-for-byte.
	const { manifest, evidence } = fixture();
	const forgedBody = canonicalStandingJson({
		schemaVersion: 1,
		kind: "standing-authority-independent-confirmation",
		identity: "flywheel-cos-lead",
		entryId,
		entryDigest: manifest.entryDigest,
		manifestDigest: sha("some other manifest"),
		mechanismVersion: "standing-authority/v1",
		revision: 1,
		packageDigest: sha("some other package"),
		deploymentReceiptId: manifest.enforcementDeployment.deploymentReceiptId,
		verificationReceiptId: manifest.verificationReceipt.receiptId,
		liveBundleReceiptId: manifest.liveBundleReceipt.sourceReceiptId,
		confirmedAt: manifest.independentConfirmation!.confirmedAt,
	});
	manifest.independentConfirmation!.receiptId = sha(forgedBody);
	manifest.independentConfirmation!.evidenceBodyDigest = sha(forgedBody);
	evidence.confirmationReceipt = {
		identity: "flywheel-cos-lead",
		receiptId: sha(forgedBody),
		confirmedAt: manifest.independentConfirmation!.confirmedAt,
		evidenceBody: forgedBody,
	};
	expect(() => verifyStandingAuthorityManifest(manifest, evidence)).toThrow(
		"standing-authority-confirmation-evidence",
	);
});

it("rejects unknown fields instead of accepting an extensible authority shape", () => {
	const { manifest, evidence } = fixture();
	const value = JSON.parse(canonicalStandingJson(manifest));
	value.extra = true;
	expect(() => verifyStandingAuthorityManifest(value, evidence)).toThrow();
});

it("keeps both repository examples pending and byte-bound to the contract", () => {
	const root = new URL(
		"../../../../engineering/doc/FLY-2654-lead-standing-authority/",
		import.meta.url,
	);
	const contractBytes = readFileSync(
		new URL("../../lead-rules-base/founder-only-authority.md", import.meta.url),
	);
	for (const [id, file] of [
		[entryId, "raya-carrier-follow-main.pending.example.json"],
		["lead-closeout-restart/v1", "lead-closeout-restart.pending.example.json"],
	] as const) {
		const example = JSON.parse(readFileSync(new URL(file, root), "utf8"));
		expect(example.status).toBe("pending");
		expect(example.independentConfirmation).toBeNull();
		expect(example.entryDigest).toBe(
			sha(extractStandingAuthorityEntry(contractBytes, id)),
		);
		expect(() =>
			verifyStandingAuthorityManifest(example, fixture().evidence),
		).toThrow("standing-authority-not-active");
	}
});
