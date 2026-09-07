/**
 * FLY-513: global codex binary stability — PATH-only drift detection.
 *
 * Root cause: the codex review gate (openai-codex plugin stop-review-gate) and
 * the codex companion both resolve `codex` via PATH and `spawn("codex",
 * ["app-server"])`. The global `~/.local/bin/codex` was symlinked into a
 * per-Lead, auto-updating CODEX_HOME (`~/.codex-mufasa{,-med3}/...standalone/
 * current/bin/codex`). The standalone updater + Lead flip churn that `current`
 * pointer; during the churn window the global codex transiently fails with
 * `failed to load configuration: No such file or directory (os error 2)`,
 * stalling EVERY runner's codex review gate (hit ≥3 projects over ~10 days).
 *
 * The PREVENTIVE fix is operational: repoint `~/.local/bin/codex` at a neutral,
 * pinned standalone install (`~/.local/share/flywheel-codex/<ver>/`) that no
 * Lead lifecycle churns. THIS module is only DRIFT DETECTION — if the global
 * binary (or CODEX_HOME) is ever pointed back into a Lead home, classify it and
 * let the caller alert loudly instead of silently stalling runners.
 *
 * Deliberately PATH-only: it does NOT spawn `codex app-server` (that would add
 * startup latency, mutate Codex state, risk a leaked child, and break the
 * byte-compat "healthy ⇒ zero behavior change" guarantee). The default Lead
 * home is `~/.codex` (no suffix) and is HEALTHY; Lead homes are `~/.codex-*`.
 */
