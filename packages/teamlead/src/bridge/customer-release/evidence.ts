import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Operator-provisioned evidence, independently captured before founder enable.
 * This reader checks provenance bindings and captured-output integrity; it does
 * not run acceptance commands or turn a fixture into live production proof. */
export const activationEvidenceChecks = {
	A0: ["shared_contract_version", "old_client_compatibility"],
	A1: [
		"immutable_upload_readback",
		"ci_version_assertion",
		"commit_cas",
		"download_entitlement",
		"cleanup_safety",
	],
	A2: [
		"beta_actions_receipt",
		"published_source_matches_local_subject",
		"fresh_green_and_hold",
		"fault_becomes_unknown",
	],
	A3: [
		"install_update_rollback",
		"previous_good_valid",
		"previous_good_expired",
		"first_bad_quarantine_or_pause",
		"no_bad_reinstall",
	],
	A4: [
		"green",
		"hold",
		"unknown",
		"veto",
		"delivery_failure",
		"zero_live_card_permit_commit",
		"isolated_cycle_ids",
	],
	A5: [
		"founder_notice_action_decision",
		"narrow_executor_same_artifact_cas",
		"customer_readback",
		"three_ledgers_readback",
		"veto",
		"exact_fence",
		"withdraw",
	],
} as const;
export interface ActivationEvidenceIdentity {
	environment: string;
	endpoint: string;
	codeSha: string;
	policyRevision: string;
	identityDigest: string;
}
interface Check {
	check: string;
	result: "passed";
	outputFile: string;
	outputSha256: string;
	evidenceUrl: string;
}
interface RecordEvidence extends ActivationEvidenceIdentity {
	stage: keyof typeof activationEvidenceChecks;
	mode: "live" | "observe";
	manifestSha256: string;
	subjectCommit: string;
	releaseId: string;
	payloadSha256: string;
	actor: string;
	observedAt: number;
	checks: Check[];
}
interface Bundle extends ActivationEvidenceIdentity {
	schemaVersion: 1;
	projectId: "flywheel";
	createdAt: number;
	expiresAt: number;
	records: RecordEvidence[];
}
function valid(value: unknown): asserts value {
	if (!value) throw new Error("activation evidence unavailable");
}
function exact(
	value: unknown,
	keys: string[],
): asserts value is Record<string, unknown> {
	valid(value && typeof value === "object" && !Array.isArray(value));
	valid(
		Object.keys(value).length === keys.length &&
			keys.every((key) => Object.hasOwn(value, key)),
	);
}
const hash = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commit = (value: unknown) =>
	typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const name = (value: unknown) =>
	typeof value === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(value);
const time = (value: unknown) =>
	Number.isSafeInteger(value) && (value as number) >= 0;
const identityKeys = [
	"environment",
	"endpoint",
	"codeSha",
	"policyRevision",
	"identityDigest",
];
function url(value: unknown) {
	valid(typeof value === "string");
	const parsed = new URL(value);
	valid(
		parsed.protocol === "https:" &&
			!parsed.username &&
			!parsed.password &&
			!parsed.hash,
	);
	return parsed;
}
/** Synchronous and bounded so callers can use the accepted digest at a claim/
 * action boundary. No arbitrary paths, URL fetching, commands or token fields. */
