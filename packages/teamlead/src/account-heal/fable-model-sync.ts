import {
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	getModelConfigSnapshot,
	MODEL_IDS,
	type ModelConfigSnapshot,
	resetModelConfigCacheForTests,
} from "flywheel-config";
import { readKeychainMonitorCredential } from "./quota-monitor-credentials.js";

const FABLE_BASE_ID = /^claude-fable-([0-9]+(?:-[0-9]+)*)$/;
const ONE_MILLION = 1_000_000;

export interface FableModelCandidate {
	id: string;
	versionSegments: number[];
	maxInputTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareVersionSegments(left: number[], right: number[]): number {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function parseFableVersion(id: string): number[] | null {
	const match = FABLE_BASE_ID.exec(id);
	const rawVersion = match?.[1];
	if (!rawVersion) return null;
	const segments = rawVersion.split("-").map((segment) => Number(segment));
	return segments.every(
		(segment) => Number.isSafeInteger(segment) && segment >= 0,
	)
		? segments
		: null;
}

/** Select a usable Fable base model without trusting API response order. */
export function selectLatestFableModel(
	payload: unknown,
): FableModelCandidate | null {
	if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
	let selected: FableModelCandidate | null = null;
	for (const value of payload.data) {
		if (!isRecord(value) || typeof value.id !== "string") continue;
		const match = FABLE_BASE_ID.exec(value.id);
		const rawVersion = match?.[1];
		if (!rawVersion) continue;
		const versionSegments = rawVersion
			.split("-")
			.map((segment) => Number(segment));
		if (
			versionSegments.some(
				(segment) => !Number.isSafeInteger(segment) || segment < 0,
			) ||
			typeof value.max_input_tokens !== "number" ||
			!Number.isSafeInteger(value.max_input_tokens) ||
			value.max_input_tokens <= 0
		) {
			continue;
		}
		const candidate: FableModelCandidate = {
			id: value.id,
			versionSegments,
			maxInputTokens: value.max_input_tokens,
		};
		if (
			selected === null ||
			compareVersionSegments(
				candidate.versionSegments,
				selected.versionSegments,
			) > 0
		) {
			selected = candidate;
		}
	}
	return selected;
}

export interface FableAuthorityDocument extends Record<string, unknown> {
	models: Array<Record<string, unknown>>;
	bindings: Record<string, unknown>;
	tiers: Record<string, unknown>;
}

export interface FableAuthorityUpdatePlan {
	status: "updated" | "normalized" | "unchanged" | "retained";
	authority: FableAuthorityDocument;
}

function stableAliases(current: unknown, wanted: string): string[] {
	const values = Array.isArray(current)
		? current.filter((value): value is string => typeof value === "string")
		: [];
	const seen = new Set<string>();
	return [...values, wanted].filter((alias) => {
		const normalized = alias.trim().toLowerCase();
		if (
			!normalized ||
			["fable", "fable-1m", "fable[1m]"].includes(normalized) ||
			seen.has(normalized)
		) {
			return false;
		}
		seen.add(normalized);
		return true;
	});
}

function versionLabel(segments: number[]): string {
	return segments.join(".");
}

/** Build a lossless authority update without mutating the caller's object. */
export function planFableAuthorityUpdate(
	input: unknown,
	currentCanonical: string,
	candidate: FableModelCandidate,
): FableAuthorityUpdatePlan {
	if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.models)) {
		throw new Error("invalid model authority document");
	}
	const currentVersion = parseFableVersion(currentCanonical);
	if (currentVersion === null)
		throw new Error("invalid current Fable canonical");
	const comparison = compareVersionSegments(
		candidate.versionSegments,
		currentVersion,
	);
	const original = structuredClone(input) as Record<string, unknown>;
	const models = original.models;
	if (!Array.isArray(models) || models.some((entry) => !isRecord(entry))) {
		throw new Error("invalid model authority entries");
	}
	const authority: FableAuthorityDocument = {
		...original,
		models: models as Array<Record<string, unknown>>,
		bindings: isRecord(original.bindings) ? original.bindings : {},
		tiers: isRecord(original.tiers) ? original.tiers : {},
	};
	if (comparison < 0) return { status: "unchanged", authority };
	// `[1m]` is a fleet-level explicit 1M contract. Do not synthesize it when
	// the API capability ceiling cannot support that contract.
	if (candidate.maxInputTokens < ONE_MILLION) {
		return { status: "retained", authority };
	}

