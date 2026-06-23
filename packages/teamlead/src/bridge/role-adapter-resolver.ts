/**
 * FLY-123: RoleAdapterResolver — pure role → executor-backend resolution.
 *
 * Precedence (plan §3.2): task override > project config > global env >
 * built-in default (claude-tmux).
 *
 * Phase 1 notes:
 * - Task overrides are LABEL-ONLY on the dispatcher path (the description is
 *   not available there — Codex design review R1 #5). The label parser is the
 *   shared `parseRunnerLabels` from flywheel-config.
 * - Only `claude-tmux` and `codex-tmux` are resolvable. A label naming an
 *   unsupported vendor (gemini/cursor) does NOT resolve at the task layer and
 *   falls through to the next precedence layer.
 * - `FLYWHEEL_RUNNER_BACKEND` selects the *executor* backend. It is distinct
 *   from `FLYWHEEL_AGENT_BACKEND`, which selects the Lead↔Runner *transport*
 *   (see plan §9 D3) — the two must never be conflated (R1 #8).
 */

import type {
	ExecutorBackend,
	RoleBackendMap,
	RoleName,
	RunnerVendorType,
} from "flywheel-config";
import { parseRunnerLabels } from "flywheel-config";

/** Transport vendor ids — matches `IAgentTeamTransport.vendorId()`. */
export type TransportBackend = "claude-code" | "codex";

/**
 * FLY-493: an explicit "this backend deliberately has no transport" sentinel.
 * Distinct from `vendor === undefined` (which Codex R1 #3 flagged would
 * otherwise overload "legacy/default" vs "intentional no-transport").
 */
export type TransportMode = TransportBackend | "none";

/**
 * FLY-123 (Codex design review R5 note #2): THE single, typed
 * executor-backend → transport mapping. Call sites must use this —
 * no ad-hoc string trimming/suffix-stripping anywhere.
 *
 * FLY-493: `antigravity-tmux` → `"none"` (the Antigravity `agy` CLI has no
 * claude-code Agent Team; v1 runs transport-less — plan §4.2).
 * FLY-494: `kimi-tmux` → `"none"` (the Kimi Code `kimi` CLI likewise has no
 * claude-code Agent Team; v1 transport-less, same no-transport lifecycle).
 */
export const EXECUTOR_TO_TRANSPORT: Readonly<
	Record<ExecutorBackend, TransportMode>
> = {
	"claude-tmux": "claude-code",
	"codex-tmux": "codex",
	"antigravity-tmux": "none",
	"kimi-tmux": "none",
};

/** Vendor-type (label layer) → executor backend. */
const VENDOR_TO_EXECUTOR: Partial<Record<RunnerVendorType, ExecutorBackend>> = {
	claude: "claude-tmux",
	codex: "codex-tmux",
	antigravity: "antigravity-tmux", // FLY-493
	kimi: "kimi-tmux", // FLY-494
	// gemini / cursor: no executor — label layer cannot resolve them.
};

export interface ResolvedRoleAdapter {
	backend: ExecutorBackend;
	/**
	 * FLY-493: explicit transport contract — `"claude-code" | "codex"` for a
	 * transported backend, `"none"` for a deliberate no-transport backend
	 * (antigravity). ALWAYS set, so callers never have to infer "no transport"
	 * from an absent `vendor`.
	 */
	transport: TransportMode;
	/**
	 * Transport vendor for a transported backend; UNDEFINED for a no-transport
	 * backend (transport === "none"). Kept for byte-compat with the existing
	 * `BlueprintContext.vendor` field (claude/codex only).
	 */
	vendor?: TransportBackend;
	model?: string;
}

export interface ResolveRoleAdapterArgs {
	role: RoleName;
	/** Linear labels (lowercased upstream or not — parser normalizes). */
	issueLabels?: readonly string[];
	/** Project `.flywheel/config.yaml` `roles:` block (already validated). */
	projectRoles?: RoleBackendMap;
	/** Process env (injectable for tests). */
	env?: NodeJS.ProcessEnv;
}

const BUILTIN_DEFAULT: ExecutorBackend = "claude-tmux";