import {
	accessSync,
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import {
	isAbsolute,
	join,
	delimiter as pathDelimiter,
	relative,
	sep,
} from "node:path";
import type { MetaAlertReason } from "../MetaAlertNotifier.js";

export type CodexHealthSeverity = "ok" | "warning" | "severe";

export type CodexHealthReason =
	| "healthy"
	| "lead-home-binary"
	| "bad-codex-home"
	| "missing-codex-home"
	| "unknown-root"
	| "codex-not-found"
	| "config-invalid"
	| "authority-unavailable"
	| "link-missing"
	| "truth-missing"
	| "truth-not-regular"
	| "truth-mode"
	| "truth-unparseable"
	| "truth-expiring"
	| "truth-expired"
	| "link-drift"
	| "copy-pending";

export interface CodexHealthResult {
	/** false only on a severe problem; a warning (unknown root) stays ok=true. */
	ok: boolean;
	/** true ⇒ caller should page the `codex_global_unhealthy` meta-alert. */
	alert: boolean;
	severity: CodexHealthSeverity;
	reason: CodexHealthReason;
	/** Diagnostic context (resolved realpath / CODEX_HOME) for logs + alerts. */
	detail?: string;
}

export type ManagedCredentialHomeState =
	| "linked"
	| "missing"
	| "drift"
	| "copy";

export interface CredentialClassificationInput {
	nowMs: number;
	deadlineMs?: number;
	configError?: string;
	authorityFailures?: string[];
	truth: {
		exists: boolean;
		regular: boolean;
		mode: number;
		parseable: boolean;
		expiresAtMs?: number;
	};
	homes: Array<{ home: string; state: ManagedCredentialHomeState }>;
	unparseableConsecutive?: number;
}

function credentialResult(
	reason: CodexHealthReason,
	severity: CodexHealthSeverity,
	detail?: string,
): CodexHealthResult {
	return {
		ok: severity !== "severe",
		alert: severity === "severe",
		severity,
		reason,
		...(detail ? { detail } : {}),
	};
}

/** Pure shared-credential classifier. Ordering is a safety contract. */
export function classifyCredential(
	input: CredentialClassificationInput,
): CodexHealthResult {
	if (input.configError) {
		return credentialResult("config-invalid", "severe", input.configError);
	}
	if (input.authorityFailures?.length) {
		return credentialResult(
			"authority-unavailable",
			"severe",
			input.authorityFailures.join(","),
		);
	}
	if (!input.truth.exists) return credentialResult("truth-missing", "severe");
	if (!input.truth.regular) {
		return credentialResult("truth-not-regular", "severe");
	}
	if (input.truth.mode !== 0o600) {
		return credentialResult(
			"truth-mode",
			"severe",
			input.truth.mode.toString(8),
		);
	}
	if (!input.truth.parseable) {
		return credentialResult(
			"truth-unparseable",
			(input.unparseableConsecutive ?? 1) >= 2 ? "severe" : "warning",
		);
	}
	if (
		input.truth.expiresAtMs !== undefined &&
		input.truth.expiresAtMs <= input.nowMs + 5 * 60_000
	) {
		return credentialResult("truth-expired", "severe");
	}
	const missing = input.homes.filter((home) => home.state === "missing");
	if (missing.length) {
		return credentialResult(
			"link-missing",
			"severe",
			missing.map((home) => home.home).join(","),
		);
	}
	const drift = input.homes.filter((home) => home.state === "drift");
	if (drift.length) {
		return credentialResult(
			"link-drift",
			"severe",
			drift.map((home) => home.home).join(","),
		);
	}
	const copies = input.homes.filter((home) => home.state === "copy");
	if (copies.length) {
		const beforeDeadline =
			input.deadlineMs !== undefined &&
			Number.isFinite(input.deadlineMs) &&
			input.nowMs < input.deadlineMs;
		return credentialResult(
			"copy-pending",
			beforeDeadline ? "warning" : "severe",
			copies.map((home) => home.home).join(","),
		);
	}
	if (
		input.truth.expiresAtMs !== undefined &&
		input.truth.expiresAtMs < input.nowMs + 30 * 60_000
	) {
		return credentialResult("truth-expiring", "warning");
	}
	return credentialResult("healthy", "ok");
}

/** Fixed priority: credential severe, binary severe, credential warning, binary warning. */
export function composeCodexHealth(
	binary: CodexHealthResult,
	credential: CodexHealthResult,
): CodexHealthResult {
	if (credential.severity === "severe") return credential;
	if (binary.severity === "severe") return binary;
	if (credential.severity === "warning") return credential;
	if (binary.severity === "warning") return binary;
	return credential;
}

export type CredentialProbe = () => Promise<CodexHealthResult>;

export interface CredentialProbeOptions {
	observe?: () => Promise<CredentialClassificationInput>;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	targets?: Array<{ projectName: string; leadId: string }>;
	flywheelRoot?: string;
	resolveLeadAuthority?: (target: {
		projectName: string;
		leadId: string;
	}) => Promise<{ codexHome: string }>;
}

function parseCredentialExpiry(raw: string): number {
	const value = JSON.parse(raw) as {
		last_refresh?: unknown;
		tokens?: { access_token?: unknown; id_token?: unknown } | null;
	};
	const tokens = value.tokens;
	if (typeof tokens !== "object" || tokens === null) {
		throw new Error("credential tokens are absent");
	}
	const token = tokens.access_token;
	if (token === undefined) {
		const idToken = tokens.id_token;
		if (typeof idToken !== "string" || idToken.split(".").length !== 3) {
			throw new Error("credential tokens are malformed");
		}
		try {
			const idPayload = JSON.parse(
				Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
			);
			if (typeof idPayload !== "object" || idPayload === null) {
				throw new Error("id token payload is malformed");
			}
		} catch {
			throw new Error("credential tokens are malformed");
		}
		if (typeof value.last_refresh !== "string") {
			throw new Error("credential expiry is absent");
		}
		const lastRefreshMs = Date.parse(value.last_refresh);
		if (!Number.isFinite(lastRefreshMs)) {
			throw new Error("credential last refresh is malformed");
		}
		return lastRefreshMs + 10 * 24 * 60 * 60 * 1_000;
	}
	if (typeof token !== "string") throw new Error("access token is malformed");
	const segments = token.split(".");
	if (segments.length !== 3) throw new Error("access token is malformed");
	const payload = JSON.parse(
		Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
	) as { exp?: unknown };
	if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
		throw new Error("access token expiry is absent");
	}
	return payload.exp * 1_000;
}

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function readRegularFileNoFollow(path: string): string {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink()) {
		throw new Error("credential truth is not a regular file");
	}
	const fd = openSync(
		path,
		fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
	);
	try {
		const opened = fstatSync(fd);
		if (
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			!opened.isFile()
		) {
			throw new Error("credential truth changed before open");
		}
		const raw = readFileSync(fd, "utf8");
		const after = fstatSync(fd);
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size
		) {
			throw new Error("credential truth changed during read");
		}
		return raw;
	} finally {
		closeSync(fd);
	}
}

