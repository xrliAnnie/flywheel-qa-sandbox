#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { parseChatDeliveryEnvelope } from "flywheel-comm/discord-chat-ingest";
import { founderOffsetMinutes, resolveFounderTimezone } from "flywheel-config";
import { loadVerifiedStandingAuthority } from "./standing-authority-activation-store.js";
import {
	resolveStandingAuthorityLedgerPath,
	resolveStandingAuthorityStateDir,
} from "./standing-authority-confirmation-ledger.js";

const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FLYWHEEL_RESTART_REPO = "xrliAnnie/flywheel";
const GITHUB_CLI =
	["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((path) =>
		existsSync(path),
	) ?? "gh";
const MAX_INSTRUCTION_AGE_MS = 24 * 60 * 60_000;

export interface RestartDiscordMessage {
	id: string;
	channelId: string;
	authorId: string;
	authorBot: boolean;
	content: string;
	timestamp: string;
}

export interface RestartRequestV2 {
	schemaVersion: 2;
	kind: "authorized-urgent-restart";
	requestId: string;
	authority: {
		kind: "founder-per-instance";
		messageRef: {
			channelId: string;
			messageId: string;
			authorId: string;
			timestamp: string;
			contentDigest: string;
		};
		timeFrame: {
			kind: "founder-local-day" | "elapsed-24h" | "explicit";
			timezone: string;
			expression: string | null;
		};
		expiresAt: string;
	};
	trigger: {
		kind: "issue_fix_landed" | "pr_merged" | "immediate";
		project: string;
		repo: string;
		issueId?: string;
		prNumber?: number;
		originalText: string;
		evidence: {
			eventId: string;
			mergedCommit: string;
			pullRequest?: {
				number: number;
				headSha: string;
			};
			verdicts: Array<{
				kind: "code-review" | "qa";
				id: string;
				status: "approved" | "pass";
				headSha: string;
			}>;
		};
	};
	requestedBy: {
		projectName: string;
		leadId: string;
		instanceId: string;
		botUserId: string;
	};
	announcement: {
		channelId: string;
		messageId: string;
		authorId: string;
		timestamp: string;
		contentDigest: string;
		purpose: string;
		affectedScope: string[];
		recoveryExpectations: string;
	};
	fromDeployedSha: string;
	targetSha: string;
	createdAt: string;
}

export interface UrgentTicketV2 extends RestartRequestV2 {
	preMergeHead: string;
	validatedAt: string;
	requestDigest: string;
}

export type RestartScopeSourceKind =
	| "state-store"
	| "comm-db"
	| "turn-wake"
	| "process-service";

export interface RestartScopeSnapshotV1 {
	version: "restart-scope-snapshot/v1";
	capturedAt: string;
	sources: Array<{
		kind: RestartScopeSourceKind;
		receiptId: string;
		digest: string;
	}>;
	entries: Array<{
		executionId: string;
		activationId: string;
		project: string;
		phase: "design" | "implement" | "qa";
		repo: string;
		worktree: string;
		headSha: string;
		pushedHeadSha: string;
		clean: boolean;
		parked: boolean;
		activeWrite: boolean;
		pendingWakeIds: string[];
		verdict: {
			kind: "code-review" | "qa" | "phase-not-applicable";
			receiptId: string;
			status: "approved" | "pass" | "not-applicable";
			headSha: string;
		};
		recovery: { path: string; digest: string };
	}>;
	snapshotDigest: string;
}

export interface RestartRequestV3 {
	schemaVersion: 3;
	kind: "lead-closeout-restart";
	decisionId: string;
	waveId: string;
	revision: number;
	authority: {
		kind: "standing-carve-out";
		entryId: "lead-closeout-restart/v1";
		entryDigest: string;
		manifestRevision: number;
		manifestDigest: string;
	};
	intent: {
		kind: "closeout-restart-intent/v1";
		classification: "precondition-not-authorization";
		messageRef: {
			channelId: string;
			messageId: string;
			authorId: string;
			timestamp: string;
			contentDigest: string;
		};
		timezone: string;
		founderLocalDate: string;
		expiresAt: string;
	};
	scopeSnapshot: RestartScopeSnapshotV1;
	readiness:
		| { kind: "all-ready"; executionIds: string[] }
		| {
				kind: "founder-recast-waiver";
				executionIds: string[];
				lossScope: string;
				messageRef: RestartRequestV3["intent"]["messageRef"];
		  };
	requestedBy: RestartRequestV2["requestedBy"];
	announcement: {
		channelId: string;
		messageId: string;
		authorId: string;
		timestamp: string;
		contentDigest: string;
		purpose: string;
		affectedExecutionIds: string[];
		recoveryExpectations: string;
	};
	fromDeployedSha: string;
	targetSha: string;
	executionPackage: {
		root: string;
		packageDigest: string;
		sourceCommit: string;
	};
	createdAt: string;
}

export interface UrgentTicketV3 extends RestartRequestV3 {
	preMergeHead: string;
	validatedAt: string;
	requestDigest: string;
}

export interface RestartCloseoutContext {
	now: number;
	founderId: string;
	founderTimezone: string;
	founderMessage: RestartDiscordMessage;
	waiverMessage?: RestartDiscordMessage;
	announcementMessage: RestartDiscordMessage;
	laterFounderMessages: RestartDiscordMessage[];
	contextComplete: boolean;
	leadRegistry: RestartRequestContext["leadRegistry"];
	currentInstanceId: string;
	deployedSha: string;
	remoteMainSha: string;
	preMergeHead: string;
	activeAuthority: {
		entryDigest: string;
		manifestRevision: number;
		manifestDigest: string;
		packageDigest: string;
		packageRoot: string;
		sourceCommit: string;
	} | null;
	currentScopeSnapshot: RestartScopeSnapshotV1;
}

export interface RestartRequestContext {
	now: number;
	founderId: string;
	founderTimezone: string;
	founderMessage: RestartDiscordMessage;
	announcementMessage: RestartDiscordMessage;
	laterFounderMessages: RestartDiscordMessage[];
	contextComplete: boolean;
	leadRegistry: Array<{
		projectName: string;
		leadId: string;
		botUserId: string;
	}>;
	currentInstanceId: string;
	deployedSha: string;
	remoteMainSha: string;
	preMergeHead: string;
	targetContainsCommit: boolean;
	verifiedPullRequest: {
		repo: string;
		number: number;
		headSha: string;
		mergeCommit: string;
		baseRef: string;
		issueIds: string[];
	} | null;
}

export type RestartIntentState =
	| "prepared"
	| "revoked"
	| "consumed-no-deploy"
	| "started"
	| "succeeded"
	| "failed"
	| "unknown";

export interface RestartIntentIndex {
	schemaVersion: 1;
	intents: Record<
		string,
		{
			requestId: string;
			requestDigest: string;
			revision?: number;
			state: RestartIntentState;
			updatedAt: string;
			waveId?: string;
			zeroSideEffects?: true;
		}
	>;
}

function fail(reason: string): never {
	throw new Error(`restart-request-${reason}`);
}

function record(value: unknown, reason: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
	return value as Record<string, unknown>;
}

function finiteTime(value: string, reason: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) fail(reason);
	return parsed;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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

export function canonicalRestartJson(value: unknown): string {
	return JSON.stringify(stable(value));
}

function exactKeys(
	value: Record<string, unknown>,
	keys: string[],
	reason: string,
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, i) => key !== expected[i])
	)
		fail(reason);
}

export function closeoutScopeDigest(snapshot: RestartScopeSnapshotV1): string {
	const { snapshotDigest: _snapshotDigest, ...identity } = snapshot;
	return digest(canonicalRestartJson(identity));
}

