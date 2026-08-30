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
	constants as fsConstants,
	realpathSync,
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

export interface CodexHealthResult {
	/** false only on a severe problem; a warning (unknown root) stays ok=true. */
	ok: boolean;
	/** true ⇒ caller should page the `codex_global_unhealthy` meta-alert. */
	alert: boolean;
	severity: CodexHealthSeverity;
	reason:
		| "healthy"
		| "lead-home-binary"
		| "bad-codex-home"
		| "missing-codex-home"
		| "unknown-root"
		| "codex-not-found";
	/** Diagnostic context (resolved realpath / CODEX_HOME) for logs + alerts. */
	detail?: string;
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

/**
 * Run the health check and, on a problem, log loudly + (on a severe result)
 * fire the `codex_global_unhealthy` meta-alert. NEVER throws — this is advisory
 * drift detection wired at Bridge boot and on a periodic poll; it must never
 * affect Bridge startup or the poll loop. `MetaAlertNotifier`'s built-in
 * per-reason debounce prevents alert spam across repeated polls.
 */
export async function reportCodexGlobalHealth(
	sink: CodexHealthAlertSink | undefined,
	deps: CodexHealthDeps & { logger?: (msg: string) => void } = {},
): Promise<CodexHealthResult> {
	const log = deps.logger ?? ((m: string) => console.error(m));
	let result: CodexHealthResult;
	try {
		result = checkCodexGlobalHealth(deps);
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

	if (result.severity === "warning") {
		log(
			`[codex-health] WARNING ${result.reason}: ${result.detail ?? ""} — ` +
				"global `codex` resolves to an unrecognized root; confirm it is a stable global install (not a per-Lead home).",
		);
	}

	if (result.alert) {
		log(
			`[codex-health] SEVERE ${result.reason}: ${result.detail ?? ""} — ` +
				`the codex review gate resolves \`codex\` via PATH and will transiently fail config-load, stalling runners. ${REMEDIATION}`,
		);
		if (sink) {
			try {
				await sink.notify({
					reason: "codex_global_unhealthy",
					title: "Global codex unhealthy — codex review gate at risk (FLY-513)",
					body: `reason=${result.reason}\ndetail=${result.detail ?? ""}\n\n${REMEDIATION}`,
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
