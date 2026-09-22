#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3, { type Database as BetterDb } from "better-sqlite3";
import {
	classifyRound,
	type ResolvedSummaryPresentationMigrationInputs,
	resolveSummaryPresentationMigrationInputs,
	runSummaryPresentationMigration,
} from "../bridge/summary-presentation-migration.js";
import {
	SUMMARY_PRESENTATION_CONTRACT_VERSION,
	type SummaryPresentationGroupState,
	type SummaryPresentationMigration,
	type SummaryPresentationRoundDisposition,
	SummaryPresentationStore,
} from "../bridge/summary-presentation-store.js";
import { StateStore } from "../StateStore.js";
import {
	atomicJson,
	type MigrationIO,
	migrationIO,
	withRayaDeployLock,
} from "./raya-migration-io.js";
import {
	parseRayaSummaryPresentationMigrationArgs,
	type RayaSummaryPresentationMigrationArgs,
} from "./raya-summary-presentation-migrate.js";

const RECEIPT_MAX_BYTES = 64 * 1024;
const EXECUTION_MAX_BYTES = 64 * 1024;
const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
const TOOL_MAX_BYTES = 8 * 1024 * 1024;
const PERSONA_MAX_BYTES = 256 * 1024;
const DEPLOYED_SHA_MAX_BYTES = 128;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,24}$/u;
const WINDOW_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const DISPOSITIONS = [
	"eligible",
	"claimed",
	"historical_presented",
	"historical_silent",
	"needs_reconciliation",
] as const;
const GROUP_STATES = [
	"collecting",
	"ready",
	"silent",
	"sending",
	"sent",
	"ambiguous",
] as const satisfies readonly SummaryPresentationGroupState[];

type GateCommand = "preflight" | "verify" | "execute";
type JsonObject = Record<string, unknown>;
type GateMode = "executed" | "adopted-legacy";

interface AuthorizationRef {
	channelId: string;
	messageId: string;
	authorId: string;
	contentSha256: string;
	authorizedPayloadDigest: string;
}

interface PlannedIdentity {
	receiptId: string;
	dispositionDigest: string;
	completedAt: string;
}

interface ExecutionRecord {
	schemaVersion: 1;
	kind: "raya-summary-presentation-m0-execution";
	windowId: string;
	mode: GateMode;
	authorizedPayloadDigest: string;
	authorization: Omit<AuthorizationRef, "authorizedPayloadDigest">;
	startedAt: string;
	schemaAdoption: null | { source: "updated_at_ms"; adoptedAt: string };
	planned: PlannedIdentity | null;
}

interface FrozenRow {
	sourceSeq: number;
	roundId: string;
	sourceDigest: string;
	disposition: SummaryPresentationRoundDisposition;
	evidenceRef: string | null;
}

interface Verification {
	migration: SummaryPresentationMigration;
	frozenRows: FrozenRow[];
	dispositions: Record<SummaryPresentationRoundDisposition, number>;
	verifiedRowCount: number;
	dispositionDigest: string;
}

interface M0ReceiptV1 extends JsonObject {
	schemaVersion: 1;
	kind: "raya-summary-presentation-m0";
	mode: GateMode;
	receiptId: string;
	windowId: string;
	projectName: "raya";
	leadId: "raya";
	database: DatabaseIdentity;
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
	dispositions: Record<SummaryPresentationRoundDisposition, number>;
	verifiedRowCount: number;
	dispositionDigest: string;
	issuer: {
		kind: "flywheel-m0-wrapper";
		toolPath: string;
		toolBlobSha256: string;
		deployedSha: string;
	};
	executionAuthorization: AuthorizationRef;
	completedAt: string;
	generatedAt: string;
}

interface DatabaseIdentity {
	canonicalPath: string;
	device: string;
	inode: string;
}

interface ParsedGateArgs {
	command: GateCommand;
	shared: RayaSummaryPresentationMigrationArgs;
	stateRoot: string;
	deployedShaFile?: string;
	rayaHome?: string;
	windowId?: string;
	frozenPayloadDigest?: string;
	authorization?: Omit<AuthorizationRef, "authorizedPayloadDigest">;
	expectPreflight?: string;
}

interface GatePaths {
	stateRoot: string;
	stateDir: string;
	receipt: string;
	evidence: string;
	execution: string;
}

interface BaseContext {
	args: ParsedGateArgs;
	database: DatabaseIdentity;
	workspaceCanonicalPath: string;
	paths: GatePaths;
}

interface AuthorizedContext extends BaseContext {
	rayaHome: string;
	deployedSha: string;
	workspaceIdentityDigest: string;
	issuer: M0ReceiptV1["issuer"];
	migrationModuleSha256: string;
}

interface PreflightMaterial {
	authorizedPayloadDigest: string;
	payload: JsonObject;
}

interface StoredFile<T> {
	value: T;
	bytes: string;
	digest: string;
}

interface GateDependencies {
	toolFiles?: { gate: string; migration: string };
	now?: () => number;
	io?: MigrationIO;
	hooks?: {
		beforeWriteDatabase?: () => void;
		beforeFinalReadonly?: () => void;
	};
}

export interface RayaSummaryPresentationGateResult {
	exitCode: 0 | 1 | 2;
	output: JsonObject;
}

class GateError extends Error {
	constructor(
		readonly code: string,
		readonly exitCode: 1 | 2 = 1,
	) {
		super(code);
	}
}

function fail(code: string, exitCode: 1 | 2 = 1): never {
	throw new GateError(code, exitCode);
}

function sha256(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as JsonObject)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function canonicalDigest(value: unknown): string {
	return sha256(canonicalJson(value));
}

function exactKeys(value: JsonObject, keys: string[], code: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, i) => key !== expected[i])
	) {
		fail(code);
	}
}

function objectValue(value: unknown, code: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
	return value as JsonObject;
}

function stringValue(value: unknown, code: string): string {
	if (typeof value !== "string" || value.length === 0) fail(code);
	return value;
}

function safeInteger(value: unknown, code: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code);
	return Number(value);
}

function sameValue(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function isoTime(ms: number): string {
	if (!Number.isSafeInteger(ms) || ms < 0) fail("invalid_clock");
	return new Date(ms).toISOString();
}

function timestampValue(value: unknown, nowMs: number, code: string): number {
	if (typeof value !== "string") fail(code);
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < 0 ||
		new Date(parsed).toISOString() !== value ||
		parsed > nowMs
	) {
		fail(code);
	}
	return parsed;
}

