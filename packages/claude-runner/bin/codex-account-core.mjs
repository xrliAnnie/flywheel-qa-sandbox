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
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_NAMES = ["school", "personal", "business"];
const PROFILE_NAME_SET = new Set(PROFILE_NAMES);
const ROLE_SET = new Set(["primary", "manual_backup"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
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

function validateRegistry(value) {
	if (!isRecord(value) || value.version !== 1) {
		throw new Error("Codex account registry must be a version 1 object");
	}
	if (value.primary !== "personal" || !Array.isArray(value.profiles)) {
		throw new Error(
			"Codex account registry primary must be personal and profiles must be an array",
		);
	}
	if (value.profiles.length !== PROFILE_NAMES.length) {
		throw new Error(
			"Codex account registry must contain exactly three profiles",
		);
	}
	const names = new Set();
	const emails = new Set();
	let primaryCount = 0;
	const profiles = value.profiles.map((candidate) => {
		if (
			!isRecord(candidate) ||
			typeof candidate.name !== "string" ||
			!PROFILE_NAME_SET.has(candidate.name) ||
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
	if (primaryCount !== 1 || PROFILE_NAMES.some((name) => !names.has(name))) {
		throw new Error(
			"Codex account registry must contain school/personal/business and one primary",
		);
	}
	return Object.freeze({
		version: 1,
		primary: "personal",
		profiles: Object.freeze(profiles),
	});
}

export function loadCodexAccountRegistry(
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
) {
	return validateRegistry(
		parseJson(
			readRegularFile(registryPath, "Codex account registry"),
			"Codex account registry",
		),
	);
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

export function identifyCodexAuth(rawAuth, registry) {
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
	const profile = registry.profiles.find((entry) => entry.email === email);
	if (!profile) {
		throw new Error(
			`unknown Codex account identity: ${redactCodexEmail(email)}`,
		);
	}
	const openAiAuth = payload["https://api.openai.com/auth"];
	const accountId =
		isRecord(openAiAuth) &&
		typeof openAiAuth.chatgpt_account_id === "string" &&
		openAiAuth.chatgpt_account_id.length > 0
			? openAiAuth.chatgpt_account_id
			: null;
	const plan =
		isRecord(openAiAuth) &&
		typeof openAiAuth.chatgpt_plan_type === "string" &&
		openAiAuth.chatgpt_plan_type.length > 0
			? openAiAuth.chatgpt_plan_type
			: null;
	return Object.freeze({
		profile: profile.name,
		email,
		accountId,
		plan,
		mode: profile.role,
	});
}

export function readCodexAuthIdentity(
	authPath,
	{ registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH } = {},
) {
	return identifyCodexAuth(
		readRegularFile(authPath, "Codex auth identity file"),
		loadCodexAccountRegistry(registryPath),
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

function assertIdentityMatchesRegistry(identity, registry) {
	if (!isRecord(identity)) {
		throw new Error("Codex account ledger identity must be an object");
	}
	const expected = registry.profiles.find(
		(profile) => profile.name === identity.profile,
	);
	if (
		!expected ||
		identity.email !== expected.email ||
		identity.mode !== expected.role ||
		!(identity.accountId === null || typeof identity.accountId === "string") ||
		!(identity.plan === null || typeof identity.plan === "string")
	) {
		throw new Error(
			"Codex account ledger identity mismatch with canonical registry",
		);
	}
	return expected;
}

function validateSnapshot(value, profile, registry) {
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
	assertIdentityMatchesRegistry(value, registry);
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
	registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
	observedAt = new Date(),
}) {
	const registry = loadCodexAccountRegistry(registryPath);
	assertIdentityMatchesRegistry(identity, registry);
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
		registryPath = DEFAULT_CODEX_ACCOUNT_REGISTRY_PATH,
	} = {},
) {
	const registry = loadCodexAccountRegistry(registryPath);
	if (!registry.profiles.some((entry) => entry.name === profile)) {
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
		registry,
	);
}
