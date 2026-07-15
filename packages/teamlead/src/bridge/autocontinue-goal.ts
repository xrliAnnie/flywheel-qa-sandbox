/**
 * FLY-818: auto-continue goal contract builder — pure.
 *
 * Produces the markdown "goal contract" written to a durable per-execution file
 * that the runner's `/loop` re-reads every iteration. Borrowed (simplified) from
 * OpenAI Codex `/goal`'s 6 elements (FLY-512 research): outcome, verification,
 * stop conditions, iteration policy, boundary/budget, blocked→escalate.
 *
 * Two hard stop distinctions (Codex design review R1#3): a BLOCKING gate/question
 * is a hard stop (the runner waits for a human answer); a NON-BLOCKING
 * `flywheel-comm ask` is NOT a stop — the runner keeps working toward the goal and
 * periodically checks for the reply (this matches Blueprint's existing contract).
 *
 * Phase-aware (FLY-793 three-stage integration): each phase-agent has its own
 * outcome + stop boundary. `monolithic` is the byte-compat default when FLY-793 is
 * off (single runner drives the whole pipeline to PR).
 */

/** Resolved auto-continue phase. `monolithic` = FLY-793 off (single runner). */
export type AutocontinuePhase = "design" | "implement" | "qa" | "monolithic";

/**
 * M0 (FLY-793 reconcile / Codex R1#4): resolve whether a session is an
 * auto-continue arming target, and which phase goal it gets.
 *
 * Backend gate (Codex R1#4): `/loop` is a Claude Code harness feature. Only the
 * claude-tmux backend (or an undefined legacy adapter_type = claude default) is
 * arm-eligible. Non-Claude backends are excluded:
 *   - `codex` has its own `/goal` (out of v1 scope);
 *   - `antigravity-tmux` / `kimi-tmux` are no-transport runners that terminate at
 *     `pr_handoff` and never enter the idle approve/wake loop — arming them is a
 *     no-op by design (they don't idle-loop waiting for continuation).
 *
 * Phase (from session_role): byte-compat default is `monolithic` (FLY-793 off,
 * single runner drives the whole pipeline). `design`/`implement` are reserved for
 * the FLY-793 three-stage roles (PR #430) — an unknown role defaults to
 * `monolithic` so this stays correct before FLY-793 lands.
 */
export interface AutocontinueTarget {
	/** True ⇒ this session may be armed for auto-continue. */
	armEligible: boolean;
	/** Phase goal template to use (meaningful only when armEligible). */
	phase: AutocontinuePhase;
	/** When not eligible, why (audit/log). */
	reason?: string;
}

/** Adapter types that support the Claude `/loop` self-continue mechanism. */
const CLAUDE_LOOP_ADAPTERS = new Set(["claude-tmux"]);

export function resolveAutocontinueTarget(input: {
	/** session.adapter_type; undefined/legacy ⇒ treated as the claude default. */
	adapterType?: string;
	/** session.session_role; undefined ⇒ 'main' (monolithic). */
	sessionRole?: string;
}): AutocontinueTarget {
	const adapter = input.adapterType;
	// Undefined/empty adapter_type = legacy claude-tmux default (byte-compat).
	const isClaudeLoop =
		adapter === undefined ||
		adapter === "" ||
		CLAUDE_LOOP_ADAPTERS.has(adapter);
	if (!isClaudeLoop) {
		return {
			armEligible: false,
			phase: "monolithic",
			reason: `backend '${adapter}' has no /loop (non-claude / no-transport pr_handoff runner)`,
		};
	}
	const role = (input.sessionRole ?? "main").toLowerCase();
	const phase: AutocontinuePhase =
		role === "design"
			? "design"
			: role === "implement"
				? "implement"
				: role === "qa"
					? "qa"
					: "monolithic";
	return { armEligible: true, phase };
}

