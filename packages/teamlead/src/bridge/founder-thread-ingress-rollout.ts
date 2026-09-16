import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isDiscordSnowflake, snowflakeToMs } from "./founder-notify-utils.js";

export const FOUNDER_THREAD_INGRESS_MARKER_FILE =
	"founder-thread-ingress-rollout.json";
export const FOUNDER_THREAD_INGRESS_ACTIVATION_FILE =
	"founder-thread-ingress-activation.json";

export interface FounderThreadIngressEnvironment {
	stateDir: string;
	teamleadDbPath: string;
	commRoot: string;
}

export interface FounderThreadIngressOwner {
	projectName: string;
	leadId: string;
	chatChannelId: string;
}

interface RolloutMarker {
	v: 1;
	environment: FounderThreadIngressEnvironment;
	owners: FounderThreadIngressOwner[];
	rolloutAfter: string;
	createdAt: string;
}

interface ActivationReceipt {
	v: 1;
	markerSha256: string;
	environment: FounderThreadIngressEnvironment;
	activatedAt: string;
}

export type FounderThreadIngressRollout =
	| {
			kind: "active";
			rolloutAfter: string;
			owners: FounderThreadIngressOwner[];
			markerSha256: string;
	  }
	| { kind: "inactive"; reason: string };

const MAX_ARTIFACT_BYTES = 64 * 1024;
const INITIAL_ADOPTION_MAX_AGE_MS = 15 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;

export function resolveFounderThreadIngressEnvironment(input: {
	stateDir: string;
	teamleadDbPath: string;
	commRoot: string;
}): FounderThreadIngressEnvironment {
	for (const value of Object.values(input)) {
		if (!isAbsolute(value))
			throw new Error("rollout_environment_path_must_be_absolute");
	}
	return {
		stateDir: realpathSync(input.stateDir),
		teamleadDbPath: realpathSync(input.teamleadDbPath),
		commRoot: realpathSync(input.commRoot),
	};
}

export function freezeFounderThreadIngressRollout(input: {
	stateDir: string;
	environment: FounderThreadIngressEnvironment;
	owners: FounderThreadIngressOwner[];
	rolloutAfter: string;
	nowMs?: number;
}): RolloutMarker {
	const stateDir = realpathSync(input.stateDir);
	if (stateDir !== input.environment.stateDir)
		throw new Error("environment_mismatch");
	if (!isDiscordSnowflake(input.rolloutAfter))
		throw new Error("rollout_after_invalid");
	const nowMs = input.nowMs ?? Date.now();
	const owners = validateOwners(input.owners);
	const marker: RolloutMarker = {
		v: 1,
		environment: input.environment,
		owners,
		rolloutAfter: input.rolloutAfter,
		createdAt: new Date(nowMs).toISOString(),
	};
	validateMarker(marker);
	writeExclusiveDurable(
		join(stateDir, FOUNDER_THREAD_INGRESS_MARKER_FILE),
		`${JSON.stringify(marker, null, 2)}\n`,
	);
	return marker;
}