function discoverKeyedCredentialHomes(homesRoot: string): {
	homes: string[];
	configErrors: string[];
} {
	const agentsRoot = join(homesRoot, "agents");
	const homes: string[] = [];
	const configErrors: string[] = [];
	const agentsStat = lstatOrNull(agentsRoot);
	if (agentsStat === null) return { homes, configErrors };
	if (!agentsStat.isDirectory() || agentsStat.isSymbolicLink()) {
		return { homes, configErrors: ["keyed agents root is unsafe"] };
	}
	for (const project of readdirSync(agentsRoot, { withFileTypes: true })) {
		if (project.name === ".locks" || !project.isDirectory()) continue;
		const projectDir = join(agentsRoot, project.name);
		for (const role of readdirSync(projectDir, { withFileTypes: true })) {
			if (role.name === ".locks" || !role.isDirectory()) continue;
			const home = join(projectDir, role.name);
			const markerPath = join(home, ".flywheel-agent-home.json");
			const markerStat = lstatOrNull(markerPath);
			if (markerStat === null) continue;
			if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
				configErrors.push(`unsafe keyed marker: ${home}`);
				continue;
			}
			try {
				const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
					version?: unknown;
					project?: unknown;
					role?: unknown;
				};
				if (
					marker.version !== 1 ||
					typeof marker.project !== "string" ||
					typeof marker.role !== "string"
				) {
					throw new Error("invalid marker");
				}
				homes.push(home);
			} catch {
				configErrors.push(`invalid keyed marker: ${home}`);
			}
		}
	}
	return { homes, configErrors };
}

function credentialHomeState(
	home: string,
	truthPath: string,
): ManagedCredentialHomeState {
	const authPath = join(home, "auth.json");
	const stat = lstatOrNull(authPath);
	if (stat === null) return "missing";
	if (stat.isSymbolicLink()) {
		return readlinkSync(authPath) === truthPath ? "linked" : "drift";
	}
	return stat.isFile() ? "copy" : "drift";
}