/** Per-session continuation budget (mandatory — Codex R1#7). */
export interface AutocontinueBudget {
	/** Max auto-continuation turns before the loop stops + reports. */
	maxContinuationTurns: number;
	/** Max wall-clock minutes for the continuation loop. */
	maxWallClockMinutes: number;
	/** Consecutive no-progress (no tool call) turns before the loop stops. */
	maxNoProgressTurns: number;
}

export interface GoalContractInput {
	phase: AutocontinuePhase;
	issueIdentifier: string;
	issueTitle?: string;
	budget: AutocontinueBudget;
}

/** Per-phase outcome ("done when") + the boundary where the runner must stop. */
const PHASE_OUTCOME: Record<
	AutocontinuePhase,
	{ outcome: string; stopAt: string }
> = {
	design: {
		outcome:
			"把 exploration/research/plan 写完并 commit,通过 design_review gate",
		stopAt: "design_review gate(阻塞)/ 本段 handoff",
	},
	implement: {
		outcome: "TDD 实现 + 过 code review + 开 PR",
		stopAt: "approve gate(阻塞,ship 仍 founder-gated)",
	},
	qa: {
		outcome: "跑完 QA + 写下 verdict",
		stopAt: "verdict 落地后",
	},
	monolithic: {
		outcome: "把整条流水线(brainstorm→…→实现→code review)做到开 PR",
		stopAt: "approve gate(阻塞,ship 仍 founder-gated)",
	},
};

/**
 * Build the goal-contract markdown. Deterministic (no clock/random) so it is a
 * stable, re-readable file the runner references after compaction.
 */
export function buildGoalContract(input: GoalContractInput): string {
	const p = PHASE_OUTCOME[input.phase];
	const title = input.issueTitle ? ` — ${input.issueTitle}` : "";
	const b = input.budget;
	return `# 自续跑目标契约 — ${input.issueIdentifier}${title}

你在**自续跑(auto-continue)模式**下工作:一轮做完后,只要目标没达成、也没被阻塞,就自己朝目标继续(用 /loop / ScheduleWakeup 排下一轮),不要 idle 死在 prompt 等人。**每轮先重读本文件再干**(compaction 后也一样)。

## Outcome(完成 = 什么为真)
- 阶段:${input.phase}
- 完成条件:${p.outcome}。
- 到达完成条件 → **停,不再续跑**。

## Verification(证据驱动,不靠"感觉做完了")
- 用客观证据判完成:测试/CI 结果、PR、verdict 文件、gate 通过等。别在没有证据时标完成。

## Stop conditions(硬性)
- **撞到阻塞 gate(brainstorm / question / approve / design_review)→ 停下等答复。** gate 命令会阻塞这一轮;你**不要**再排下一次续跑。
- **本段停在:${p.stopAt}。**
- **注意区分**:\`flywheel-comm ask\` 是**非阻塞**的——你**继续**朝目标干、周期性 check 回复,**不要**因为发了一条 ask 就停 loop。只有阻塞的 \`gate\` 才是硬停。

## Iteration policy(防空转)
- 一次续跑 turn 若**没有实质进展 / 没有任何 tool 调用** → **停,不再续跑**(避免空转刷屏)。

## Budget(硬预算,到就停并报告进度)
- 最多 **${b.maxContinuationTurns}** 次自续跑 turn;
- 最多 **${b.maxWallClockMinutes}** 分钟续跑墙钟;
- 连续 **${b.maxNoProgressTurns}** 次无进展 turn。
- 任一预算耗尽 → **停 loop、总结当前进度与下一步**(不当作完成)。

## Blocked → escalate
- 反复失败 / 没有可行路径 / 续不动 → 走 \`flywheel-comm ask\`(问 Lead)或阻塞 gate 升级;**别硬续**。真卡住时系统的安全网会把你上报给 founder。

绝不自合并、绝不自 ship —— ship 永远是 founder 的 gate。
`;
}