	const displayVersion = versionLabel(candidate.versionSegments);
	const baseId = candidate.id;
	const oneMId = `${baseId}[1m]`;
	const upsert = (
		id: string,
		build: (
			current: Record<string, unknown> | undefined,
		) => Record<string, unknown>,
	): void => {
		const index = authority.models.findIndex((entry) => entry.id === id);
		const next = build(index >= 0 ? authority.models[index] : undefined);
		if (index >= 0) authority.models[index] = next;
		else authority.models.push(next);
	};
	upsert(baseId, (current) => ({
		...(current ?? {}),
		id: baseId,
		provider: "anthropic",
		runtimeVendor: "claude",
		label: `Fable ${displayVersion}`,
		aliases: stableAliases(
			current?.aliases,
			`fable-${candidate.versionSegments.join("-")}`,
		),
		dispatch: true,
		maxInputTokens: candidate.maxInputTokens,
		// Only today's builtin has independent launched-session corroboration.
		...(baseId === MODEL_IDS.FABLE ? { contextWindowTokens: ONE_MILLION } : {}),
	}));
	upsert(oneMId, (current) => ({
		...(current ?? {}),
		id: oneMId,
		provider: "anthropic",
		runtimeVendor: "claude",
		label: `Fable ${displayVersion} (1M)`,
		aliases: stableAliases(
			current?.aliases,
			`fable-${candidate.versionSegments.join("-")}-1m`,
		),
		dispatch: true,
		maxInputTokens: candidate.maxInputTokens,
		contextWindowTokens: ONE_MILLION,
	}));
	authority.bindings = { ...authority.bindings, fable: baseId };
	const configuredHeavy = authority.tiers.heavy;
	if (
		configuredHeavy === undefined ||
		configuredHeavy === "fable" ||
		configuredHeavy === currentCanonical
	) {
		authority.tiers = { ...authority.tiers, heavy: "fable" };
	}
	const changed = JSON.stringify(authority) !== JSON.stringify(input);
	return {
		status: comparison > 0 ? "updated" : changed ? "normalized" : "unchanged",
		authority,
	};
}

interface SyncCredential {
	accessToken: string;
	expiresAt: number;
}

export interface SyncFableModelAuthorityOptions {
	authorityPath?: string;
	fetchFn?: typeof fetch;
	readCredential?: () => Promise<SyncCredential | null>;
	timeoutMs?: number;
	now?: () => number;
	log?: (message: string) => void;
	/** Test seam after durable temp write, immediately before atomic rename. */
	beforeRename?: (tempPath: string) => void;
	/** Test seam after rename and before the real registry reload. */
	afterWrite?: (authorityPath: string) => void;
}

export interface SyncFableModelAuthorityResult {
	status: "updated" | "normalized" | "unchanged" | "retained";
	previousCanonical?: string;
	canonical?: string;
	reason?:
		| "unsafe_authority"
		| "invalid_authority"
		| "credential_unavailable"
		| "api_unavailable"
		| "malformed_response"
		| "unsupported_1m"
		| "write_failed"
		| "verification_failed";
}

function authorityIsSafe(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			(stat.mode & 0o777) === 0o600 &&
			(process.getuid === undefined || stat.uid === process.getuid())
		);
	} catch {
		return false;
	}
}

let tempSequence = 0;