const SHARED_FLAGS = [
	"--db",
	"--workspace",
	"--project",
	"--lead",
	"--ledger",
	"--decisions",
	"--max-rows",
] as const;
const PATH_FLAGS = new Set([
	"--db",
	"--workspace",
	"--ledger",
	"--decisions",
	"--state-root",
	"--deployed-sha-file",
	"--raya-home",
]);
const ALL_FLAGS = new Set([
	...SHARED_FLAGS,
	"--state-root",
	"--deployed-sha-file",
	"--raya-home",
	"--window-id",
	"--frozen-payload-digest",
	"--authorization-channel-id",
	"--authorization-message-id",
	"--authorization-author-id",
	"--authorization-content-sha256",
	"--expect-preflight",
]);

function parsePairs(argv: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
			fail("invalid_arguments");
		}
		if (!ALL_FLAGS.has(flag)) fail(`unknown_argument:${flag}`);
		if (values.has(flag)) fail(`duplicate_argument:${flag}`);
		values.set(flag, value);
	}
	return values;
}

function required(values: Map<string, string>, flag: string): string {
	const value = values.get(flag)?.trim();
	if (!value) fail(`missing_argument:${flag}`);
	return value;
}

function validateShape(
	values: Map<string, string>,
	flag: string,
	pattern: RegExp,
): string {
	const value = required(values, flag);
	if (!pattern.test(value)) fail(`invalid_argument:${flag}`);
	return value;
}

function parseArgs(argv: string[]): ParsedGateArgs {
	const command = argv[0];
	if (
		!(["preflight", "verify", "execute"] as string[]).includes(command ?? "")
	) {
		fail("invalid_subcommand");
	}
	const values = parsePairs(argv.slice(1));
	const projectName = required(values, "--project");
	const leadId = required(values, "--lead");
	if (projectName !== "raya" || leadId !== "raya") fail("identity_not_allowed");

	for (const [flag, value] of values) {
		if (PATH_FLAGS.has(flag) && !isAbsolute(value)) {
			fail(`path_not_absolute:${flag}`);
		}
	}
	for (const flag of ["--db", "--workspace", "--state-root"])
		required(values, flag);
	const sharedArgv: string[] = [];
	for (const flag of SHARED_FLAGS) {
		const value = values.get(flag);
		if (value !== undefined) sharedArgv.push(flag, value);
	}
	let shared: RayaSummaryPresentationMigrationArgs;
	try {
		shared = parseRayaSummaryPresentationMigrationArgs(sharedArgv);
	} catch (error) {
		fail((error as Error).message);
	}
	const result: ParsedGateArgs = {
		command: command as GateCommand,
		shared,
		stateRoot: required(values, "--state-root"),
	};
	if (command === "preflight" || command === "execute") {
		result.deployedShaFile = required(values, "--deployed-sha-file");
		result.rayaHome = required(values, "--raya-home");
		result.windowId = validateShape(values, "--window-id", WINDOW_PATTERN);
		result.frozenPayloadDigest = validateShape(
			values,
			"--frozen-payload-digest",
			SHA256_PATTERN,
		);
	}
	if (command === "execute") {
		result.authorization = {
			channelId: validateShape(
				values,
				"--authorization-channel-id",
				SNOWFLAKE_PATTERN,
			),
			messageId: validateShape(
				values,
				"--authorization-message-id",
				SNOWFLAKE_PATTERN,
			),
			authorId: validateShape(
				values,
				"--authorization-author-id",
				SNOWFLAKE_PATTERN,
			),
			contentSha256: validateShape(
				values,
				"--authorization-content-sha256",
				SHA256_PATTERN,
			),
		};
		result.expectPreflight = validateShape(
			values,
			"--expect-preflight",
			SHA256_PATTERN,
		);
	}
	return result;
}

function assertDirectory(path: string, code: string): string {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
		return realpathSync(path);
	} catch (error) {
		if (error instanceof GateError) throw error;
		return fail(code);
	}
}

function assertDirectoryChain(
	root: string,
	segments: readonly string[],
	code: string,
): string {
	let current = root;
	try {
		for (const segment of segments) {
			current = join(current, segment);
			const stat = lstatSync(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
		}
		return realpathSync(current);
	} catch (error) {
		if (error instanceof GateError) throw error;
		return fail(code);
	}
}

function databaseIdentity(path: string): DatabaseIdentity {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) fail("db_invalid");
		const canonicalPath = realpathSync(path);
		const canonicalStat = lstatSync(canonicalPath);
		if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) {
			fail("db_invalid");
		}
		return {
			canonicalPath,
			device: String(canonicalStat.dev),
			inode: String(canonicalStat.ino),
		};
	} catch (error) {
		if (error instanceof GateError) throw error;
		return fail("db_invalid");
	}
}

function assertDatabaseIdentity(
	expected: DatabaseIdentity,
	path: string,
): void {
	if (!sameValue(expected, databaseIdentity(path))) fail("db_identity_changed");
}

