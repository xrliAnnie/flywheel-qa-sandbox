/**
 * FLY-245 Phase C — Flywheel Lead gateway: the three-layer tool dispatch guard
 * (plan §4). This is the ONLY out-of-sandbox channel a write-capable Codex Lead
 * has for actions (the exec sandbox has network/socket confined off, §3; the MCP
 * allowlist leaves only this gateway, §3.2; non-MCP action surfaces are disabled,
 * §3.5). The model can only REQUEST a reserved action through a tool here; it can
 * never self-authorize.
 *
 * Security contract enforced by this dispatcher (the load-bearing discipline,
 * plan §4 + §2):
 *   1. Tools are classified into three layers — `reserved_ship`,
 *      `reserved_lifecycle`, `non_reserved`. RESERVED tools MUST pass their
 *      preflight before the handler runs; a reject (or a thrown preflight) is
 *      fail-closed — the handler is NEVER invoked.
 *   2. The authority fields (`execId`, `prHead`, `action`, `nonce`, …) are
 *      DERIVED by the runtime (`deriveContext`) from session state + git, NEVER
 *      taken from the model's tool arguments. The model's args carry only "which
 *      issue / what intent"; the handler + preflight see the DERIVED context.
 *   3. An unknown tool is fail-closed.
 *
 * The concrete preflights are injected: `reserved_ship` → CodexFounderPreflight
 * (Phase C2), `reserved_lifecycle` → verifyLifecycleConsent (Phase D). Handlers
 * are injected too (filled by C2 / D / FLY-251). This module is the pure,
 * exhaustively-tested skeleton those phases plug into.
 */

export type GatewayToolKind =
	| "reserved_ship"
	| "reserved_lifecycle"
	| "non_reserved";

/** Raw arguments as supplied by the model — carry intent ONLY, never authority. */
export type ModelToolArgs = Record<string, unknown>;

/** Runtime-derived authoritative context for one tool call (NOT from the model). */
export interface DerivedToolContext {
	tool: string;
	kind: GatewayToolKind;
	/** Authoritative values resolved by the runtime (execId/prHead/action/nonce/…). */
	authority: Record<string, unknown>;
}

export interface PreflightVerdict {
	allowed: boolean;
	reason: string;
}

export type ReservedPreflight = (
	ctx: DerivedToolContext,
) => PreflightVerdict | Promise<PreflightVerdict>;

export type GatewayToolHandler = (
	args: ModelToolArgs,
	derived: DerivedToolContext,
) => Promise<unknown>;

export interface GatewayTool {
	name: string;
	kind: GatewayToolKind;
	description: string;
	handler: GatewayToolHandler;
}

/** Resolve the runtime-authoritative context for a tool call. MUST derive the
 * authority fields from trusted runtime state (session store + git), never echo
 * the model's args. May throw to fail-close (e.g. ambiguous / no target). */
export type DeriveContextFn = (
	tool: GatewayTool,
	args: ModelToolArgs,
) => Promise<DerivedToolContext> | DerivedToolContext;

export interface GatewayDispatcherOptions {
	tools: GatewayTool[];
	deriveContext: DeriveContextFn;
	/** Preflight for `reserved_ship` tools (CodexFounderPreflight, Phase C2). */
	preflightShip: ReservedPreflight;
	/** Preflight for `reserved_lifecycle` tools (verifyLifecycleConsent, Phase D). */
	preflightLifecycle: ReservedPreflight;
	logger?: { warn: (m: string, c?: unknown) => void };
}

export interface DispatchResult {
	ok: boolean;
	/** Machine-readable outcome: handler result on success, else a denial reason. */
	reason: string;
	result?: unknown;
}

export class GatewayDispatcher {
	private readonly tools: Map<string, GatewayTool>;
	private readonly deriveContext: DeriveContextFn;
	private readonly preflightShip: ReservedPreflight;
	private readonly preflightLifecycle: ReservedPreflight;
	private readonly logger: { warn: (m: string, c?: unknown) => void };

	constructor(opts: GatewayDispatcherOptions) {
		this.tools = new Map();
		for (const t of opts.tools) {
			if (this.tools.has(t.name)) {
				throw new Error(`GatewayDispatcher: duplicate tool "${t.name}"`);
			}
			this.tools.set(t.name, t);
		}
		this.deriveContext = opts.deriveContext;
		this.preflightShip = opts.preflightShip;
		this.preflightLifecycle = opts.preflightLifecycle;
		this.logger = opts.logger ?? { warn: () => {} };
	}

	/** The reserved (founder-gated) tool names — for the MCP allowlist / audit. */
	reservedToolNames(): string[] {
		return [...this.tools.values()]
			.filter((t) => t.kind !== "non_reserved")
			.map((t) => t.name);
	}

	/**
	 * Dispatch one model tool call. FAIL-CLOSED everywhere: unknown tool, a context
	 * derivation throw, a preflight reject, or a thrown preflight all return
	 * `{ ok: false }` WITHOUT invoking the handler. Only a genuine allow (or a
	 * non-reserved tool) reaches the handler — and the handler receives the
	 * runtime-DERIVED context, never the raw model authority.
	 */
	async dispatch(name: string, args: ModelToolArgs): Promise<DispatchResult> {
		const tool = this.tools.get(name);
		if (!tool) {
			return { ok: false, reason: "unknown_tool" };
		}

		let derived: DerivedToolContext;
		try {
			derived = await this.deriveContext(tool, args);
		} catch (err) {
			this.logger.warn("gateway: context derivation failed → fail-closed", {
				tool: name,
				err: (err as Error).message,
			});
			return { ok: false, reason: "context_derivation_failed" };
		}

		if (tool.kind !== "non_reserved") {
			const preflight =
				tool.kind === "reserved_ship"
					? this.preflightShip
					: this.preflightLifecycle;
			let verdict: PreflightVerdict;
			try {
				verdict = await preflight(derived);
			} catch (err) {
				this.logger.warn("gateway: preflight threw → fail-closed", {
					tool: name,
					kind: tool.kind,
					err: (err as Error).message,
				});
				return { ok: false, reason: "preflight_threw" };
			}
			if (!verdict.allowed) {
				return { ok: false, reason: verdict.reason || "preflight_denied" };
			}
		}

		const result = await tool.handler(args, derived);
		return { ok: true, reason: "ok", result };
	}
}
