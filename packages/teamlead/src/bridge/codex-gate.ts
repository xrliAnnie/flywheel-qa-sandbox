/**
 * FLY-827: the centralized Codex code-review hard-gate predicates (MED-7).
 *
 * Three Bridge-side surfaces consume the gate — auto-QA spawn
 * (AutoQaCoordinator.onMainAwaitingReview), founder hold (isReviewHeld →
 * event-route / GatePoller / HeartbeatService / DirectEventSink), and the
 * reconcile sweep. They MUST agree, so the "is the gate satisfied?" logic lives
 * here in ONE place. `verify-approval` (the runner-CLI merge gate) lives in the
 * `flywheel-comm` package and cannot import this, so it MIRRORS the same
 * query/conditions + reads a call-time `~/.flywheel/.env` for the kill-switch
 * (see verify-approval.ts).
 *
 * Kill-switch (Lead hard requirement — must be reliable): `FLYWHEEL_CODEX_HARD_GATE`
 * is a default-ON kill-switch (`!== "0"`). On the Bridge side it is live-mutated
 * into `process.env` by the direct feature-flag toggle (flag-routes apply), so a
 * plain `env` read here is live. The registry entry (registry.ts) is what makes
 * that a `direct` toggle.
 */

const HARD_GATE_ENV = "FLYWHEEL_CODEX_HARD_GATE";

/**
 * FLY-827 + FLY-793: the session roles that OWN a PR and reach `awaiting_review`
 * for founder review — the ones the Codex founder-hold + verdict-recording apply
 * to. `main` is the normal runner; `implement` is the FLY-793 three-stage phase
 * that creates the PR and hands off at `awaiting_review`. The `qa` role (auto-QA
 * runner AND the FLY-793 `qa` phase) is the VERIFIER — never held. `design` never
 * reaches `awaiting_review`.
 */
export function isReviewableRole(role: string | undefined): boolean {
	const r = role ?? "main";
	return r === "main" || r === "implement";
}

/** Minimal read surface — keeps the predicate trivially unit-testable with a fake. */
export interface CodexGateStore {
	isCodexCodeReviewApproved(executionId: string, sha: string): boolean;
}

/** Minimal session shape the gate needs. */
export interface CodexGateSession {
	execution_id: string;
	/**
	 * Truthy when the sanctioned codex-skip label/flag was snapshotted at run start.
	 * The DB column is INTEGER (0/1); the Session type surfaces it as boolean — accept
	 * both so callers can pass a Session row directly.
	 */
	codex_skip?: number | boolean;
}

/**
 * The hard gate is ON by default; only an explicit `FLYWHEEL_CODEX_HARD_GATE=0`
 * disables it (kill-switch idiom). Absent / any other value → ON.
 */
export function codexHardGateEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env[HARD_GATE_ENV] !== "0";
}

/**
 * Is the Codex code-review gate satisfied for this session's exact head?
 *   - hard gate OFF (kill-switch)      → true (byte-compat / emergency release)
 *   - session carries codex_skip       → true (sanctioned bypass; head-independent)
 *   - an approved/skipped record for (exec, sha) exists → true
 *   - otherwise                        → false (fail-closed: hold + block + alert)
 * FLY-1278 governance rulings never add another gate-side escape hatch: they
 * are consumed inside cross-family review, and only its delivered effective
 * APPROVED record reaches this predicate. The codex_skip iron rule is unchanged.
 */
export function isCodexGateSatisfied(
	store: CodexGateStore,
	session: CodexGateSession,
	sha: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!codexHardGateEnabled(env)) return true;
	if (session.codex_skip) return true;
	return store.isCodexCodeReviewApproved(session.execution_id, sha);
}
