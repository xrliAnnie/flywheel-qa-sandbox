#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveFounderId } from "flywheel-comm/founder-attribution";
import { type MigrationIO, migrationIO } from "./raya-migration-io.js";
import type { CursorSeed } from "./seed-lead-inbound-cursor.js";

const SNOWFLAKE = /^[0-9]{17,20}$/;
const SHA40 = /^[0-9a-f]{40}$/;

import { loadVerifiedStandingAuthority } from "./standing-authority-activation-store.js";
import {
	resolveStandingAuthorityLedgerPath,
	resolveStandingAuthorityStateDir,
} from "./standing-authority-confirmation-ledger.js";

export interface FounderMigrationAuthorization {
	legacy_stop: true;
	granted_by: "founder";
	granted_at: string;
	evidence_message_id: string;
	evidence_channel_id: string;
	evidence_author_id: string;
	content_sha256: string;
	canonical_line: string;
	issued_by: "flywheel-eng-lead";
}

export interface StandingMigrationAuthorization {
	legacy_stop: true;
	granted_by: "standing-carve-out";
	entry_id: "raya-carrier-follow-main/v1";
	entry_digest: string;
	activation_manifest_digest: string;
	manifest_revision: number;
	mechanism_version: string;
	execution_package_digest: string;
	confirmed_by: "flywheel-cos-lead";
	confirmation_receipt_id: string;
	issued_by: "flywheel-eng-lead";
}

export type MigrationAuthorization =
	| FounderMigrationAuthorization
	| StandingMigrationAuthorization;

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid-object");
	return value as Record<string, unknown>;
}

export function verifyMigrationAuthorization(input: {
	message: unknown;
	targetRayaSha: string;
	messageId: string;
	channelId: string;
	founder: Parameters<typeof resolveFounderId>[0];
}): FounderMigrationAuthorization {
	const founderId = resolveFounderId(input.founder);
	if (
		!founderId ||
		!SNOWFLAKE.test(founderId) ||
		!SHA40.test(input.targetRayaSha) ||
		!SNOWFLAKE.test(input.messageId) ||
		!SNOWFLAKE.test(input.channelId)
	)
		throw new Error("authorization-identity-invalid");
	const message = object(input.message);
	const author = object(message.author);
	const canonical = `FLY-2496 AUTHORIZE register cutover=${input.targetRayaSha.slice(0, 8)} urgent-restart baseline=quiet15m`;
	if (
		message.id !== input.messageId ||
		message.channel_id !== input.channelId ||
		author.id !== founderId ||
		author.bot === true ||
		typeof message.content !== "string" ||
		!message.content.split(/\r?\n/).some((line) => line.trim() === canonical) ||
		typeof message.timestamp !== "string" ||
		!Number.isFinite(Date.parse(message.timestamp))
	)
		throw new Error("authorization-message-invalid");
	return {
		legacy_stop: true,
		granted_by: "founder",
		granted_at: message.timestamp,
		evidence_message_id: input.messageId,
		evidence_channel_id: input.channelId,
		evidence_author_id: founderId,
		content_sha256: createHash("sha256").update(message.content).digest("hex"),
		canonical_line: canonical,
		issued_by: "flywheel-eng-lead",
	};
}

export function verifyStoredFounderMigrationAuthorization(
	targetRayaSha: string,
	value: unknown,
): FounderMigrationAuthorization {
	const authorization = object(value);
	const canonical = `FLY-2496 AUTHORIZE register cutover=${targetRayaSha.slice(0, 8)} urgent-restart baseline=quiet15m`;
	if (
		!SHA40.test(targetRayaSha) ||
		Object.keys(authorization).sort().join(",") !==
			"canonical_line,content_sha256,evidence_author_id,evidence_channel_id,evidence_message_id,granted_at,granted_by,issued_by,legacy_stop" ||
		authorization.legacy_stop !== true ||
		authorization.granted_by !== "founder" ||
		typeof authorization.granted_at !== "string" ||
		!Number.isFinite(Date.parse(authorization.granted_at)) ||
		!SNOWFLAKE.test(String(authorization.evidence_message_id)) ||
		!SNOWFLAKE.test(String(authorization.evidence_channel_id)) ||
		!SNOWFLAKE.test(String(authorization.evidence_author_id)) ||
		!/^[a-f0-9]{64}$/.test(String(authorization.content_sha256)) ||
		authorization.canonical_line !== canonical ||
		authorization.issued_by !== "flywheel-eng-lead"
	)
		throw new Error("stored-founder-authorization-invalid");
	return authorization as unknown as FounderMigrationAuthorization;
}