function readRegular(
	path: string,
	maxBytes: number,
	requirePrivateMode: boolean,
	code: string,
): Buffer {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.size > maxBytes ||
			(requirePrivateMode && (stat.mode & 0o077) !== 0)
		) {
			fail(code);
		}
		return readFileSync(fd);
	} catch (error) {
		if (error instanceof GateError) throw error;
		return fail(code);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function readOptional(
	path: string,
	maxBytes: number,
	code: string,
): { bytes: string; digest: string } | null {
	if (!existsSync(path)) return null;
	const bytes = readRegular(path, maxBytes, true, code).toString("utf8");
	return { bytes, digest: sha256(bytes) };
}

function prepareBaseContext(args: ParsedGateArgs): BaseContext {
	const workspaceCanonicalPath = assertDirectory(
		args.shared.workspaceRoot,
		"workspace_invalid",
	);
	const stateRoot = assertDirectory(args.stateRoot, "state_root_invalid");
	const stateDir = assertDirectoryChain(
		stateRoot,
		["state", "lead-persona", "raya", "raya"],
		"state_dir_missing",
	);
	return {
		args,
		database: databaseIdentity(args.shared.dbPath),
		workspaceCanonicalPath,
		paths: {
			stateRoot,
			stateDir,
			receipt: join(stateDir, "m0-receipt.json"),
			evidence: join(stateDir, "m0-dispositions.jsonl"),
			execution: join(stateDir, "m0-execution.json"),
		},
	};
}

function prepareAuthorizedContext(
	args: ParsedGateArgs,
	toolFiles: { gate: string; migration: string },
): AuthorizedContext {
	const base = prepareBaseContext(args);
	const rayaHome = assertDirectory(args.rayaHome!, "raya_home_invalid");
	const deployedSha = readRegular(
		args.deployedShaFile!,
		DEPLOYED_SHA_MAX_BYTES,
		false,
		"deployed_sha_invalid",
	)
		.toString("utf8")
		.trim();
	if (!COMMIT_PATTERN.test(deployedSha)) fail("deployed_sha_invalid");
	const personaDir = assertDirectoryChain(
		base.workspaceCanonicalPath,
		[".lead", "raya"],
		"persona_invalid",
	);
	const persona = readRegular(
		join(personaDir, "identity.md"),
		PERSONA_MAX_BYTES,
		false,
		"persona_invalid",
	);
	const gateBytes = readRegular(
		toolFiles.gate,
		TOOL_MAX_BYTES,
		false,
		"tool_file_missing",
	);
	const migrationBytes = readRegular(
		toolFiles.migration,
		TOOL_MAX_BYTES,
		false,
		"tool_file_missing",
	);
	return {
		...base,
		rayaHome,
		deployedSha,
		workspaceIdentityDigest: sha256(persona),
		issuer: {
			kind: "flywheel-m0-wrapper",
			toolPath: realpathSync(toolFiles.gate),
			toolBlobSha256: sha256(gateBytes),
			deployedSha,
		},
		migrationModuleSha256: sha256(migrationBytes),
	};
}

function openReadonly(path: string): BetterDb {
	try {
		return new BetterSqlite3(path, { readonly: true, fileMustExist: true });
	} catch {
		fail("db_invalid");
	}
}

function resolveInputs(
	db: BetterDb,
	context: BaseContext,
	existing: SummaryPresentationMigration | null,
): ResolvedSummaryPresentationMigrationInputs {
	try {
		return resolveSummaryPresentationMigrationInputs(
			{
				store: new SummaryPresentationStore(db),
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: context.workspaceCanonicalPath,
				...(context.args.shared.ledgerPath
					? { ledgerPath: context.args.shared.ledgerPath }
					: {}),
				...(context.args.shared.decisionsPath
					? { decisionsPath: context.args.shared.decisionsPath }
					: {}),
			},
			existing,
		);
	} catch (error) {
		if (error instanceof GateError) throw error;
		fail((error as Error).message);
	}
}

function preflightMaterial(
	context: AuthorizedContext,
	resolved: ResolvedSummaryPresentationMigrationInputs,
): PreflightMaterial {
	const payload: JsonObject = {
		windowId: context.args.windowId!,
		frozenPayloadDigest: context.args.frozenPayloadDigest!,
		projectName: "raya",
		leadId: "raya",
		summaryContractVersion: SUMMARY_PRESENTATION_CONTRACT_VERSION,
		database: context.database,
		workspaceCanonicalPath: context.workspaceCanonicalPath,
		workspaceIdentityDigest: context.workspaceIdentityDigest,
		sources: {
			ledgerPath: resolved.ledgerPath,
			decisionsPath: resolved.decisionsPath,
		},
		stateRoot: context.paths.stateRoot,
		receiptPath: context.paths.receipt,
		evidencePath: context.paths.evidence,
		lock: {
			rayaHome: context.rayaHome,
			lockTarget: join(context.rayaHome, "deploy.lock.d"),
		},
		migration: {
			migration_boundary_seq: resolved.boundarySeq,
			sourceDigests: resolved.sourceDigests,
			journalRounds: resolved.journal.length,
		},
		issuer: context.issuer,
		migrationModuleSha256: context.migrationModuleSha256,
	};
	return { authorizedPayloadDigest: canonicalDigest(payload), payload };
}

function parseJsonFile<T>(bytes: string, code: string): T {
	try {
		return objectValue(JSON.parse(bytes) as unknown, code) as T;
	} catch (error) {
		if (error instanceof GateError) throw error;
		fail(code);
	}
}

function parseExecution(bytes: string): ExecutionRecord {
	const value = parseJsonFile<JsonObject>(bytes, "execution_record_conflict");
	exactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"windowId",
			"mode",
			"authorizedPayloadDigest",
			"authorization",
			"startedAt",
			"schemaAdoption",
			"planned",
		],
		"execution_record_conflict",
	);
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "raya-summary-presentation-m0-execution" ||
		(value.mode !== "executed" && value.mode !== "adopted-legacy") ||
		typeof value.windowId !== "string" ||
		!WINDOW_PATTERN.test(value.windowId) ||
		!SHA256_PATTERN.test(String(value.authorizedPayloadDigest)) ||
		typeof value.startedAt !== "string"
	) {
		fail("execution_record_conflict");
	}
	const authorization = objectValue(
		value.authorization,
		"execution_record_conflict",
	);
	exactKeys(
		authorization,
		["channelId", "messageId", "authorId", "contentSha256"],
		"execution_record_conflict",
	);
	if (
		![
			authorization.channelId,
			authorization.messageId,
			authorization.authorId,
		].every(
			(entry) => typeof entry === "string" && SNOWFLAKE_PATTERN.test(entry),
		) ||
		typeof authorization.contentSha256 !== "string" ||
		!SHA256_PATTERN.test(authorization.contentSha256)
	) {
		fail("execution_record_conflict");
	}
	if (value.schemaAdoption !== null) {
		const adoption = objectValue(
			value.schemaAdoption,
			"execution_record_conflict",
		);
		exactKeys(adoption, ["source", "adoptedAt"], "execution_record_conflict");
		if (
			adoption.source !== "updated_at_ms" ||
			typeof adoption.adoptedAt !== "string"
		) {
			fail("execution_record_conflict");
		}
	}
	if (value.planned !== null) {
		const planned = objectValue(value.planned, "execution_record_conflict");
		exactKeys(
			planned,
			["receiptId", "dispositionDigest", "completedAt"],
			"execution_record_conflict",
		);
		if (
			typeof planned.receiptId !== "string" ||
			!SHA256_PATTERN.test(planned.receiptId) ||
			typeof planned.dispositionDigest !== "string" ||
			!SHA256_PATTERN.test(planned.dispositionDigest) ||
			typeof planned.completedAt !== "string"
		) {
			fail("execution_record_conflict");
		}
	}
	return value as unknown as ExecutionRecord;
}

function readExecution(path: string): StoredFile<ExecutionRecord> | null {
	const stored = readOptional(
		path,
		EXECUTION_MAX_BYTES,
		"execution_record_conflict",
	);
	return stored ? { ...stored, value: parseExecution(stored.bytes) } : null;
}