async function observeCredential(
	opts: CredentialProbeOptions,
): Promise<CredentialClassificationInput> {
	const env = opts.env ?? process.env;
	const homeDir = opts.homeDir ?? osHomedir();
	const nowMs = (opts.now ?? Date.now)();
	const sleep =
		opts.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const sourceHome =
		env.FLYWHEEL_CODEX_SOURCE_HOME?.trim() || join(homeDir, ".codex");
	const emptyTruth = {
		exists: false,
		regular: false,
		mode: 0,
		parseable: false,
	};
	if (!isAbsolute(sourceHome)) {
		return {
			nowMs,
			truth: emptyTruth,
			homes: [],
			configError: "credential source home must be absolute",
		};
	}
	let canonicalSource: string;
	try {
		canonicalSource = realpathSync(sourceHome);
	} catch {
		return { nowMs, truth: emptyTruth, homes: [] };
	}
	const truthPath = join(canonicalSource, "auth.json");
	const truthStat = lstatOrNull(truthPath);
	let truth: CredentialClassificationInput["truth"] = {
		exists: truthStat !== null,
		regular: Boolean(truthStat?.isFile() && !truthStat.isSymbolicLink()),
		mode: truthStat?.mode ? truthStat.mode & 0o777 : 0,
		parseable: false,
	};
	if (truth.exists && truth.regular && truth.mode === 0o600) {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				truth = {
					...truth,
					parseable: true,
					expiresAtMs: parseCredentialExpiry(
						readRegularFileNoFollow(truthPath),
					),
				};
				break;
			} catch {
				truth = { ...truth, parseable: false };
				if (attempt < 2) await sleep(50);
			}
		}
	}

	const homesRoot =
		env.FLYWHEEL_CODEX_HOMES_ROOT?.trim() ||
		join(homeDir, ".flywheel", "codex-homes");
	const keyed = discoverKeyedCredentialHomes(homesRoot);
	const homes = [...keyed.homes];
	const configErrors = [...keyed.configErrors];
	const authorityFailures: string[] = [];
	const resolveAuthority =
		opts.resolveLeadAuthority ??
		(async (target: { projectName: string; leadId: string }) => {
			if (!opts.flywheelRoot) throw new Error("flywheel root is unavailable");
			const { execFile } = await import("node:child_process");
			const output = await new Promise<string>((resolve, reject) => {
				execFile(
					join(
						opts.flywheelRoot as string,
						"scripts",
						"resident-codex-lead-recover.sh",
					),
					[
						"--project",
						target.projectName,
						"--lead",
						target.leadId,
						"--authority",
					],
					{ encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
					(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
				);
			});
			const parsed = JSON.parse(output) as { codexHome?: unknown };
			if (typeof parsed.codexHome !== "string") {
				throw new Error("authority omitted codexHome");
			}
			return { codexHome: parsed.codexHome };
		});
	for (const target of opts.targets ?? []) {
		try {
			const authority = await resolveAuthority(target);
			if (
				!isAbsolute(authority.codexHome) ||
				!isUnder(authority.codexHome, homeDir) ||
				authority.codexHome === homeDir
			) {
				throw new Error("authority home is outside the user home");
			}
			const homeStat = lstatOrNull(authority.codexHome);
			if (!homeStat?.isDirectory() || homeStat.isSymbolicLink()) {
				throw new Error("authority home is unavailable");
			}
			homes.push(authority.codexHome);
		} catch {
			authorityFailures.push(`${target.projectName}/${target.leadId}`);
		}
	}

	const extraRaw = env.FLYWHEEL_CODEX_EXTRA_HOMES?.trim();
	if (extraRaw) {
		for (const extra of extraRaw.split(pathDelimiter).filter(Boolean)) {
			if (!isAbsolute(extra) || !isUnder(extra, homeDir) || extra === homeDir) {
				configErrors.push(`invalid extra home: ${extra}`);
				continue;
			}
			const stat = lstatOrNull(extra);
			if (!stat?.isDirectory() || stat.isSymbolicLink()) {
				configErrors.push(`unavailable extra home: ${extra}`);
				continue;
			}
			homes.push(extra);
		}
	}
	const duplicates = homes.filter(
		(home, index) => homes.indexOf(home) !== index,
	);
	if (duplicates.length)
		configErrors.push(`duplicate managed home: ${duplicates[0]}`);
	const uniqueHomes = [...new Set(homes)].sort();
	const deadlineRaw = env.FLYWHEEL_CODEX_LINK_DEADLINE?.trim();
	const parsedDeadline = deadlineRaw ? Date.parse(deadlineRaw) : Number.NaN;
	return {
		nowMs,
		...(Number.isFinite(parsedDeadline) ? { deadlineMs: parsedDeadline } : {}),
		...(configErrors.length ? { configError: configErrors.join(";") } : {}),
		...(authorityFailures.length ? { authorityFailures } : {}),
		truth,
		homes: uniqueHomes.map((home) => ({
			home,
			state: credentialHomeState(home, truthPath),
		})),
	};
}

/** Long-lived, single-flight credential probe with cross-tick tear debounce. */
export function createCredentialProbe(
	opts: CredentialProbeOptions,
): CredentialProbe {
	const observe = opts.observe ?? (() => observeCredential(opts));
	let inFlight: Promise<CodexHealthResult> | null = null;
	let unparseableConsecutive = 0;
	return () => {
		if (inFlight) return inFlight;
		inFlight = (async () => {
			try {
				const observation = await observe();
				if (
					observation.truth.exists &&
					observation.truth.regular &&
					observation.truth.mode === 0o600 &&
					!observation.truth.parseable
				) {
					unparseableConsecutive += 1;
				} else {
					unparseableConsecutive = 0;
				}
				return classifyCredential({
					...observation,
					unparseableConsecutive,
				});
			} catch (error) {
				return credentialResult(
					"authority-unavailable",
					"severe",
					error instanceof Error ? error.message : "credential probe failed",
				);
			}
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
}

/** Neutral, pinned global-codex install root (the operational repoint target). */
export const NEUTRAL_CODEX_ROOT_SEGMENTS = [
	".local",
	"share",
	"flywheel-codex",
];

export interface ClassifyInput {
	/** Fully-resolved real path of the `codex` on PATH (realpathSync), or null. */
	realPath: string | null;
	/** `CODEX_HOME` env value (the companion inherits the invoking process env). */
	codexHome: string | undefined;
	/** Whether `codexHome` (when set) exists on disk. */
	codexHomeExists: boolean;
	homedir: string;
}

/** True if `child` is `parent` itself or nested under it (segment-safe). */
function isUnder(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** First path segment of `p` relative to `homedir` (e.g. ".codex-mufasa"), or "". */
function firstSegmentUnderHome(p: string, homedir: string): string {
	const rel = relative(homedir, p);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return "";
	return rel.split(sep)[0] ?? "";
}

/**
 * A "Lead home" is `~/.codex-<suffix>` (e.g. .codex-mufasa, .codex-mufasa-med3,
 * .codex-245). The DEFAULT home `~/.codex` (no hyphen) is NOT a Lead home and is
 * healthy. Matching the first segment avoids false-positives on neutral paths
 * that merely contain "codex-" deeper down (e.g. ~/.local/share/flywheel-codex).
 */
function isUnderLeadHome(p: string, homedir: string): boolean {
	return firstSegmentUnderHome(p, homedir).startsWith(".codex-");
}

function isUnderDefaultHome(p: string, homedir: string): boolean {
	return firstSegmentUnderHome(p, homedir) === ".codex";
}

function isUnderNeutralRoot(p: string, homedir: string): boolean {
	return isUnder(p, join(homedir, ...NEUTRAL_CODEX_ROOT_SEGMENTS));
}

/**
 * Pure classifier (no I/O). Order matters: CODEX_HOME env contamination is
 * checked BEFORE the binary, because a bad CODEX_HOME breaks config-load even
 * when the binary itself is neutral (the stop-review hook forwards process.env
 * to the spawned `codex app-server`).
 */
export function classifyCodexGlobal(input: ClassifyInput): CodexHealthResult {
	const { realPath, codexHome, codexHomeExists, homedir } = input;

	// 1. CODEX_HOME env contamination (independent of which binary runs).
	if (codexHome && codexHome.trim() !== "") {
		if (isUnderLeadHome(codexHome, homedir)) {
			return {
				ok: false,
				alert: true,
				severity: "severe",
				reason: "bad-codex-home",
				detail: codexHome,
			};
		}
		if (!codexHomeExists) {
			return {
				ok: false,
				alert: true,
				severity: "severe",
				reason: "missing-codex-home",
				detail: codexHome,
			};
		}
	}

	// 2. Binary resolution.
	if (realPath == null) {
		return {
			ok: false,
			alert: true,
			severity: "severe",
			reason: "codex-not-found",
			detail: "no `codex` executable resolvable on PATH",
		};
	}
	if (isUnderLeadHome(realPath, homedir)) {
		return {
			ok: false,
			alert: true,
			severity: "severe",
			reason: "lead-home-binary",
			detail: realPath,
		};
	}
	if (
		isUnderNeutralRoot(realPath, homedir) ||
		isUnderDefaultHome(realPath, homedir)
	) {
		return {
			ok: true,
			alert: false,
			severity: "ok",
			reason: "healthy",
			detail: realPath,
		};
	}

	// 3. Unknown non-Lead root (e.g. Homebrew / custom). NOT an incident — warn
	//    only, never page (would page forever on a benign custom install).
	return {
		ok: true,
		alert: false,
		severity: "warning",
		reason: "unknown-root",
		detail: realPath,
	};
}

export interface CodexHealthDeps {
	env?: NodeJS.ProcessEnv;
	homedir?: () => string;
	/** Resolve an executable by scanning PATH (default: access(X_OK) scan). */
	resolveExecutable?: (name: string, env: NodeJS.ProcessEnv) => string | null;
	/** Resolve all symlink layers (default: fs.realpathSync). */
	realpath?: (p: string) => string;
	/** Whether a directory exists (default: fs.statSync isDirectory). */
	dirExists?: (p: string) => boolean;
}

/**
 * Resolve `name` against PATH the way a spawned `codex` would, WITHOUT a shell
 * (`command -v` is a shell builtin and is not exec-able). Returns the first
 * PATH entry holding an executable file, or null.
 */
export function resolveExecutableOnPath(
	name: string,
	env: NodeJS.ProcessEnv,
): string | null {
	const rawPath = env.PATH ?? env.Path ?? "";
	for (const dir of rawPath.split(pathDelimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// not here / not executable — keep scanning
		}
	}
	return null;
}

/**
 * Resolve the global `codex` and classify it. NEVER throws — any I/O failure is
 * folded into a severe result (a broken global codex symlink is itself the
 * incident). Callers run this at Bridge boot and periodically; they must treat
 * it as advisory (loud log + meta-alert), never fatal.
 */
export function checkCodexGlobalHealth(
	deps: CodexHealthDeps = {},
): CodexHealthResult {
	const env = deps.env ?? process.env;

	const homedir = (deps.homedir ?? osHomedir)();
	const resolveExecutable = deps.resolveExecutable ?? resolveExecutableOnPath;
	const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
	const dirExists =
		deps.dirExists ??
		((p: string) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		});

	let realPath: string | null = null;
	try {
		const onPath = resolveExecutable("codex", env);
		realPath = onPath ? realpath(onPath) : null;
	} catch {
		// Broken symlink / realpath failure IS the bad state — treat as severe.
		return {
			ok: false,
			alert: true,
			severity: "severe",
			reason: "codex-not-found",
			detail: "failed to resolve realpath of `codex` (broken symlink?)",
		};
	}

	// Codex code-review R1 MEDIUM: realpath CODEX_HOME before classifying, so a
	// CODEX_HOME that is a symlink INTO a Lead home (e.g. ~/codex-home → ~/.codex-
	// mufasa) is not mis-classified as healthy. Only resolve when it exists; a
	// missing CODEX_HOME keeps its raw value so `missing-codex-home` still fires.
	const codexHomeRaw = env.CODEX_HOME?.trim() || undefined;
	let codexHome = codexHomeRaw;
	let codexHomeExists = true;
	if (codexHomeRaw) {
		codexHomeExists = dirExists(codexHomeRaw);
		if (codexHomeExists) {
			try {
				codexHome = realpath(codexHomeRaw);
			} catch {
				// realpath failed on an existing dir — keep raw for classification.
				codexHome = codexHomeRaw;
			}
		}
	}

	return classifyCodexGlobal({ realPath, codexHome, codexHomeExists, homedir });
}

/** Minimal sink — satisfied by `MetaAlertNotifier`. Kept narrow so the boot hook
 * and the GatePoller piggyback reuse ONE notifier instance (no split debounce). */
export interface CodexHealthAlertSink {
	notify(input: {
		reason: MetaAlertReason;
		title: string;
		body: string;
	}): Promise<unknown>;
}

const REMEDIATION =
	"Repoint ~/.local/bin/codex (atomically) to a neutral pinned install " +
	"~/.local/share/flywheel-codex/<ver>/bin/codex that no Lead lifecycle churns. See FLY-513.";

const CREDENTIAL_REASONS = new Set<CodexHealthReason>([
	"config-invalid",
	"authority-unavailable",
	"link-missing",
	"truth-missing",
	"truth-not-regular",
	"truth-mode",
	"truth-unparseable",
	"truth-expiring",
	"truth-expired",
	"link-drift",
	"copy-pending",
]);

function remediationFor(reason: CodexHealthReason): string {
	switch (reason) {
		case "truth-missing":
		case "truth-expired":
		case "truth-unparseable":
			return "Founder: run `codex login` once on the host; every linked home recovers without a restart.";
		case "truth-mode":
		case "truth-not-regular":
			return "Repair ~/.codex/auth.json as one 0600 regular file (chmod 600 when applicable); no per-home login is needed.";
		case "link-drift":
		case "link-missing":
		case "copy-pending":
			return "Stop the affected process in a shuttle window, run scripts/codex-home-link-truth.sh <home>, then restart it; logging in does not repair link topology.";
		case "authority-unavailable":
			return "Repair projects/manifest/plist/wrapper consistency until resident-codex-lead-recover.sh --authority succeeds.";
		case "config-invalid":
			return "Repair the managed-home configuration; invalid or duplicate home authority is fail-closed.";
		case "truth-expiring":
			return "Schedule one founder host `codex login` before expiry if normal refresh does not advance the shared truth.";
		default:
			return REMEDIATION;
	}
}

/**
 * Run the health check and, on a problem, log loudly + (on a severe result)
 * fire the `codex_global_unhealthy` meta-alert. NEVER throws — this is advisory
 * drift detection wired at Bridge boot and on a periodic poll; it must never
 * affect Bridge startup or the poll loop. `MetaAlertNotifier`'s built-in
 * per-reason debounce prevents alert spam across repeated polls.
 */
export async function reportCodexGlobalHealth(
	sink: CodexHealthAlertSink | undefined,
	deps: CodexHealthDeps & {
		logger?: (msg: string) => void;
		credentialProbe?: CredentialProbe;
	} = {},
): Promise<CodexHealthResult> {
	const log = deps.logger ?? ((m: string) => console.error(m));
	let result: CodexHealthResult;
	try {
		const binary = checkCodexGlobalHealth(deps);
		let credential = credentialResult("healthy", "ok");
		if (deps.credentialProbe) {
			try {
				credential = await deps.credentialProbe();
			} catch (error) {
				credential = credentialResult(
					"authority-unavailable",
					"severe",
					error instanceof Error ? error.message : "credential probe failed",
				);
			}
		}
		result = composeCodexHealth(binary, credential);
	} catch (err) {
		// Defense in depth — checkCodexGlobalHealth is already non-throwing.
		log(
			`[codex-health] check threw (treated as non-fatal): ${(err as Error).message}`,
		);
		return {
			ok: false,
			alert: false,
			severity: "warning",
			reason: "unknown-root",
		};
	}

	const remediation = remediationFor(result.reason);
	if (result.severity === "warning") {
		log(
			`[codex-health] WARNING ${result.reason}: ${result.detail ?? ""} — ` +
				remediation,
		);
	}

	if (result.alert) {
		log(
			`[codex-health] SEVERE ${result.reason}: ${result.detail ?? ""} — ` +
				remediation,
		);
		if (sink) {
			try {
				await sink.notify({
					reason: "codex_global_unhealthy",
					title: CREDENTIAL_REASONS.has(result.reason)
						? "Global Codex credential unhealthy (FLY-2404)"
						: "Global codex unhealthy — codex review gate at risk (FLY-513)",
					body: `reason=${result.reason}\ndetail=${result.detail ?? ""}\n\n${remediation}`,
				});
			} catch (err) {
				log(
					`[codex-health] meta-alert notify failed: ${(err as Error).message}`,
				);
			}
		}
	}

	return result;
}