function parseEnvBackend(
	raw: string | undefined,
	envName: string,
): ExecutorBackend | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	// Accept the executor-backend form directly...
	if (
		value === "claude-tmux" ||
		value === "codex-tmux" ||
		value === "antigravity-tmux" ||
		value === "kimi-tmux"
	) {
		return value;
	}
	// ...and the vendor aliases (`claude` / `codex` / `antigravity`, plus the
	// `agy` short alias) via the SAME VENDOR_TO_EXECUTOR map the label path
	// uses. Without this, the env and the label disagreed: a label `codex`
	// resolved fine but `FLYWHEEL_RUNNER_BACKEND=codex` fell through to the
	// default and silently spawned a CLAUDE runner — a wrong-vendor silent
	// failure (qa-fly-123 hit this). Symmetric now.
	//
	// FLY-493: `agy` is the short alias the label parser also accepts; normalize
	// it to the `antigravity` vendor key before the lookup.
	// FLY-494: `kimi` needs NO normalization — the vendor key IS `kimi` (unlike
	// `agy`, whose alias differs from the `antigravity` vendor key).
	const normalized = value === "agy" ? "antigravity" : value;
	//
	// `Object.hasOwn` guard is required: VENDOR_TO_EXECUTOR is a plain object,
	// so indexing it with an arbitrary env string would otherwise hit inherited
	// prototype members (`constructor`, `__proto__`, `toString`, …) and return a
	// function/object as the "backend", silently bypassing the warn+fallback
	// below (Codex review). Only OWN keys (claude/codex/antigravity) may resolve.
	const aliased = Object.hasOwn(VENDOR_TO_EXECUTOR, normalized)
		? VENDOR_TO_EXECUTOR[normalized as RunnerVendorType]
		: undefined;
	if (aliased) return aliased;
	// Genuine misconfiguration must be loud, not silent (plan §6 config
	// validation spirit) — but env is read at dispatch time, so warn + ignore
	// rather than crash the Bridge.
	console.warn(
		`[RoleAdapterResolver] ${envName}="${raw}" is not a supported backend (claude-tmux | codex-tmux | antigravity-tmux | kimi-tmux | claude | codex | antigravity | agy | kimi) — ignoring.`,
	);
	return undefined;
}

/**
 * Resolve the executor backend (+ transport vendor + optional model) for a
 * role. Pure given (args.env ?? process.env); no I/O.
 */
export function resolveRoleAdapter(
	args: ResolveRoleAdapterArgs,
): ResolvedRoleAdapter {
	const env = args.env ?? process.env;

	let backend: ExecutorBackend | undefined;
	let model: string | undefined;

	// 1. Task override — labels (runner role only; a label can't re-bind the
	//    Lead, which doesn't flow through the dispatcher).
	if (args.role === "runner") {
		const labelSelection = parseRunnerLabels(args.issueLabels);
		if (labelSelection.runnerType) {
			const mapped = VENDOR_TO_EXECUTOR[labelSelection.runnerType];
			if (mapped) {
				backend = mapped;
				model = labelSelection.modelOverride;
			}
			// Unsupported vendor label (gemini/cursor) → fall through.
		}
	}

	// 2. Project config roles block.
	if (!backend) {
		const projectRole = args.projectRoles?.[args.role];
		if (projectRole?.backend) {
			backend = projectRole.backend;
			model = projectRole.model;
		}
	}

	// 3. Global env default.
	if (!backend) {
		const envName =
			args.role === "lead"
				? "FLYWHEEL_LEAD_BACKEND"
				: "FLYWHEEL_RUNNER_BACKEND";
		backend = parseEnvBackend(env[envName], envName);
	}

	// 4. Built-in default.
	if (!backend) backend = BUILTIN_DEFAULT;

	// FLY-493: `transport` is ALWAYS set (explicit no-transport contract);
	// `vendor` is set only for a transported backend, so a no-transport backend
	// (antigravity) yields `vendor: undefined` — never confused with legacy.
	const transport = EXECUTOR_TO_TRANSPORT[backend];
	const resolved: ResolvedRoleAdapter = { backend, transport };
	if (transport !== "none") resolved.vendor = transport;
	if (model) resolved.model = model;
	return resolved;
}