function parseFrozenRow(value: unknown): FrozenRow {
	const row = objectValue(value, "receipt_conflict");
	exactKeys(
		row,
		["sourceSeq", "roundId", "sourceDigest", "disposition", "evidenceRef"],
		"receipt_conflict",
	);
	const disposition = stringValue(row.disposition, "receipt_conflict");
	if (!(DISPOSITIONS as readonly string[]).includes(disposition)) {
		fail("receipt_conflict");
	}
	if (
		typeof row.roundId !== "string" ||
		!row.roundId ||
		typeof row.sourceDigest !== "string" ||
		!SHA256_PATTERN.test(row.sourceDigest) ||
		!(row.evidenceRef === null || typeof row.evidenceRef === "string")
	) {
		fail("receipt_conflict");
	}
	return {
		sourceSeq: safeInteger(row.sourceSeq, "receipt_conflict"),
		roundId: row.roundId,
		sourceDigest: row.sourceDigest,
		disposition: disposition as SummaryPresentationRoundDisposition,
		evidenceRef: row.evidenceRef as string | null,
	};
}

function parseEvidence(bytes: string): FrozenRow[] {
	const rows: FrozenRow[] = [];
	for (const raw of bytes.split(/\r?\n/u)) {
		if (!raw) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			fail("receipt_conflict");
		}
		const row = parseFrozenRow(parsed);
		if (raw !== canonicalJson(row)) fail("receipt_conflict");
		rows.push(row);
	}
	return rows;
}

function readEvidence(path: string): StoredFile<FrozenRow[]> | null {
	const stored = readOptional(path, EVIDENCE_MAX_BYTES, "receipt_conflict");
	return stored ? { ...stored, value: parseEvidence(stored.bytes) } : null;
}

function parseReceipt(bytes: string, nowMs: number): M0ReceiptV1 {
	const receipt = parseJsonFile<JsonObject>(bytes, "receipt_malformed");
	exactKeys(
		receipt,
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
		"receipt_malformed",
	);
	if (
		receipt.schemaVersion !== 1 ||
		receipt.kind !== "raya-summary-presentation-m0" ||
		(receipt.mode !== "executed" && receipt.mode !== "adopted-legacy") ||
		typeof receipt.receiptId !== "string" ||
		!SHA256_PATTERN.test(receipt.receiptId) ||
		typeof receipt.windowId !== "string" ||
		!WINDOW_PATTERN.test(receipt.windowId) ||
		receipt.projectName !== "raya" ||
		receipt.leadId !== "raya" ||
		receipt.summaryContractVersion !== 2 ||
		receipt.state !== "complete" ||
		typeof receipt.workspaceCanonicalPath !== "string" ||
		!isAbsolute(receipt.workspaceCanonicalPath) ||
		typeof receipt.workspaceIdentityDigest !== "string" ||
		!SHA256_PATTERN.test(receipt.workspaceIdentityDigest) ||
		typeof receipt.dispositionDigest !== "string" ||
		!SHA256_PATTERN.test(receipt.dispositionDigest) ||
		typeof receipt.completedAt !== "string" ||
		typeof receipt.generatedAt !== "string"
	) {
		fail("receipt_malformed");
	}
	for (const key of [
		"database",
		"sourceDigests",
		"dispositions",
		"issuer",
		"executionAuthorization",
	]) {
		objectValue(receipt[key], "receipt_malformed");
	}
	const database = receipt.database as JsonObject;
	exactKeys(
		database,
		["canonicalPath", "device", "inode"],
		"receipt_malformed",
	);
	if (
		![database.canonicalPath, database.device, database.inode].every(
			(value) => typeof value === "string" && value.length > 0,
		) ||
		!isAbsolute(String(database.canonicalPath))
	) {
		fail("receipt_malformed");
	}
	const sourceDigests = receipt.sourceDigests as JsonObject;
	exactKeys(
		sourceDigests,
		["journal", "legacyLedger", "migrationDecisions"],
		"receipt_malformed",
	);
	if (
		!Object.values(sourceDigests).every(
			(v) => typeof v === "string" && SHA256_PATTERN.test(v),
		)
	) {
		fail("receipt_malformed");
	}
	const dispositions = receipt.dispositions as JsonObject;
	exactKeys(dispositions, [...DISPOSITIONS], "receipt_malformed");
	for (const key of DISPOSITIONS)
		safeInteger(dispositions[key], "receipt_malformed");
	const issuer = receipt.issuer as JsonObject;
	exactKeys(
		issuer,
		["kind", "toolPath", "toolBlobSha256", "deployedSha"],
		"receipt_malformed",
	);
	if (
		issuer.kind !== "flywheel-m0-wrapper" ||
		typeof issuer.toolPath !== "string" ||
		!isAbsolute(issuer.toolPath) ||
		typeof issuer.toolBlobSha256 !== "string" ||
		!SHA256_PATTERN.test(issuer.toolBlobSha256) ||
		typeof issuer.deployedSha !== "string" ||
		!COMMIT_PATTERN.test(issuer.deployedSha)
	) {
		fail("receipt_malformed");
	}
	const authorization = receipt.executionAuthorization as JsonObject;
	exactKeys(
		authorization,
		[
			"channelId",
			"messageId",
			"authorId",
			"contentSha256",
			"authorizedPayloadDigest",
		],
		"receipt_malformed",
	);
	if (
		![
			authorization.channelId,
			authorization.messageId,
			authorization.authorId,
		].every((v) => typeof v === "string" && SNOWFLAKE_PATTERN.test(v)) ||
		typeof authorization.contentSha256 !== "string" ||
		!SHA256_PATTERN.test(authorization.contentSha256) ||
		typeof authorization.authorizedPayloadDigest !== "string" ||
		!SHA256_PATTERN.test(authorization.authorizedPayloadDigest)
	) {
		fail("receipt_malformed");
	}
	safeInteger(receipt.migration_boundary_seq, "receipt_malformed");
	safeInteger(receipt.cursor_seq, "receipt_malformed");
	safeInteger(receipt.verifiedRowCount, "receipt_malformed");
	timestampValue(receipt.completedAt, nowMs, "receipt_malformed");
	timestampValue(receipt.generatedAt, nowMs, "receipt_malformed");
	const {
		receiptId: _receiptId,
		generatedAt: _generatedAt,
		...identity
	} = receipt;
	if (canonicalDigest(identity) !== receipt.receiptId)
		fail("receipt_malformed");
	return receipt as M0ReceiptV1;
}

function readReceipt(
	path: string,
	nowMs: number,
): StoredFile<M0ReceiptV1> | null {
	const stored = readOptional(path, RECEIPT_MAX_BYTES, "receipt_malformed");
	return stored
		? { ...stored, value: parseReceipt(stored.bytes, nowMs) }
		: null;
}

function emptyDispositionCounts(): Record<
	SummaryPresentationRoundDisposition,
	number
