import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_SET = new Set(["primary", "manual_backup"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const IDENTITY_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const OBSERVATION_SOURCES = ["status", "use", "save", "provision"];
const OBSERVATION_SOURCE_SET = new Set(OBSERVATION_SOURCES);
const SNAPSHOT_KEYS = [
	"version",
	"profile",
	"email",
	"accountId",
	"plan",
	"lastObservedAt",
	"lastSource",
	"lastHomeFingerprint",
	"mode",
];

export const DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH = fileURLToPath(
	new URL("../agents/codex-account-registry.json", import.meta.url),
);
export const CODEX_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function isCodexSlotName(name) {
	return (
		typeof name === "string" &&
		CODEX_PROFILE_NAME.test(name) &&
		!name.startsWith("account-")
	);
}

export function isCodexIdentityLabel(name) {
	return typeof name === "string" && IDENTITY_LABEL_RE.test(name);
}

/** FLY-2869: a Codex quota reading older than this is unknown, not evidence. */
export const CODEX_READING_STALE_AFTER_MS = 30 * 60_000;
/** Same clock-skew allowance the capacity snapshot applies to observations. */
const CODEX_READING_FUTURE_SKEW_MS = 60_000;

/**
 * FLY-2869: whether a stored Codex reading may still decide anything.
 * "stale" and "unobserved" readings are unknown; "reset_elapsed" means an
 * exhausted window's reset has passed, so the 100% no longer holds and the
 * account needs a fresh probe. Shared by the Bridge and `codex-profile list`.
 */
export function codexReadingFreshness(
	reading,
	nowMs,
	staleAfterMs = CODEX_READING_STALE_AFTER_MS,
) {
	if (
		!Number.isFinite(nowMs) ||
		!Number.isFinite(staleAfterMs) ||
		staleAfterMs <= 0
	)
		return "unobserved";
	const observedMs =
		typeof reading?.observedAt === "string"
			? Date.parse(reading.observedAt)
			: Number.NaN;
	if (
		!Number.isFinite(observedMs) ||
		observedMs > nowMs + CODEX_READING_FUTURE_SKEW_MS
	)
		return "unobserved";
	if (nowMs - observedMs > staleAfterMs) return "stale";
	const elapsed = [reading.fiveH, reading.weekly].some((window) => {
		if (!isRecord(window) || window.usedPercent !== 100) return false;
		const resetMs =
			typeof window.resetAt === "string"
				? Date.parse(window.resetAt)
				: Number.NaN;
		return Number.isFinite(resetMs) && resetMs <= nowMs;
	});
	return elapsed ? "reset_elapsed" : "fresh";
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegularFile(path, label) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		throw new Error(
			`${label} is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (stat.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file, not a symlink: ${path}`);
	}
	if (!stat.isFile()) {
		throw new Error(`${label} must be a regular file: ${path}`);
	}
}

function lstatIfExists(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return null;
		throw error;
	}
}

