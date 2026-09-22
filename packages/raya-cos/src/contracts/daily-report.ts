import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface DailyReportTime {
	hour: number;
	minute: number;
}

const DAILY_REPORT_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseDailyReportTime(source: string): DailyReportTime {
	const match = DAILY_REPORT_TIME_PATTERN.exec(source);
	if (!match) {
		throw new Error("daily report time must use HH:MM (00:00-23:59)");
	}
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

function localDateParts(
	nowMs: number,
	timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
	if (!Number.isFinite(nowMs)) {
		throw new Error("daily report time source must be a finite timestamp");
	}
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
	} catch (error) {
		throw new Error(`invalid daily report time zone: ${timeZone}`, {
			cause: error,
		});
	}
	const values = new Map(
		formatter
			.formatToParts(new Date(nowMs))
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, Number(part.value)]),
	);
	const required = ["year", "month", "day", "hour", "minute"] as const;
	for (const key of required) {
		if (!Number.isInteger(values.get(key))) {
			throw new Error(`daily report time zone omitted ${key}: ${timeZone}`);
		}
	}
	return {
		year: values.get("year") as number,
		month: values.get("month") as number,
		day: values.get("day") as number,
		hour: values.get("hour") as number,
		minute: values.get("minute") as number,
	};
}

function isoDate(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dueReportDate(
	nowMs: number,
	timeZone: string,
	hhmm: string,
): string {
	const target = parseDailyReportTime(hhmm);
	const local = localDateParts(nowMs, timeZone);
	const isDueToday =
		local.hour > target.hour ||
		(local.hour === target.hour && local.minute >= target.minute);
	if (isDueToday) {
		return isoDate(local.year, local.month, local.day);
	}
	const previous = new Date(
		Date.UTC(local.year, local.month - 1, local.day - 1),
	);
	return isoDate(
		previous.getUTCFullYear(),
		previous.getUTCMonth() + 1,
		previous.getUTCDate(),
	);
}

export type DailyReportStatus =
	| "generating"
	| "generated"
	| "file_written"
	| "ingesting"
	| "ingested"
	| "posting"
	| "posted"
	| "posted_unknown"
	| "recovered_unknown"
	| "failed_pending_notice"
	| "failed";

export interface DailyReportAttempt {
	n: number;
	startedAt: string;
	endedAt?: string;
	category?: string;
}

export interface ReportSource {
	state: "open" | "merged";
	pr?: number;
	head: string;
	blob: string;
	path: string;
	project: string;
	lead: string;
	contract:
		| "ok"
		| `invalid:${
				| "frontmatter_missing"
				| "project_mismatch"
				| "lead_mismatch"
				| "period_unparseable"
				| "period_mismatch"
				| "facts_missing"
				| "judgment_missing"}`;
	bytes: number;
	truncated: boolean;
	omitted: boolean;
	divergent: boolean;
	also_in: string[];
}

export interface ReportSilent {
	project: string;
	last_summary: string;
}

export interface DailyReportState {
	v: 1;
	date: string;
	status: DailyReportStatus;
	nextEligibleAt?: number;
	gen?: { attempts: DailyReportAttempt[] };
	write?: { attempts: DailyReportAttempt[] };
	ingest?: {
		attempts: DailyReportAttempt[];
		result?: "ok" | "failed";
	};
	deliver?: {
		attempts: number;
		inFlight?: { index: number; sentAt: number };
	};
	failedNotice?: {
		attempts: number;
		inFlight?: { sentAt: number };
		messageId?: string;
		result?: "sent" | "unknown" | "undeliverable";
	};
	bodyFile?: string;
	bodySha256?: string;
	bodyBytes?: number;
	mainCommit?: string;
	sources?: ReportSource[];
	silent?: ReportSilent[];
	generationTurnKey?: string;
	fileSha?: string;
	commitSha?: string;
	adopted?: boolean;
	chunkPlan?: {
		catchUp: boolean;
		chunks: Array<{
			index: number;
			kind: "title" | "body" | "footer";
			sha256: string;
		}>;
	};
	messageIds?: Record<string, string>;
	receipts?: "unknown";
	failStage?: "generate" | "write" | "deliver";
	failCategory?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BODY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.body\.([0-9a-f]{64})\.md$/;
const DISCORD_ID_PATTERN = /^\d{17,20}$/;
const DAILY_REPORT_STATUSES = new Set<DailyReportStatus>([
	"generating",
	"generated",
	"file_written",
	"ingesting",
	"ingested",
	"posting",
	"posted",
	"posted_unknown",
	"recovered_unknown",
	"failed_pending_notice",
	"failed",
]);
const BODY_REQUIRED_STATUSES = new Set<DailyReportStatus>([
	"generated",
	"file_written",
	"ingesting",
	"ingested",
	"posting",
	"posted",
	"posted_unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStateKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	context: string,
): void {
	const keys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) {
			throw new Error(`${context} contains unknown key ${key}`);
		}
	}
}

function assertStateInteger(
	value: unknown,
	context: string,
	minimum = 0,
): asserts value is number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum) {
		throw new Error(`${context} must be a safe integer >= ${minimum}`);
	}
}