function localDate(at: string | number, timezone: string): string {
	const milliseconds =
		typeof at === "number" ? at : finiteTime(at, "intent-time-invalid");
	const parts = localParts(new Date(milliseconds), timezone);
	return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function validateCloseoutScope(
	request: RestartRequestV3,
	context: RestartCloseoutContext,
): void {
	const snapshot = request.scopeSnapshot;
	exactKeys(
		record(snapshot, "scope-shape-invalid"),
		["version", "capturedAt", "sources", "entries", "snapshotDigest"],
		"scope-shape-invalid",
	);
	if (
		snapshot.version !== "restart-scope-snapshot/v1" ||
		!DIGEST.test(snapshot.snapshotDigest) ||
		snapshot.snapshotDigest !== closeoutScopeDigest(snapshot) ||
		canonicalRestartJson(snapshot) !==
			canonicalRestartJson(context.currentScopeSnapshot) ||
		finiteTime(snapshot.capturedAt, "scope-time-invalid") > context.now ||
		!Array.isArray(snapshot.sources) ||
		!Array.isArray(snapshot.entries) ||
		snapshot.entries.length === 0
	)
		fail("scope-drift");
	const expectedSources: RestartScopeSourceKind[] = [
		"state-store",
		"comm-db",
		"turn-wake",
		"process-service",
	];
	if (
		snapshot.sources.length !== expectedSources.length ||
		new Set(snapshot.sources.map((source) => source.kind)).size !==
			expectedSources.length ||
		snapshot.sources.some((source) => {
			exactKeys(
				record(source, "scope-source-invalid"),
				["kind", "receiptId", "digest"],
				"scope-source-invalid",
			);
			return (
				!expectedSources.includes(source.kind) ||
				!validText(source.receiptId, 500) ||
				!DIGEST.test(source.digest)
			);
		})
	)
		fail("scope-source-invalid");
	const ids = new Set<string>();
	const notReady = new Set<string>();
	for (const entry of snapshot.entries) {
		exactKeys(
			record(entry, "scope-entry-invalid"),
			[
				"executionId",
				"activationId",
				"project",
				"phase",
				"repo",
				"worktree",
				"headSha",
				"pushedHeadSha",
				"clean",
				"parked",
				"activeWrite",
				"pendingWakeIds",
				"verdict",
				"recovery",
			],
			"scope-entry-invalid",
		);
		exactKeys(
			record(entry.verdict, "scope-entry-invalid"),
			["kind", "receiptId", "status", "headSha"],
			"scope-entry-invalid",
		);
		exactKeys(
			record(entry.recovery, "scope-entry-invalid"),
			["path", "digest"],
			"scope-entry-invalid",
		);
		if (
			!UUID.test(entry.executionId) ||
			ids.has(entry.executionId) ||
			!validText(entry.activationId, 500) ||
			!SAFE_SEGMENT.test(entry.project) ||
			!["design", "implement", "qa"].includes(entry.phase) ||
			!GITHUB_REPO.test(entry.repo) ||
			!isAbsolute(entry.worktree) ||
			!SHA40.test(entry.headSha) ||
			entry.pushedHeadSha !== entry.headSha ||
			!Array.isArray(entry.pendingWakeIds) ||
			entry.pendingWakeIds.some((wake) => !validText(wake, 500)) ||
			!validText(entry.verdict.receiptId, 500) ||
			entry.verdict.headSha !== entry.headSha ||
			!isAbsolute(entry.recovery.path) ||
			!DIGEST.test(entry.recovery.digest)
		)
			fail("scope-entry-invalid");
		const verdictValid =
			(entry.phase === "implement" &&
				entry.verdict.kind === "code-review" &&
				entry.verdict.status === "approved") ||
			(entry.phase === "qa" &&
				entry.verdict.kind === "qa" &&
				entry.verdict.status === "pass") ||
			(entry.phase === "design" &&
				entry.verdict.kind === "phase-not-applicable" &&
				entry.verdict.status === "not-applicable");
		if (!verdictValid) fail("scope-verdict-invalid");
		ids.add(entry.executionId);
		if (
			!entry.clean ||
			!entry.parked ||
			entry.activeWrite ||
			entry.pendingWakeIds.length > 0
		)
			notReady.add(entry.executionId);
	}
	const readiness = request.readiness;
	if (readiness.kind === "all-ready") {
		exactKeys(
			record(readiness, "readiness-invalid"),
			["kind", "executionIds"],
			"readiness-invalid",
		);
		if (
			notReady.size > 0 ||
			!Array.isArray(readiness.executionIds) ||
			canonicalRestartJson([...readiness.executionIds].sort()) !==
				canonicalRestartJson([...ids].sort())
		)
			fail("scope-not-ready");
		return;
	}
	if (readiness.kind !== "founder-recast-waiver") fail("readiness-invalid");
	exactKeys(
		record(readiness, "readiness-invalid"),
		["kind", "executionIds", "lossScope", "messageRef"],
		"readiness-invalid",
	);
	if (
		!context.waiverMessage ||
		!validText(readiness.lossScope, 1_000) ||
		readiness.lossScope !== "不在乎重铸" ||
		canonicalRestartJson([...readiness.executionIds].sort()) !==
			canonicalRestartJson([...notReady].sort())
	)
		fail("waiver-invalid");
	validateMessageBinding(
		readiness.messageRef,
		context.waiverMessage,
		context.founderId,
	);
	if (
		context.waiverMessage.content.trim() !== readiness.lossScope ||
		localDate(context.waiverMessage.timestamp, context.founderTimezone) !==
			request.intent.founderLocalDate
	)
		fail("waiver-invalid");
}

function validateCloseoutTopLevel(request: RestartRequestV3): void {
	exactKeys(
		record(request, "shape-invalid"),
		[
			"schemaVersion",
			"kind",
			"decisionId",
			"waveId",
			"revision",
			"authority",
			"intent",
			"scopeSnapshot",
			"readiness",
			"requestedBy",
			"announcement",
			"fromDeployedSha",
			"targetSha",
			"executionPackage",
			"createdAt",
		],
		"shape-invalid",
	);
	if (
		request.schemaVersion !== 3 ||
		request.kind !== "lead-closeout-restart" ||
		!UUID.test(request.decisionId) ||
		!SAFE_NAME.test(request.waveId) ||
		!Number.isSafeInteger(request.revision) ||
		request.revision < 1 ||
		!SHA40.test(request.fromDeployedSha) ||
		!SHA40.test(request.targetSha)
	)
		fail("shape-invalid");
	exactKeys(
		record(request.authority, "shape-invalid"),
		["kind", "entryId", "entryDigest", "manifestRevision", "manifestDigest"],
		"shape-invalid",
	);
	exactKeys(
		record(request.intent, "shape-invalid"),
		[
			"kind",
			"classification",
			"messageRef",
			"timezone",
			"founderLocalDate",
			"expiresAt",
		],
		"shape-invalid",
	);
	exactKeys(
		record(request.intent.messageRef, "shape-invalid"),
		["channelId", "messageId", "authorId", "timestamp", "contentDigest"],
		"shape-invalid",
	);
	exactKeys(
		record(request.requestedBy, "shape-invalid"),
		["projectName", "leadId", "instanceId", "botUserId"],
		"shape-invalid",
	);
	exactKeys(
		record(request.announcement, "shape-invalid"),
		[
			"channelId",
			"messageId",
			"authorId",
			"timestamp",
			"contentDigest",
			"purpose",
			"affectedExecutionIds",
			"recoveryExpectations",
		],
		"shape-invalid",
	);
	exactKeys(
		record(request.executionPackage, "shape-invalid"),
		["root", "packageDigest", "sourceCommit"],
		"shape-invalid",
	);
}

export function prepareCloseoutRestartTicket(
	request: RestartRequestV3,
	context: RestartCloseoutContext,
): UrgentTicketV3 {
	validateCloseoutTopLevel(request);
	if (
		!Number.isSafeInteger(context.now) ||
		context.now < 0 ||
		!SNOWFLAKE.test(context.founderId) ||
		!SHA40.test(context.deployedSha) ||
		!SHA40.test(context.remoteMainSha) ||
		!SHA40.test(context.preMergeHead) ||
		request.fromDeployedSha !== context.deployedSha ||
		request.targetSha !== context.remoteMainSha
	)
		fail("version-binding-invalid");
	const active = context.activeAuthority;
	if (!active) fail("standing-authority-inactive");
	if (
		request.authority.kind !== "standing-carve-out" ||
		request.authority.entryId !== "lead-closeout-restart/v1" ||
		request.authority.entryDigest !== active.entryDigest ||
		request.authority.manifestRevision !== active.manifestRevision ||
		request.authority.manifestDigest !== active.manifestDigest ||
		!DIGEST.test(active.entryDigest) ||
		!DIGEST.test(active.manifestDigest) ||
		!Number.isSafeInteger(active.manifestRevision) ||
		active.manifestRevision < 1
	)
		fail("standing-authority-mismatch");
	if (
		request.executionPackage.root !== active.packageRoot ||
		request.executionPackage.packageDigest !== active.packageDigest ||
		request.executionPackage.sourceCommit !== active.sourceCommit ||
		!isAbsolute(request.executionPackage.root) ||
		!DIGEST.test(request.executionPackage.packageDigest) ||
		!SHA40.test(request.executionPackage.sourceCommit)
	)
		fail("execution-package-mismatch");
	if (
		request.intent.kind !== "closeout-restart-intent/v1" ||
		request.intent.classification !== "precondition-not-authorization" ||
		request.intent.timezone !== context.founderTimezone ||
		!/^\d{4}-\d{2}-\d{2}$/.test(request.intent.founderLocalDate)
	)
		fail("intent-invalid");
	validateMessageBinding(
		request.intent.messageRef,
		context.founderMessage,
		context.founderId,
	);
	if (!matchesCloseoutRestartIntent(context.founderMessage.content))
		fail("intent-unverified");
	if (
		localDate(context.founderMessage.timestamp, context.founderTimezone) !==
			request.intent.founderLocalDate ||
		localDate(context.now, context.founderTimezone) !==
			request.intent.founderLocalDate ||
		request.intent.expiresAt !==
			founderLocalDayExpiry(
				context.founderMessage.timestamp,
				context.founderTimezone,
			) ||
		context.now >= finiteTime(request.intent.expiresAt, "intent-time-invalid")
	)
		fail("intent-expired");
	if (!context.contextComplete) fail("context-incomplete");
	const sourceAt = finiteTime(
		context.founderMessage.timestamp,
		"intent-time-invalid",
	);
	for (const message of context.laterFounderMessages) {
		const at = finiteTime(message.timestamp, "later-context-invalid");
		if (
			!SNOWFLAKE.test(message.channelId) ||
			message.authorId !== context.founderId ||
			message.authorBot ||
			at <= sourceAt ||
			at > context.now
		)
			fail("later-context-invalid");
		if (REVOCATION.test(message.content) && RESTART_WORD.test(message.content))
			fail("intent-revoked");
		// The standing carve-out never asks a model to decide whether later
		// founder prose is "related enough". Any later founder message in the
		// authenticated project window invalidates this decision snapshot; the
		// Lead may re-read the complete window and create a new revision.
		fail("intent-context-advanced");
	}
	validateCloseoutScope(request, context);
	const by = request.requestedBy;
	if (
		by.projectName !== "flywheel" ||
		by.leadId !== "flywheel-eng-lead" ||
		!(by.instanceId === "current" || DIGEST.test(by.instanceId)) ||
		!DIGEST.test(context.currentInstanceId) ||
		(by.instanceId !== "current" &&
			by.instanceId !== context.currentInstanceId) ||
		!SNOWFLAKE.test(by.botUserId) ||
		context.leadRegistry.filter(
			(entry) =>
				entry.projectName === by.projectName &&
				entry.leadId === by.leadId &&
				entry.botUserId === by.botUserId,
		).length !== 1
	)
		fail("lead-identity-invalid");
	const announcement = request.announcement;
	const message = context.announcementMessage;
	if (
		![
			announcement.channelId,
			announcement.messageId,
			announcement.authorId,
		].every((id) => SNOWFLAKE.test(id)) ||
		announcement.authorId !== by.botUserId ||
		message.id !== announcement.messageId ||
		message.channelId !== announcement.channelId ||
		message.authorId !== by.botUserId ||
		!message.authorBot ||
		message.timestamp !== announcement.timestamp ||
		!DIGEST.test(announcement.contentDigest) ||
		digest(message.content) !== announcement.contentDigest ||
		!validText(announcement.purpose) ||
		!validText(announcement.recoveryExpectations) ||
		canonicalRestartJson([...announcement.affectedExecutionIds].sort()) !==
			canonicalRestartJson(
				request.scopeSnapshot.entries.map((entry) => entry.executionId).sort(),
			)
	)
		fail("announcement-invalid");
	const required = [
		`[closeout-restart:${request.decisionId}:r${request.revision}]`,
		`wave:${request.waveId}`,
		`intent:${request.intent.messageRef.channelId}/${request.intent.messageRef.messageId}`,
		`scope:${request.scopeSnapshot.snapshotDigest}`,
		`target:${request.targetSha}`,
		`purpose:${announcement.purpose}`,
		`recovery:${announcement.recoveryExpectations}`,
		...announcement.affectedExecutionIds.map(
			(executionId) => `interrupts:${executionId}`,
		),
	];
	if (required.some((line) => !message.content.includes(line)))
		fail("announcement-unbound");
	const founderAt = finiteTime(
		context.founderMessage.timestamp,
		"intent-time-invalid",
	);
	const scopeAt = finiteTime(
		request.scopeSnapshot.capturedAt,
		"scope-time-invalid",
	);
	const announcementAt = finiteTime(
		announcement.timestamp,
		"announcement-time-invalid",
	);
	const created = finiteTime(request.createdAt, "created-time-invalid");
	if (
		announcementAt <= founderAt ||
		announcementAt < scopeAt ||
		announcementAt > created ||
		created > context.now + 5_000
	)
		fail("announcement-order-invalid");
	const clean = JSON.parse(canonicalRestartJson(request)) as RestartRequestV3;
	clean.requestedBy.instanceId = context.currentInstanceId;
	return {
		...clean,
		preMergeHead: context.preMergeHead,
		validatedAt: new Date(context.now).toISOString(),
		requestDigest: digest(canonicalRestartJson(clean)),
	};
}

export function verifyCloseoutRestartTicket(
	ticket: UrgentTicketV3,
	context: RestartCloseoutContext,
): UrgentTicketV3 {
	const raw = record(ticket, "ticket-shape-invalid");
	exactKeys(
		raw,
		[
			"schemaVersion",
			"kind",
			"decisionId",
			"waveId",
			"revision",
			"authority",
			"intent",
			"scopeSnapshot",
			"readiness",
			"requestedBy",
			"announcement",
			"fromDeployedSha",
			"targetSha",
			"executionPackage",
			"createdAt",
			"preMergeHead",
			"validatedAt",
			"requestDigest",
		],
		"ticket-shape-invalid",
	);
	const {
		preMergeHead: storedPreMergeHead,
		validatedAt,
		requestDigest,
		...request
	} = ticket;
	if (
		storedPreMergeHead !== context.preMergeHead ||
		!DIGEST.test(requestDigest) ||
		requestDigest !== digest(canonicalRestartJson(request)) ||
		finiteTime(validatedAt, "ticket-validation-time-invalid") > context.now
	)
		fail("ticket-binding-invalid");
	prepareCloseoutRestartTicket(request, context);
	return JSON.parse(canonicalRestartJson(ticket)) as UrgentTicketV3;
}

function validText(value: unknown, max = 2_000): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!value.includes("\0")
	);
}

function localParts(
	at: Date,
	timezone: string,
): {
	year: number;
	month: number;
	day: number;
} {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			calendar: "iso8601",
			numberingSystem: "latn",
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(at);
	} catch {
		fail("timezone-invalid");
	}
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((item) => item.type === type)?.value);
	const result = { year: part("year"), month: part("month"), day: part("day") };
	if (!result.year || !result.month || !result.day) fail("timezone-invalid");
	return result;
}

function localMidnightUtc(
	year: number,
	month: number,
	day: number,
	timezone: string,
): number {
	const wallClock = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
	let candidate = wallClock;
	for (let i = 0; i < 4; i += 1) {
		candidate =
			wallClock - founderOffsetMinutes(new Date(candidate), timezone) * 60_000;
	}
	return candidate;
}

function localWallClockUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string,
): number {
	const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
	let candidate = wallClock;
	for (let i = 0; i < 4; i += 1) {
		candidate =
			wallClock - founderOffsetMinutes(new Date(candidate), timezone) * 60_000;
	}
	return candidate;
}

export function founderLocalDayExpiry(
	messageTime: string,
	timezone: string,
): string {
	const at = finiteTime(messageTime, "message-time-invalid");
	const { year, month, day } = localParts(new Date(at), timezone);
	const next = new Date(Date.UTC(year, month - 1, day + 1));
	return new Date(
		localMidnightUtc(
			next.getUTCFullYear(),
			next.getUTCMonth() + 1,
			next.getUTCDate(),
			timezone,
		),
	).toISOString();
}

const NATURAL_DAY_WINDOW =
	/(今天|今晚|今夜|午夜|晚上\s*12\s*点|midnight|tonight|end of (the )?day)/iu;
// Independent lexical pre-scan: an unrecognised time phrase must not fall
// through to the otherwise valid elapsed-24h default.
const TIME_LANGUAGE =
	/(今天|今晚|今夜|明天|后天|午夜|凌晨|早上|上午|中午|下午|晚上|\d{1,2}\s*(?:点|时)|\d{1,2}[:：]\d{2}|\d+\s*(?:分钟|小时|天)|midnight|tonight|tomorrow|morning|afternoon|evening|\d{1,2}\s*(?:am|pm)|\d+\s*(?:minutes?|hours?|days?)|before|until|by\s+\d)/iu;
const RESTART_WORD = /(重启|restart)/iu;
const CONDITIONAL_WORD =
	/(修好|修复|合入|merge[ds]?|land(?:ed)?|完成|之后|以后|后再)/iu;
