/**
 * FLY-696 M1/④ — format the one-line Alerts notice for a Codex per-runner
 * account rotation (event_type `account_rotation`, emitted by
 * `flywheel-codex-with-fallback` via `flywheel-comm account-rotation-notify`).
 *
 * Pure so the Bridge /events branch that posts it to the unified Alerts channel
 * is a tiny call, and the wording is unit-tested. Codex rotates its OWN
 * per-runner auth.json (no Bridge mechanical switch — D2); this notice only
 * makes that rotation VISIBLE (today it is silent).
 */

export interface AccountRotationNotice {
	provider: string;
	to: string;
	from?: string | undefined;
	reason?: string | undefined;
	resetAt?: string | undefined;
}

/** Human labels for the fixed reasons `flywheel-codex-with-fallback` emits. */
const REASON_LABEL: Record<string, string> = {
	rate_limit: "额度/限流",
	auth_expired: "认证过期",
	model_unsupported: "模型不支持",
};

/** Title-case a known provider id ("codex" → "Codex"), else pass through. */
function providerLabel(provider: string): string {
	if (provider === "codex") return "Codex";
	if (provider === "claude") return "Claude";
	return provider;
}

export function formatAccountRotationNotice(n: AccountRotationNotice): string {
	const arrow = n.from ? `${n.from} → ${n.to}` : `→ ${n.to}`;
	const parts: string[] = [];
	if (n.reason) parts.push(REASON_LABEL[n.reason] ?? n.reason);
	if (n.resetAt) parts.push(`reset ${n.resetAt}`);
	const suffix = parts.length ? `（${parts.join("，")}）` : "";
	return `🔁 ${providerLabel(n.provider)} 账号轮转：${arrow}${suffix}`;
}