function assertStateTimestamp(value: unknown, context: string): void {
	if (
		typeof value !== "string" ||
		!value.includes("T") ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new Error(`${context} must be an ISO-8601 timestamp`);
	}
}

function assertAttemptSection(
	value: unknown,
	context: string,
	extraKeys: readonly string[] = [],
): void {
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	assertStateKeys(value, ["attempts", ...extraKeys], context);
	if (!Array.isArray(value.attempts)) {
		throw new Error(`${context}.attempts must be an array`);
	}
	value.attempts.forEach((attempt, index) => {
		if (!isRecord(attempt)) {
			throw new Error(`${context}.attempts[${index}] must be an object`);
		}
		assertStateKeys(
			attempt,
			["n", "startedAt", "endedAt", "category"],
			`${context}.attempts[${index}]`,
		);
		assertStateInteger(attempt.n, `${context}.attempts[${index}].n`, 1);
		if (attempt.n !== index + 1) {
			throw new Error(
				`${context}.attempts must use sequential attempt numbers`,
			);
		}
		assertStateTimestamp(
			attempt.startedAt,
			`${context}.attempts[${index}].startedAt`,
		);
		if (attempt.endedAt !== undefined) {
			assertStateTimestamp(
				attempt.endedAt,
				`${context}.attempts[${index}].endedAt`,
			);
		}
		if (
			attempt.category !== undefined &&
			(typeof attempt.category !== "string" || !attempt.category)
		) {
			throw new Error(`${context}.attempts[${index}].category is invalid`);
		}
	});
}

function assertBodyReference(
	value: Record<string, unknown>,
	expectedDate: string,
	required: boolean,
): void {
	const fields = [value.bodyFile, value.bodySha256, value.bodyBytes];
	if (!required && fields.every((field) => field === undefined)) return;
	if (
		typeof value.bodyFile !== "string" ||
		typeof value.bodySha256 !== "string" ||
		!SHA256_PATTERN.test(value.bodySha256) ||
		typeof value.bodyBytes !== "number" ||
		!Number.isSafeInteger(value.bodyBytes) ||
		value.bodyBytes < 1
	) {
		throw new Error("daily report state body reference is invalid");
	}
	const match = BODY_FILE_PATTERN.exec(value.bodyFile);
	if (match?.[1] !== expectedDate || match[2] !== value.bodySha256) {
		throw new Error("daily report state body file is outside its date or sha");
	}
}

