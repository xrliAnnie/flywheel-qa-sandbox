import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { processTupleStateWithStart } from "flywheel-comm/lead-lease";
import {
	canonicalSubmissionDigest,
	type PersonaPin,
	type PersonaProjection,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { OpenedDatabaseIdentity, StateStore } from "../StateStore.js";
import type { FetchDiscordMessageResult } from "./discord-utils.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const WINDOW_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_JSON_BYTES = 64 * 1024;

export interface PersonaAuthorizationRef {
	channelId: string;
	messageId: string;
	authorId: string;
	contentSha256: string;
	authorizedPayloadDigest: string;
}

export interface ActivationStoppedConsumer {
	pid: number;
	lstart: string;
	leaseId: string;
	processAbsentObservedAt: string;
	leaseReleasedObservedAt: string;
}

export type MigrationCompatiblePin = PersonaPin & {
	migrationCompatible: true;
};

export interface ActivationFenceV1 {
	schemaVersion: 1;
	kind: "raya-persona-activation";
	windowId: string;
	projectName: "raya";
	leadId: "raya";
	database: OpenedDatabaseIdentity;
	workspaceCanonicalPath: string;
	a0Digest: string;
	target: PersonaPin;
	fallback: MigrationCompatiblePin | null;
	frozenPayloadDigest: string;
	frozenAt: string;
	activationAuthorization: PersonaAuthorizationRef;
	phase: "prepared" | "fenced" | "migrating" | "migrated" | "ready";
	revision: number;
	fenceEnteredAt: string | null;
	stoppedConsumer: ActivationStoppedConsumer | null;
	migrationReceipt: { path: string; receiptId: string } | null;
	issuer: { kind: "activation-owner"; executionId: string };
	legacyWriterHandoff: {
		disabledAt: string;
		guardDeployedSha: string;
		legacyPassDrainedAt: string;
		baselinePersonaDigest: string;
	};
	migrationOrigin: "new-execution" | "legacy-adoption";
}

export type ActivationView =
	| { kind: "unmanaged" }
	| { kind: "legacy-managed" }
	| {
			kind: "pre-m0";
			contractDigest: string;
			a0Digest: string;
			revision: string;
	  }
	| { kind: "fenced"; windowId: string; revision: string }
	| {
			kind: "post-m0";
			windowId: string;
			contractDigest: string;
			expected: PersonaPin;
			fallback: MigrationCompatiblePin | null;
			dbIdentity: string;
			migrationReceiptDigest: string;
			revision: string;
	  }
	| { kind: "refused"; reason: string };

export interface PersonaActivationReaderDeps {
	store: Pick<
		StateStore,
		| "assertOpenedDatabaseIdentityCurrent"
		| "readSummaryPresentationMigrationEvidence"
	>;
	projects: readonly ProjectEntry[];
	stateRoot: string;
	founderUserId?: string;
	fetchMessage: (
		channelId: string,
		messageId: string,
	) => Promise<FetchDiscordMessageResult>;
	verifyStoppedConsumer?: (
		leadKey: string,
		proof: ActivationStoppedConsumer,
	) => boolean | Promise<boolean>;
	now?: () => Date;
}

type EnrollmentV1 = {
	schemaVersion: 1;
	kind: "raya-persona-enrollment";
	windowId: string;
	projectName: "raya";
	leadId: "raya";
	database: OpenedDatabaseIdentity;
	workspaceCanonicalPath: string;
	frozenPayloadDigest: string;
	activationAuthorization: PersonaAuthorizationRef;
};

type M0ReceiptV1 = {
	schemaVersion: 1;
	kind: "raya-summary-presentation-m0";
	mode: "executed" | "adopted-legacy";
	receiptId: string;
	windowId: string;
	projectName: "raya";
	leadId: "raya";
	database: OpenedDatabaseIdentity;
	workspaceCanonicalPath: string;
	workspaceIdentityDigest: string;
	summaryContractVersion: 2;
	state: "complete";
	migration_boundary_seq: number;
	cursor_seq: number;
	sourceDigests: {
		journal: string;
		legacyLedger: string;
		migrationDecisions: string;
	};
	dispositions: {
		eligible: number;
		historical_presented: number;
		historical_silent: number;
		needs_reconciliation: number;
		claimed: number;
	};
	verifiedRowCount: number;
	dispositionDigest: string;
	issuer: {
		kind: "flywheel-m0-wrapper";
		toolPath: string;
		toolBlobSha256: string;
		deployedSha: string;
	};
	executionAuthorization: PersonaAuthorizationRef;
	completedAt: string;
	generatedAt: string;
};

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUtcIso(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new Error(`${label}_unknown_field`);
	}
}