> {
	return {
		eligible: 0,
		claimed: 0,
		historical_presented: 0,
		historical_silent: 0,
		needs_reconciliation: 0,
	};
}

function verifyCurrent(
	db: BetterDb,
	existing: SummaryPresentationMigration | null,
	resolved: ResolvedSummaryPresentationMigrationInputs,
	options: { allowMissingCompletedAt?: boolean } = {},
): Verification {
	if (!existing) fail("migration_missing", 2);
	if (existing.state !== "complete") fail("migration_building", 2);
	if (existing.cursorSeq !== existing.boundarySeq)
		fail("migration_cursor_mismatch");
	if (existing.completedAtMs === null && !options.allowMissingCompletedAt) {
		fail("completed_at_missing");
	}
	for (const key of [
		"journal",
		"legacyLedger",
		"migrationDecisions",
	] as const) {
		if (resolved.sourceDigests[key] !== existing.sourceDigests[key]) {
			fail(`source_digest_drift:${key}`);
		}
	}
	const store = new SummaryPresentationStore(db);
	const frozenRows: FrozenRow[] = [];
	const dispositions = emptyDispositionCounts();
	for (const journal of resolved.journal) {
		const round = store.getRound("raya", "raya", journal.roundId);
		if (!round) fail(`round_missing:${journal.sourceSeq}`);
		if (round.sourceSeq !== journal.sourceSeq) {
			fail(`round_seq_mismatch:${journal.sourceSeq}`);
		}
		if (round.sourceDigest !== journal.sourceDigest) {
			fail(`round_digest_mismatch:${journal.sourceSeq}`);
		}
		let expected: {
			disposition: Exclude<SummaryPresentationRoundDisposition, "claimed">;
			evidenceRef: string | null;
		};
		let payload: JsonObject;
		try {
			payload = objectValue(
				JSON.parse(journal.payload) as unknown,
				`round_payload_invalid:${journal.sourceSeq}`,
			);
		} catch (error) {
			if (error instanceof GateError) throw error;
			fail(`round_payload_invalid:${journal.sourceSeq}`);
		}
		const classifyExpected = () => {
			try {
				return classifyRound({
					roundId: journal.roundId,
					ledgerRows: resolved.ledger.rows,
					decisionRows: resolved.decisions.rows,
					ledgerMalformed: resolved.ledger.malformed.length > 0,
				});
			} catch (error) {
				fail((error as Error).message);
			}
		};
		if (
			payload.contract_version === SUMMARY_PRESENTATION_CONTRACT_VERSION &&
			["eligible", "claimed"].includes(round.disposition)
		) {
			expected =
				round.disposition === "eligible" && round.evidenceRef !== null
					? classifyExpected()
					: { disposition: "eligible", evidenceRef: null };
		} else {
			expected = classifyExpected();
		}
		if (
			round.disposition !== expected.disposition &&
			!(expected.disposition === "eligible" && round.disposition === "claimed")
		) {
			fail(
				`round_disposition_mismatch:${journal.sourceSeq}:${expected.disposition}:${round.disposition}`,
			);
		}
		if (
			round.disposition !== "claimed" &&
			round.evidenceRef !== expected.evidenceRef
		) {
			fail(
				`round_disposition_mismatch:${journal.sourceSeq}:${expected.disposition}:${round.disposition}`,
			);
		}
		if (round.disposition === "claimed") {
			const member = store.getMemberByRound("raya", "raya", journal.roundId);
			const group = member ? store.getGroup(member.groupId) : null;
			if (
				!member ||
				member.sourceSeq !== round.sourceSeq ||
				!group ||
				group.projectName !== "raya" ||
				group.leadId !== "raya" ||
				!(GROUP_STATES as readonly string[]).includes(group.state)
			) {
				fail(`claimed_reference_invalid:${journal.sourceSeq}`);
			}
		}
		frozenRows.push({
			sourceSeq: round.sourceSeq,
			roundId: round.roundId,
			sourceDigest: round.sourceDigest,
			disposition: round.disposition,
			evidenceRef: round.evidenceRef,
		});
		dispositions[round.disposition] += 1;
	}
	const count = db
		.prepare(
			`SELECT COUNT(*) AS count FROM summary_presentation_rounds
			 WHERE project_name = ? AND lead_id = ? AND source_seq <= ?`,
		)
		.get("raya", "raya", existing.boundarySeq) as { count: number };
	if (count.count !== resolved.journal.length) {
		fail(`round_orphan:${count.count - resolved.journal.length}`);
	}
	frozenRows.sort(
		(left, right) =>
			left.sourceSeq - right.sourceSeq ||
			left.roundId.localeCompare(right.roundId),
	);
	return {
		migration: existing,
		frozenRows,
		dispositions,
		verifiedRowCount: frozenRows.length,
		dispositionDigest: canonicalDigest(frozenRows),
	};
}

function verifyReceipt(
	receipt: M0ReceiptV1,
	evidence: FrozenRow[],
	current: Verification,
	context: BaseContext,
): void {
	if (
		!sameValue(receipt.database, context.database) ||
		receipt.migration_boundary_seq !== current.migration.boundarySeq ||
		receipt.cursor_seq !== current.migration.cursorSeq ||
		!sameValue(receipt.sourceDigests, current.migration.sourceDigests) ||
		receipt.completedAt !== isoTime(current.migration.completedAtMs!) ||
		receipt.verifiedRowCount !== evidence.length ||
		receipt.verifiedRowCount !== current.verifiedRowCount ||
		receipt.dispositionDigest !== canonicalDigest(evidence)
	) {
		fail("receipt_conflict");
	}
	const frozenCounts = emptyDispositionCounts();
	for (const row of evidence) frozenCounts[row.disposition] += 1;
	if (!sameValue(frozenCounts, receipt.dispositions)) fail("receipt_conflict");
	for (let index = 0; index < evidence.length; index += 1) {
		const frozen = evidence[index]!;
		const now = current.frozenRows[index]!;
		if (
			frozen.sourceSeq !== now.sourceSeq ||
			frozen.roundId !== now.roundId ||
			frozen.sourceDigest !== now.sourceDigest ||
			frozen.evidenceRef !== now.evidenceRef ||
			(frozen.disposition !== now.disposition &&
				!(frozen.disposition === "eligible" && now.disposition === "claimed"))
		) {
			fail("receipt_conflict");
		}
	}
	for (const key of [
		"historical_presented",
		"historical_silent",
		"needs_reconciliation",
	] as const) {
		if (frozenCounts[key] !== current.dispositions[key])
			fail("receipt_conflict");
	}
	if (
		current.dispositions.claimed < frozenCounts.claimed ||
		frozenCounts.eligible !==
			current.dispositions.eligible +
				(current.dispositions.claimed - frozenCounts.claimed)
	) {
		fail("receipt_conflict");
	}
	if (receipt.mode === "executed" && frozenCounts.claimed !== 0) {
		fail("receipt_conflict");
	}
}