function assertDailyReportStateShape(
	value: unknown,
	expectedDate: string,
): asserts value is DailyReportState {
	if (!isRecord(value) || value.v !== 1 || value.date !== expectedDate) {
		throw new Error("daily report state identity mismatch");
	}
	if (
		typeof value.status !== "string" ||
		!DAILY_REPORT_STATUSES.has(value.status as DailyReportStatus)
	) {
		throw new Error("daily report state status is invalid");
	}
	const status = value.status as DailyReportStatus;
	assertStateKeys(
		value,
		[
			"v",
			"date",
			"status",
			"nextEligibleAt",
			"gen",
			"write",
			"ingest",
			"deliver",
			"failedNotice",
			"bodyFile",
			"bodySha256",
			"bodyBytes",
			"mainCommit",
			"sources",
			"silent",
			"generationTurnKey",
			"fileSha",
			"commitSha",
			"adopted",
			"chunkPlan",
			"messageIds",
			"receipts",
			"failStage",
			"failCategory",
		],
		"daily report state",
	);
	if (value.nextEligibleAt !== undefined) {
		assertStateInteger(value.nextEligibleAt, "nextEligibleAt");
	}
	if (value.gen !== undefined) assertAttemptSection(value.gen, "gen");
	if (value.write !== undefined) assertAttemptSection(value.write, "write");
	if (value.ingest !== undefined) {
		assertAttemptSection(value.ingest, "ingest", ["result"]);
		const ingest = value.ingest as Record<string, unknown>;
		if (
			ingest.result !== undefined &&
			ingest.result !== "ok" &&
			ingest.result !== "failed"
		) {
			throw new Error("ingest.result is invalid");
		}
	}
	if (value.deliver !== undefined) {
		if (!isRecord(value.deliver)) {
			throw new Error("deliver must be an object");
		}
		assertStateKeys(value.deliver, ["attempts", "inFlight"], "deliver");
		assertStateInteger(value.deliver.attempts, "deliver.attempts");
		if (value.deliver.inFlight !== undefined) {
			if (!isRecord(value.deliver.inFlight)) {
				throw new Error("deliver.inFlight must be an object");
			}
			assertStateKeys(
				value.deliver.inFlight,
				["index", "sentAt"],
				"deliver.inFlight",
			);
			assertStateInteger(
				value.deliver.inFlight.index,
				"deliver.inFlight.index",
			);
			assertStateInteger(
				value.deliver.inFlight.sentAt,
				"deliver.inFlight.sentAt",
			);
		}
	}
	if (value.failedNotice !== undefined) {
		if (!isRecord(value.failedNotice)) {
			throw new Error("failedNotice must be an object");
		}
		assertStateKeys(
			value.failedNotice,
			["attempts", "inFlight", "messageId", "result"],
			"failedNotice",
		);
		assertStateInteger(value.failedNotice.attempts, "failedNotice.attempts");
		if (value.failedNotice.inFlight !== undefined) {
			if (!isRecord(value.failedNotice.inFlight)) {
				throw new Error("failedNotice.inFlight must be an object");
			}
			assertStateKeys(
				value.failedNotice.inFlight,
				["sentAt"],
				"failedNotice.inFlight",
			);
			assertStateInteger(
				value.failedNotice.inFlight.sentAt,
				"failedNotice.inFlight.sentAt",
			);
		}
		if (
			value.failedNotice.messageId !== undefined &&
			(typeof value.failedNotice.messageId !== "string" ||
				!DISCORD_ID_PATTERN.test(value.failedNotice.messageId))
		) {
			throw new Error("failedNotice.messageId is invalid");
		}
		if (
			value.failedNotice.result !== undefined &&
			value.failedNotice.result !== "sent" &&
			value.failedNotice.result !== "unknown" &&
			value.failedNotice.result !== "undeliverable"
		) {
			throw new Error("failedNotice.result is invalid");
		}
	}
	assertBodyReference(value, expectedDate, BODY_REQUIRED_STATUSES.has(status));
	if (value.mainCommit !== undefined) {
		if (
			typeof value.mainCommit !== "string" ||
			!/^[0-9a-f]{40}$/.test(value.mainCommit)
		) {
			throw new Error("mainCommit is invalid");
		}
	}
	if (value.sources !== undefined && !Array.isArray(value.sources)) {
		throw new Error("sources must be an array");
	}
	if (value.silent !== undefined && !Array.isArray(value.silent)) {
		throw new Error("silent must be an array");
	}
	if (value.generationTurnKey !== undefined) {
		if (
			typeof value.generationTurnKey !== "string" ||
			!new RegExp(`^daily-report:${expectedDate}:gen:[1-9]\\d*$`).test(
				value.generationTurnKey,
			)
		) {
			throw new Error("generationTurnKey is invalid");
		}
	}
	for (const key of ["fileSha", "commitSha"] as const) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "string" || !/^[0-9a-f]{40}$/.test(value[key]))
		) {
			throw new Error(`${key} is invalid`);
		}
	}
	if (value.adopted !== undefined && typeof value.adopted !== "boolean") {
		throw new Error("adopted must be boolean");
	}
	if (value.chunkPlan !== undefined) {
		if (!isRecord(value.chunkPlan)) {
			throw new Error("chunkPlan must be an object");
		}
		assertStateKeys(value.chunkPlan, ["catchUp", "chunks"], "chunkPlan");
		if (
			typeof value.chunkPlan.catchUp !== "boolean" ||
			!Array.isArray(value.chunkPlan.chunks) ||
			value.chunkPlan.chunks.length < 1 ||
			value.chunkPlan.chunks.length > 11
		) {
			throw new Error("chunkPlan is invalid");
		}
		value.chunkPlan.chunks.forEach((chunk, index) => {
			if (!isRecord(chunk)) throw new Error("chunkPlan chunk is invalid");
			assertStateKeys(chunk, ["index", "kind", "sha256"], "chunkPlan chunk");
			if (
				chunk.index !== index ||
				(chunk.kind !== "title" &&
					chunk.kind !== "body" &&
					chunk.kind !== "footer") ||
				typeof chunk.sha256 !== "string" ||
				!SHA256_PATTERN.test(chunk.sha256)
			) {
				throw new Error("chunkPlan chunk is invalid");
			}
		});
	}
	if (value.messageIds !== undefined) {
		if (!isRecord(value.messageIds)) {
			throw new Error("messageIds must be an object");
		}
		for (const [index, id] of Object.entries(value.messageIds)) {
			if (
				!/^(?:0|[1-9]\d*)$/.test(index) ||
				typeof id !== "string" ||
				!DISCORD_ID_PATTERN.test(id)
			) {
				throw new Error("messageIds contains an invalid receipt");
			}
		}
	}
	if (value.receipts !== undefined && value.receipts !== "unknown") {
		throw new Error("receipts is invalid");
	}
	if (
		value.failStage !== undefined &&
		value.failStage !== "generate" &&
		value.failStage !== "write" &&
		value.failStage !== "deliver"
	) {
		throw new Error("failStage is invalid");
	}
	if (
		value.failCategory !== undefined &&
		(typeof value.failCategory !== "string" || !value.failCategory)
	) {
		throw new Error("failCategory is invalid");
	}
}