function sameDatabase(
	left: OpenedDatabaseIdentity,
	right: OpenedDatabaseIdentity,
): boolean {
	return (
		left.canonicalPath === right.canonicalPath &&
		left.device === right.device &&
		left.inode === right.inode
	);
}

function parseDatabase(value: unknown, label: string): OpenedDatabaseIdentity {
	if (!isObject(value)) throw new Error(`${label}_invalid`);
	exactKeys(value, ["canonicalPath", "device", "inode"], label);
	if (
		typeof value.canonicalPath !== "string" ||
		!isAbsolute(value.canonicalPath) ||
		typeof value.device !== "string" ||
		!/^\d+$/.test(value.device) ||
		typeof value.inode !== "string" ||
		!/^\d+$/.test(value.inode)
	) {
		throw new Error(`${label}_invalid`);
	}
	return {
		canonicalPath: value.canonicalPath,
		device: value.device,
		inode: value.inode,
	};
}

function parseAuthorization(
	value: unknown,
	label: string,
): PersonaAuthorizationRef {
	if (!isObject(value)) throw new Error(`${label}_invalid`);
	exactKeys(
		value,
		[
			"channelId",
			"messageId",
			"authorId",
			"contentSha256",
			"authorizedPayloadDigest",
		],
		label,
	);
	for (const field of ["channelId", "messageId", "authorId"] as const) {
		if (typeof value[field] !== "string" || !/^\d{17,20}$/.test(value[field])) {
			throw new Error(`${label}_${field}_invalid`);
		}
	}
	for (const field of ["contentSha256", "authorizedPayloadDigest"] as const) {
		if (typeof value[field] !== "string" || !SHA256_RE.test(value[field])) {
			throw new Error(`${label}_${field}_invalid`);
		}
	}
	return value as unknown as PersonaAuthorizationRef;
}

function parsePin(
	value: unknown,
	label: string,
	allowMigrationCompatible = false,
): PersonaPin | MigrationCompatiblePin {
	if (!isObject(value)) throw new Error(`${label}_invalid`);
	exactKeys(
		value,
		allowMigrationCompatible
			? ["commit", "personaBlobDigest", "approval", "migrationCompatible"]
			: ["commit", "personaBlobDigest", "approval"],
		label,
	);
	if (
		typeof value.commit !== "string" ||
		!COMMIT_RE.test(value.commit) ||
		typeof value.personaBlobDigest !== "string" ||
		!SHA256_RE.test(value.personaBlobDigest) ||
		!isObject(value.approval)
	) {
		throw new Error(`${label}_invalid`);
	}
	if (allowMigrationCompatible && value.migrationCompatible !== true) {
		throw new Error(`${label}_migration_compatible_required`);
	}
	const approval = value.approval;
	exactKeys(
		approval,
		["channelId", "messageId", "contentSha256"],
		`${label}_approval`,
	);
	if (
		typeof approval.channelId !== "string" ||
		!/^\d{17,20}$/.test(approval.channelId) ||
		typeof approval.messageId !== "string" ||
		!/^\d{17,20}$/.test(approval.messageId) ||
		typeof approval.contentSha256 !== "string" ||
		!SHA256_RE.test(approval.contentSha256)
	) {
		throw new Error(`${label}_approval_invalid`);
	}
	return {
		commit: value.commit,
		personaBlobDigest: value.personaBlobDigest,
		approval: {
			channelId: approval.channelId,
			messageId: approval.messageId,
			contentSha256: approval.contentSha256,
		},
		...(allowMigrationCompatible ? { migrationCompatible: true as const } : {}),
	};
}

function secureRead(
	path: string,
	label: string,
	maxBytes = MAX_JSON_BYTES,
	allowEmpty = false,
): Buffer {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(`${label}_not_regular`);
	if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label}_mode_invalid`);
	if ((!allowEmpty && stat.size < 1) || stat.size > maxBytes)
		throw new Error(`${label}_size_invalid`);
	const data = readFileSync(path);
	if (data.length !== stat.size)
		throw new Error(`${label}_changed_during_read`);
	return data;
}

function secureJson(path: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(secureRead(path, label).toString("utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${label}_json_invalid`);
		throw error;
	}
	if (!isObject(parsed)) throw new Error(`${label}_json_invalid`);
	return parsed;
}