const COMPLETED_STATE_ASSERTION =
	/(?:(?:已经|已)[^。！？!?]{0,6}(?:修好|修复|合入|完成)|(?:already|has been|have been)[^.!?]{0,12}(?:fixed|merged|landed|completed))/iu;
const NAMED_RESTART_OBJECT =
	/(?:\b[A-Z][A-Z0-9]+-[1-9][0-9]*\b|(?:^|[^A-Za-z0-9])(?:PR\s*#?\s*|#)[1-9][0-9]*\b|(?:^|[^0-9])[1-9][0-9]{2,}(?=$|[^0-9]))/iu;
const CONDITIONAL_FRAMING =
	/(?:等[^。！？!?]{0,24}(?:就|再)|一[^。！？!?]{0,12}就|\b(?:as soon as|once|when|if|after)\b)/iu;
const IMMEDIATE_RESTART_REQUEST =
	/(?:(?:现在|马上|立即|立刻)[^。！？!?]{0,16}重启|(?:请|麻烦|帮我|给我|直接)[^。！？!?]{0,16}重启|restart\s+(?:now|immediately)|(?:please|now|immediately)\s+restart|(?:can|could|would|will)\s+you[^.!?]{0,24}restart[^.!?]{0,12}(?:now|immediately))/iu;
const IMMEDIATE_PERMISSION_QUESTION =
	/(?:(?:现在|马上|立即|立刻)[^。！？!?]{0,16}重启[^。！？!?]{0,8}(?:可以吗|好吗|行吗)[？?]?|(?:can|could|would|will)\s+you[^.!?]{0,24}restart[^.!?]{0,12}(?:now|immediately)[?]?)/iu;
const RESTART_NEGATION =
	/(?:(?:不|没|未|别|不能|不可|无需|无须|不可以)[^。！？!?]{0,16}重启|(?:do not|don't|dont|cannot|can't|cant|should not|shouldn't|must not|mustn't|not ready to)[^.!?]{0,24}restart)/iu;
const QUESTION_MARKER = /(?:吗|呢|是否|[？?])/u;
const REVOCATION =
	/(撤回|取消|先不要|不要重启|别重启|hold off|cancel|do not restart)/iu;
const RESTART_DEADLINE_EXPRESSION =
	/^(?:(?:今天|今晚|今夜|午夜)|(?:今天\s*)?(?:(?:凌晨|早上|上午|中午|下午|晚上)\s*)?\d{1,2}(?:\s*[:：]\s*\d{2}|\s*点(?:\s*(?:半|\d{1,2}\s*分?))?)|\d{1,3}\s*(?:分钟|小时)|(?:today|tonight|midnight|end\s+of\s+(?:the\s+)?day)|(?:(?:today|tonight)\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,3}\s*(?:minutes?|hours?))$/iu;

const CLOSEOUT_RESTART_INTENT =
	/^(?:(?:今天|今晚)[ \t]*)?(?:(?:收尾后|收尾完后|收尾完成后|工作收尾后|全部收尾后)[ \t]*(?:[，,][ \t]*)?(?:(?:我们|咱们)[ \t]*)?(?:请[ \t]*)?(?:(?:马上|立刻|立即)[ \t]*)?(?:重启|紧急[ \t]*重启)(?:[ \t]*电脑)?|重启[ \t]*电脑)[ \t]*[。！!]?$/u;

export function matchesCloseoutRestartIntent(content: string): boolean {
	if (typeof content !== "string" || /[\r\n]/u.test(content)) return false;
	return CLOSEOUT_RESTART_INTENT.test(content.trim());
}

function regexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCurrentRestartAuthorization(
	request: RestartRequestV2,
	content: string,
): boolean {
	const trigger = request.trigger;
	const object =
		trigger.kind === "issue_fix_landed" && trigger.issueId
			? `(?:${regexLiteral(trigger.issueId)}|${regexLiteral(trigger.issueId.split("-").at(-1)!)})`
			: trigger.kind === "pr_merged" && trigger.prNumber
				? `(?:PR\\s*#?\\s*${trigger.prNumber}|#${trigger.prNumber})`
				: null;
	if (!object) return false;
	const completed = `(?:${object}\\s*(?:已经|已)\\s*(?:修好|修复|合入|完成)(?:了)?|${object}\\s+(?:(?:has|have)\\s+been|is\\s+already)\\s+(?:fixed|merged|landed|completed))`;
	const command =
		"(?:(?:请\\s*)?(?:(?:现在|马上|立即|立刻)\\s*){0,2}(?:直接\\s*)?(?:紧急\\s*)?重启|(?:please\\s+)?restart(?:\\s+(?:now|immediately))?)";
	const expression = request.authority.timeFrame.expression;
	if (expression !== null && !RESTART_DEADLINE_EXPRESSION.test(expression))
		return false;
	const deadline = expression
		? `\\s*[,，;；]\\s*(?:最晚\\s*)?${regexLiteral(expression)}(?:\\s*(?:前|之前))?(?:\\s*(?:完成|重启))?`
		: "";
	return new RegExp(
		`^\\s*${completed}\\s*[,，;；。]\\s*${command}${deadline}\\s*[。.!！]?\\s*$`,
		"iu",
	).test(content);
}

function derivedExplicitExpiry(
	expression: string,
	messageAt: number,
	timezone: string,
): number | null {
	const relativeZh = /(\d{1,3})\s*(分钟|小时)/u.exec(expression);
	if (relativeZh) {
		const amount = Number(relativeZh[1]);
		const unit = relativeZh[2] === "小时" ? 60 * 60_000 : 60_000;
		return amount > 0 ? messageAt + amount * unit : null;
	}
	const relativeEn = /(\d{1,3})\s*(minutes?|hours?)/iu.exec(expression);
	if (relativeEn) {
		const amount = Number(relativeEn[1]);
		const unit = /^hours?$/iu.test(relativeEn[2]!) ? 60 * 60_000 : 60_000;
		return amount > 0 ? messageAt + amount * unit : null;
	}

	const chinese =
		/(?:今天\s*)?(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:\s*[:：]\s*(\d{2})|\s*点(?:\s*(半|(\d{1,2})\s*分?))?)/u.exec(
			expression,
		);
	if (chinese) {
		const period = chinese[1] ?? "";
		let hour = Number(chinese[2]);
		const minute =
			chinese[4] === "半" ? 30 : Number(chinese[3] ?? chinese[5] ?? 0);
		if (hour > 24 || minute > 59) return null;
		if (["凌晨", "早上", "上午"].includes(period) && hour === 12) hour = 0;
		if (["中午", "下午"].includes(period) && hour < 12) hour += 12;
		if (period === "晚上") {
			if (hour === 12) hour = 24;
			else if (hour < 12) hour += 12;
		}
		const parts = localParts(new Date(messageAt), timezone);
		return localWallClockUtc(
			parts.year,
			parts.month,
			parts.day,
			hour,
			minute,
			timezone,
		);
	}

	const english =
		/(?:today\s+|tonight\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/iu.exec(
			expression,
		);
	if (english) {
		let hour = Number(english[1]);
		const minute = Number(english[2] ?? 0);
		if (hour < 1 || hour > 12 || minute > 59) return null;
		if (hour === 12) hour = 0;
		if (english[3]!.toLowerCase() === "pm") hour += 12;
		const parts = localParts(new Date(messageAt), timezone);
		return localWallClockUtc(
			parts.year,
			parts.month,
			parts.day,
			hour,
			minute,
			timezone,
		);
	}
	return null;
}

function validateMessageBinding(
	ref: RestartRequestV2["authority"]["messageRef"],
	message: RestartDiscordMessage,
	founderId: string,
): void {
	if (
		![ref.channelId, ref.messageId, ref.authorId, founderId].every((id) =>
			SNOWFLAKE.test(id),
		) ||
		ref.authorId !== founderId ||
		message.id !== ref.messageId ||
		message.channelId !== ref.channelId ||
		message.authorId !== founderId ||
		message.authorBot ||
		message.timestamp !== ref.timestamp ||
		finiteTime(message.timestamp, "founder-message-time-invalid") < 0 ||
		!DIGEST.test(ref.contentDigest) ||
		digest(message.content) !== ref.contentDigest
	)
		fail("founder-message-invalid");
}

function validateTimeFrame(
	request: RestartRequestV2,
	message: RestartDiscordMessage,
	context: RestartRequestContext,
): void {
	const frame = request.authority.timeFrame;
	if (frame.timezone !== context.founderTimezone) fail("timezone-stale");
	const messageAt = finiteTime(
		message.timestamp,
		"founder-message-time-invalid",
	);
	const expires = finiteTime(request.authority.expiresAt, "expiry-invalid");
	const hasNaturalDay = NATURAL_DAY_WINDOW.test(message.content);
	const hasTimeLanguage = TIME_LANGUAGE.test(message.content);
	if (hasTimeLanguage && frame.kind === "elapsed-24h")
		fail("time-frame-omission");
	if (frame.kind === "founder-local-day") {
		const derived = validText(frame.expression, 200)
			? derivedExplicitExpiry(frame.expression, messageAt, frame.timezone)
			: null;
		if (
			!hasNaturalDay ||
			!validText(frame.expression, 200) ||
			!message.content.includes(frame.expression) ||
			request.authority.expiresAt !==
				founderLocalDayExpiry(message.timestamp, frame.timezone) ||
			(derived !== null && derived !== expires)
		)
			fail("time-frame-invalid");
	} else if (frame.kind === "elapsed-24h") {
		if (
			frame.expression !== null ||
			hasNaturalDay ||
			expires !== messageAt + 24 * 60 * 60_000
		)
			fail("time-frame-invalid");
	} else if (frame.kind === "explicit") {
		if (
			!validText(frame.expression, 200) ||
			!message.content.includes(frame.expression) ||
			derivedExplicitExpiry(frame.expression, messageAt, frame.timezone) !==
				expires
		)
			fail("time-frame-invalid");
	} else {
		fail("time-frame-kind-invalid");
	}
	if (expires <= messageAt || expires > messageAt + MAX_INSTRUCTION_AGE_MS)
		fail("time-frame-invalid");
	if (context.now >= expires) fail("expired");
}

function triggerObject(request: RestartRequestV2): string {
	const trigger = request.trigger;
	if (trigger.kind === "issue_fix_landed") return trigger.issueId ?? "";
	if (trigger.kind === "pr_merged") return String(trigger.prNumber ?? "");
	return `${trigger.repo}:${trigger.evidence.mergedCommit}`;
}

function validateTrigger(
	request: RestartRequestV2,
	context: RestartRequestContext,
): void {
	const trigger = request.trigger;
	if (
		!SAFE_NAME.test(trigger.project) ||
		!SAFE_NAME.test(trigger.repo) ||
		trigger.repo !== FLYWHEEL_RESTART_REPO ||
		!validText(trigger.originalText) ||
		trigger.originalText !== context.founderMessage.content ||
		!validText(trigger.evidence.eventId) ||
		!SHA40.test(trigger.evidence.mergedCommit) ||
		!context.targetContainsCommit ||
		!RESTART_WORD.test(context.founderMessage.content)
	)
		fail("trigger-invalid");
	if (
		REVOCATION.test(context.founderMessage.content) ||
		RESTART_NEGATION.test(context.founderMessage.content)
	)
		fail("trigger-source-revoked");
	if (trigger.kind === "issue_fix_landed") {
		if (
			!trigger.issueId ||
			!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/.test(trigger.issueId) ||
			!context.founderMessage.content.includes(
				trigger.issueId.split("-").at(-1)!,
			) ||
			!CONDITIONAL_WORD.test(context.founderMessage.content)
		)
			fail("trigger-issue-invalid");
	} else if (trigger.kind === "pr_merged") {
		if (
			!Number.isSafeInteger(trigger.prNumber) ||
			(trigger.prNumber ?? 0) <= 0 ||
			!context.founderMessage.content.includes(String(trigger.prNumber)) ||
			!CONDITIONAL_WORD.test(context.founderMessage.content)
		)
			fail("trigger-pr-invalid");
	} else if (trigger.kind === "immediate") {
		const content = context.founderMessage.content;
		if (
			NAMED_RESTART_OBJECT.test(content) ||
			CONDITIONAL_FRAMING.test(content) ||
			(CONDITIONAL_WORD.test(content) &&
				!COMPLETED_STATE_ASSERTION.test(content))
		)
			fail("trigger-immediate-conditional");
		if (
			RESTART_NEGATION.test(content) ||
			!IMMEDIATE_RESTART_REQUEST.test(content) ||
			(QUESTION_MARKER.test(content) &&
				!IMMEDIATE_PERMISSION_QUESTION.test(content))
		)
			fail("trigger-immediate-unproven");
	} else {
		fail("trigger-kind-invalid");
	}
	if (
		trigger.kind !== "immediate" &&
		!isCurrentRestartAuthorization(request, context.founderMessage.content)
	)
		fail("trigger-conditional-unproven");
	if (!Array.isArray(trigger.evidence.verdicts)) fail("verdicts-invalid");
	const verdicts = trigger.evidence.verdicts;
	if (trigger.kind === "immediate") {
		if (verdicts.length !== 0) fail("verdicts-invalid");
		return;
	}
	const pullRequest = trigger.evidence.pullRequest;
	const verified = context.verifiedPullRequest;
	if (
		!pullRequest ||
		!Number.isSafeInteger(pullRequest.number) ||
		pullRequest.number <= 0 ||
		!SHA40.test(pullRequest.headSha) ||
		!verified ||
		verified.repo !== trigger.repo ||
		verified.number !== pullRequest.number ||
		verified.headSha !== pullRequest.headSha ||
		verified.mergeCommit !== trigger.evidence.mergedCommit ||
		verified.baseRef !== "main" ||
		(trigger.kind === "pr_merged" && pullRequest.number !== trigger.prNumber)
	)
		fail("pull-request-invalid");
	if (
		trigger.kind === "issue_fix_landed" &&
		!verified.issueIds.includes(trigger.issueId!)
	)
		fail("trigger-issue-unbound");
	if (
		verdicts.length < 2 ||
		!verdicts.some(
			(verdict) =>
				verdict.kind === "code-review" && verdict.status === "approved",
		) ||
		!verdicts.some(
			(verdict) => verdict.kind === "qa" && verdict.status === "pass",
		) ||
		verdicts.some(
			(verdict) =>
				!validText(verdict.id) ||
				!SHA40.test(verdict.headSha) ||
				verdict.headSha !== pullRequest.headSha,
		)
	)
		fail("verdicts-invalid");
}

function validateLeadAndAnnouncement(
	request: RestartRequestV2,
	context: RestartRequestContext,
): void {
	const by = request.requestedBy;
	if (
		![by.projectName, by.leadId].every((value) => SAFE_SEGMENT.test(value)) ||
		!(by.instanceId === "current" || DIGEST.test(by.instanceId)) ||
		!SNOWFLAKE.test(by.botUserId) ||
		!DIGEST.test(context.currentInstanceId) ||
		(by.instanceId !== "current" && by.instanceId !== context.currentInstanceId)
	)
		fail("lead-identity-invalid");
	const matches = context.leadRegistry.filter(
		(entry) =>
			entry.projectName === by.projectName &&
			entry.leadId === by.leadId &&
			entry.botUserId === by.botUserId,
	);
	if (matches.length !== 1) fail("lead-registry-invalid");
	const ann = request.announcement;
	const message = context.announcementMessage;
	if (
		![ann.channelId, ann.messageId, ann.authorId].every((id) =>
			SNOWFLAKE.test(id),
		) ||
		ann.authorId !== by.botUserId ||
		message.id !== ann.messageId ||
		message.channelId !== ann.channelId ||
		message.authorId !== by.botUserId ||
		message.authorBot !== true ||
		message.timestamp !== ann.timestamp ||
		digest(message.content) !== ann.contentDigest ||
		!DIGEST.test(ann.contentDigest) ||
		!validText(ann.purpose) ||
		!validText(ann.recoveryExpectations) ||
		!Array.isArray(ann.affectedScope) ||
		ann.affectedScope.length === 0 ||
		ann.affectedScope.some((scope) => !validText(scope, 200))
	)
		fail("announcement-invalid");
	const triggerValue = triggerObject(request);
	const required = [
		`[restart-request:${request.requestId}]`,
		`founder-message:${request.authority.messageRef.channelId}/${request.authority.messageRef.messageId}`,
		`trigger:${request.trigger.kind}:${request.trigger.project}:${triggerValue}`,
		`target:${request.targetSha}`,
		`purpose:${ann.purpose}`,
		`recovery:${ann.recoveryExpectations}`,
	];
	if (
		required.some((line) => !message.content.includes(line)) ||
		ann.affectedScope.some((scope) => !message.content.includes(scope))
	)
		fail("announcement-unbound");
	const founderAt = finiteTime(
		context.founderMessage.timestamp,
		"founder-message-time-invalid",
	);
	const announcementAt = finiteTime(ann.timestamp, "announcement-time-invalid");
	const createdAt = finiteTime(request.createdAt, "created-time-invalid");
	if (
		announcementAt <= founderAt ||
		announcementAt > createdAt ||
		createdAt > context.now + 5_000
	)
		fail("announcement-order-invalid");
}

function validateLaterContext(
	request: RestartRequestV2,
	context: RestartRequestContext,
): void {
	if (!context.contextComplete) fail("context-incomplete");
	const sourceAt = finiteTime(
		context.founderMessage.timestamp,
		"founder-message-time-invalid",
	);
	const object = triggerObject(request).toLowerCase();
	for (const message of context.laterFounderMessages) {
		const at = finiteTime(message.timestamp, "later-context-invalid");
		if (
			message.channelId !== request.authority.messageRef.channelId ||
			message.authorId !== context.founderId ||
			message.authorBot ||
			at <= sourceAt ||
			at > context.now
		)
			fail("later-context-invalid");
		const content = message.content.toLowerCase();
		if (
			REVOCATION.test(content) &&
			(content.includes(object) || RESTART_WORD.test(content))
		)
			fail("revoked");
	}
}

function validateTopLevel(request: RestartRequestV2): void {
	const value = record(request, "shape-invalid");
	exactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"requestId",
			"authority",
			"trigger",
			"requestedBy",
			"announcement",
			"fromDeployedSha",
			"targetSha",
			"createdAt",
		],
		"shape-invalid",
	);
	if (
		request.schemaVersion !== 2 ||
		request.kind !== "authorized-urgent-restart" ||
		!UUID.test(request.requestId) ||
		request.authority.kind !== "founder-per-instance" ||
		!SHA40.test(request.fromDeployedSha) ||
		!SHA40.test(request.targetSha)
	)
		fail("shape-invalid");
	exactKeys(
		record(request.authority, "shape-invalid"),
		["kind", "messageRef", "timeFrame", "expiresAt"],
		"shape-invalid",
	);
	exactKeys(
		record(request.authority.messageRef, "shape-invalid"),
		["channelId", "messageId", "authorId", "timestamp", "contentDigest"],
		"shape-invalid",
	);
	exactKeys(
		record(request.authority.timeFrame, "shape-invalid"),
		["kind", "timezone", "expression"],
		"shape-invalid",
	);
	exactKeys(
		record(request.trigger, "shape-invalid"),
		[
			"kind",
			"project",
			"repo",
			...(request.trigger.kind === "issue_fix_landed" ? ["issueId"] : []),
			...(request.trigger.kind === "pr_merged" ? ["prNumber"] : []),
			"originalText",
			"evidence",
		],
		"shape-invalid",
	);
	exactKeys(
		record(request.trigger.evidence, "shape-invalid"),
		[
			"eventId",
			"mergedCommit",
			...(request.trigger.kind === "immediate" ? [] : ["pullRequest"]),
			"verdicts",
		],
		"shape-invalid",
	);
	if (request.trigger.kind !== "immediate")
		exactKeys(
			record(request.trigger.evidence.pullRequest, "shape-invalid"),
			["number", "headSha"],
			"shape-invalid",
		);
	if (!Array.isArray(request.trigger.evidence.verdicts)) fail("shape-invalid");
	for (const verdict of request.trigger.evidence.verdicts)
		exactKeys(
			record(verdict, "shape-invalid"),
			["kind", "id", "status", "headSha"],
			"shape-invalid",
		);
	exactKeys(
		record(request.requestedBy, "shape-invalid"),
		["projectName", "leadId", "instanceId", "botUserId"],
		"shape-invalid",
	);
	exactKeys(
		record(request.announcement, "shape-invalid"),
		[
			"channelId",
			"messageId",
			"authorId",
			"timestamp",
			"contentDigest",
			"purpose",
			"affectedScope",
			"recoveryExpectations",
		],
		"shape-invalid",
	);
}

export function prepareRestartTicket(
	request: RestartRequestV2,
	context: RestartRequestContext,
): UrgentTicketV2 {
	validateTopLevel(request);
	if (
		!Number.isSafeInteger(context.now) ||
		context.now < 0 ||
		!SNOWFLAKE.test(context.founderId) ||
		!SHA40.test(context.deployedSha) ||
		!SHA40.test(context.remoteMainSha) ||
		!SHA40.test(context.preMergeHead) ||
		request.fromDeployedSha !== context.deployedSha ||
		request.targetSha !== context.remoteMainSha
	)
		fail("version-binding-invalid");
	validateMessageBinding(
		request.authority.messageRef,
		context.founderMessage,
		context.founderId,
	);
	validateTimeFrame(request, context.founderMessage, context);
	validateTrigger(request, context);
	validateLeadAndAnnouncement(request, context);
	validateLaterContext(request, context);
	const clean = JSON.parse(canonicalRestartJson(request)) as RestartRequestV2;
	clean.requestedBy.instanceId = context.currentInstanceId;
	return {
		...clean,
		preMergeHead: context.preMergeHead,
		validatedAt: new Date(context.now).toISOString(),
		requestDigest: digest(canonicalRestartJson(clean)),
	};
}

export function verifyRestartTicket(
	ticket: UrgentTicketV2,
	context: RestartRequestContext,
): UrgentTicketV2 {
	const raw = record(ticket, "ticket-shape-invalid");
	exactKeys(
		raw,
		[
			"schemaVersion",
			"kind",
			"requestId",
			"authority",
			"trigger",
			"requestedBy",
			"announcement",
			"fromDeployedSha",
			"targetSha",
			"createdAt",
			"preMergeHead",
			"validatedAt",
			"requestDigest",
		],
		"ticket-shape-invalid",
	);
	const {
		preMergeHead: storedPreMergeHead,
		validatedAt,
		requestDigest,
		...request
	} = ticket;
	if (
		storedPreMergeHead !== context.preMergeHead ||
		!DIGEST.test(requestDigest) ||
		requestDigest !== digest(canonicalRestartJson(request)) ||
		finiteTime(validatedAt, "ticket-validation-time-invalid") > context.now
	)
		fail("ticket-binding-invalid");
	// Re-run every mutable source check, but preserve the producer's validation
	// timestamp. Consumers may validate the same ticket minutes later; freshness
	// is governed by the founder instruction's expiresAt, not byte equality with
	// a newly generated validatedAt value.
	prepareRestartTicket(request, context);
	return JSON.parse(canonicalRestartJson(ticket)) as UrgentTicketV2;
}

type RestartTicket = UrgentTicketV2 | UrgentTicketV3;

function ticketIdentity(ticket: RestartTicket): string {
	return ticket.schemaVersion === 3 ? ticket.decisionId : ticket.requestId;
}

function intentKey(ticket: RestartTicket): string {
	return digest(
		canonicalRestartJson(
			ticket.schemaVersion === 3
				? {
						entryId: ticket.authority.entryId,
						founderChannelId: ticket.intent.messageRef.channelId,
						founderMessageId: ticket.intent.messageRef.messageId,
					}
				: {
						founderChannelId: ticket.authority.messageRef.channelId,
						founderMessageId: ticket.authority.messageRef.messageId,
					},
		),
	);
}

export function transitionRestartIntent(
	current: RestartIntentIndex | undefined,
	ticket: RestartTicket,
	action: {
		state: RestartIntentState;
		at: string;
		waveId?: string;
		zeroSideEffects?: true;
	},
): RestartIntentIndex {
	const at = finiteTime(action.at, "index-time-invalid");
	if (at < finiteTime(ticket.createdAt, "created-time-invalid"))
		fail("index-time-invalid");
	if (
		(action.state === "consumed-no-deploy" ||
			action.state === "started" ||
			action.state === "succeeded" ||
			action.state === "failed" ||
			action.state === "unknown") &&
		!validText(action.waveId, 200)
	)
		fail("wave-id-required");
	const index: RestartIntentIndex = current
		? (JSON.parse(canonicalRestartJson(current)) as RestartIntentIndex)
		: { schemaVersion: 1, intents: {} };
	if (index.schemaVersion !== 1 || !index.intents) fail("index-invalid");
	const key = intentKey(ticket);
	const prior = index.intents[key];
	const identity = ticketIdentity(ticket);
	if (!prior) {
		if (action.state !== "prepared") fail("index-must-prepare-first");
		index.intents[key] = {
			requestId: identity,
			requestDigest: ticket.requestDigest,
			...(ticket.schemaVersion === 3 ? { revision: ticket.revision } : {}),
			state: "prepared",
			updatedAt: action.at,
			...(ticket.schemaVersion === 3 ? { waveId: ticket.waveId } : {}),
		};
		return index;
	}
	const replacementAfterZeroSideEffectFailure =
		(prior.state === "failed" || prior.state === "consumed-no-deploy") &&
		prior.zeroSideEffects === true &&
		action.state === "prepared" &&
		action.zeroSideEffects === true &&
		(ticket.schemaVersion === 2 ||
			(prior.requestId === ticket.decisionId &&
				prior.waveId === ticket.waveId &&
				prior.revision !== undefined &&
				ticket.revision === prior.revision + 1));
	if (
		(prior.requestId !== identity ||
			prior.requestDigest !== ticket.requestDigest) &&
		!replacementAfterZeroSideEffectFailure
	)
		fail("already-used");
	if (replacementAfterZeroSideEffectFailure) {
		index.intents[key] = {
			requestId: identity,
			requestDigest: ticket.requestDigest,
			...(ticket.schemaVersion === 3 ? { revision: ticket.revision } : {}),
			state: "prepared",
			updatedAt: action.at,
			...(ticket.schemaVersion === 3 ? { waveId: ticket.waveId } : {}),
		};
		return index;
	}
	const legal =
		(prior.state === "prepared" && action.state === "prepared") ||
		(prior.state === "prepared" && action.state === "revoked") ||
		(prior.state === "revoked" && action.state === "revoked") ||
		(prior.state === "prepared" && action.state === "started") ||
		(prior.state === "prepared" &&
			action.state === "consumed-no-deploy" &&
			action.zeroSideEffects === true) ||
		(prior.state === "started" &&
			["succeeded", "failed", "unknown"].includes(action.state)) ||
		// Review round 5 HIGH (FLY-2654): a failed wave re-arms only when the
		// failure itself was recorded with zero service side effects. A
		// post-stop deploy failure is written without that flag and stays
		// terminal for this intent.
		(prior.state === "failed" &&
			prior.zeroSideEffects === true &&
			action.state === "prepared" &&
			action.zeroSideEffects === true);
	if (!legal) fail("already-used");
	if (prior.waveId && action.waveId && prior.waveId !== action.waveId)
		fail("wave-id-mismatch");
	// The zero-side-effect flag is provable only before the wave started
	// (prepared → consumed-no-deploy) or when the prior row already carried it.
	// It can never be stamped onto a started/failed/unknown row after the fact.
	if (
		action.zeroSideEffects === true &&
		(action.state === "started" ||
			(prior.state !== "prepared" && prior.zeroSideEffects !== true))
	)
		fail("side-effects-not-provable");
	// Review round 6 HIGH: the flag is never inherited across a wave start. A
	// producer re-submission (prepared → prepared) legitimately carries it,
	// but the moment `started` is minted the first service stop may already
	// have happened, so the started row and every row after it are unflagged
	// unless this very call proved it (guarded above).
	const { zeroSideEffects: inherited, ...carried } = prior;
	const provable =
		action.zeroSideEffects === true ||
		(inherited === true &&
			action.state !== "started" &&
			prior.state !== "started");
	index.intents[key] = {
		...carried,
		state: action.state,
		updatedAt: action.at,
		...(action.waveId ? { waveId: action.waveId } : {}),
		...(provable ? { zeroSideEffects: true as const } : {}),
	};
	return index;
}

export function restartIntentState(
	current: RestartIntentIndex,
	ticket: RestartTicket,
): RestartIntentState {
	if (current.schemaVersion !== 1 || !current.intents) fail("index-invalid");
	const entry = current.intents[intentKey(ticket)];
	if (
		!entry ||
		entry.requestId !== ticketIdentity(ticket) ||
		entry.requestDigest !== ticket.requestDigest
	)
		fail("intent-missing");
	return entry.state;
}

interface LiveRegistryLead {
	projectName: string;
	leadId: string;
	botUserId: string;
	botTokenEnv: string;
}

export interface RestartContextIo {
	fetch: typeof fetch;
	githubPull?: (repo: string, number: number) => unknown | Promise<unknown>;
	readFile(path: string): string;
	lstat(path: string): Stats;
	processAlive(pid: number): boolean;
	now(): number;
}

const defaultContextIo: RestartContextIo = {
	fetch,
	githubPull: (repo, number) => {
		const source = execFileSync(
			GITHUB_CLI,
			[
				"api",
				"--hostname",
				"github.com",
				`repos/${repo}/pulls/${number}`,
				"--header",
				"Accept: application/vnd.github+json",
				"--header",
				"X-GitHub-Api-Version: 2022-11-28",
			],
			{
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 512 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return JSON.parse(source);
	},
	readFile: (path) => readFileSync(path, "utf8"),
	lstat: lstatSync,
	processAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	now: Date.now,
};

function privateRegular(path: string, io: RestartContextIo): string {
	if (!isAbsolute(path)) fail("path-not-absolute");
	const stat = io.lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink()) fail("file-invalid");
	if ((stat.mode & 0o077) !== 0) fail("file-not-private");
	return io.readFile(path);
}

export function resolveLeadRuntimeInstanceId(input: {
	home: string;
	projectName: string;
	leadId: string;
	io?: RestartContextIo;
}): string {
	const io = input.io ?? defaultContextIo;
	if (
		!isAbsolute(input.home) ||
		!SAFE_SEGMENT.test(input.projectName) ||
		!SAFE_SEGMENT.test(input.leadId)
	)
		fail("lead-runtime-invalid");
	const path = join(
		input.home,
		".flywheel/manifests",
		`${input.projectName}-${input.leadId}.json`,
	);
	let manifest: Record<string, unknown>;
	let manifestStat: Stats;
	try {
		manifestStat = io.lstat(path);
		manifest = record(
			JSON.parse(privateRegular(path, io)),
			"lead-runtime-invalid",
		);
	} catch {
		fail("lead-runtime-invalid");
	}
	const pid = manifest.pid;
	if (
		manifest.projectName !== input.projectName ||
		manifest.leadId !== input.leadId ||
		!Number.isSafeInteger(pid) ||
		(pid as number) <= 0 ||
		!io.processAlive(pid as number)
	)
		fail("lead-runtime-invalid");

	const evidencePath = join(input.home, ".flywheel/lead-carrier-evidence.json");
	try {
		const evidence = record(
			JSON.parse(privateRegular(evidencePath, io)),
			"lead-runtime-invalid",
		);
		const collectedAt =
			typeof evidence.collectedAt === "string"
				? Date.parse(evidence.collectedAt)
				: Number.NaN;
		const leads = record(evidence.leads, "lead-runtime-invalid");
		const rawEntry = leads[`${input.projectName}-${input.leadId}`];
		if (rawEntry === undefined)
			throw Object.assign(new Error("no-entry"), { code: "ENOENT" });
		const entry = record(rawEntry, "lead-runtime-invalid");
		if (
			evidence.schemaVersion !== 1 ||
			!Number.isFinite(collectedAt) ||
			collectedAt > io.now() + 5_000 ||
			io.now() - collectedAt > 90_000 ||
			entry.leadKey !== `${input.projectName}-${input.leadId}` ||
			entry.backend !== "codex-app-server" ||
			entry.pid !== pid ||
			typeof entry.instanceDigest !== "string" ||
			!DIGEST.test(entry.instanceDigest)
		)
			fail("lead-runtime-invalid");
		return entry.instanceDigest as string;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			fail("lead-runtime-invalid");
	}

	return digest(
		canonicalRestartJson({
			projectName: input.projectName,
			leadId: input.leadId,
			pid,
			manifestInode: manifestStat.ino,
			manifestBirthtimeMs: manifestStat.birthtimeMs,
			manifestMtimeMs: manifestStat.mtimeMs,
		}),
	);
}

function parseDotEnv(source: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2]!.trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)
			value = value.slice(1, -1);
		result[match[1]!] = value;
	}
	return result;
}