function readRegularFile(path, label) {
	assertRegularFile(path, label);
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(
			`${label} could not be opened safely at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			throw new Error(`${label} must be a regular file: ${path}`);
		}
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function parseJson(raw, label) {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}

export function loadCodexAccountPolicy(
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
) {
	const value = parseJson(
		readRegularFile(registryPath, "Codex account policy"),
		"Codex account policy",
	);
	if (!isRecord(value) || value.version !== 2) {
		throw new Error("Codex account policy must be a version 2 object");
	}
	if (Object.keys(value).sort().join(",") !== "primary,version") {
		throw new Error("Codex account policy contains invalid keys");
	}
	if (!isCodexSlotName(value.primary)) {
		throw new Error(
			"Codex account policy primary must be a valid profile name",
		);
	}
	return Object.freeze({ version: 2, primary: value.primary });
}

function assertProfilePoolRoot(profilesRoot) {
	if (typeof profilesRoot !== "string" || !isAbsolute(profilesRoot)) {
		throw new Error(
			"Codex profile pool root must be an explicit absolute path",
		);
	}
	let stat;
	try {
		stat = lstatSync(profilesRoot);
	} catch (error) {
		throw new Error(
			`Codex profile pool is unavailable at ${profilesRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(
			`Codex profile pool must be a real directory, not a symlink: ${profilesRoot}`,
		);
	}
}

function parseCodexAuthClaims(rawAuth) {
	const auth = parseJson(rawAuth, "Codex auth identity file");
	if (!isRecord(auth) || !isRecord(auth.tokens)) {
		throw new Error("Codex auth identity file has no tokens object");
	}
	const idToken = auth.tokens.id_token;
	if (typeof idToken !== "string" || idToken.length === 0) {
		throw new Error("Codex auth identity file has no id_token");
	}
	const payload = decodeJwtPayload(idToken);
	const email = payload.email;
	if (typeof email !== "string" || !EMAIL_RE.test(email)) {
		throw new Error("Codex auth identity JWT has no valid email claim");
	}
	const openAiAuth = payload["https://api.openai.com/auth"];
	return Object.freeze({
		email,
		accountId:
			isRecord(openAiAuth) &&
			typeof openAiAuth.chatgpt_account_id === "string" &&
			openAiAuth.chatgpt_account_id.length > 0
				? openAiAuth.chatgpt_account_id
				: null,
		plan:
			isRecord(openAiAuth) &&
			typeof openAiAuth.chatgpt_plan_type === "string" &&
			openAiAuth.chatgpt_plan_type.length > 0
				? openAiAuth.chatgpt_plan_type
				: null,
	});
}

export function enumerateCodexProfileSlots(profilesRoot) {
	assertProfilePoolRoot(profilesRoot);
	let entries;
	try {
		entries = readdirSync(profilesRoot, { withFileTypes: true });
	} catch (error) {
		throw new Error(
			`Codex profile pool could not be read at ${profilesRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return Object.freeze(
		entries
			.filter((entry) => !entry.name.startsWith("."))
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => {
				if (entry.isSymbolicLink() || !isCodexSlotName(entry.name)) {
					return Object.freeze({
						name: entry.name,
						state: "invalid_name",
						error: "unsafe profile directory name",
					});
				}
				const authPath = join(profilesRoot, entry.name, "auth.json");
				if (!lstatIfExists(authPath)) {
					return Object.freeze({
						name: entry.name,
						state: "not_logged_in",
					});
				}
				try {
					const claims = parseCodexAuthClaims(
						readRegularFile(authPath, `Codex ${entry.name} auth.json`),
					);
					return Object.freeze({
						name: entry.name,
						state: "ready",
						identity: Object.freeze({
							profile: entry.name,
							...claims,
							mode: "manual_backup",
						}),
					});
				} catch (error) {
					return Object.freeze({
						name: entry.name,
						state: "invalid_credential",
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.sort((left, right) =>
				left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
			),
	);
}

export function validateCodexAccountPool(value) {
	if (
		!isRecord(value) ||
		value.version !== 2 ||
		!(value.primary === null || isCodexSlotName(value.primary)) ||
		!Array.isArray(value.profiles)
	) {
		throw new Error("Codex account pool must be a version 2 object");
	}
	const names = new Set();
	const emails = new Set();
	let primaryCount = 0;
	const profiles = value.profiles.map((candidate) => {
		if (
			!isRecord(candidate) ||
			!isCodexSlotName(candidate.name) ||
			typeof candidate.email !== "string" ||
			!EMAIL_RE.test(candidate.email) ||
			typeof candidate.role !== "string" ||
			!ROLE_SET.has(candidate.role)
		) {
			throw new Error("Codex account registry contains an invalid profile");
		}
		if (names.has(candidate.name) || emails.has(candidate.email)) {
			throw new Error(
				"Codex account registry profile names/emails must be unique",
			);
		}
		names.add(candidate.name);
		emails.add(candidate.email);
		if (candidate.role === "primary") primaryCount += 1;
		if ((candidate.name === value.primary) !== (candidate.role === "primary")) {
			throw new Error("Codex account registry primary role is inconsistent");
		}
		return Object.freeze({
			name: candidate.name,
			email: candidate.email,
			role: candidate.role,
		});
	});
	if (
		(value.primary === null && primaryCount !== 0) ||
		(value.primary !== null &&
			(primaryCount !== 1 || !names.has(value.primary)))
	) {
		throw new Error(
			"Codex account pool must contain at most one valid primary",
		);
	}
	return Object.freeze({
		...value,
		version: 2,
		primary: value.primary,
		profiles: Object.freeze(profiles),
	});
}

export function loadCodexAccountPool({
	profilesRoot,
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
}) {
	const policy = loadCodexAccountPolicy(registryPath);
	const slots = enumerateCodexProfileSlots(profilesRoot);
	const ready = slots.filter((slot) => slot.state === "ready");
	const emailCounts = new Map();
	for (const slot of ready) {
		emailCounts.set(
			slot.identity.email,
			(emailCounts.get(slot.identity.email) ?? 0) + 1,
		);
	}
	const problems = slots
		.filter(
			(slot) =>
				slot.state !== "ready" || emailCounts.get(slot.identity.email) > 1,
		)
		.map((slot) =>
			Object.freeze({
				name: slot.name,
				code: slot.state === "ready" ? "duplicate_email" : slot.state,
			}),
		);
	const profiles = ready
		.filter((slot) => emailCounts.get(slot.identity.email) === 1)
		.map((slot) =>
			Object.freeze({
				name: slot.name,
				email: slot.identity.email,
				role: slot.name === policy.primary ? "primary" : "manual_backup",
			}),
		);
	const primary = profiles.some((profile) => profile.name === policy.primary)
		? policy.primary
		: null;
	return validateCodexAccountPool({
		version: 2,
		primary,
		profiles,
		slots,
		problems,
	});
}

function decodeJwtPayload(token) {
	const segments = token.split(".");
	if (
		segments.length !== 3 ||
		!segments[1] ||
		!BASE64URL_RE.test(segments[1])
	) {
		throw new Error("Codex auth identity id_token is not a valid JWT");
	}
	let raw;
	try {
		raw = Buffer.from(segments[1], "base64url").toString("utf8");
	} catch {
		throw new Error("Codex auth identity JWT payload is not valid base64url");
	}
	const payload = parseJson(raw, "Codex auth identity JWT payload");
	if (!isRecord(payload)) {
		throw new Error("Codex auth identity JWT payload must be an object");
	}
	return payload;
}

function unregisteredProfileName(email) {
	const local = email.split("@")[0].toLowerCase();
	const slug = local.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const candidate = `account-${slug || "unknown"}`;
	if (candidate.length <= 80) return candidate;
	const suffix = createHash("sha256").update(email).digest("hex").slice(0, 8);
	const bounded = slug.slice(0, 63).replace(/-+$/g, "") || "unknown";
	return `account-${bounded}-${suffix}`;
}

export function identifyCodexAuth(rawAuth, pool) {
	const claims = parseCodexAuthClaims(rawAuth);
	// FLY-2750: any logged-in ChatGPT account is usable. Registered accounts keep
	// their profile name/role; an unregistered account gets a stable name derived
	// from its email local part instead of being refused.
	const profile = pool.profiles.find(
		(entry) => entry.email === claims.email,
	) ?? {
		name: unregisteredProfileName(claims.email),
		role: "manual_backup",
	};
	return Object.freeze({
		profile: profile.name,
		...claims,
		mode: profile.role,
	});
}

export function readCodexAuthIdentity(
	authPath,
	{ profilesRoot, registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH } = {},
) {
	return identifyCodexAuth(
		readRegularFile(authPath, "Codex auth identity file"),
		loadCodexAccountPool({ profilesRoot, registryPath }),
	);
}

export function redactCodexEmail(email) {
	const at = typeof email === "string" ? email.indexOf("@") : -1;
	if (at <= 0) return "***";
	return `${email[0]}***${email.slice(at)}`;
}

export function resolveCodexAccountLedgerRoot(env = process.env) {
	const stateRoot = env.FLYWHEEL_STATE_DIR;
	if (typeof stateRoot === "string" && stateRoot.length > 0) {
		return join(stateRoot, "codex-account-ledger");
	}
	const home = env.HOME;
	if (typeof home !== "string" || home.length === 0) {
		throw new Error(
			"HOME is required when FLYWHEEL_STATE_DIR is not set for the Codex account ledger",
		);
	}
	return join(home, ".flywheel", "codex-account-ledger");
}

export function fingerprintCodexHome(home) {
	if (typeof home !== "string" || home.length === 0) {
		throw new Error("Codex home is required for account ledger observation");
	}
	return createHash("sha256").update(resolve(home)).digest("hex");
}

function assertLedgerRoot(ledgerRoot, { create }) {
	if (typeof ledgerRoot !== "string" || !isAbsolute(ledgerRoot)) {
		throw new Error("Codex account ledger root must be an absolute path");
	}
	if (!existsSync(ledgerRoot)) {
		if (!create) return false;
		mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });
	}
	const stat = lstatSync(ledgerRoot);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(
			`Codex account ledger root must be a real directory, not a symlink: ${ledgerRoot}`,
		);
	}
	return true;
}

function assertIdentityMatchesPool(identity, pool) {
	if (!isRecord(identity)) {
		throw new Error("Codex account ledger identity must be an object");
	}
	const expected = pool.profiles.find(
		(profile) => profile.name === identity.profile,
	);
	if (
		!expected ||
		identity.email !== expected.email ||
		identity.mode !== expected.role ||
		!(identity.accountId === null || typeof identity.accountId === "string") ||
		!(identity.plan === null || typeof identity.plan === "string")
	) {
		throw new Error("Codex account ledger identity mismatch with account pool");
	}
	return expected;
}

function validateSnapshot(value, profile, pool) {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== SNAPSHOT_KEYS.length ||
		SNAPSHOT_KEYS.some((key) => !(key in value)) ||
		value.version !== 1 ||
		value.profile !== profile ||
		typeof value.lastObservedAt !== "string" ||
		!Number.isFinite(Date.parse(value.lastObservedAt)) ||
		!OBSERVATION_SOURCE_SET.has(value.lastSource) ||
		typeof value.lastHomeFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.lastHomeFingerprint)
	) {
		throw new Error(`Codex account ledger snapshot for ${profile} is invalid`);
	}
	assertIdentityMatchesPool(value, pool);
	return Object.freeze({ ...value });
}

function atomicWriteSnapshot(path, snapshot) {
	if (lstatIfExists(path))
		assertRegularFile(path, "Codex account ledger snapshot");
	const tempPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let fd;
	try {
		fd = openSync(
			tempPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600,
		);
		writeFileSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		const directoryFd = openSync(dirname(path), constants.O_RDONLY);
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

export function recordCodexAccountObservation({
	identity,
	home,
	source,
	ledgerRoot = resolveCodexAccountLedgerRoot(),
	profilesRoot,
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
	observedAt = new Date(),
}) {
	const pool = loadCodexAccountPool({ profilesRoot, registryPath });
	assertIdentityMatchesPool(identity, pool);
	if (!OBSERVATION_SOURCE_SET.has(source)) {
		throw new Error(
			`Invalid Codex account ledger observation source: ${source}`,
		);
	}
	const observedDate =
		observedAt instanceof Date ? observedAt : new Date(observedAt);
	if (!Number.isFinite(observedDate.getTime())) {
		throw new Error("Invalid Codex account ledger observation timestamp");
	}
	assertLedgerRoot(ledgerRoot, { create: true });
	const snapshot = Object.freeze({
		version: 1,
		profile: identity.profile,
		email: identity.email,
		accountId: identity.accountId,
		plan: identity.plan,
		lastObservedAt: observedDate.toISOString(),
		lastSource: source,
		lastHomeFingerprint: fingerprintCodexHome(home),
		mode: identity.mode,
	});
	atomicWriteSnapshot(join(ledgerRoot, `${identity.profile}.json`), snapshot);
	return snapshot;
}

export function readCodexAccountSnapshot(
	profile,
	{
		ledgerRoot = resolveCodexAccountLedgerRoot(),
		profilesRoot,
		registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
	} = {},
) {
	const pool = loadCodexAccountPool({ profilesRoot, registryPath });
	if (!pool.profiles.some((entry) => entry.name === profile)) {
		throw new Error(`Unknown Codex account ledger profile: ${profile}`);
	}
	if (!assertLedgerRoot(ledgerRoot, { create: false })) return null;
	const path = join(ledgerRoot, `${profile}.json`);
	if (!lstatIfExists(path)) return null;
	return validateSnapshot(
		parseJson(
			readRegularFile(path, "Codex account ledger snapshot"),
			"Codex account ledger snapshot",
		),
		profile,
		pool,
	);
}