function pathPresence(path: string): "absent" | "present" | "unsafe" {
	try {
		const stat = lstatSync(path);
		return stat.isSymbolicLink() ? "unsafe" : "present";
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return "absent";
		}
		return "unsafe";
	}
}

function assertDirectoryChainNoSymlink(stateRoot: string): void {
	let cursor = resolve(stateRoot);
	const components: string[] = [];
	while (cursor !== dirname(cursor)) {
		components.unshift(cursor);
		cursor = dirname(cursor);
	}
	for (const component of components) {
		const stat = lstatSync(component);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("persona_state_parent_unsafe");
		}
	}
}

function parseEnrollment(value: Record<string, unknown>): EnrollmentV1 {
	exactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"windowId",
			"projectName",
			"leadId",
			"database",
			"workspaceCanonicalPath",
			"frozenPayloadDigest",
			"activationAuthorization",
		],
		"enrollment",
	);
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "raya-persona-enrollment" ||
		typeof value.windowId !== "string" ||
		!WINDOW_RE.test(value.windowId) ||
		value.projectName !== "raya" ||
		value.leadId !== "raya" ||
		typeof value.workspaceCanonicalPath !== "string" ||
		typeof value.frozenPayloadDigest !== "string" ||
		!SHA256_RE.test(value.frozenPayloadDigest)
	) {
		throw new Error("enrollment_invalid");
	}
	return {
		schemaVersion: 1,
		kind: "raya-persona-enrollment",
		windowId: value.windowId,
		projectName: "raya",
		leadId: "raya",
		database: parseDatabase(value.database, "enrollment_database"),
		workspaceCanonicalPath: value.workspaceCanonicalPath,
		frozenPayloadDigest: value.frozenPayloadDigest,
		activationAuthorization: parseAuthorization(
			value.activationAuthorization,
			"enrollment_authorization",
		),
	};
}