export function standingMigrationAuthorization(
	home: string,
): StandingMigrationAuthorization {
	const active = loadVerifiedStandingAuthority(
		resolveStandingAuthorityStateDir(home),
		"raya-carrier-follow-main/v1",
		{ ledgerPath: resolveStandingAuthorityLedgerPath(home) },
	);
	const confirmation = active.manifest.independentConfirmation;
	if (!confirmation) throw new Error("standing-authority-not-active");
	return {
		legacy_stop: true,
		granted_by: "standing-carve-out",
		entry_id: "raya-carrier-follow-main/v1",
		entry_digest: active.verification.entryDigest,
		activation_manifest_digest: active.verification.manifestDigest,
		manifest_revision: active.verification.revision,
		mechanism_version: active.verification.mechanismVersion,
		execution_package_digest: active.verification.packageDigest,
		confirmed_by: confirmation.identity,
		confirmation_receipt_id: confirmation.receiptId,
		issued_by: "flywheel-eng-lead",
	};
}

export function verifyStandingMigrationAuthorization(
	home: string,
	value: unknown,
): StandingMigrationAuthorization {
	const expected = standingMigrationAuthorization(home);
	if (JSON.stringify(value) !== JSON.stringify(expected))
		throw new Error("standing-migration-authorization-mismatch");
	return expected;
}

export interface MigrationResolution {
	target: string;
	as: string;
	evidence: string;
	reason?: string;
}

export interface MigrationUnresolved {
	message_id?: string;
	reason:
		| "stop-window"
		| "quiet-window-violated"
		| "lookback_exhausted"
		| "probe_delivery_ambiguous";
}