function liveRegistry(
	projectsPath: string,
	requestedBy: RestartRequestV2["requestedBy"],
	io: RestartContextIo,
): LiveRegistryLead {
	const parsed: unknown = JSON.parse(privateRegular(projectsPath, io));
	if (!Array.isArray(parsed)) fail("registry-invalid");
	const rows: LiveRegistryLead[] = [];
	for (const rawProject of parsed) {
		const project = record(rawProject, "registry-invalid");
		if (project.projectName !== requestedBy.projectName) continue;
		if (!Array.isArray(project.leads)) fail("registry-invalid");
		for (const rawLead of project.leads) {
			const lead = record(rawLead, "registry-invalid");
			if (lead.agentId !== requestedBy.leadId) continue;
			if (
				typeof lead.botUserId !== "string" ||
				!SNOWFLAKE.test(lead.botUserId) ||
				typeof lead.botTokenEnv !== "string" ||
				!/^[A-Z][A-Z0-9_]{1,99}$/.test(lead.botTokenEnv)
			)
				fail("registry-invalid");
			rows.push({
				projectName: requestedBy.projectName,
				leadId: requestedBy.leadId,
				botUserId: lead.botUserId,
				botTokenEnv: lead.botTokenEnv,
			});
		}
	}
	if (rows.length !== 1 || rows[0]!.botUserId !== requestedBy.botUserId)
		fail("registry-invalid");
	return rows[0]!;
}