function parseFence(value: Record<string, unknown>): ActivationFenceV1 {
	exactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"windowId",
			"projectName",
			"leadId",
			"database",
			"workspaceCanonicalPath",
			"a0Digest",
			"target",
			"fallback",
			"frozenPayloadDigest",
			"frozenAt",
			"activationAuthorization",
			"phase",
			"revision",
			"fenceEnteredAt",
			"stoppedConsumer",
			"migrationReceipt",
			"issuer",
			"legacyWriterHandoff",
			"migrationOrigin",
		],
		"activation",
	);
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "raya-persona-activation" ||
		typeof value.windowId !== "string" ||
		!WINDOW_RE.test(value.windowId) ||
		value.projectName !== "raya" ||
		value.leadId !== "raya" ||
		typeof value.workspaceCanonicalPath !== "string" ||
		typeof value.a0Digest !== "string" ||
		!SHA256_RE.test(value.a0Digest) ||
		typeof value.frozenPayloadDigest !== "string" ||
		!SHA256_RE.test(value.frozenPayloadDigest) ||
		!isUtcIso(value.frozenAt) ||
		!(
			value.phase === "prepared" ||
			value.phase === "fenced" ||
			value.phase === "migrating" ||
			value.phase === "migrated" ||
			value.phase === "ready"
		) ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 0 ||
		!(
			value.migrationOrigin === "new-execution" ||
			value.migrationOrigin === "legacy-adoption"
		)
	) {
		throw new Error("activation_invalid");
	}
	if (!(value.fenceEnteredAt === null || isUtcIso(value.fenceEnteredAt)))
		throw new Error("activation_fence_entered_at_invalid");
	const fallback =
		value.fallback === null
			? null
			: (parsePin(
					value.fallback,
					"activation_fallback",
					true,
				) as MigrationCompatiblePin);
	if (
		!isObject(value.issuer) ||
		value.issuer.kind !== "activation-owner" ||
		typeof value.issuer.executionId !== "string" ||
		!value.issuer.executionId
	) {
		throw new Error("activation_issuer_invalid");
	}
	if (!isObject(value.legacyWriterHandoff))
		throw new Error("activation_handoff_invalid");
	exactKeys(
		value.legacyWriterHandoff,
		[
			"disabledAt",
			"guardDeployedSha",
			"legacyPassDrainedAt",
			"baselinePersonaDigest",
		],
		"activation_handoff",
	);
	const handoff = value.legacyWriterHandoff;
	if (
		typeof handoff.disabledAt !== "string" ||
		!Number.isFinite(Date.parse(handoff.disabledAt)) ||
		typeof handoff.legacyPassDrainedAt !== "string" ||
		!Number.isFinite(Date.parse(handoff.legacyPassDrainedAt)) ||
		typeof handoff.guardDeployedSha !== "string" ||
		!COMMIT_RE.test(handoff.guardDeployedSha) ||
		typeof handoff.baselinePersonaDigest !== "string" ||
		!SHA256_RE.test(handoff.baselinePersonaDigest)
	)
		throw new Error("activation_handoff_invalid");
	let stoppedConsumer: ActivationStoppedConsumer | null = null;
	if (value.stoppedConsumer !== null) {
		if (!isObject(value.stoppedConsumer))
			throw new Error("activation_stopped_consumer_invalid");
		exactKeys(
			value.stoppedConsumer,
			[
				"pid",
				"lstart",
				"leaseId",
				"processAbsentObservedAt",
				"leaseReleasedObservedAt",
			],
			"activation_stopped_consumer",
		);
		const proof = value.stoppedConsumer;
		if (
			!Number.isSafeInteger(proof.pid) ||
			(proof.pid as number) < 1 ||
			typeof proof.lstart !== "string" ||
			!proof.lstart ||
			typeof proof.leaseId !== "string" ||
			!proof.leaseId ||
			!isUtcIso(proof.processAbsentObservedAt) ||
			!isUtcIso(proof.leaseReleasedObservedAt)
		)
			throw new Error("activation_stopped_consumer_invalid");
		stoppedConsumer = proof as unknown as ActivationStoppedConsumer;
	}
	let migrationReceipt: { path: string; receiptId: string } | null = null;
	if (value.migrationReceipt !== null) {
		if (!isObject(value.migrationReceipt))
			throw new Error("activation_receipt_ref_invalid");
		exactKeys(
			value.migrationReceipt,
			["path", "receiptId"],
			"activation_receipt_ref",
		);
		if (
			typeof value.migrationReceipt.path !== "string" ||
			typeof value.migrationReceipt.receiptId !== "string" ||
			!SHA256_RE.test(value.migrationReceipt.receiptId)
		)
			throw new Error("activation_receipt_ref_invalid");
		migrationReceipt = value.migrationReceipt as {
			path: string;
			receiptId: string;
		};
	}
	return {
		schemaVersion: 1,
		kind: "raya-persona-activation",
		windowId: value.windowId,
		projectName: "raya",
		leadId: "raya",
		database: parseDatabase(value.database, "activation_database"),
		workspaceCanonicalPath: value.workspaceCanonicalPath,
		a0Digest: value.a0Digest,
		target: parsePin(value.target, "activation_target") as PersonaPin,
		fallback,
		frozenPayloadDigest: value.frozenPayloadDigest,
		frozenAt: value.frozenAt,
		activationAuthorization: parseAuthorization(
			value.activationAuthorization,
			"activation_authorization",
		),
		phase: value.phase,
		revision: value.revision as number,
		fenceEnteredAt: value.fenceEnteredAt as string | null,
		stoppedConsumer,
		migrationReceipt,
		issuer: value.issuer as ActivationFenceV1["issuer"],
		legacyWriterHandoff: handoff as ActivationFenceV1["legacyWriterHandoff"],
		migrationOrigin: value.migrationOrigin,
	};
}

function samePin(left: PersonaPin, right: PersonaPin): boolean {
	return canonicalSubmissionDigest(left) === canonicalSubmissionDigest(right);
}

async function verifyMessage(
	deps: PersonaActivationReaderDeps,
	ref: PersonaAuthorizationRef | PersonaPin["approval"],
	bindings: readonly string[],
): Promise<number> {
	if (!deps.founderUserId || !/^\d{17,20}$/.test(deps.founderUserId)) {
		throw new Error("founder_identity_unavailable");
	}
	const result = await deps.fetchMessage(ref.channelId, ref.messageId);
	if (!result.ok) throw new Error(`authorization_message_${result.kind}`);
	const { message } = result;
	if (message.authorId !== deps.founderUserId || message.authorIsBot === true) {
		throw new Error("authorization_author_invalid");
	}
	if (sha256(message.content) !== ref.contentSha256) {
		throw new Error("authorization_content_changed");
	}
	if (bindings.some((binding) => !message.content.includes(binding))) {
		throw new Error("authorization_binding_missing");
	}
	return message.timestampMs;
}