export function buildCutoverSeed(input: {
	migrationId: string;
	channelId: string;
	probeMessageId: string;
	legacyOwners: Array<{ stop_started_at_ms: number; stopped_at_ms: number }>;
	messages: unknown[];
	historyComplete: boolean;
	resolutions: MigrationResolution[];
	expectedBeforeSha256: string | null;
	writerStopped?: boolean;
}): {
	seed?: CursorSeed;
	boundaryMessageId: string | null;
	unresolved: MigrationUnresolved[];
} {
	if (
		!SNOWFLAKE.test(input.channelId) ||
		!SNOWFLAKE.test(input.probeMessageId) ||
		input.legacyOwners.length !== 2 ||
		input.legacyOwners.some(
			(owner) =>
				!Number.isSafeInteger(owner.stop_started_at_ms) ||
				!Number.isSafeInteger(owner.stopped_at_ms) ||
				owner.stopped_at_ms < owner.stop_started_at_ms,
		)
	)
		throw new Error("cutover-window-invalid");
	const t0 = Math.min(
		...input.legacyOwners.map((owner) => owner.stop_started_at_ms),
	);
	const t1 = Math.max(
		...input.legacyOwners.map((owner) => owner.stopped_at_ms),
	);
	const messages = input.messages
		.map((raw) => {
			const value = object(raw);
			const author = object(value.author);
			if (
				typeof value.id !== "string" ||
				!SNOWFLAKE.test(value.id) ||
				typeof author.id !== "string" ||
				!SNOWFLAKE.test(author.id)
			)
				throw new Error("cutover-message-invalid");
			return {
				id: value.id,
				time: Number((BigInt(value.id) >> 22n) + 1420070400000n),
				bot: author.bot === true,
			};
		})
		.sort((a, b) =>
			BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
		);
	if (
		new Set(messages.map((message) => message.id)).size !== messages.length ||
		messages.some(
			(message) => BigInt(message.id) >= BigInt(input.probeMessageId),
		)
	)
		throw new Error("cutover-history-invalid");
	const unresolved: MigrationUnresolved[] = [];
	if (
		!input.historyComplete &&
		(messages[0]?.time ?? Number.POSITIVE_INFINITY) >= t0 - 15 * 60_000
	)
		unresolved.push({ reason: "lookback_exhausted" });
	const window = messages.filter(
		(message) => !message.bot && message.time >= t0 && message.time <= t1,
	);
	const requiringResolution = messages.filter(
		(message) =>
			!message.bot && message.time >= t0 - 15 * 60_000 && message.time <= t1,
	);
	const resolutions = new Map<string, MigrationResolution>();
	for (const resolution of input.resolutions) {
		if (
			!requiringResolution.some(
				(message) => message.id === resolution.target,
			) ||
			resolutions.has(resolution.target) ||
			!resolution.evidence.trim() ||
			![
				"confirmed_processed",
				"confirmed_unprocessed",
				"side_effect_reconciled",
			].includes(resolution.as)
		)
			throw new Error("cutover-resolution-invalid");
		if (
			requiringResolution.some(
				(message) => message.id === resolution.target && message.time < t0,
			) &&
			resolution.reason !== "quiet-window-violated"
		)
			throw new Error("quiet-window-ruling-required");
		resolutions.set(resolution.target, resolution);
	}
	let firstUnprocessed: string | undefined;
	for (const message of requiringResolution) {
		const resolution = resolutions.get(message.id);
		if (!resolution) {
			unresolved.push({
				message_id: message.id,
				reason: message.time < t0 ? "quiet-window-violated" : "stop-window",
			});
		} else if (resolution.as === "confirmed_unprocessed") {
			firstUnprocessed ??= message.id;
		} else if (firstUnprocessed) {
			throw new Error("cutover-resolution-non-contiguous");
		}
	}
	if (unresolved.length) return { boundaryMessageId: null, unresolved };
	const eligible = messages.filter((message) => {
		if (firstUnprocessed) return BigInt(message.id) < BigInt(firstUnprocessed);
		if (!window.length) return message.time < t0;
		// Both ends of the stop interval are inclusive. Processing the final
		// millisecond must advance past it, otherwise that message is replayed.
		return message.time <= t1;
	});
	const boundaryMessageId = eligible.at(-1)?.id ?? null;
	const seed: CursorSeed = {
		schemaVersion: 1,
		migrationId: input.migrationId,
		expectedBeforeSha256: input.expectedBeforeSha256,
		writerStopped: input.writerStopped ?? true,
		unresolved: [],
		channels: boundaryMessageId
			? [
					{
						channelId: input.channelId,
						lastConfirmedMessageId: boundaryMessageId,
					},
				]
			: [],
		...(boundaryMessageId ? {} : { emptyChannels: [input.channelId] }),
	};
	return { seed, boundaryMessageId, unresolved: [] };
}