const ALLOWED_TRANSITIONS: Readonly<
	Record<DailyReportStatus, Set<DailyReportStatus>>
> = {
	generating: new Set(["generating", "generated", "failed_pending_notice"]),
	generated: new Set([
		"generated",
		"file_written",
		"generating",
		"failed_pending_notice",
	]),
	file_written: new Set(["ingesting"]),
	ingesting: new Set(["ingesting", "ingested", "posting"]),
	ingested: new Set(["posting"]),
	posting: new Set([
		"posting",
		"posted",
		"posted_unknown",
		"failed_pending_notice",
	]),
	failed_pending_notice: new Set(["failed_pending_notice", "failed"]),
	posted: new Set(),
	posted_unknown: new Set(),
	recovered_unknown: new Set(),
	failed: new Set(),
};

export function assertDailyReportTransition(
	previous: DailyReportState | undefined,
	next: DailyReportState,
): void {
	if (previous && previous.date !== next.date) {
		throw new Error("daily report transition cannot change date");
	}
	if (!previous) {
		if (
			!new Set<DailyReportStatus>([
				"generating",
				"recovered_unknown",
				"failed_pending_notice",
			]).has(next.status)
		) {
			throw new Error(
				`daily report transition is not allowed: empty -> ${next.status}`,
			);
		}
		if (
			next.status === "failed_pending_notice" &&
			next.failCategory !== "text_chat_unavailable"
		) {
			throw new Error(
				"empty -> failed_pending_notice requires text_chat_unavailable",
			);
		}
		return;
	}
	if (!ALLOWED_TRANSITIONS[previous.status].has(next.status)) {
		throw new Error(
			`daily report transition is not allowed: ${previous.status} -> ${next.status}`,
		);
	}
	if (previous.status === "generated" && next.status === "generating") {
		const last = next.gen?.attempts.at(-1);
		if (last?.category !== "body_missing") {
			throw new Error(
				"generated -> generating requires a body_missing attempt",
			);
		}
	}
	if (previous.status === "ingesting" && next.status === "posting") {
		if (next.ingest?.result !== "failed") {
			throw new Error("ingesting -> posting requires failed ingest evidence");
		}
	}
}

function dailyReportDirectory(stateDir: string): string {
	return join(stateDir, "daily-report");
}

function assertDate(date: string): void {
	if (!DATE_PATTERN.test(date)) {
		throw new Error(`invalid daily report date: ${date}`);
	}
}

export function dailyReportStatePath(stateDir: string, date: string): string {
	assertDate(date);
	return join(dailyReportDirectory(stateDir), `${date}.json`);
}

/** Strict read-only decoder for migration inventory; never quarantines or erases state. */
export function parseDailyReportState(
	source: string,
	date: string,
): DailyReportState {
	assertDate(date);
	const value: unknown = JSON.parse(source);
	assertDailyReportStateShape(value, date);
	return value;
}