function atomicReplace(
	path: string,
	contents: string,
	beforeRename?: (tempPath: string) => void,
): void {
	const directory = dirname(path);
	tempSequence += 1;
	const tempPath = join(
		directory,
		`.${path.split("/").at(-1) ?? "models.json"}.${process.pid}.${tempSequence}.tmp`,
	);
	let file: number | undefined;
	try {
		file = openSync(
			tempPath,
			fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_WRONLY |
				(fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeSync(file, contents, undefined, "utf8");
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		beforeRename?.(tempPath);
		renameSync(tempPath, path);
		const directoryFd = openSync(directory, fsConstants.O_RDONLY);
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} catch (error) {
		if (file !== undefined) closeSync(file);
		try {
			unlinkSync(tempPath);
		} catch {
			// Temp may already have been atomically renamed.
		}
		throw error;
	}
}

function readVerifiedSnapshot(path: string) {
	const previous = process.env.FLYWHEEL_MODELS_CONFIG;
	process.env.FLYWHEEL_MODELS_CONFIG = path;
	resetModelConfigCacheForTests();
	try {
		return getModelConfigSnapshot();
	} finally {
		if (previous === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
		else process.env.FLYWHEEL_MODELS_CONFIG = previous;
		resetModelConfigCacheForTests();
	}
}

async function fetchModels(
	credential: SyncCredential,
	opts: SyncFableModelAuthorityOptions,
): Promise<{ ok: true; payload: unknown } | { ok: false }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
	try {
		const response = await (opts.fetchFn ?? fetch)(
			"https://api.anthropic.com/v1/models?limit=1000",
			{
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${credential.accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
					"anthropic-version": "2023-06-01",
					Accept: "application/json",
				},
			},
		);
		if (!response.ok) return { ok: false };
		try {
			return { ok: true, payload: await response.json() };
		} catch {
			return { ok: false };
		}
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timer);
	}
}

/** One bounded probe/update transaction. All failures retain the old authority. */
export async function syncFableModelAuthority(
	opts: SyncFableModelAuthorityOptions = {},
): Promise<SyncFableModelAuthorityResult> {
	const path =
		opts.authorityPath ??
		process.env.FLYWHEEL_MODELS_CONFIG ??
		join(homedir(), ".flywheel", "models.json");
	if (!authorityIsSafe(path)) {
		return { status: "retained", reason: "unsafe_authority" };
	}
	let originalBytes: string;
	let original: unknown;
	let before: ModelConfigSnapshot;
	try {
		originalBytes = readFileSync(path, "utf8");
		original = JSON.parse(originalBytes);
		before = readVerifiedSnapshot(path);
	} catch {
		return { status: "retained", reason: "invalid_authority" };
	}
	const previousCanonical = before.getDispatchCanonical("fable");
	if (previousCanonical === null) {
		return { status: "retained", reason: "invalid_authority" };
	}
	const now = opts.now?.() ?? Date.now();
	let credential: SyncCredential | null;
	try {
		credential = await (
			opts.readCredential ?? (() => readKeychainMonitorCredential())
		)();
	} catch {
		return {
			status: "retained",
			reason: "credential_unavailable",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	if (
		credential === null ||
		!credential.accessToken ||
		!Number.isFinite(credential.expiresAt) ||
		credential.expiresAt <= now
	) {
		return {
			status: "retained",
			reason: "credential_unavailable",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	const fetched = await fetchModels(credential, opts);
	if (!fetched.ok) {
		return {
			status: "retained",
			reason: "api_unavailable",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	const candidate = selectLatestFableModel(fetched.payload);
	if (candidate === null) {
		return {
			status: "retained",
			reason: "malformed_response",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	let plan: FableAuthorityUpdatePlan;
	try {
		plan = planFableAuthorityUpdate(original, previousCanonical, candidate);
	} catch {
		return {
			status: "retained",
			reason: "invalid_authority",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	if (plan.status === "retained") {
		return {
			status: "retained",
			reason: "unsupported_1m",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	if (plan.status === "unchanged") {
		return {
			status: "unchanged",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	const nextBytes = `${JSON.stringify(plan.authority, null, 2)}\n`;
	try {
		atomicReplace(path, nextBytes, opts.beforeRename);
	} catch {
		return {
			status: "retained",
			reason: "write_failed",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	let verified = false;
	try {
		opts.afterWrite?.(path);
		const after = readVerifiedSnapshot(path);
		const base = after.getModelRegistryEntry(candidate.id);
		const oneM = after.getModelRegistryEntry(`${candidate.id}[1m]`);
		const managedHeavy = plan.authority.tiers.heavy === "fable";
		verified =
			after.getDispatchCanonical("fable") === candidate.id &&
			(!managedHeavy || after.tiers.heavy.id === candidate.id) &&
			base?.maxInputTokens === candidate.maxInputTokens &&
			oneM?.maxInputTokens === candidate.maxInputTokens &&
			oneM.contextWindowTokens === ONE_MILLION;
	} catch {
		verified = false;
	}
	if (!verified) {
		try {
			atomicReplace(path, originalBytes);
			readVerifiedSnapshot(path);
		} catch {
			// The result remains verification_failed and never claims success.
		}
		return {
			status: "retained",
			reason: "verification_failed",
			previousCanonical,
			canonical: previousCanonical,
		};
	}
	if (plan.status === "normalized") {
		(opts.log ?? console.info)(
			`[fable-model-sync] normalized authority ${path}: bindings.fable, Fable dispatch metadata, and tiers.heavy`,
		);
	}
	return {
		status: plan.status,
		previousCanonical,
		canonical: candidate.id,
	};
}