export function closeoutFounderChannels(input: {
	projectsPath: string;
	home: string;
	requestedBy: RestartRequestV2["requestedBy"];
	boundChannels: string[];
	founderId: string;
	intentAt: string;
	io: RestartContextIo;
}): string[] {
	const parsed: unknown = JSON.parse(
		privateRegular(input.projectsPath, input.io),
	);
	if (!Array.isArray(parsed)) fail("registry-invalid");
	const channels = new Set(input.boundChannels);
	let projectCount = 0;
	let leadCount = 0;
	for (const rawProject of parsed) {
		const project = record(rawProject, "registry-invalid");
		if (project.projectName !== input.requestedBy.projectName) continue;
		projectCount += 1;
		if (typeof project.generalChannel === "string")
			channels.add(project.generalChannel);
		if (!Array.isArray(project.leads)) fail("registry-invalid");
		for (const rawLead of project.leads) {
			const lead = record(rawLead, "registry-invalid");
			if (lead.agentId !== input.requestedBy.leadId) continue;
			leadCount += 1;
			for (const key of ["chatChannel", "alertChannel"] as const) {
				const value = lead[key];
				if (value !== undefined && value !== null) {
					if (typeof value !== "string") fail("registry-invalid");
					channels.add(value);
				}
			}
		}
	}
	const state = openRestartScopeDb(
		join(input.home, ".flywheel", "teamlead.db"),
	);
	try {
		const issueThreads = sqlRows(
			state,
			`SELECT thread_id FROM chat_threads
			  WHERE issue_id IN (
			    SELECT DISTINCT issue_id FROM sessions
			     WHERE project_name = ? AND terminal_at IS NULL
			  ) AND archived_at IS NULL AND discord_missing_at IS NULL
			 UNION
			 SELECT thread_id FROM phase_chat_threads
			  WHERE issue_id IN (
			    SELECT DISTINCT issue_id FROM sessions
			     WHERE project_name = ? AND terminal_at IS NULL
			  ) AND archived_at IS NULL AND discord_missing_at IS NULL`,
			[input.requestedBy.projectName, input.requestedBy.projectName],
		);
		for (const row of issueThreads) channels.add(String(row.thread_id));
	} finally {
		state.close();
	}

	const comm = openRestartScopeDb(
		join(
			input.home,
			".flywheel",
			"comm",
			input.requestedBy.projectName,
			"comm.db",
		),
	);
	try {
		const current = sqlRows(
			comm,
			`SELECT content FROM mailbox
			  WHERE source_kind IN ('discord_chat','voice')
			    AND from_agent = 'founder' AND to_agent = ?`,
			[input.requestedBy.leadId],
		);
		const archived = sqlRows(
			comm,
			`SELECT json_extract(mailbox_json, '$.content') AS content
			   FROM mailbox_terminal_archive
			  WHERE mailbox_json IS NOT NULL
			    AND json_extract(mailbox_json, '$.source_kind') IN ('discord_chat','voice')
			    AND json_extract(mailbox_json, '$.from_agent') = 'founder'
			    AND json_extract(mailbox_json, '$.to_agent') = ?`,
			[input.requestedBy.leadId],
		);
		finiteTime(input.intentAt, "withdrawal-context-incomplete");
		for (const row of [...current, ...archived]) {
			if (typeof row.content !== "string")
				fail("withdrawal-context-incomplete");
			let envelope: ReturnType<typeof parseChatDeliveryEnvelope>;
			try {
				envelope = parseChatDeliveryEnvelope(row.content);
			} catch {
				fail("withdrawal-context-incomplete");
			}
			if (
				envelope.leadId !== input.requestedBy.leadId ||
				envelope.authorId !== input.founderId ||
				!Number.isFinite(
					finiteTime(envelope.ts, "withdrawal-context-incomplete"),
				)
			)
				fail("withdrawal-context-incomplete");
			for (const channel of [
				envelope.chatId,
				envelope.originChannelId,
				envelope.replyChannelId,
				envelope.replyRoute?.parentChannelId,
				envelope.replyRoute?.threadId,
				envelope.replyTo?.channelId,
			]) {
				if (channel) channels.add(channel);
			}
		}
	} finally {
		comm.close();
	}
	if (
		projectCount !== 1 ||
		leadCount !== 1 ||
		[...channels].some((channel) => !SNOWFLAKE.test(channel))
	)
		fail("withdrawal-context-incomplete");
	return [...channels].sort();
}