export function readDailyReportState(
	stateDir: string,
	date: string,
	nowMs = Date.now(),
): DailyReportState | undefined {
	const path = dailyReportStatePath(stateDir, date);
	if (!existsSync(path)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		assertDailyReportStateShape(value, date);
		return value;
	} catch (error) {
		try {
			renameSync(path, `${path}.corrupt-${nowMs}`);
		} catch (renameError) {
			throw new AggregateError(
				[error, renameError],
				`daily report state is corrupt and could not be quarantined: ${path}`,
			);
		}
		return undefined;
	}
}

function atomicWriteOwnerOnly(path: string, contents: string): void {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(16)
		.slice(2)}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporary)) unlinkSync(temporary);
		throw error;
	}
}

export function writeDailyReportState(
	stateDir: string,
	next: DailyReportState,
): void {
	assertDate(next.date);
	assertDailyReportStateShape(next, next.date);
	const previous = readDailyReportState(stateDir, next.date);
	assertDailyReportTransition(previous, next);
	const directory = dailyReportDirectory(stateDir);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	atomicWriteOwnerOnly(
		dailyReportStatePath(stateDir, next.date),
		`${JSON.stringify(next, null, 2)}\n`,
	);
}

export interface ReportMeta {
	issue: "FLY-2380";
	date: string;
	timezone: string;
	generated_at: string;
	generation_turn_key: string;
	main_commit: string;
	body_sha256: string;
	body_bytes: number;
	sources: ReportSource[];
	silent: ReportSilent[];
}

export type ReportMetaInput = Omit<ReportMeta, "body_sha256" | "body_bytes">;

export interface ParsedReportDocument {
	meta: ReportMeta;
	body: string;
}

export class ReportDocumentError extends Error {
	constructor(
		public readonly reason: string,
		message: string,
	) {
		super(message);
		this.name = "ReportDocumentError";
	}
}

const REPORT_MAX_BODY_BYTES = 16 * 1024;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SUMMARY_PATH_PATTERN =
	/^summaries\/([^/]+)\/(\d{4}-\d{2}-\d{2})--(?:([^/]+)--)?(\d{2})\.md$/;
const REPORT_CONTRACTS = new Set<ReportSource["contract"]>([
	"ok",
	"invalid:frontmatter_missing",
	"invalid:project_mismatch",
	"invalid:lead_mismatch",
	"invalid:period_unparseable",
	"invalid:period_mismatch",
	"invalid:facts_missing",
	"invalid:judgment_missing",
]);

function reportError(reason: string, message: string): never {
	throw new ReportDocumentError(reason, message);
}

function sha256Utf8(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
	context: string,
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) {
			reportError("unknown_key", `${context} has unknown key ${key}`);
		}
	}
	for (const key of required) {
		if (!Object.hasOwn(record, key)) {
			reportError("missing_key", `${context} is missing ${key}`);
		}
	}
}

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		reportError("field_type", `${field} must be a string`);
	}
	return value;
}

function expectInteger(value: unknown, field: string, minimum = 0): number {
	if (!Number.isInteger(value) || (value as number) < minimum) {
		reportError("field_type", `${field} must be an integer >= ${minimum}`);
	}
	return value as number;
}

function expectBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		reportError("field_type", `${field} must be a boolean`);
	}
	return value;
}

function expectStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		reportError("field_type", `${field} must be a string array`);
	}
	return value as string[];
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function compareReportSources(
	left: ReportSource,
	right: ReportSource,
): number {
	const leftParts = [
		left.project,
		left.lead,
		left.path,
		left.state,
		String(left.pr ?? 0).padStart(12, "0"),
		left.head,
	];
	const rightParts = [
		right.project,
		right.lead,
		right.path,
		right.state,
		String(right.pr ?? 0).padStart(12, "0"),
		right.head,
	];
	for (let index = 0; index < leftParts.length; index += 1) {
		const compared = compareText(
			leftParts[index] ?? "",
			rightParts[index] ?? "",
		);
		if (compared !== 0) return compared;
	}
	return 0;
}