function previewFrozenRows(
	db: BetterDb,
	resolved: ResolvedSummaryPresentationMigrationInputs,
): FrozenRow[] {
	const store = new SummaryPresentationStore(db);
	return resolved.journal
		.map((journal): FrozenRow => {
			const confirmed = store.getRound("raya", "raya", journal.roundId);
			let payload: JsonObject;
			try {
				payload = objectValue(
					JSON.parse(journal.payload) as unknown,
					"round_payload_invalid",
				);
			} catch (error) {
				if (error instanceof GateError) throw error;
				fail("round_payload_invalid");
			}
			let disposition: SummaryPresentationRoundDisposition;
			let evidenceRef: string | null;
			if (
				confirmed?.disposition === "eligible" &&
				payload.contract_version === SUMMARY_PRESENTATION_CONTRACT_VERSION
			) {
				disposition = "eligible";
				evidenceRef = null;
			} else if (
				confirmed &&
				["historical_presented", "historical_silent"].includes(
					confirmed.disposition,
				)
			) {
				disposition = confirmed.disposition;
				evidenceRef = confirmed.evidenceRef;
			} else if (confirmed?.disposition === "claimed") {
				disposition = "claimed";
				evidenceRef = confirmed.evidenceRef;
			} else {
				try {
					const classified = classifyRound({
						roundId: journal.roundId,
						ledgerRows: resolved.ledger.rows,
						decisionRows: resolved.decisions.rows,
						ledgerMalformed: resolved.ledger.malformed.length > 0,
					});
					disposition = classified.disposition;
					evidenceRef = classified.evidenceRef;
				} catch (error) {
					fail((error as Error).message);
				}
			}
			return {
				sourceSeq: journal.sourceSeq,
				roundId: journal.roundId,
				sourceDigest: journal.sourceDigest,
				disposition,
				evidenceRef,
			};
		})
		.sort(
			(left, right) =>
				left.sourceSeq - right.sourceSeq ||
				left.roundId.localeCompare(right.roundId),
		);
}

function assertProspectiveSizes(
	db: BetterDb,
	context: AuthorizedContext,
	resolved: ResolvedSummaryPresentationMigrationInputs,
	existing: SummaryPresentationMigration | null,
	execution: ExecutionRecord,
	nowMs: number,
): void {
	const frozenRows = previewFrozenRows(db, resolved);
	if (Buffer.byteLength(evidenceBytes(frozenRows)) > EVIDENCE_MAX_BYTES) {
		fail("evidence_too_large");
	}
	const dispositions = emptyDispositionCounts();
	for (const row of frozenRows) dispositions[row.disposition] += 1;
	const completedAtMs = existing?.completedAtMs ?? 0;
	const migration: SummaryPresentationMigration = {
		projectName: "raya",
		leadId: "raya",
		boundarySeq: resolved.boundarySeq,
		sourceDigests: resolved.sourceDigests,
		cursorSeq: resolved.boundarySeq,
		state: "complete",
		completedAtMs,
	};
	const receipt = buildReceipt(
		context,
		execution,
		{
			migration,
			frozenRows,
			dispositions,
			verifiedRowCount: frozenRows.length,
			dispositionDigest: canonicalDigest(frozenRows),
		},
		nowMs,
	);
	if (Buffer.byteLength(`${JSON.stringify(receipt)}\n`) > RECEIPT_MAX_BYTES) {
		fail("receipt_too_large");
	}
}

function evidenceBytes(rows: FrozenRow[]): string {
	return (
		rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "")
	);
}

