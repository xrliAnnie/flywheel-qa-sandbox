import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalSubmissionDigest } from "./canonical-json.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SNOWFLAKE_RE = /^[0-9]{17,20}$/;
const PERSONA_KEYS = new Set([
	"schemaVersion",
	"enabled",
	"leadId",
	"repo",
	"path",
	"pin",
	"lastKnownGood",
]);
const PIN_KEYS = new Set(["commit", "personaBlobDigest", "approval"]);
const APPROVAL_KEYS = new Set(["channelId", "messageId", "contentSha256"]);

export interface PersonaApprovalRef {
	channelId: string;
	messageId: string;
	contentSha256: string;
}

export interface PersonaPin {
	commit: string;
	personaBlobDigest: string;
	approval: PersonaApprovalRef;
}

export interface PersonaProjection {
	schemaVersion: 1;
	enabled: true;
	leadId: "raya";
	repo: "xrliAnnie/raya";
	path: ".lead/raya/identity.md";
	pin: PersonaPin;
	lastKnownGood: PersonaPin;
}

export type ParsedPersonaProjection =
	| { kind: "absent" }
	| { kind: "invalid"; reason: string }
	| {
			kind: "valid";
			value: PersonaProjection;
			contractDigest: string;
	  };

export interface PersonaProjectionContext {
	projectName: string;
	projectRepo?: string;
}

function canonicalizeThroughExisting(input: string): string {
	let cursor = resolve(input);
	const suffix: string[] = [];
	for (;;) {
		try {
			const base = realpathSync.native(cursor);
			return suffix.length === 0 ? base : join(base, ...suffix);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				(error as NodeJS.ErrnoException).code !== "ENOENT"
			) {
				throw error;
			}
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			suffix.unshift(cursor.slice(parent.length + 1));
			cursor = parent;
		}
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: Set<string>,
	label: string,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		throw new Error(`${label} has unknown field ${unknown.sort().join(",")}`);
	}
}

function parseApproval(value: unknown, label: string): PersonaApprovalRef {
	const input = record(value, label);
	exactKeys(input, APPROVAL_KEYS, label);
	if (
		typeof input.channelId !== "string" ||
		!SNOWFLAKE_RE.test(input.channelId)
	) {
		throw new Error(`${label}.channelId must be a Discord snowflake`);
	}
	if (
		typeof input.messageId !== "string" ||
		!SNOWFLAKE_RE.test(input.messageId)
	) {
		throw new Error(`${label}.messageId must be a Discord snowflake`);
	}
	if (
		typeof input.contentSha256 !== "string" ||
		!SHA256_RE.test(input.contentSha256)
	) {
		throw new Error(`${label}.contentSha256 must be lowercase sha256`);
	}
	return {
		channelId: input.channelId,
		messageId: input.messageId,
		contentSha256: input.contentSha256,
	};
}

function parsePin(value: unknown, label: string): PersonaPin {
	const input = record(value, label);
	exactKeys(input, PIN_KEYS, label);
	if (typeof input.commit !== "string" || !COMMIT_RE.test(input.commit)) {
		throw new Error(`${label}.commit must be a lowercase 40-hex commit`);
	}
	if (
		typeof input.personaBlobDigest !== "string" ||
		!SHA256_RE.test(input.personaBlobDigest)
	) {
		throw new Error(`${label}.personaBlobDigest must be lowercase sha256`);
	}
	return {
		commit: input.commit,
		personaBlobDigest: input.personaBlobDigest,
		approval: parseApproval(input.approval, `${label}.approval`),
	};
}

/**
 * Parse the dormant project-level opt-in without throwing across the fleet.
 * Consumers selecting the affected row must fail closed on `invalid`.
 */
export function parsePersonaProjection(
	value: unknown,
	context: PersonaProjectionContext,
): ParsedPersonaProjection {
	if (value === undefined) return { kind: "absent" };
	try {
		const input = record(value, "personaProjection");
		exactKeys(input, PERSONA_KEYS, "personaProjection");
		if (context.projectName !== "raya") {
			throw new Error("personaProjection is supported only for project raya");
		}
		if (context.projectRepo !== "xrliAnnie/raya") {
			throw new Error("personaProjection requires projectRepo xrliAnnie/raya");
		}
		if (input.schemaVersion !== 1) {
			throw new Error("personaProjection.schemaVersion must be 1");
		}
		if (input.enabled !== true) {
			throw new Error(
				"personaProjection.enabled must be true; remove the field to disable",
			);
		}
		if (input.leadId !== "raya") {
			throw new Error("personaProjection.leadId must be raya");
		}
		if (input.repo !== "xrliAnnie/raya" || input.repo !== context.projectRepo) {
			throw new Error("personaProjection.repo must equal projectRepo");
		}
		if (input.path !== ".lead/raya/identity.md") {
			throw new Error("personaProjection.path must be .lead/raya/identity.md");
		}
		const normalized: PersonaProjection = {
			schemaVersion: 1,
			enabled: true,
			leadId: "raya",
			repo: "xrliAnnie/raya",
			path: ".lead/raya/identity.md",
			pin: parsePin(input.pin, "personaProjection.pin"),
			lastKnownGood: parsePin(
				input.lastKnownGood,
				"personaProjection.lastKnownGood",
			),
		};
		return {
			kind: "valid",
			value: normalized,
			contractDigest: canonicalSubmissionDigest(normalized),
		};
	} catch (error) {
		return {
			kind: "invalid",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** One state-root contract shared by shell, Bridge, runtime and future guards. */
export function resolvePersonaStateRoot(
	env: Record<string, string | undefined>,
	homeDir: string,
): string {
	const configured = env.FLYWHEEL_STATE_DIR;
	if (!configured) {
		throw new Error("FLYWHEEL_STATE_DIR must be explicitly configured");
	}
	const expected = resolve(homeDir, ".flywheel");
	let configuredCanonical: string;
	let expectedCanonical: string;
	try {
		configuredCanonical = canonicalizeThroughExisting(configured);
		expectedCanonical = canonicalizeThroughExisting(expected);
	} catch (error) {
		throw new Error(
			`persona state canonicalization failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (configuredCanonical !== expectedCanonical) {
		throw new Error(
			`FLYWHEEL_STATE_DIR must equal canonical host root ${expectedCanonical}`,
		);
	}
	return join(configuredCanonical, "state", "lead-persona", "raya", "raya");
}