function validateReportSource(
	value: unknown,
	index: number,
	expectedDate: string,
): ReportSource {
	if (!isRecord(value)) {
		reportError("field_type", `sources[${index}] must be a map`);
	}
	const state = expectString(value.state, `sources[${index}].state`);
	if (state !== "open" && state !== "merged") {
		reportError("field_value", `sources[${index}].state is invalid`);
	}
	assertExactKeys(
		value,
		[
			"state",
			...(state === "open" ? ["pr"] : []),
			"head",
			"blob",
			"path",
			"project",
			"lead",
			"contract",
			"bytes",
			"truncated",
			"omitted",
			"divergent",
			"also_in",
		],
		[],
		`sources[${index}]`,
	);
	if (state === "merged" && Object.hasOwn(value, "pr")) {
		reportError(
			"source_pr",
			`sources[${index}] merged source must not have pr`,
		);
	}
	const head = expectString(value.head, `sources[${index}].head`);
	const blob = expectString(value.blob, `sources[${index}].blob`);
	if (!GIT_SHA_PATTERN.test(head) || !GIT_SHA_PATTERN.test(blob)) {
		reportError("source_sha", `sources[${index}] has an invalid git sha`);
	}
	const path = expectString(value.path, `sources[${index}].path`);
	const pathMatch = SUMMARY_PATH_PATTERN.exec(path);
	if (!pathMatch) {
		reportError("source_path", `sources[${index}] path is not a summary path`);
	}
	if (pathMatch[2] !== expectedDate) {
		reportError(
			"source_date",
			`sources[${index}] source path date mismatches report date`,
		);
	}
	const contract = expectString(
		value.contract,
		`sources[${index}].contract`,
	) as ReportSource["contract"];
	if (!REPORT_CONTRACTS.has(contract)) {
		reportError("source_contract", `sources[${index}] contract is invalid`);
	}
	const alsoIn = expectStringArray(value.also_in, `sources[${index}].also_in`);
	for (const location of alsoIn) {
		if (
			!/^open#[1-9]\d*@[0-9a-f]{40}$/.test(location) &&
			!/^merged#main@[0-9a-f]{40}$/.test(location)
		) {
			reportError("source_also_in", `sources[${index}].also_in is invalid`);
		}
	}
	const source: ReportSource = {
		state,
		...(state === "open"
			? { pr: expectInteger(value.pr, `sources[${index}].pr`, 1) }
			: {}),
		head,
		blob,
		path,
		project: expectString(value.project, `sources[${index}].project`),
		lead: expectString(value.lead, `sources[${index}].lead`),
		contract,
		bytes: expectInteger(value.bytes, `sources[${index}].bytes`),
		truncated: expectBoolean(value.truncated, `sources[${index}].truncated`),
		omitted: expectBoolean(value.omitted, `sources[${index}].omitted`),
		divergent: expectBoolean(value.divergent, `sources[${index}].divergent`),
		also_in: alsoIn,
	};
	return source;
}

function validateSilent(value: unknown, index: number): ReportSilent {
	if (!isRecord(value)) {
		reportError("field_type", `silent[${index}] must be a map`);
	}
	assertExactKeys(value, ["project", "last_summary"], [], `silent[${index}]`);
	const lastSummary = expectString(
		value.last_summary,
		`silent[${index}].last_summary`,
	);
	if (!DATE_PATTERN.test(lastSummary)) {
		reportError("silent_date", `silent[${index}].last_summary is invalid`);
	}
	return {
		project: expectString(value.project, `silent[${index}].project`),
		last_summary: lastSummary,
	};
}