export function readReleaseActivationEvidence(
	directory: string,
	identity: ActivationEvidenceIdentity,
	now: number,
): { digest: string; stages: string[]; expiresAt: number } | null {
	try {
		valid(time(now));
		exact(identity, identityKeys);
		valid(
			name(identity.environment) &&
				commit(identity.codeSha) &&
				digest(identity.policyRevision) &&
				digest(identity.identityDigest),
		);
		valid(url(identity.endpoint).origin === identity.endpoint);
		const root = resolve(directory);
		valid(realpathSync(root) === root);
		const before = lstatSync(root);
		valid(before.isDirectory() && !before.isSymbolicLink());
		let total = 0;
		const read = (file: string) => {
			valid(
				typeof file === "string" &&
					/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(file) &&
					file !== "." &&
					file !== "..",
			);
			const fd = openSync(
				join(root, file),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const stat = fstatSync(fd);
				valid(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024);
				total += stat.size;
				valid(total <= 8 * 1024 * 1024);
				const buffer = Buffer.alloc(stat.size + 1);
				let length = 0;
				while (length < buffer.length) {
					const count = readSync(
						fd,
						buffer,
						length,
						buffer.length - length,
						null,
					);
					if (count === 0) break;
					length += count;
				}
				const bytes = buffer.subarray(0, length);
				const after = fstatSync(fd);
				valid(
					bytes.length === stat.size &&
						after.size === stat.size &&
						after.mtimeMs === stat.mtimeMs &&
						after.ctimeMs === stat.ctimeMs,
				);
				return bytes;
			} finally {
				closeSync(fd);
			}
		};
		const bytes = read("bundle.json"),
			parsed: unknown = JSON.parse(bytes.toString("utf8"));
		exact(parsed, [
			"schemaVersion",
			"projectId",
			...identityKeys,
			"createdAt",
			"expiresAt",
			"records",
		]);
		const bundle = parsed as unknown as Bundle;
		valid(
			bundle.schemaVersion === 1 &&
				bundle.projectId === "flywheel" &&
				identityKeys.every(
					(key) =>
						bundle[key as keyof ActivationEvidenceIdentity] ===
						identity[key as keyof ActivationEvidenceIdentity],
				) &&
				time(bundle.createdAt) &&
				time(bundle.expiresAt) &&
				bundle.createdAt <= now &&
				bundle.expiresAt > now,
		);
		const stages = Object.keys(activationEvidenceChecks);
		valid(
			Array.isArray(bundle.records) && bundle.records.length === stages.length,
		);
		const outputs = new Map<string, string>();
		for (const [index, record] of bundle.records.entries()) {
			exact(record, [
				"stage",
				"mode",
				...identityKeys,
				"manifestSha256",
				"subjectCommit",
				"releaseId",
				"payloadSha256",
				"actor",
				"observedAt",
				"checks",
			]);
			valid(
				record.stage === stages[index] &&
					record.mode === (record.stage === "A4" ? "observe" : "live") &&
					identityKeys.every(
						(key) =>
							record[key as keyof ActivationEvidenceIdentity] ===
							identity[key as keyof ActivationEvidenceIdentity],
					) &&
					digest(record.manifestSha256) &&
					commit(record.subjectCommit) &&
					name(record.releaseId) &&
					digest(record.payloadSha256) &&
					name(record.actor) &&
					time(record.observedAt) &&
					record.observedAt <= bundle.createdAt,
			);
			const checks = activationEvidenceChecks[record.stage];
			valid(
				Array.isArray(record.checks) && record.checks.length === checks.length,
			);
			for (const [checkIndex, proof] of record.checks.entries()) {
				exact(proof, [
					"check",
					"result",
					"outputFile",
					"outputSha256",
					"evidenceUrl",
				]);
				valid(
					proof.check === checks[checkIndex] &&
						proof.result === "passed" &&
						digest(proof.outputSha256),
				);
				url(proof.evidenceUrl);
				let outputHash = outputs.get(proof.outputFile);
				if (!outputHash) {
					outputHash = hash(read(proof.outputFile));
					outputs.set(proof.outputFile, outputHash);
				}
				valid(outputHash === proof.outputSha256);
			}
		}
		const after = lstatSync(root);
		valid(
			after.dev === before.dev &&
				after.ino === before.ino &&
				after.isDirectory() &&
				!after.isSymbolicLink(),
		);
		return { digest: hash(bytes), stages, expiresAt: bundle.expiresAt };
	} catch {
		return null;
	}
}