export function activateFounderThreadIngressRollout(input: {
	stateDir: string;
	environment: FounderThreadIngressEnvironment;
	currentOwners: FounderThreadIngressOwner[];
	expectedOwners?: FounderThreadIngressOwner[];
	dryRun: { rolloutAfter: string; automaticReplayBeforeBoundary: number };
	nowMs?: number;
}): Extract<FounderThreadIngressRollout, { kind: "active" }> {
	const nowMs = input.nowMs ?? Date.now();
	const markerPath = join(
		realpathSync(input.stateDir),
		FOUNDER_THREAD_INGRESS_MARKER_FILE,
	);
	const markerBytes = readArtifact(markerPath);
	const marker = parseMarker(markerBytes);
	assertEnvironment(marker.environment, input.environment);
	assertCurrentOwners(marker.owners, input.currentOwners);
	if (input.expectedOwners) {
		const expected = validateOwners(input.expectedOwners).map(ownerKey);
		if (
			expected.length !== marker.owners.length ||
			expected.some((key, index) => key !== ownerKey(marker.owners[index]!))
		)
			throw new Error("owner_mismatch");
	}
	const createdAtMs = Date.parse(marker.createdAt);
	if (createdAtMs > nowMs + FUTURE_CLOCK_SKEW_MS)
		throw new Error("rollout_marker_from_future");
	if (nowMs - createdAtMs > INITIAL_ADOPTION_MAX_AGE_MS)
		throw new Error("rollout_marker_stale");
	if (input.dryRun.rolloutAfter !== marker.rolloutAfter)
		throw new Error("dry_run_boundary_mismatch");
	if (input.dryRun.automaticReplayBeforeBoundary !== 0)
		throw new Error("historical_replay_not_zero");

	const receipt: ActivationReceipt = {
		v: 1,
		markerSha256: sha256(markerBytes),
		environment: input.environment,
		activatedAt: new Date(nowMs).toISOString(),
	};
	try {
		writeExclusiveDurable(
			join(input.environment.stateDir, FOUNDER_THREAD_INGRESS_ACTIVATION_FILE),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const loaded = loadFounderThreadIngressRollout(input);
	if (loaded.kind !== "active") throw new Error(loaded.reason);
	return loaded;
}

export function loadFounderThreadIngressRollout(input: {
	stateDir: string;
	environment: FounderThreadIngressEnvironment;
	currentOwners: FounderThreadIngressOwner[];
	nowMs?: number;
}): FounderThreadIngressRollout {
	let markerBytes: string;
	let marker: RolloutMarker;
	try {
		markerBytes = readArtifact(
			join(realpathSync(input.stateDir), FOUNDER_THREAD_INGRESS_MARKER_FILE),
		);
		marker = parseMarker(markerBytes);
	} catch (error) {
		return {
			kind: "inactive",
			reason:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "marker_missing"
					: "marker_invalid",
		};
	}
	try {
		assertEnvironment(marker.environment, input.environment);
		assertCurrentOwners(marker.owners, input.currentOwners);
	} catch (error) {
		return { kind: "inactive", reason: (error as Error).message };
	}

	let receipt: ActivationReceipt;
	try {
		receipt = parseActivation(
			readArtifact(
				join(
					input.environment.stateDir,
					FOUNDER_THREAD_INGRESS_ACTIVATION_FILE,
				),
			),
		);
	} catch (error) {
		return {
			kind: "inactive",
			reason:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "activation_missing"
					: "activation_invalid",
		};
	}
	try {
		assertEnvironment(receipt.environment, input.environment);
	} catch {
		return { kind: "inactive", reason: "environment_mismatch" };
	}
	if (receipt.markerSha256 !== sha256(markerBytes))
		return { kind: "inactive", reason: "marker_hash_mismatch" };
	return {
		kind: "active",
		rolloutAfter: marker.rolloutAfter,
		owners: marker.owners,
		markerSha256: receipt.markerSha256,
	};
}

function parseMarker(bytes: string): RolloutMarker {
	const marker = JSON.parse(bytes) as unknown;
	validateMarker(marker);
	return marker;
}

function validateMarker(value: unknown): asserts value is RolloutMarker {
	if (!value || typeof value !== "object") throw new Error("marker_invalid");
	const marker = value as Partial<RolloutMarker>;
	if (
		marker.v !== 1 ||
		!isEnvironment(marker.environment) ||
		!isDiscordSnowflake(marker.rolloutAfter) ||
		typeof marker.createdAt !== "string" ||
		!Number.isFinite(Date.parse(marker.createdAt)) ||
		!marker.createdAt.endsWith("Z") ||
		!Array.isArray(marker.owners)
	)
		throw new Error("marker_invalid");
	marker.owners = validateOwners(marker.owners);
	const rolloutAtMs = snowflakeToMs(marker.rolloutAfter);
	if (
		rolloutAtMs === null ||
		rolloutAtMs > Date.parse(marker.createdAt) + FUTURE_CLOCK_SKEW_MS
	)
		throw new Error("marker_time_inconsistent");
}

function parseActivation(bytes: string): ActivationReceipt {
	const value = JSON.parse(bytes) as Partial<ActivationReceipt>;
	if (
		value.v !== 1 ||
		typeof value.markerSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.markerSha256) ||
		!isEnvironment(value.environment) ||
		typeof value.activatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.activatedAt)) ||
		!value.activatedAt.endsWith("Z")
	)
		throw new Error("activation_invalid");
	return value as ActivationReceipt;
}

function validateOwners(value: unknown[]): FounderThreadIngressOwner[] {
	if (value.length === 0) throw new Error("owners_empty");
	const owners = value.map((owner) => {
		if (!owner || typeof owner !== "object") throw new Error("owner_invalid");
		const candidate = owner as Partial<FounderThreadIngressOwner>;
		if (
			typeof candidate.projectName !== "string" ||
			!candidate.projectName.trim() ||
			typeof candidate.leadId !== "string" ||
			!candidate.leadId.trim() ||
			!isDiscordSnowflake(candidate.chatChannelId)
		)
			throw new Error("owner_invalid");
		return {
			projectName: candidate.projectName,
			leadId: candidate.leadId,
			chatChannelId: candidate.chatChannelId,
		};
	});
	owners.sort((left, right) => ownerKey(left).localeCompare(ownerKey(right)));
	if (new Set(owners.map(ownerKey)).size !== owners.length)
		throw new Error("owner_duplicate");
	return owners;
}

function assertCurrentOwners(
	owners: FounderThreadIngressOwner[],
	currentOwners: FounderThreadIngressOwner[],
): void {
	const current = new Set(validateOwners(currentOwners).map(ownerKey));
	if (owners.some((owner) => !current.has(ownerKey(owner))))
		throw new Error("owner_mismatch");
}

function ownerKey(owner: FounderThreadIngressOwner): string {
	return `${owner.projectName}\u0000${owner.leadId}\u0000${owner.chatChannelId}`;
}

function isEnvironment(
	value: unknown,
): value is FounderThreadIngressEnvironment {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<FounderThreadIngressEnvironment>;
	return [
		candidate.stateDir,
		candidate.teamleadDbPath,
		candidate.commRoot,
	].every((path) => typeof path === "string" && isAbsolute(path));
}

function assertEnvironment(
	actual: FounderThreadIngressEnvironment,
	expected: FounderThreadIngressEnvironment,
): void {
	if (
		actual.stateDir !== expected.stateDir ||
		actual.teamleadDbPath !== expected.teamleadDbPath ||
		actual.commRoot !== expected.commRoot
	)
		throw new Error("environment_mismatch");
}

function readArtifact(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES)
		throw new Error("artifact_invalid");
	if ((stat.mode & 0o077) !== 0) throw new Error("artifact_mode_invalid");
	return readFileSync(path, "utf8");
}

function writeExclusiveDurable(path: string, bytes: string): void {
	let file: number | undefined;
	try {
		file = openSync(path, "wx", 0o600);
		writeFileSync(file, bytes, "utf8");
		fsyncSync(file);
	} finally {
		if (file !== undefined) closeSync(file);
	}
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function sha256(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