function frozenPayload(fence: ActivationFenceV1): Record<string, unknown> {
	return {
		windowId: fence.windowId,
		projectName: fence.projectName,
		leadId: fence.leadId,
		database: fence.database,
		workspaceCanonicalPath: fence.workspaceCanonicalPath,
		a0Digest: fence.a0Digest,
		target: fence.target,
		fallback: fence.fallback,
		frozenAt: fence.frozenAt,
	};
}

function parseReceipt(value: Record<string, unknown>): M0ReceiptV1 {
	exactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"mode",
			"receiptId",
			"windowId",
			"projectName",
			"leadId",
			"database",
			"workspaceCanonicalPath",
			"workspaceIdentityDigest",
			"summaryContractVersion",
			"state",
			"migration_boundary_seq",
			"cursor_seq",
			"sourceDigests",
			"dispositions",
			"verifiedRowCount",
			"dispositionDigest",
			"issuer",
			"executionAuthorization",
			"completedAt",
			"generatedAt",
		],
		"m0_receipt",
	);
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "raya-summary-presentation-m0" ||
		!(value.mode === "executed" || value.mode === "adopted-legacy") ||
		typeof value.receiptId !== "string" ||
		!SHA256_RE.test(value.receiptId) ||
		typeof value.windowId !== "string" ||
		!WINDOW_RE.test(value.windowId) ||
		value.projectName !== "raya" ||
		value.leadId !== "raya" ||
		typeof value.workspaceCanonicalPath !== "string" ||
		typeof value.workspaceIdentityDigest !== "string" ||
		!SHA256_RE.test(value.workspaceIdentityDigest) ||
		value.summaryContractVersion !== 2 ||
		value.state !== "complete" ||
		!Number.isSafeInteger(value.migration_boundary_seq) ||
		(value.migration_boundary_seq as number) < 0 ||
		!Number.isSafeInteger(value.cursor_seq) ||
		(value.cursor_seq as number) < 0 ||
		typeof value.dispositionDigest !== "string" ||
		!SHA256_RE.test(value.dispositionDigest) ||
		!Number.isSafeInteger(value.verifiedRowCount) ||
		(value.verifiedRowCount as number) < 0 ||
		!isUtcIso(value.completedAt) ||
		!isUtcIso(value.generatedAt) ||
		!isObject(value.sourceDigests) ||
		!isObject(value.dispositions) ||
		!isObject(value.issuer)
	)
		throw new Error("m0_receipt_invalid");
	const sourceDigests = value.sourceDigests;
	exactKeys(
		sourceDigests,
		["journal", "legacyLedger", "migrationDecisions"],
		"m0_source_digests",
	);
	if (
		Object.values(sourceDigests).some(
			(digest) => typeof digest !== "string" || !SHA256_RE.test(digest),
		)
	)
		throw new Error("m0_source_digests_invalid");
	const dispositions = value.dispositions;
	exactKeys(
		dispositions,
		[
			"eligible",
			"historical_presented",
			"historical_silent",
			"needs_reconciliation",
			"claimed",
		],
		"m0_dispositions",
	);
	if (
		Object.values(dispositions).some(
			(count) => !Number.isSafeInteger(count) || (count as number) < 0,
		)
	)
		throw new Error("m0_dispositions_invalid");
	const issuer = value.issuer;
	exactKeys(
		issuer,
		["kind", "toolPath", "toolBlobSha256", "deployedSha"],
		"m0_issuer",
	);
	if (
		issuer.kind !== "flywheel-m0-wrapper" ||
		typeof issuer.toolPath !== "string" ||
		!isAbsolute(issuer.toolPath) ||
		typeof issuer.toolBlobSha256 !== "string" ||
		!SHA256_RE.test(issuer.toolBlobSha256) ||
		typeof issuer.deployedSha !== "string" ||
		!COMMIT_RE.test(issuer.deployedSha)
	)
		throw new Error("m0_issuer_invalid");
	parseDatabase(value.database, "m0_database");
	parseAuthorization(
		value.executionAuthorization,
		"m0_execution_authorization",
	);
	return value as unknown as M0ReceiptV1;
}

