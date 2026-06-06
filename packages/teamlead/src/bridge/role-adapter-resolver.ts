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
 * FLY-123 (Codex design review R5 note #2): THE single, typed
 * executor-backend → transport-backend mapping. Call sites must use this —
 * no ad-hoc string trimming/suffix-stripping anywhere.
 */
export const EXECUTOR_TO_TRANSPORT: Readonly<
	Record<ExecutorBackend, TransportBackend>
> = {
	"claude-tmux": "claude-code",
	"codex-tmux": "codex",
};

/** Vendor-type (label layer) → Phase 1 executor backend. */
const VENDOR_TO_EXECUTOR: Partial<Record<RunnerVendorType, ExecutorBackend>> = {
	claude: "claude-tmux",
	codex: "codex-tmux",
	// gemini / cursor: no Phase 1 executor — label layer cannot resolve them.
};

export interface ResolvedRoleAdapter {
	backend: ExecutorBackend;
	vendor: TransportBackend;
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
	if (value === "claude-tmux" || value === "codex-tmux") return value;
	// ...and the vendor aliases (`claude` / `codex`) via the SAME
	// VENDOR_TO_EXECUTOR map the label path uses. Without this, the env and the
	// label disagreed: a label `codex` resolved fine but `FLYWHEEL_RUNNER_BACKEND=codex`
	// fell through to the default and silently spawned a CLAUDE runner — a
	// wrong-vendor silent failure (qa-fly-123 hit this). Symmetric now.
	//
	// `Object.hasOwn` guard is required: VENDOR_TO_EXECUTOR is a plain object,
	// so indexing it with an arbitrary env string would otherwise hit inherited
	// prototype members (`constructor`, `__proto__`, `toString`, …) and return a
	// function/object as the "backend", silently bypassing the warn+fallback
	// below (Codex review). Only OWN keys (claude/codex) may resolve.
	const aliased = Object.hasOwn(VENDOR_TO_EXECUTOR, value)
		? VENDOR_TO_EXECUTOR[value as RunnerVendorType]
		: undefined;
	if (aliased) return aliased;
	// Genuine misconfiguration must be loud, not silent (plan §6 config
	// validation spirit) — but env is read at dispatch time, so warn + ignore
	// rather than crash the Bridge.
	console.warn(
		`[RoleAdapterResolver] ${envName}="${raw}" is not a supported backend (claude-tmux | codex-tmux | claude | codex) — ignoring.`,
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

	const resolved: ResolvedRoleAdapter = {
		backend,
		vendor: EXECUTOR_TO_TRANSPORT[backend],
	};
	if (model) resolved.model = model;
	return resolved;
}