function atomicText(
	path: string,
	bytes: string,
	expected: string | null,
): void {
	const current = readOptional(path, EVIDENCE_MAX_BYTES, "write-conflict");
	if (current?.bytes === bytes) return;
	if ((current?.digest ?? null) !== expected) fail("write-conflict");
	const temporary = `${path}.tmp.${randomUUID()}`;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const second = readOptional(path, EVIDENCE_MAX_BYTES, "write-conflict");
		if ((second?.digest ?? null) !== expected) fail("write-conflict");
		renameSync(temporary, path);
		const directory = openSync(dirname(path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

function writeJsonStable(
	path: string,
	value: unknown,
	expected: string | null,
	maxBytes: number,
): void {
	const bytes = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(bytes) > maxBytes) {
		fail(
			path.endsWith("m0-receipt.json")
				? "receipt_too_large"
				: "evidence_too_large",
		);
	}
	const current = readOptional(path, maxBytes, "write-conflict");
	if (current?.bytes === bytes) return;
	try {
		atomicJson(path, value, expected);
	} catch (error) {
		fail((error as Error).message);
	}
}

function validateExecution(
	record: ExecutionRecord,
	context: AuthorizedContext,
	mode?: GateMode,
): void {
	const expectedAuthorization = context.args.authorization!;
	if (
		record.windowId !== context.args.windowId ||
		record.authorizedPayloadDigest !== context.args.expectPreflight ||
		(mode !== undefined && record.mode !== mode) ||
		!sameValue(record.authorization, expectedAuthorization)
	) {
		fail("execution_record_conflict");
	}
}

function newExecution(
	context: AuthorizedContext,
	mode: GateMode,
	nowMs: number,
): ExecutionRecord {
	return {
		schemaVersion: 1,
		kind: "raya-summary-presentation-m0-execution",
		windowId: context.args.windowId!,
		mode,
		authorizedPayloadDigest: context.args.expectPreflight!,
		authorization: context.args.authorization!,
		startedAt: isoTime(nowMs),
		schemaAdoption: null,
		planned: null,
	};
}

function writeExecution(
	context: AuthorizedContext,
	record: ExecutionRecord,
	expected: string | null,
): StoredFile<ExecutionRecord> {
	writeJsonStable(
		context.paths.execution,
		record,
		expected,
		EXECUTION_MAX_BYTES,
	);
	return readExecution(context.paths.execution)!;
}

function buildReceipt(
	context: AuthorizedContext,
	execution: ExecutionRecord,
	verification: Verification,
	nowMs: number,
): M0ReceiptV1 {
	const migration = verification.migration;
	if (migration.completedAtMs === null) fail("completed_at_missing");
	if (migration.completedAtMs > nowMs) fail("completed_at_invalid");
	const withoutIdentity = {
		schemaVersion: 1 as const,
		kind: "raya-summary-presentation-m0" as const,
		mode: execution.mode,
		windowId: context.args.windowId!,
		projectName: "raya" as const,
		leadId: "raya" as const,
		database: context.database,
		workspaceCanonicalPath: context.workspaceCanonicalPath,
		workspaceIdentityDigest: context.workspaceIdentityDigest,
		summaryContractVersion: 2 as const,
		state: "complete" as const,
		migration_boundary_seq: migration.boundarySeq,
		cursor_seq: migration.cursorSeq,
		sourceDigests: migration.sourceDigests as M0ReceiptV1["sourceDigests"],
		dispositions: verification.dispositions,
		verifiedRowCount: verification.verifiedRowCount,
		dispositionDigest: verification.dispositionDigest,
		issuer: context.issuer,
		executionAuthorization: {
			...execution.authorization,
			authorizedPayloadDigest: execution.authorizedPayloadDigest,
		},
		completedAt: isoTime(migration.completedAtMs),
	};
	return {
		...withoutIdentity,
		receiptId: canonicalDigest(withoutIdentity),
		generatedAt: isoTime(nowMs),
	};
}

function assertPlanned(record: ExecutionRecord, receipt: M0ReceiptV1): void {
	const planned: PlannedIdentity = {
		receiptId: receipt.receiptId,
		dispositionDigest: receipt.dispositionDigest,
		completedAt: receipt.completedAt,
	};
	if (record.planned && !sameValue(record.planned, planned)) {
		fail("rebuild_identity_mismatch");
	}
}

function materialize(
	context: AuthorizedContext,
	recordFile: StoredFile<ExecutionRecord>,
	verification: Verification,
	nowMs: number,
	existing: {
		receipt: StoredFile<M0ReceiptV1> | null;
		evidence: StoredFile<FrozenRow[]> | null;
	},
): { receipt: M0ReceiptV1; recordFile: StoredFile<ExecutionRecord> } {
	const proposedReceipt = buildReceipt(
		context,
		recordFile.value,
		verification,
		nowMs,
	);
	assertPlanned(recordFile.value, proposedReceipt);
	if (existing.receipt) {
		const { generatedAt: _storedGeneratedAt, ...storedIdentity } =
			existing.receipt.value;
		const { generatedAt: _proposedGeneratedAt, ...proposedIdentity } =
			proposedReceipt;
		if (!sameValue(storedIdentity, proposedIdentity)) {
			fail("rebuild_identity_mismatch");
		}
	}
	const receipt = existing.receipt?.value ?? proposedReceipt;
	if (recordFile.value.planned === null) {
		recordFile = writeExecution(
			context,
			{
				...recordFile.value,
				planned: {
					receiptId: receipt.receiptId,
					dispositionDigest: receipt.dispositionDigest,
					completedAt: receipt.completedAt,
				},
			},
			recordFile.digest,
		);
	}
	const jsonl = evidenceBytes(verification.frozenRows);
	if (Buffer.byteLength(jsonl) > EVIDENCE_MAX_BYTES) fail("evidence_too_large");
	if (existing.evidence && existing.evidence.bytes !== jsonl) {
		fail("rebuild_identity_mismatch");
	}
	if (existing.receipt && !sameValue(existing.receipt.value, receipt)) {
		fail("rebuild_identity_mismatch");
	}
	if (!existing.evidence) atomicText(context.paths.evidence, jsonl, null);
	if (!existing.receipt) {
		writeJsonStable(context.paths.receipt, receipt, null, RECEIPT_MAX_BYTES);
	}
	const readbackEvidence = readEvidence(context.paths.evidence);
	const readbackReceipt = readReceipt(context.paths.receipt, nowMs);
	if (!readbackEvidence || !readbackReceipt) fail("evidence_incomplete");
	verifyReceipt(
		readbackReceipt.value,
		readbackEvidence.value,
		verification,
		context,
	);
	return { receipt: readbackReceipt.value, recordFile };
}

async function runPreflight(
	context: AuthorizedContext,
): Promise<RayaSummaryPresentationGateResult> {
	const db = openReadonly(context.args.shared.dbPath);
	try {
		const store = new SummaryPresentationStore(db);
		const existing = store.getMigration("raya", "raya");
		const resolved = resolveInputs(db, context, existing);
		const material = preflightMaterial(context, resolved);
		return {
			exitCode: 0,
			output: {
				status: "preflight",
				authorizedPayloadDigest: material.authorizedPayloadDigest,
				existingState: existing?.state ?? "missing",
				completedAtMsPresent: existing?.completedAtMs != null,
				...material.payload,
			},
		};
	} finally {
		db.close();
	}
}

async function runVerify(
	context: BaseContext,
	nowMs: number,
): Promise<RayaSummaryPresentationGateResult> {
	const db = openReadonly(context.args.shared.dbPath);
	try {
		const store = new SummaryPresentationStore(db);
		const existing = store.getMigration("raya", "raya");
		const resolved = resolveInputs(db, context, existing);
		const verification = verifyCurrent(db, existing, resolved);
		const receipt = readReceipt(context.paths.receipt, nowMs);
		const evidence = readEvidence(context.paths.evidence);
		if (!receipt && !evidence) fail("receipt_missing", 2);
		if (!receipt || !evidence) fail("evidence_incomplete");
		verifyReceipt(receipt.value, evidence.value, verification, context);
		return {
			exitCode: 0,
			output: {
				status: "unchanged",
				receiptId: receipt.value.receiptId,
				verifiedRowCount: verification.verifiedRowCount,
			},
		};
	} finally {
		db.close();
	}
}

async function executeLocked(
	context: AuthorizedContext,
	dependencies: Required<Pick<GateDependencies, "now" | "hooks">>,
): Promise<RayaSummaryPresentationGateResult> {
	const nowMs = dependencies.now();
	let executionFile = readExecution(context.paths.execution);
	const storedReceipt = readReceipt(context.paths.receipt, nowMs);
	const storedEvidence = readEvidence(context.paths.evidence);
	if (executionFile) validateExecution(executionFile.value, context);

	let readonly = openReadonly(context.args.shared.dbPath);
	let existing: SummaryPresentationMigration | null;
	let resolved: ResolvedSummaryPresentationMigrationInputs;
	try {
		const store = new SummaryPresentationStore(readonly);
		existing = store.getMigration("raya", "raya");
		resolved = resolveInputs(readonly, context, existing);
		const material = preflightMaterial(context, resolved);
		if (material.authorizedPayloadDigest !== context.args.expectPreflight) {
			fail("preflight_drift");
		}

		if (storedReceipt && storedEvidence) {
			const verification = verifyCurrent(readonly, existing, resolved);
			verifyReceipt(
				storedReceipt.value,
				storedEvidence.value,
				verification,
				context,
			);
			return {
				exitCode: 0,
				output: {
					status: "unchanged",
					receiptId: storedReceipt.value.receiptId,
				},
			};
		}
		if ((storedReceipt || storedEvidence) && !executionFile?.value.planned) {
			fail("evidence_incomplete");
		}
		if (!storedReceipt && !storedEvidence) {
			const mode =
				executionFile?.value.mode ??
				(existing?.state === "complete" ? "adopted-legacy" : "executed");
			assertProspectiveSizes(
				readonly,
				context,
				resolved,
				existing,
				executionFile?.value ?? newExecution(context, mode, nowMs),
				nowMs,
			);
		}
	} finally {
		readonly.close();
	}

	if (!existing || existing.state !== "complete") {
		if (executionFile && executionFile.value.mode !== "executed") {
			fail("execution_record_conflict");
		}
		if (!executionFile) {
			executionFile = writeExecution(
				context,
				newExecution(context, "executed", nowMs),
				null,
			);
		}
		dependencies.hooks.beforeWriteDatabase?.();
		assertDatabaseIdentity(context.database, context.args.shared.dbPath);
		const state = await StateStore.create(context.args.shared.dbPath);
		let result: ReturnType<typeof runSummaryPresentationMigration>;
		try {
			result = runSummaryPresentationMigration({
				store: state.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: context.workspaceCanonicalPath,
				...(context.args.shared.ledgerPath
					? { ledgerPath: context.args.shared.ledgerPath }
					: {}),
				...(context.args.shared.decisionsPath
					? { decisionsPath: context.args.shared.decisionsPath }
					: {}),
				...(context.args.shared.maxRows === undefined
					? {}
					: { maxRows: context.args.shared.maxRows }),
				nowMs,
				resolved,
			});
		} finally {
			state.close();
		}
		if (result.state !== "complete") fail("migration_building", 2);
	} else {
		readonly = openReadonly(context.args.shared.dbPath);
		try {
			verifyCurrent(readonly, existing, resolved, {
				allowMissingCompletedAt: true,
			});
		} finally {
			readonly.close();
		}
		if (!executionFile) {
			executionFile = writeExecution(
				context,
				newExecution(context, "adopted-legacy", nowMs),
				null,
			);
		}
		if (existing.completedAtMs === null) {
			dependencies.hooks.beforeWriteDatabase?.();
			assertDatabaseIdentity(context.database, context.args.shared.dbPath);
			const state = await StateStore.create(context.args.shared.dbPath);
			try {
				state.summaryPresentations.adoptMigrationCompletedAt("raya", "raya");
			} finally {
				state.close();
			}
			executionFile = writeExecution(
				context,
				{
					...executionFile.value,
					schemaAdoption: {
						source: "updated_at_ms",
						adoptedAt: isoTime(nowMs),
					},
				},
				executionFile.digest,
			);
		}
	}

	dependencies.hooks.beforeFinalReadonly?.();
	assertDatabaseIdentity(context.database, context.args.shared.dbPath);
	readonly = openReadonly(context.args.shared.dbPath);
	try {
		const store = new SummaryPresentationStore(readonly);
		existing = store.getMigration("raya", "raya");
		const finalResolved = resolveInputs(readonly, context, existing);
		const verification = verifyCurrent(readonly, existing, finalResolved);
		if (
			executionFile.value.mode === "executed" &&
			verification.dispositions.claimed !== 0 &&
			executionFile.value.planned === null
		) {
			fail("rebuild_after_consumption");
		}
		const materialized = materialize(
			context,
			executionFile,
			verification,
			nowMs,
			{ receipt: storedReceipt, evidence: storedEvidence },
		);
		return {
			exitCode: 0,
			output: {
				status: "complete",
				mode: materialized.receipt.mode,
				receiptId: materialized.receipt.receiptId,
				verifiedRowCount: materialized.receipt.verifiedRowCount,
			},
		};
	} finally {
		readonly.close();
	}
}

async function runExecute(
	args: ParsedGateArgs,
	toolFiles: { gate: string; migration: string },
	dependencies: Required<Pick<GateDependencies, "now" | "io" | "hooks">>,
): Promise<RayaSummaryPresentationGateResult> {
	const rayaHome = assertDirectory(args.rayaHome!, "raya_home_invalid");
	return withRayaDeployLock(rayaHome, dependencies.io, () => {
		const context = prepareAuthorizedContext(args, toolFiles);
		if (context.rayaHome !== rayaHome) fail("raya_home_invalid");
		return executeLocked(context, dependencies);
	});
}

export async function runRayaSummaryPresentationGate(
	argv: string[],
	dependencies: GateDependencies = {},
): Promise<RayaSummaryPresentationGateResult> {
	try {
		const args = parseArgs(argv);
		const toolFiles =
			dependencies.toolFiles ??
			({
				gate: fileURLToPath(import.meta.url),
				migration: fileURLToPath(
					new URL(
						"../bridge/summary-presentation-migration.js",
						import.meta.url,
					),
				),
			} satisfies NonNullable<GateDependencies["toolFiles"]>);
		const now = dependencies.now ?? Date.now;
		const hooks = dependencies.hooks ?? {};
		if (args.command === "verify") {
			return await runVerify(prepareBaseContext(args), now());
		}
		if (args.command === "preflight") {
			return await runPreflight(prepareAuthorizedContext(args, toolFiles));
		}
		return await runExecute(args, toolFiles, {
			now,
			io: dependencies.io ?? migrationIO,
			hooks,
		});
	} catch (error) {
		const gateError =
			error instanceof GateError
				? error
				: new GateError((error as Error).message || "unexpected_error");
		return {
			exitCode: gateError.exitCode,
			output:
				gateError.exitCode === 2
					? { status: gateError.code }
					: { status: "error", code: gateError.code },
		};
	}
}

async function main(): Promise<void> {
	const result = await runRayaSummaryPresentationGate(process.argv.slice(2));
	process.stdout.write(`${JSON.stringify(result.output)}\n`);
	if (result.exitCode === 1) {
		process.stderr.write(`${String(result.output.code)}\n`);
	}
	process.exitCode = result.exitCode;
}

if (process.argv[1]?.includes("raya-summary-presentation-gate")) {
	main().catch((error) => {
		process.stdout.write(
			`${JSON.stringify({ status: "error", code: (error as Error).message })}\n`,
		);
		process.stderr.write(`${(error as Error).message}\n`);
		process.exitCode = 1;
	});
}