function parseDispositionRows(value: string): Record<string, unknown>[] {
	const rows = value
		? value.split("\n").map((line) => JSON.parse(line) as unknown)
		: [];
	let previous: [number, string] | undefined;
	return rows.map((row, index) => {
		if (!isObject(row)) throw new Error("migration_disposition_row_invalid");
		exactKeys(
			row,
			["sourceSeq", "roundId", "sourceDigest", "disposition", "evidenceRef"],
			"migration_disposition_row",
		);
		if (
			!Number.isSafeInteger(row.sourceSeq) ||
			(row.sourceSeq as number) < 0 ||
			typeof row.roundId !== "string" ||
			row.roundId.length === 0 ||
			typeof row.sourceDigest !== "string" ||
			!SHA256_RE.test(row.sourceDigest) ||
			!(
				[
					"historical_presented",
					"historical_silent",
					"needs_reconciliation",
					"claimed",
				] as unknown[]
			).includes(row.disposition) ||
			!(row.evidenceRef === null || typeof row.evidenceRef === "string")
		)
			throw new Error("migration_disposition_row_invalid");
		const current: [number, string] = [row.sourceSeq as number, row.roundId];
		if (
			previous &&
			(current[0] < previous[0] ||
				(current[0] === previous[0] &&
					current[1].localeCompare(previous[1]) <= 0))
		)
			throw new Error(`migration_disposition_order_invalid:${index}`);
		previous = current;
		return row;
	});
}

export class PersonaActivationReader {
	constructor(private readonly deps: PersonaActivationReaderDeps) {}