async function boundedDiscordJson(
	path: string,
	token: string,
	io: RestartContextIo,
): Promise<unknown> {
	let response: Response;
	try {
		response = await io.fetch(`https://discord.com/api/v10${path}`, {
			method: "GET",
			headers: { Authorization: `Bot ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(5_000),
		});
	} catch {
		fail("discord-unavailable");
	}
	if (!response.ok) fail("discord-unavailable");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > 512 * 1024) fail("discord-response-too-large");
	try {
		return JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		fail("discord-response-invalid");
	}
}

export async function loadVerifiedPullRequest(
	request: RestartRequestV2,
	githubToken: string | undefined,
	io: RestartContextIo = defaultContextIo,
): Promise<RestartRequestContext["verifiedPullRequest"]> {
	if (request.trigger.kind === "immediate") return null;
	const repo = request.trigger.repo;
	const evidence = request.trigger.evidence.pullRequest;
	if (
		!GITHUB_REPO.test(repo) ||
		repo !== FLYWHEEL_RESTART_REPO ||
		!evidence ||
		!Number.isSafeInteger(evidence.number) ||
		evidence.number <= 0
	)
		fail("pull-request-invalid");
	let raw: unknown;
	try {
		if (io.githubPull) {
			raw = await io.githubPull(repo, evidence.number);
		} else {
			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"User-Agent": "flywheel-restart-request",
				"X-GitHub-Api-Version": "2022-11-28",
			};
			if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
			const response = await io.fetch(
				`https://api.github.com/repos/${repo}/pulls/${evidence.number}`,
				{
					method: "GET",
					headers,
					redirect: "error",
					signal: AbortSignal.timeout(5_000),
				},
			);
			if (!response.ok) fail("github-unavailable");
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > 512 * 1024) fail("github-response-too-large");
			raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
		}
	} catch {
		fail("github-unavailable");
	}
	const parsed = record(raw, "github-response-invalid");
	const head = record(parsed.head, "github-response-invalid");
	const base = record(parsed.base, "github-response-invalid");
	const baseRepo = record(base.repo, "github-response-invalid");
	if (
		parsed.number !== evidence.number ||
		parsed.state !== "closed" ||
		parsed.merged !== true ||
		typeof parsed.merged_at !== "string" ||
		!Number.isFinite(Date.parse(parsed.merged_at)) ||
		typeof head.sha !== "string" ||
		!SHA40.test(head.sha) ||
		typeof parsed.merge_commit_sha !== "string" ||
		!SHA40.test(parsed.merge_commit_sha) ||
		typeof parsed.title !== "string" ||
		(parsed.body !== null && typeof parsed.body !== "string") ||
		typeof head.ref !== "string" ||
		base.ref !== "main" ||
		baseRepo.full_name !== repo
	)
		fail("pull-request-invalid");
	const issueIds = [parsed.title, parsed.body ?? "", head.ref].flatMap(
		(value) =>
			Array.from(
				value.matchAll(
					/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-[1-9][0-9]*)(?=$|[^A-Za-z0-9])/g,
				),
				(match) => match[1]!,
			),
	);
	return {
		repo,
		number: evidence.number,
		headSha: head.sha,
		mergeCommit: parsed.merge_commit_sha,
		baseRef: base.ref,
		issueIds: [...new Set(issueIds)],
	};
}

function discordMessage(value: unknown): RestartDiscordMessage {
	const message = record(value, "discord-message-invalid");
	const author = record(message.author, "discord-message-invalid");
	if (
		typeof message.id !== "string" ||
		!SNOWFLAKE.test(message.id) ||
		typeof message.channel_id !== "string" ||
		!SNOWFLAKE.test(message.channel_id) ||
		typeof author.id !== "string" ||
		!SNOWFLAKE.test(author.id) ||
		typeof message.content !== "string" ||
		message.content.length > 100_000 ||
		typeof message.timestamp !== "string" ||
		!Number.isFinite(Date.parse(message.timestamp))
	)
		fail("discord-message-invalid");
	return {
		id: message.id,
		channelId: message.channel_id,
		authorId: author.id,
		authorBot: author.bot === true,
		content: message.content,
		timestamp: message.timestamp,
	};
}

async function laterFounderContext(input: {
	channelId: string;
	after: string;
	founderId: string;
	token: string;
	io: RestartContextIo;
}): Promise<RestartDiscordMessage[]> {
	const result: RestartDiscordMessage[] = [];
	let after = input.after;
	for (let page = 0; page < 10; page += 1) {
		const raw = await boundedDiscordJson(
			`/channels/${input.channelId}/messages?after=${after}&limit=100`,
			input.token,
			input.io,
		);
		if (!Array.isArray(raw)) fail("discord-context-invalid");
		const messages = raw
			.map(discordMessage)
			.sort((a, b) =>
				BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
			);
		if (messages.some((message) => message.channelId !== input.channelId))
			fail("discord-context-invalid");
		result.push(
			...messages.filter((message) => message.authorId === input.founderId),
		);
		if (messages.length < 100) return result;
		const next = messages.at(-1)?.id;
		if (!next || next === after) fail("discord-context-invalid");
		after = next;
	}
	fail("discord-context-incomplete");
}

async function laterFounderContextAcrossChannels(input: {
	channelIds: string[];
	after: string;
	founderId: string;
	token: string;
	io: RestartContextIo;
}): Promise<RestartDiscordMessage[]> {
	const byMessage = new Map<string, RestartDiscordMessage>();
	try {
		for (const channelId of input.channelIds) {
			for (const message of await laterFounderContext({
				channelId,
				after: input.after,
				founderId: input.founderId,
				token: input.token,
				io: input.io,
			})) {
				const prior = byMessage.get(message.id);
				if (
					prior &&
					canonicalRestartJson(prior) !== canonicalRestartJson(message)
				)
					fail("withdrawal-context-incomplete");
				byMessage.set(message.id, message);
			}
		}
	} catch {
		fail("withdrawal-context-incomplete");
	}
	return [...byMessage.values()].sort((left, right) =>
		BigInt(left.id) < BigInt(right.id)
			? -1
			: BigInt(left.id) > BigInt(right.id)
				? 1
				: 0,
	);
}

export async function loadRestartRequestContext(input: {
	request: RestartRequestV2;
	home: string;
	projectsPath: string;
	deployedSha: string;
	remoteMainSha: string;
	preMergeHead: string;
	targetContainsCommit: boolean;
	env?: Record<string, string | undefined>;
	founderTimezone?: string;
	consumer?: boolean;
	io?: RestartContextIo;
}): Promise<RestartRequestContext> {
	const io = input.io ?? defaultContextIo;
	const envPath = join(input.home, ".flywheel/.env");
	const dotenv = parseDotEnv(privateRegular(envPath, io));
	const env = { ...dotenv, ...(input.env ?? process.env) };
	const founderCandidates = [
		env.DISCORD_OWNER_USER_ID,
		env.FLYWHEEL_FOUNDER_USER_ID,
	].filter((value): value is string => Boolean(value));
	if (
		founderCandidates.length === 0 ||
		new Set(founderCandidates).size !== 1 ||
		!SNOWFLAKE.test(founderCandidates[0]!)
	)
		fail("founder-identity-invalid");
	const founderId = founderCandidates[0]!;
	const pullRequest = await loadVerifiedPullRequest(
		input.request,
		env.GH_TOKEN ?? env.GITHUB_TOKEN,
		io,
	);
	const lead = liveRegistry(input.projectsPath, input.request.requestedBy, io);
	const currentInstanceId = resolveLeadRuntimeInstanceId({
		home: input.home,
		projectName: lead.projectName,
		leadId: lead.leadId,
		io,
	});
	const token = env[lead.botTokenEnv];
	if (!token) fail("discord-token-unavailable");
	const bot = record(
		await boundedDiscordJson("/users/@me", token, io),
		"discord-bot-invalid",
	);
	if (bot.id !== lead.botUserId || bot.bot !== true)
		fail("discord-bot-invalid");
	const founderMessage = discordMessage(
		await boundedDiscordJson(
			`/channels/${input.request.authority.messageRef.channelId}/messages/${input.request.authority.messageRef.messageId}`,
			token,
			io,
		),
	);
	const announcementMessage = discordMessage(
		await boundedDiscordJson(
			`/channels/${input.request.announcement.channelId}/messages/${input.request.announcement.messageId}`,
			token,
			io,
		),
	);
	const laterFounderMessages = await laterFounderContext({
		channelId: input.request.authority.messageRef.channelId,
		after: input.request.authority.messageRef.messageId,
		founderId,
		token,
		io,
	});
	return {
		now: io.now(),
		founderId,
		founderTimezone: input.founderTimezone ?? resolveFounderTimezone(),
		founderMessage,
		announcementMessage,
		laterFounderMessages,
		contextComplete: true,
		leadRegistry: [lead],
		currentInstanceId,
		deployedSha: input.deployedSha,
		remoteMainSha: input.remoteMainSha,
		preMergeHead: input.preMergeHead,
		targetContainsCommit: input.targetContainsCommit,
		verifiedPullRequest: pullRequest,
	};
}

export function loadCurrentRestartScope(
	home: string,
	io: RestartContextIo,
	scopeRoot?: string,
): RestartScopeSnapshotV1 {
	const root = resolve(
		scopeRoot ?? join(home, ".flywheel", "state", "restart-scope"),
	);
	const snapshot = JSON.parse(
		privateRegular(join(root, "current.json"), io),
	) as RestartScopeSnapshotV1;
	const collected = collectRestartScopeRuntime(snapshot, home, io);
	if (!Array.isArray(snapshot.sources)) fail("scope-source-invalid");
	for (const source of snapshot.sources) {
		if (!SAFE_SEGMENT.test(source.kind) || !SAFE_SEGMENT.test(source.receiptId))
			fail("scope-source-invalid");
		const receipt = privateRegular(
			join(root, "receipts", source.kind, `${source.receiptId}.json`),
			io,
		);
		let parsed: Record<string, unknown>;
		try {
			parsed = record(JSON.parse(receipt), "scope-source-invalid");
		} catch {
			fail("scope-source-invalid");
		}
		exactKeys(
			parsed,
			["schemaVersion", "kind", "receiptId", "observedAt", "factsDigest"],
			"scope-source-invalid",
		);
		if (
			digest(receipt) !== source.digest ||
			parsed.schemaVersion !== 1 ||
			parsed.kind !== source.kind ||
			parsed.receiptId !== source.receiptId ||
			parsed.observedAt !== snapshot.capturedAt ||
			parsed.factsDigest !==
				digest(canonicalRestartJson(collected.facts[source.kind]))
		)
			fail("scope-drift");
	}
	const current = {
		...snapshot,
		entries: collected.entries,
		snapshotDigest: "",
	};
	current.snapshotDigest = closeoutScopeDigest(current);
	return current;
}

interface RestartScopeCollection {
	entries: RestartScopeSnapshotV1["entries"];
	facts: Record<RestartScopeSourceKind, unknown>;
}

function openRestartScopeDb(path: string) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) fail("scope-source-invalid");
	try {
		return new Database(path, { readonly: true, fileMustExist: true });
	} catch {
		fail("scope-source-invalid");
	}
}

function sqlRows(
	db: Database.Database,
	sql: string,
	parameters: unknown[] = [],
): Array<Record<string, unknown>> {
	try {
		return db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;
	} catch {
		fail("scope-source-invalid");
	}
}

function gitScopeText(worktree: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", worktree, ...args], {
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 512 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		fail("scope-worktree-invalid");
	}
}

function assertScopeTmux(target: string): void {
	if (!validText(target, 500)) fail("scope-process-invalid");
	try {
		execFileSync("tmux", ["has-session", "-t", target], {
			timeout: 3_000,
			stdio: "ignore",
		});
	} catch {
		fail("scope-process-invalid");
	}
}