export async function runMigrationManifest(
	argv: string[],
	context: { home: string; flywheelDir: string; io: MigrationIO },
): Promise<Record<string, unknown>> {
	const parsed = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			"lock-owner": { type: "string" },
			"target-raya-sha": { type: "string" },
			"authorization-message-id": { type: "string" },
			"authorization-channel-id": { type: "string" },
			"standing-authority": { type: "boolean" },
			"migration-manifest": { type: "string" },
			"expected-manifest-digest": { type: "string" },
			"probe-bot-token-env": { type: "string" },
			"dry-run": { type: "boolean" },
			"resume-from-failed": { type: "boolean" },
			"message-id": { type: "string" },
			"boundary-message-id": { type: "string" },
			as: { type: "string" },
			evidence: { type: "string" },
		},
	});
	if (
		parsed.positionals.length !== 1 &&
		!(
			parsed.positionals.length === 2 &&
			parsed.positionals[0] === "resolve" &&
			parsed.values.as === "probe_message-id"
		)
	)
		throw new Error("migration-command-invalid");
	const string = (key: keyof typeof parsed.values) => {
		const value = parsed.values[key];
		if (typeof value !== "string" || !value)
			throw new Error("migration-argument-missing");
		return value;
	};
	const step = parsed.positionals[0]!;
	if (
		["quiet-check", "prestop-probe", "cutover-probe", "seed-boundary"].includes(
			step,
		)
	) {
		if (Object.keys(parsed.values).some((key) => key !== "lock-owner"))
			throw new Error("shuttle-arguments-invalid");
		const owner = parsed.values["lock-owner"];
		if (
			owner !== undefined &&
			(!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(Number(owner)))
		)
			throw new Error("deploy-lock-owner-invalid");
		const { runShuttleStep } = await import("./raya-migration-shuttle.js");
		return runShuttleStep({
			...context,
			step,
			lockOwner: owner === undefined ? undefined : Number(owner),
		});
	}
	if (parsed.values["lock-owner"] !== undefined)
		throw new Error("migration-arguments-invalid");
	if (parsed.positionals[0] === "verify-standing") {
		const allowed = new Set(["migration-manifest"]);
		if (Object.keys(parsed.values).some((key) => !allowed.has(key)))
			throw new Error("migration-arguments-invalid");
		const path =
			parsed.values["migration-manifest"] ??
			join(
				context.home,
				".flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json",
			);
		const migration = object(JSON.parse(readFileSync(path, "utf8")));
		verifyStandingMigrationAuthorization(context.home, migration.authorization);
		return { status: "verified", authority: "standing-carve-out" };
	}
	if (parsed.positionals[0] === "migrate-standing-authority") {
		if (
			Object.keys(parsed.values).some(
				(key) => key !== "expected-manifest-digest",
			)
		)
			throw new Error("migration-arguments-invalid");
		const { migrateMigrationToStandingAuthority } = await import(
			"./raya-migration-init.js"
		);
		return migrateMigrationToStandingAuthority({
			home: context.home,
			expectedManifestDigest: string("expected-manifest-digest"),
		});
	}
	if (parsed.positionals[0] === "init") {
		const allowed = new Set([
			"target-raya-sha",
			"authorization-message-id",
			"authorization-channel-id",
			"standing-authority",
			"probe-bot-token-env",
			"dry-run",
			"resume-from-failed",
		]);
		if (Object.keys(parsed.values).some((key) => !allowed.has(key)))
			throw new Error("migration-arguments-invalid");
		const { initializeMigration } = await import("./raya-migration-init.js");
		const standing = parsed.values["standing-authority"] === true;
		if (
			standing &&
			(parsed.values["authorization-message-id"] !== undefined ||
				parsed.values["authorization-channel-id"] !== undefined)
		)
			throw new Error("migration-arguments-invalid");
		return initializeMigration({
			...context,
			targetRayaSha: string("target-raya-sha"),
			...(standing
				? { standingAuthority: true }
				: {
						authorizationMessageId: string("authorization-message-id"),
						authorizationChannelId: string("authorization-channel-id"),
					}),
			probeBotTokenEnv: string("probe-bot-token-env"),
			dryRun: parsed.values["dry-run"] === true,
			resumeFromFailed: parsed.values["resume-from-failed"] === true,
		});
	}
	if (
		parsed.positionals[0] === "resolve" ||
		parsed.positionals[0] === "resolve-quiet-window"
	) {
		if (parsed.values["dry-run"] || parsed.values["resume-from-failed"])
			throw new Error("resolution-arguments-invalid");
		const { resolveMigration } = await import("./raya-migration-resolve.js");
		return resolveMigration({
			...context,
			messageId: parsed.values["message-id"] ?? parsed.positionals[1] ?? "",
			as: string("as"),
			evidence: string("evidence"),
			boundaryMessageId: parsed.values["boundary-message-id"],
			quietWindow: parsed.positionals[0] === "resolve-quiet-window",
		});
	}
	throw new Error("migration-command-invalid");
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	const home = homedir();
	runMigrationManifest(process.argv.slice(2), {
		home,
		flywheelDir: process.env.FLYWHEEL_DIR ?? join(home, "Dev/flywheel"),
		io: migrationIO,
	})
		.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : "";
			const failure = /^[a-z][a-z0-9-]+$/.test(message)
				? message
				: "migration-operation-failed";
			process.stderr.write(`${failure}\n`);
			process.exitCode = 1;
		});
}