function validateReportMeta(value: unknown, expectedDate: string): ReportMeta {
	if (!isRecord(value))
		reportError("field_type", "report metadata must be a map");
	assertExactKeys(
		value,
		[
			"issue",
			"date",
			"timezone",
			"generated_at",
			"generation_turn_key",
			"main_commit",
			"body_sha256",
			"body_bytes",
			"sources",
			"silent",
		],
		[],
		"report metadata",
	);
	if (value.issue !== "FLY-2380") {
		reportError("issue", "report issue must be FLY-2380");
	}
	const date = expectString(value.date, "date");
	if (!DATE_PATTERN.test(date) || date !== expectedDate) {
		reportError("date", "report date does not match the expected path date");
	}
	const timezone = expectString(value.timezone, "timezone");
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
	} catch {
		reportError("timezone", "report timezone is invalid");
	}
	const generatedAt = expectString(value.generated_at, "generated_at");
	if (!generatedAt.includes("T") || !Number.isFinite(Date.parse(generatedAt))) {
		reportError("generated_at", "generated_at must be ISO-8601");
	}
	const generationTurnKey = expectString(
		value.generation_turn_key,
		"generation_turn_key",
	);
	const turnMatch = /^daily-report:(\d{4}-\d{2}-\d{2}):gen:([1-9]\d*)$/.exec(
		generationTurnKey,
	);
	if (!turnMatch || turnMatch[1] !== expectedDate) {
		reportError(
			"generation_turn_key",
			"generation turn key date does not match report date",
		);
	}
	const mainCommit = expectString(value.main_commit, "main_commit");
	if (!GIT_SHA_PATTERN.test(mainCommit)) {
		reportError("main_commit", "main_commit must be a 40-character git sha");
	}
	const bodySha256 = expectString(value.body_sha256, "body_sha256");
	if (!SHA256_PATTERN.test(bodySha256)) {
		reportError("body_sha256", "body sha must be 64 lowercase hex characters");
	}
	const bodyBytes = expectInteger(value.body_bytes, "body_bytes", 1);
	if (!Array.isArray(value.sources) || !Array.isArray(value.silent)) {
		reportError("field_type", "sources and silent must be lists");
	}
	const sources = value.sources.map((source, index) =>
		validateReportSource(source, index, expectedDate),
	);
	for (let index = 1; index < sources.length; index += 1) {
		const previous = sources[index - 1];
		const current = sources[index];
		if (!previous || !current) {
			reportError("source_sort", "report source sort comparison is incomplete");
		}
		if (compareReportSources(previous, current) > 0) {
			reportError(
				"source_sort",
				"report sources are not in canonical sort order",
			);
		}
	}
	return {
		issue: "FLY-2380",
		date,
		timezone,
		generated_at: generatedAt,
		generation_turn_key: generationTurnKey,
		main_commit: mainCommit,
		body_sha256: bodySha256,
		body_bytes: bodyBytes,
		sources,
		silent: value.silent.map(validateSilent),
	};
}

function encodeString(value: string): string {
	return JSON.stringify(value);
}

function serializeMapList(
	name: string,
	items: Array<Array<[string, string | number | boolean | string[]]>>,
): string[] {
	if (items.length === 0) return [`${name}: []`];
	const lines = [`${name}:`];
	for (const item of items) {
		item.forEach(([key, value], index) => {
			const prefix = index === 0 ? "  - " : "    ";
			const rendered =
				typeof value === "string"
					? encodeString(value)
					: Array.isArray(value)
						? JSON.stringify(value)
						: String(value);
			lines.push(`${prefix}${key}: ${rendered}`);
		});
	}
	return lines;
}

function serializeMeta(meta: ReportMeta): string {
	const lines = [
		`issue: ${encodeString(meta.issue)}`,
		`date: ${encodeString(meta.date)}`,
		`timezone: ${encodeString(meta.timezone)}`,
		`generated_at: ${encodeString(meta.generated_at)}`,
		`generation_turn_key: ${encodeString(meta.generation_turn_key)}`,
		`main_commit: ${encodeString(meta.main_commit)}`,
		`body_sha256: ${encodeString(meta.body_sha256)}`,
		`body_bytes: ${meta.body_bytes}`,
	];
	lines.push(
		...serializeMapList(
			"sources",
			meta.sources.map((source) => [
				["state", source.state],
				...(source.state === "open"
					? ([["pr", source.pr as number]] as Array<[string, number]>)
					: []),
				["head", source.head],
				["blob", source.blob],
				["path", source.path],
				["project", source.project],
				["lead", source.lead],
				["contract", source.contract],
				["bytes", source.bytes],
				["truncated", source.truncated],
				["omitted", source.omitted],
				["divergent", source.divergent],
				["also_in", source.also_in],
			]),
		),
		...serializeMapList(
			"silent",
			meta.silent.map((silent) => [
				["project", silent.project],
				["last_summary", silent.last_summary],
			]),
		),
	);
	return lines.join("\n");
}

function validateBody(body: string): { bytes: number; sha256: string } {
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes === 0) reportError("body_empty", "report body must not be empty");
	if (bytes > REPORT_MAX_BODY_BYTES) {
		reportError("body_too_large", "report body exceeds 16 KiB");
	}
	return { bytes, sha256: sha256Utf8(body) };
}

export function serializeReportDocument(
	input: ReportMetaInput,
	body: string,
): string {
	const measured = validateBody(body);
	const meta = validateReportMeta(
		{
			...input,
			body_sha256: measured.sha256,
			body_bytes: measured.bytes,
		},
		input.date,
	);
	return `---\n${serializeMeta(meta)}\n---\n\n${body}`;
}