function normalizeRepoRemote(remote: string): string {
	return remote
		.replace(/^git@github\.com:/, "")
		.replace(/^https:\/\/github\.com\//, "")
		.replace(/\.git$/, "");
}

export function collectRestartScopeRuntime(
	snapshot: RestartScopeSnapshotV1,
	home: string,
	io: RestartContextIo,
): RestartScopeCollection {
	if (!Array.isArray(snapshot.entries) || snapshot.entries.length === 0)
		fail("scope-entry-invalid");
	const draftIds = new Set<string>();
	for (const entry of snapshot.entries) {
		exactKeys(
			record(entry, "scope-entry-invalid"),
			[
				"executionId",
				"activationId",
				"project",
				"phase",
				"repo",
				"worktree",
				"headSha",
				"pushedHeadSha",
				"clean",
				"parked",
				"activeWrite",
				"pendingWakeIds",
				"verdict",
				"recovery",
			],
			"scope-entry-invalid",
		);
		exactKeys(
			record(entry.verdict, "scope-entry-invalid"),
			["kind", "receiptId", "status", "headSha"],
			"scope-entry-invalid",
		);
		exactKeys(
			record(entry.recovery, "scope-entry-invalid"),
			["path", "digest"],
			"scope-entry-invalid",
		);
		const verdictValid =
			(entry.phase === "implement" &&
				entry.verdict.kind === "code-review" &&
				entry.verdict.status === "approved") ||
			(entry.phase === "qa" &&
				entry.verdict.kind === "qa" &&
				entry.verdict.status === "pass") ||
			(entry.phase === "design" &&
				entry.verdict.kind === "phase-not-applicable" &&
				entry.verdict.status === "not-applicable");
		if (
			!UUID.test(entry.executionId) ||
			draftIds.has(entry.executionId) ||
			!validText(entry.activationId, 500) ||
			!SAFE_SEGMENT.test(entry.project) ||
			!GITHUB_REPO.test(entry.repo) ||
			!isAbsolute(entry.worktree) ||
			!SHA40.test(entry.headSha) ||
			!SHA40.test(entry.pushedHeadSha) ||
			typeof entry.clean !== "boolean" ||
			typeof entry.parked !== "boolean" ||
			typeof entry.activeWrite !== "boolean" ||
			!Array.isArray(entry.pendingWakeIds) ||
			entry.pendingWakeIds.some((wake) => !validText(wake, 500)) ||
			!validText(entry.verdict.receiptId, 500) ||
			entry.verdict.headSha !== entry.headSha ||
			!verdictValid ||
			!isAbsolute(entry.recovery.path) ||
			!DIGEST.test(entry.recovery.digest)
		)
			fail("scope-entry-invalid");
		draftIds.add(entry.executionId);
	}
	const statePath = join(home, ".flywheel", "teamlead.db");
	const state = openRestartScopeDb(statePath);
	try {
		const stateSessions = sqlRows(
			state,
			`SELECT execution_id, project_name, worktree_path, status, terminal_at,
			        session_role, workflow_node_id, pr_head_sha
			   FROM sessions
			  WHERE terminal_at IS NULL
			  ORDER BY execution_id`,
		);
		const expectedIds = snapshot.entries
			.map((entry) => entry.executionId)
			.sort();
		const stateIds = stateSessions
			.map((row) => String(row.execution_id))
			.sort();
		if (canonicalRestartJson(expectedIds) !== canonicalRestartJson(stateIds))
			fail("scope-inventory-drift");

		const stateFacts: unknown[] = [];
		const commFacts: unknown[] = [];
		const turnWakeFacts: unknown[] = [];
		const processFacts: unknown[] = [];
		const nextEntries: RestartScopeSnapshotV1["entries"] = [];
		const commByProject = new Map<
			string,
			ReturnType<typeof openRestartScopeDb>
		>();
		try {
			const commRoot = join(home, ".flywheel", "comm");
			let commProjects: string[];
			try {
				commProjects = readdirSync(commRoot, { withFileTypes: true }).map(
					(item) => {
						if (
							!item.isDirectory() ||
							item.isSymbolicLink() ||
							!SAFE_SEGMENT.test(item.name)
						)
							fail("scope-source-invalid");
						return item.name;
					},
				);
			} catch {
				fail("scope-source-invalid");
			}
			for (const project of commProjects.sort()) {
				const comm = openRestartScopeDb(join(commRoot, project, "comm.db"));
				commByProject.set(project, comm);
				const activeComm = sqlRows(
					comm,
					`SELECT execution_id, tmux_window, project_name, issue_id, lead_id,
					        status, phase_keep_alive
					   FROM sessions WHERE status IN ('running','blocked')
					  ORDER BY execution_id`,
				);
				const expectedProjectIds = snapshot.entries
					.filter((entry) => entry.project === project)
					.map((entry) => entry.executionId)
					.sort();
				const activeProjectIds = activeComm
					.map((row) => String(row.execution_id))
					.sort();
				if (
					canonicalRestartJson(expectedProjectIds) !==
					canonicalRestartJson(activeProjectIds)
				)
					fail("scope-inventory-drift");
				commFacts.push({ project, inventory: activeComm });
			}
			for (const claimed of [...snapshot.entries].sort((a, b) =>
				a.executionId.localeCompare(b.executionId),
			)) {
				const session = stateSessions.find(
					(row) => row.execution_id === claimed.executionId,
				);
				if (
					!session ||
					session.project_name !== claimed.project ||
					session.worktree_path !== claimed.worktree ||
					session.session_role !== claimed.phase
				)
					fail("scope-state-drift");
				const bindings = sqlRows(
					state,
					`SELECT activation_id, run_id, node_id, attempt, mode, bound_at
					   FROM workflow_execution_binding
					  WHERE execution_id = ? ORDER BY bound_at DESC LIMIT 1`,
					[claimed.executionId],
				);
				if (
					bindings.length !== 1 ||
					bindings[0]!.activation_id !== claimed.activationId
				)
					fail("scope-state-drift");
				const binding = bindings[0]!;
				let verdictFact: Record<string, unknown>;
				if (claimed.phase === "implement") {
					const rows = sqlRows(
						state,
						`SELECT request_id, verdict_event_id, status, target_pr_head_sha,
						        approved_at, author_family, reviewer_family
						   FROM codex_review_record
						  WHERE execution_id = ? AND target_repo_identity = '__main__'
						    AND target_pr_head_sha = ? AND status = 'approved'
						  ORDER BY approved_at DESC LIMIT 2`,
						[claimed.executionId, claimed.headSha],
					);
					if (
						rows.length !== 1 ||
						![rows[0]!.request_id, rows[0]!.verdict_event_id].includes(
							claimed.verdict.receiptId,
						)
					)
						fail("scope-verdict-drift");
					verdictFact = rows[0]!;
				} else if (claimed.phase === "qa") {
					const claimId = Number(claimed.verdict.receiptId);
					if (!Number.isSafeInteger(claimId) || claimId < 1)
						fail("scope-verdict-drift");
					const rows = sqlRows(
						state,
						`SELECT id, server_seq, workflow_run_id, node_id, attempt, predicate,
						        issuer_execution_id, subject_kind, subject_digest, permanent,
						        expires_at, authority_id
						   FROM workflow_claims claim
						  WHERE id = ? AND decision_kind = 'qa_verdict'
						    AND predicate = 'qa_passed' AND issuer_kind = 'runner_node'
						    AND issuer_execution_id = ? AND subject_kind = 'git_head'
						    AND lower(subject_digest) = ?
						    AND NOT EXISTS (SELECT 1 FROM workflow_claim_revocation rev WHERE rev.claim_id = claim.id)
						    AND NOT EXISTS (
						      SELECT 1 FROM workflow_claims later
						       WHERE later.workflow_run_id = claim.workflow_run_id
						         AND later.decision_kind = 'qa_verdict' AND later.server_seq > claim.server_seq
						         AND later.predicate <> 'qa_passed'
						         AND NOT EXISTS (SELECT 1 FROM workflow_claim_revocation r2 WHERE r2.claim_id = later.id)
						    )`,
						[claimId, claimed.executionId, claimed.headSha],
					);
					if (rows.length !== 1) fail("scope-verdict-drift");
					verdictFact = rows[0]!;
				} else {
					const rows = sqlRows(
						state,
						`SELECT source_event_id, event_uid, route, completed_at
						   FROM workflow_node_completion
						  WHERE execution_id = ? AND activation_id = ?
						    AND (source_event_id = ? OR event_uid = ?)`,
						[
							claimed.executionId,
							claimed.activationId,
							claimed.verdict.receiptId,
							claimed.verdict.receiptId,
						],
					);
					if (rows.length !== 1) fail("scope-verdict-drift");
					verdictFact = rows[0]!;
				}

				const comm = commByProject.get(claimed.project);
				if (!comm) fail("scope-inventory-drift");
				const commRows = sqlRows(
					comm,
					`SELECT execution_id, tmux_window, project_name, issue_id, lead_id,
					        status, phase_keep_alive
					   FROM sessions WHERE execution_id = ? AND status IN ('running','blocked')`,
					[claimed.executionId],
				);
				if (commRows.length !== 1) fail("scope-comm-drift");
				const declared = sqlRows(
					comm,
					`SELECT kind, reason, created_at, expires_at, updated_at
					   FROM runner_declared_states
					  WHERE execution_id = ? AND kind = 'parked'
					    AND (expires_at IS NULL OR expires_at > ?)`,
					[claimed.executionId, io.now()],
				);
				const parks = sqlRows(
					comm,
					`SELECT run_id, node_id, attempt, activation_id, generation, state,
					        reason, source_row_id, updated_at
					   FROM workflow_engine_park
					  WHERE execution_id = ? AND state = 'open'`,
					[claimed.executionId],
				);
				const parked = declared.length === 1 || parks.length === 1;
				if (declared.length > 1 || parks.length > 1) fail("scope-comm-drift");
				const turnRows = sqlRows(
					comm,
					`SELECT issue_id, holder_exec_id, phase, epoch, activation_id,
					        active_turn_id, turn_generation
					   FROM three_stage_turn WHERE holder_exec_id = ?`,
					[claimed.executionId],
				);
				if (
					turnRows.length > 1 ||
					turnRows.some(
						(row) =>
							row.active_turn_id !== null &&
							!validText(row.active_turn_id, 500),
					)
				)
					fail("scope-comm-drift");
				const phaseWakes = sqlRows(
					comm,
					`SELECT message_id AS wake_id, state, queued_at
					   FROM runner_phase_wakes
					  WHERE execution_id = ? AND state IN ('pending','started')`,
					[claimed.executionId],
				);
				const turnWakes = sqlRows(
					comm,
					`SELECT wake_id, state, created_at
					   FROM turn_wake_outbox
					  WHERE execution_id = ? AND state IN ('pending','sent')`,
					[claimed.executionId],
				);
				const pendingWakeIds = [...phaseWakes, ...turnWakes]
					.map((row) => String(row.wake_id))
					.sort();
				const activeWrite = turnRows.some((row) => row.active_turn_id !== null);

				const headSha = gitScopeText(claimed.worktree, ["rev-parse", "HEAD"]);
				const pushedHeadSha = gitScopeText(claimed.worktree, [
					"rev-parse",
					"@{upstream}",
				]);
				if (headSha !== pushedHeadSha) fail("scope-worktree-unpushed");
				const status = gitScopeText(claimed.worktree, [
					"status",
					"--porcelain",
				]);
				const remote = normalizeRepoRemote(
					gitScopeText(claimed.worktree, [
						"config",
						"--get",
						"remote.origin.url",
					]),
				);
				if (remote !== claimed.repo) fail("scope-worktree-invalid");
				const recovery = privateRegular(claimed.recovery.path, io);
				if (digest(recovery) !== claimed.recovery.digest)
					fail("scope-recovery-drift");
				assertScopeTmux(String(commRows[0]!.tmux_window));

				const entry: RestartScopeSnapshotV1["entries"][number] = {
					...claimed,
					headSha,
					pushedHeadSha,
					clean: status.length === 0,
					parked,
					activeWrite,
					pendingWakeIds,
				};
				nextEntries.push(entry);
				stateFacts.push({ session, binding, verdict: verdictFact });
				commFacts.push({ session: commRows[0], declared, parks });
				turnWakeFacts.push({
					executionId: claimed.executionId,
					turnRows,
					phaseWakes,
					turnWakes,
				});
				processFacts.push({
					executionId: claimed.executionId,
					tmuxWindow: commRows[0]!.tmux_window,
					worktree: claimed.worktree,
					headSha,
					pushedHeadSha,
					clean: status.length === 0,
					remote,
					recoveryDigest: digest(recovery),
				});
			}
		} finally {
			for (const comm of commByProject.values()) comm.close();
		}
		return {
			entries: nextEntries,
			facts: {
				"state-store": stateFacts,
				"comm-db": commFacts,
				"turn-wake": turnWakeFacts,
				"process-service": processFacts,
			},
		};
	} finally {
		state.close();
	}
}

export function materializeRestartScopeSnapshot(input: {
	home: string;
	draft: RestartScopeSnapshotV1;
	receiptId: string;
	scopeRoot?: string;
	io?: RestartContextIo;
}): RestartScopeSnapshotV1 {
	if (!SAFE_SEGMENT.test(input.receiptId)) fail("scope-source-invalid");
	const io = input.io ?? defaultContextIo;
	const collected = collectRestartScopeRuntime(input.draft, input.home, io);
	const capturedAt = new Date(io.now()).toISOString();
	const root = resolve(
		input.scopeRoot ?? join(input.home, ".flywheel", "state", "restart-scope"),
	);
	const sources = (
		[
			"state-store",
			"comm-db",
			"turn-wake",
			"process-service",
		] as RestartScopeSourceKind[]
	).map((kind) => {
		const receipt = {
			schemaVersion: 1,
			kind,
			receiptId: input.receiptId,
			observedAt: capturedAt,
			factsDigest: digest(canonicalRestartJson(collected.facts[kind])),
		};
		const bytes = `${canonicalRestartJson(receipt)}\n`;
		atomicWritePrivate(
			join(root, "receipts", kind, `${input.receiptId}.json`),
			bytes,
		);
		return { kind, receiptId: input.receiptId, digest: digest(bytes) };
	});
	const snapshot: RestartScopeSnapshotV1 = {
		version: "restart-scope-snapshot/v1",
		capturedAt,
		sources,
		entries: collected.entries,
		snapshotDigest: "",
	};
	snapshot.snapshotDigest = closeoutScopeDigest(snapshot);
	atomicWritePrivate(
		join(root, "current.json"),
		`${canonicalRestartJson(snapshot)}\n`,
	);
	return snapshot;
}

export async function loadRestartCloseoutContext(input: {
	request: RestartRequestV3;
	home: string;
	projectsPath: string;
	deployedSha: string;
	remoteMainSha: string;
	preMergeHead: string;
	scopeRoot?: string;
	env?: Record<string, string | undefined>;
	founderTimezone?: string;
	io?: RestartContextIo;
}): Promise<RestartCloseoutContext> {
	const io = input.io ?? defaultContextIo;
	const envPath = join(input.home, ".flywheel/.env");
	const dotenv = parseDotEnv(privateRegular(envPath, io));
	const env = { ...dotenv, ...(input.env ?? process.env) };
	const founderCandidates = [
		env.DISCORD_OWNER_USER_ID,
		env.FLYWHEEL_FOUNDER_USER_ID,
	].filter((value): value is string => Boolean(value));
	if (
		founderCandidates.length === 0 ||
		new Set(founderCandidates).size !== 1 ||
		!SNOWFLAKE.test(founderCandidates[0]!)
	)
		fail("founder-identity-invalid");
	const founderId = founderCandidates[0]!;
	const lead = liveRegistry(input.projectsPath, input.request.requestedBy, io);
	const currentInstanceId = resolveLeadRuntimeInstanceId({
		home: input.home,
		projectName: lead.projectName,
		leadId: lead.leadId,
		io,
	});
	const token = env[lead.botTokenEnv];
	if (!token) fail("discord-token-unavailable");
	const bot = record(
		await boundedDiscordJson("/users/@me", token, io),
		"discord-bot-invalid",
	);
	if (bot.id !== lead.botUserId || bot.bot !== true)
		fail("discord-bot-invalid");
	const founderMessage = discordMessage(
		await boundedDiscordJson(
			`/channels/${input.request.intent.messageRef.channelId}/messages/${input.request.intent.messageRef.messageId}`,
			token,
			io,
		),
	);
	const announcementMessage = discordMessage(
		await boundedDiscordJson(
			`/channels/${input.request.announcement.channelId}/messages/${input.request.announcement.messageId}`,
			token,
			io,
		),
	);
	const waiverMessage =
		input.request.readiness.kind === "founder-recast-waiver"
			? discordMessage(
					await boundedDiscordJson(
						`/channels/${input.request.readiness.messageRef.channelId}/messages/${input.request.readiness.messageRef.messageId}`,
						token,
						io,
					),
				)
			: undefined;
	const laterFounderMessages = await laterFounderContextAcrossChannels({
		channelIds: closeoutFounderChannels({
			projectsPath: input.projectsPath,
			home: input.home,
			requestedBy: input.request.requestedBy,
			boundChannels: [
				input.request.intent.messageRef.channelId,
				input.request.announcement.channelId,
			],
			founderId,
			intentAt: input.request.intent.messageRef.timestamp,
			io,
		}),
		after: input.request.intent.messageRef.messageId,
		founderId,
		token,
		io,
	});
	let active: ReturnType<typeof loadVerifiedStandingAuthority>;
	try {
		active = loadVerifiedStandingAuthority(
			// Resolved from the process environment only, exactly like the shell
			// fences and the Raya standing authorization (review round 6 LOW).
			resolveStandingAuthorityStateDir(input.home, input.env ?? process.env),
			"lead-closeout-restart/v1",
			{ ledgerPath: resolveStandingAuthorityLedgerPath(input.home) },
		);
	} catch {
		fail("standing-authority-inactive");
	}
	return {
		now: io.now(),
		founderId,
		founderTimezone: input.founderTimezone ?? resolveFounderTimezone(),
		founderMessage,
		...(waiverMessage ? { waiverMessage } : {}),
		announcementMessage,
		laterFounderMessages,
		contextComplete: true,
		leadRegistry: [lead],
		currentInstanceId,
		deployedSha: input.deployedSha,
		remoteMainSha: input.remoteMainSha,
		preMergeHead: input.preMergeHead,
		activeAuthority: {
			entryDigest: active.verification.entryDigest,
			manifestRevision: active.verification.revision,
			manifestDigest: active.verification.manifestDigest,
			packageDigest: active.verification.packageDigest,
			packageRoot: active.manifest.enforcementDeployment.immutableRoot,
			sourceCommit: active.manifest.enforcementDeployment.commit,
		},
		currentScopeSnapshot: loadCurrentRestartScope(
			input.home,
			io,
			input.scopeRoot,
		),
	};
}

function readRequestFile(path: string): RestartRequestV2 | RestartRequestV3 {
	return JSON.parse(privateRegular(resolve(path), defaultContextIo));
}

function readTicketFile(path: string): RestartTicket {
	return JSON.parse(privateRegular(resolve(path), defaultContextIo));
}

function atomicWritePrivate(path: string, value: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	chmodSync(dirname(path), 0o700);
	const temp = join(
		dirname(path),
		`.${path.split("/").at(-1)}.${process.pid}.${Date.now()}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, value, "utf8");
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temp);
		} catch {
			// The rename path is the normal successful case.
		}
	}
}

function transitionFile(input: {
	indexPath: string;
	ticket: RestartTicket;
	state: RestartIntentState;
	at: string;
	waveId?: string;
	zeroSideEffects?: true;
}): RestartIntentIndex {
	const indexPath = resolve(input.indexPath);
	const lock = `${indexPath}.lock.d`;
	mkdirSync(dirname(indexPath), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch {
		fail("index-lock-busy");
	}
	try {
		let current: RestartIntentIndex | undefined;
		if (existsSync(indexPath)) {
			const stat = lstatSync(indexPath);
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
				fail("index-invalid");
			current = JSON.parse(readFileSync(indexPath, "utf8"));
		}
		const next = transitionRestartIntent(current, input.ticket, {
			state: input.state,
			at: input.at,
			...(input.waveId ? { waveId: input.waveId } : {}),
			...(input.zeroSideEffects ? { zeroSideEffects: true as const } : {}),
		});
		atomicWritePrivate(indexPath, `${canonicalRestartJson(next)}\n`);
		return next;
	} finally {
		rmdirSync(lock);
	}
}

function intentStateFile(input: {
	indexPath: string;
	ticket: RestartTicket;
}): RestartIntentState {
	const current = JSON.parse(
		privateRegular(resolve(input.indexPath), defaultContextIo),
	) as RestartIntentIndex;
	return restartIntentState(current, input.ticket);
}

async function cli(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		strict: true,
		options: {
			request: { type: "string" },
			ticket: { type: "string" },
			home: { type: "string" },
			projects: { type: "string" },
			"deployed-sha": { type: "string" },
			"remote-sha": { type: "string" },
			"pre-merge-head": { type: "string" },
			"contains-trigger": { type: "boolean" },
			project: { type: "string" },
			lead: { type: "string" },
			index: { type: "string" },
			state: { type: "string" },
			at: { type: "string" },
			"wave-id": { type: "string" },
			"zero-side-effects": { type: "boolean" },
			"allow-started-v2-recovery": { type: "boolean" },
			"scope-root": { type: "string" },
		},
	});
	const command = positionals[0];
	if (command === "instance") {
		const home = resolve(values.home ?? homedir());
		const instanceId = resolveLeadRuntimeInstanceId({
			home,
			projectName: values.project ?? "",
			leadId: values.lead ?? "",
		});
		process.stdout.write(`${instanceId}\n`);
		return;
	}
	if (command === "scope-snapshot") {
		const candidate = readRequestFile(values.request ?? "");
		if (candidate.schemaVersion !== 3) fail("shape-invalid");
		validateCloseoutTopLevel(candidate);
		const result = materializeRestartScopeSnapshot({
			home: resolve(values.home ?? homedir()),
			draft: candidate.scopeSnapshot,
			receiptId: `${candidate.decisionId}-r${candidate.revision}`,
			...(values["scope-root"]
				? { scopeRoot: resolve(values["scope-root"]) }
				: {}),
		});
		process.stdout.write(`${canonicalRestartJson(result)}\n`);
		return;
	}
	if (command === "prepare" || command === "verify") {
		const candidate =
			command === "prepare"
				? readRequestFile(values.request ?? "")
				: readTicketFile(values.ticket ?? "");
		const home = resolve(values.home ?? homedir());
		const projectsPath = resolve(
			values.projects ?? join(home, ".flywheel/projects.json"),
		);
		if (candidate.schemaVersion === 3) {
			const ticket =
				command === "verify" ? (candidate as UrgentTicketV3) : undefined;
			const request = ticket
				? (({
						preMergeHead: _preMergeHead,
						validatedAt: _validatedAt,
						requestDigest: _requestDigest,
						...body
					}) => body)(ticket)
				: (candidate as RestartRequestV3);
			const context = await loadRestartCloseoutContext({
				request,
				home,
				projectsPath,
				deployedSha: values["deployed-sha"] ?? "",
				remoteMainSha: values["remote-sha"] ?? "",
				preMergeHead: values["pre-merge-head"] ?? "",
				...(values["scope-root"]
					? { scopeRoot: resolve(values["scope-root"]) }
					: {}),
			});
			const result = ticket
				? verifyCloseoutRestartTicket(ticket, context)
				: prepareCloseoutRestartTicket(request, context);
			process.stdout.write(`${canonicalRestartJson(result)}\n`);
			return;
		}
		if (candidate.schemaVersion !== 2) fail("shape-invalid");
		if (command === "prepare") fail("retired-conditional-authority");
		if (
			values["allow-started-v2-recovery"] !== true ||
			!values.index ||
			intentStateFile({
				indexPath: values.index,
				ticket: candidate as UrgentTicketV2,
			}) !== "started"
		)
			fail("retired-conditional-authority");
		const legacyTicket = candidate as UrgentTicketV2;
		const {
			preMergeHead: _preMergeHead,
			validatedAt: _validatedAt,
			requestDigest: _requestDigest,
			...legacyRequest
		} = legacyTicket;
		const legacyContext = await loadRestartRequestContext({
			request: legacyRequest,
			home,
			projectsPath,
			deployedSha: values["deployed-sha"] ?? "",
			remoteMainSha: values["remote-sha"] ?? "",
			preMergeHead: values["pre-merge-head"] ?? "",
			targetContainsCommit: values["contains-trigger"] === true,
			consumer: true,
		});
		process.stdout.write(
			`${canonicalRestartJson(verifyRestartTicket(legacyTicket, legacyContext))}\n`,
		);
		return;
	}
	if (command === "transition") {
		const state = values.state as RestartIntentState;
		if (
			![
				"prepared",
				"revoked",
				"consumed-no-deploy",
				"started",
				"succeeded",
				"failed",
				"unknown",
			].includes(state)
		)
			fail("state-invalid");
		const result = transitionFile({
			indexPath: values.index ?? "",
			ticket: readTicketFile(values.ticket ?? ""),
			state,
			at: values.at ?? new Date().toISOString(),
			...(values["wave-id"] ? { waveId: values["wave-id"] } : {}),
			...(values["zero-side-effects"]
				? { zeroSideEffects: true as const }
				: {}),
		});
		process.stdout.write(`${canonicalRestartJson(result)}\n`);
		return;
	}
	if (command === "intent-state") {
		const state = intentStateFile({
			indexPath: values.index ?? "",
			ticket: readTicketFile(values.ticket ?? ""),
		});
		process.stdout.write(`${state}\n`);
		return;
	}
	fail("usage");
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	cli().catch((error: unknown) => {
		const message =
			error instanceof Error ? error.message : "restart-request-unknown";
		process.stderr.write(`${message.slice(0, 500)}\n`);
		process.exitCode = 1;
	});
}