	async read(projectName: string, leadId: string): Promise<ActivationView> {
		if (projectName !== "raya" || leadId !== "raya") {
			return { kind: "refused", reason: "persona_identity_unsupported" };
		}
		const project = this.deps.projects.find(
			(row) => row.projectName === projectName,
		);
		if (!project) return { kind: "refused", reason: "persona_project_missing" };
		if (project.invalidPersonaProjection) {
			return {
				kind: "refused",
				reason: `persona_contract_invalid:${project.invalidPersonaProjection}`,
			};
		}
		const contract =
			project.personaProjection?.leadId === leadId
				? project.personaProjection
				: undefined;
		const enrollmentPath = join(this.deps.stateRoot, "enrollment.json");
		const activationPath = join(this.deps.stateRoot, "activation.json");
		const enrollmentPresence = pathPresence(enrollmentPath);
		const activationPresence = pathPresence(activationPath);
		if (enrollmentPresence === "absent" && activationPresence === "absent") {
			if (contract)
				return { kind: "refused", reason: "contract_without_enrollment" };
			const evidence = this.deps.store.readSummaryPresentationMigrationEvidence(
				projectName,
				leadId,
			);
			return {
				kind:
					evidence.migration?.state === "complete"
						? "legacy-managed"
						: "unmanaged",
			};
		}
		if (enrollmentPresence !== "present" || activationPresence !== "present") {
			return { kind: "refused", reason: "enrollment_or_activation_unsafe" };
		}
		if (!contract || !project.personaProjectionContractDigest) {
			return { kind: "refused", reason: "enrolled_contract_missing" };
		}
		try {
			assertDirectoryChainNoSymlink(this.deps.stateRoot);
			const enrollment = parseEnrollment(
				secureJson(enrollmentPath, "enrollment"),
			);
			const fence = parseFence(secureJson(activationPath, "activation"));
			if (enrollment.windowId !== fence.windowId)
				throw new Error("window_mismatch");
			if (enrollment.frozenPayloadDigest !== fence.frozenPayloadDigest)
				throw new Error("enrollment_frozen_digest_mismatch");
			if (
				canonicalSubmissionDigest(frozenPayload(fence)) !==
				fence.frozenPayloadDigest
			)
				throw new Error("frozen_payload_digest_mismatch");
			const workspace = realpathSync.native(project.projectRoot);
			if (
				workspace !== fence.workspaceCanonicalPath ||
				workspace !== enrollment.workspaceCanonicalPath
			)
				throw new Error("workspace_identity_mismatch");
			const database = this.deps.store.assertOpenedDatabaseIdentityCurrent();
			if (
				!sameDatabase(database, fence.database) ||
				!sameDatabase(database, enrollment.database)
			)
				throw new Error("database_identity_mismatch");
			if (
				enrollment.activationAuthorization.authorizedPayloadDigest !==
				fence.activationAuthorization.authorizedPayloadDigest
			)
				throw new Error("enrollment_authorization_mismatch");
			if (
				fence.activationAuthorization.authorizedPayloadDigest !==
				fence.frozenPayloadDigest
			)
				throw new Error("activation_authorized_payload_mismatch");
			const activationAuthorizedAt = await verifyMessage(
				this.deps,
				fence.activationAuthorization,
				[
					fence.activationAuthorization.authorizedPayloadDigest,
					fence.frozenPayloadDigest,
					fence.windowId,
				],
			);
			await verifyMessage(this.deps, contract.pin.approval, [
				"raya",
				contract.repo,
				contract.path,
				contract.pin.commit,
				contract.pin.personaBlobDigest,
			]);
			await verifyMessage(this.deps, contract.lastKnownGood.approval, [
				contract.lastKnownGood.commit,
				contract.lastKnownGood.personaBlobDigest,
			]);
			const evidence = this.deps.store.readSummaryPresentationMigrationEvidence(
				projectName,
				leadId,
			);
			const revision = String(fence.revision);
			if (activationAuthorizedAt < Date.parse(fence.frozenAt))
				throw new Error("activation_authorization_before_freeze");
			if (fence.phase === "prepared") {
				if (
					fence.fenceEnteredAt !== null ||
					fence.stoppedConsumer !== null ||
					fence.migrationReceipt !== null
				)
					throw new Error("prepared_fence_fields_invalid");
				if (evidence.migration !== null)
					return { kind: "fenced", windowId: fence.windowId, revision };
				if (
					contract.pin.personaBlobDigest !==
						contract.lastKnownGood.personaBlobDigest ||
					contract.pin.personaBlobDigest !== fence.a0Digest
				)
					throw new Error("pre_m0_a0_mismatch");
				return {
					kind: "pre-m0",
					contractDigest: project.personaProjectionContractDigest,
					a0Digest: fence.a0Digest,
					revision,
				};
			}
			if (fence.fenceEnteredAt === null || fence.stoppedConsumer === null)
				throw new Error("fence_proof_missing");
			if (
				Date.parse(fence.fenceEnteredAt) < activationAuthorizedAt ||
				Date.parse(fence.fenceEnteredAt) < Date.parse(fence.frozenAt)
			)
				throw new Error("activation_fence_order_invalid");
			const stopObservedAt = (this.deps.now ?? (() => new Date()))().getTime();
			if (
				Date.parse(fence.stoppedConsumer.processAbsentObservedAt) <
					Date.parse(fence.fenceEnteredAt) ||
				Date.parse(fence.stoppedConsumer.leaseReleasedObservedAt) <
					Date.parse(fence.fenceEnteredAt) ||
				Date.parse(fence.stoppedConsumer.processAbsentObservedAt) >
					stopObservedAt ||
				Date.parse(fence.stoppedConsumer.leaseReleasedObservedAt) >
					stopObservedAt
			)
				throw new Error("consumer_stop_order_invalid");
			if (
				!this.deps.verifyStoppedConsumer ||
				!(await this.deps.verifyStoppedConsumer(
					"raya-raya",
					fence.stoppedConsumer,
				))
			)
				throw new Error("consumer_stop_unverified");
			if (fence.phase !== "ready") {
				return { kind: "fenced", windowId: fence.windowId, revision };
			}
			if (!fence.migrationReceipt) throw new Error("migration_receipt_missing");
			const expectedReceiptPath = join(this.deps.stateRoot, "m0-receipt.json");
			if (resolve(fence.migrationReceipt.path) !== resolve(expectedReceiptPath))
				throw new Error("migration_receipt_path_invalid");
			const receiptRaw = secureJson(expectedReceiptPath, "m0_receipt");
			const receipt = parseReceipt(receiptRaw);
			const {
				receiptId: _receiptId,
				generatedAt: _generatedAt,
				...receiptIdentity
			} = receiptRaw;
			if (
				canonicalSubmissionDigest(receiptIdentity) !== receipt.receiptId ||
				receipt.receiptId !== fence.migrationReceipt.receiptId
			)
				throw new Error("migration_receipt_id_invalid");
			if (
				receipt.windowId !== fence.windowId ||
				!sameDatabase(receipt.database, database) ||
				receipt.workspaceCanonicalPath !== workspace
			)
				throw new Error("migration_receipt_identity_mismatch");
			if (receipt.workspaceIdentityDigest !== fence.target.personaBlobDigest)
				throw new Error("migration_workspace_digest_mismatch");
			if (
				!evidence.migration ||
				evidence.migration.state !== "complete" ||
				evidence.completedAtMs === null
			)
				throw new Error("migration_database_incomplete");
			if (
				receipt.migration_boundary_seq !== receipt.cursor_seq ||
				receipt.migration_boundary_seq !== evidence.migration.boundarySeq ||
				receipt.cursor_seq !== evidence.migration.cursorSeq ||
				canonicalSubmissionDigest(receipt.sourceDigests) !==
					canonicalSubmissionDigest(evidence.migration.sourceDigests) ||
				Date.parse(receipt.completedAt) !== evidence.completedAtMs
			)
				throw new Error("migration_database_evidence_mismatch");
			const dispositionCount = Object.values(receipt.dispositions).reduce(
				(sum, value) => sum + value,
				0,
			);
			if (
				dispositionCount !== receipt.verifiedRowCount ||
				(receipt.mode === "executed" && receipt.dispositions.claimed !== 0)
			)
				throw new Error("migration_disposition_count_invalid");
			const dispositionText = secureRead(
				join(this.deps.stateRoot, "m0-dispositions.jsonl"),
				"m0_dispositions",
				MAX_JSON_BYTES,
				true,
			)
				.toString("utf8")
				.trim();
			const dispositionRows = parseDispositionRows(dispositionText);
			if (
				dispositionRows.length !== receipt.verifiedRowCount ||
				canonicalSubmissionDigest(dispositionRows) !== receipt.dispositionDigest
			)
				throw new Error("migration_disposition_evidence_invalid");
			if (
				sha256(
					secureRead(receipt.issuer.toolPath, "m0_tool", 2 * 1024 * 1024),
				) !== receipt.issuer.toolBlobSha256
			)
				throw new Error("migration_tool_digest_invalid");
			const executionAuthorizedAt = await verifyMessage(
				this.deps,
				receipt.executionAuthorization,
				[
					receipt.executionAuthorization.authorizedPayloadDigest,
					receipt.issuer.toolBlobSha256,
					receipt.issuer.deployedSha,
					receipt.sourceDigests.journal,
					receipt.sourceDigests.legacyLedger,
					receipt.sourceDigests.migrationDecisions,
					canonicalSubmissionDigest(database),
				],
			);
			const now = (this.deps.now ?? (() => new Date()))().getTime();
			if (
				Date.parse(receipt.completedAt) > now ||
				Date.parse(receipt.generatedAt) > now
			)
				throw new Error("migration_time_future");
			if (
				executionAuthorizedAt < Date.parse(fence.fenceEnteredAt) ||
				executionAuthorizedAt > Date.parse(receipt.completedAt)
			)
				throw new Error("migration_authorization_order_invalid");
			if (!samePin(contract.pin, fence.target))
				throw new Error("post_m0_target_contract_mismatch");
			return {
				kind: "post-m0",
				windowId: fence.windowId,
				contractDigest: project.personaProjectionContractDigest,
				expected: fence.target,
				fallback: fence.fallback,
				dbIdentity: canonicalSubmissionDigest(database),
				migrationReceiptDigest: receipt.receiptId,
				revision,
			};
		} catch (error) {
			return {
				kind: "refused",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

export function personaContractFor(
	project: ProjectEntry,
	leadId: string,
): PersonaProjection | undefined {
	return project.personaProjection?.leadId === leadId
		? project.personaProjection
		: undefined;
}

export function verifyStoppedPersonaConsumer(
	leadKey: string,
	proof: ActivationStoppedConsumer,
	options: {
		leaseDbPath: string;
		now?: () => Date;
		processTupleState?: (
			pid: number,
			lstart: string,
		) => "alive" | "dead" | "sensor_error";
	},
): boolean {
	const now = (options.now ?? (() => new Date()))().getTime();
	const tupleState = options.processTupleState ?? processTupleStateWithStart;
	if (
		Date.parse(proof.processAbsentObservedAt) > now ||
		Date.parse(proof.leaseReleasedObservedAt) > now ||
		tupleState(proof.pid, proof.lstart) !== "dead"
	)
		return false;
	let db: BetterSqlite3.Database | undefined;
	try {
		db = new BetterSqlite3(options.leaseDbPath, {
			readonly: true,
			fileMustExist: true,
		});
		db.pragma("query_only = ON");
		const row = db
			.prepare(
				"SELECT holder_pid AS holderPid, holder_start AS holderStart FROM lead_lease WHERE lead_key = ?",
			)
			.get(leadKey) as
			| { holderPid: number | null; holderStart: string | null }
			| undefined;
		if (!row?.holderPid || !row.holderStart) return true;
		return tupleState(row.holderPid, row.holderStart) === "dead";
	} catch {
		return false;
	} finally {
		db?.close();
	}
}