function parseYamlScalar(source: string, context: string): unknown {
	if (source.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(source);
			if (typeof parsed !== "string") throw new Error("not a string");
			return parsed;
		} catch {
			reportError("yaml_scalar", `${context} has an invalid quoted string`);
		}
	}
	if (source === "true") return true;
	if (source === "false") return false;
	if (/^\d+$/.test(source)) return Number(source);
	if (source.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(source);
			if (
				!Array.isArray(parsed) ||
				parsed.some((item) => typeof item !== "string")
			) {
				throw new Error("not a string array");
			}
			return parsed;
		} catch {
			reportError("yaml_scalar", `${context} has an invalid string array`);
		}
	}
	reportError("yaml_scalar", `${context} uses an unsupported YAML scalar`);
}

function assignUnique(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
	context: string,
): void {
	if (Object.hasOwn(target, key)) {
		reportError("duplicate_key", `${context} repeats key ${key}`);
	}
	target[key] = value;
}

function parseFlatMapLine(source: string, context: string): [string, unknown] {
	const match = /^([a-z0-9_]+): (.+)$/.exec(source);
	if (!match) reportError("yaml_shape", `${context} has invalid map syntax`);
	return [match[1], parseYamlScalar(match[2], `${context}.${match[1]}`)];
}

function parseStrictYaml(frontmatter: string): Record<string, unknown> {
	const lines = frontmatter.split("\n");
	const result: Record<string, unknown> = {};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line || /^\s/.test(line)) {
			reportError("yaml_shape", `frontmatter line ${index + 1} is invalid`);
		}
		const topMatch = /^([a-z0-9_]+):(?: (.+))?$/.exec(line);
		if (!topMatch) {
			reportError("yaml_shape", `frontmatter line ${index + 1} is invalid`);
		}
		const key = topMatch[1];
		const scalar = topMatch[2];
		if (key !== "sources" && key !== "silent") {
			if (scalar === undefined) {
				reportError("yaml_shape", `${key} must be a scalar`);
			}
			assignUnique(result, key, parseYamlScalar(scalar, key), "frontmatter");
			continue;
		}
		if (scalar === "[]") {
			assignUnique(result, key, [], "frontmatter");
			continue;
		}
		if (scalar !== undefined) {
			reportError("yaml_shape", `${key} must be [] or an indented list`);
		}
		const items: Record<string, unknown>[] = [];
		while (true) {
			const nextItemLine = lines[index + 1];
			if (nextItemLine === undefined || !/^\s/.test(nextItemLine)) break;
			index += 1;
			const itemLine = nextItemLine;
			if (!itemLine.startsWith("  - ")) {
				reportError("yaml_shape", `${key} item must begin with two-space dash`);
			}
			const item: Record<string, unknown> = {};
			let [itemKey, itemValue] = parseFlatMapLine(
				itemLine.slice(4),
				`${key}[${items.length}]`,
			);
			assignUnique(item, itemKey, itemValue, `${key}[${items.length}]`);
			while (true) {
				const nextPropertyLine = lines[index + 1];
				if (
					nextPropertyLine === undefined ||
					!nextPropertyLine.startsWith("    ") ||
					nextPropertyLine.startsWith("  - ")
				) {
					break;
				}
				index += 1;
				[itemKey, itemValue] = parseFlatMapLine(
					nextPropertyLine.slice(4),
					`${key}[${items.length}]`,
				);
				assignUnique(item, itemKey, itemValue, `${key}[${items.length}]`);
			}
			items.push(item);
		}
		assignUnique(result, key, items, "frontmatter");
	}
	return result;
}

export function parseReportDocument(
	document: string,
	expected: { date: string },
): ParsedReportDocument {
	assertDate(expected.date);
	if (!document.startsWith("---\n")) {
		reportError("frontmatter_missing", "report frontmatter is missing");
	}
	const boundary = document.indexOf("\n---\n", 4);
	if (boundary < 0 || document[boundary + 5] !== "\n") {
		reportError("frontmatter_unclosed", "report frontmatter is not closed");
	}
	const frontmatter = document.slice(4, boundary);
	const body = document.slice(boundary + 6);
	const measured = validateBody(body);
	const meta = validateReportMeta(parseStrictYaml(frontmatter), expected.date);
	if (meta.body_sha256 !== measured.sha256) {
		reportError("body_sha256", "report body sha does not match metadata");
	}
	if (meta.body_bytes !== measured.bytes) {
		reportError("body_bytes", "report body bytes do not match metadata");
	}
	return { meta, body };
}
