# Design Review — plan.md FLY-1446 (Round 2)

Date: 2026-07-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 实质性吸收了 Round 1 的大部分反馈：E1/E2 的 fail-closed 边界、报警 episode、证据先行、锁内 keepalive policy、flag 传播和 symlink 收敛都明显更扎实；WP-C 偏离字面 “cp + md5” 的选择是合理的。当前仍有四个会直接影响生产正确性或使 rollout 无效的契约缺口，另有一个默认关闭但尚未达到可安全启用条件的 observer 设计缺口，因此本轮不能批准实施。

## What's Good (Keep)

- WP-0 把易失证据保全前置，并要求命令、时间、时区和 sha256 chain-of-custody；这避免修复动作先污染死因证据。
- WP-C 以 trusted-main symlink 作为终态是对当前安装架构的正确顺应；archive-first、canonical path 无缺口和失败时零替换应保留。
- WP-B 不再制造第二套 watcher 生命周期，launchd 唯一启动者 + `.zshrc` job 卫兵与现有 watcher lease 分工清楚。
- E1 把 `(generation,title)` 明确定义为逻辑可视槽位，并把唯一性检查放进 ledger 写事务；历史 double-committed 只报不动，符合保守 mutation authority。
- E2 将 syntax malformed、known collision 和 indeterminate failure 分型，并让 collision view 进入本轮 blocked set；这既缩小故障域，又没有把未知失败误降级为可继续。
- durable episode counter、maintenance marker 每轮优先、observer 默认关闭、keepalive flag 只停止 enforcement 而不伪装成状态回滚，均正确修复了 Round 1 的语义问题。

## Issues & Recommendations

1. **[HIGH] A-Lead carrier matrix 仍不能准确分类当前 HEAD 的 Codex TUI。** Plan `plan.md:74-82` 用“专用 `*-tui*` wrapper”或“标准 wrapper + codex backend 且 TUI 形态”识别 TUI，但真实 mode 由 `FLYWHEEL_CODEX_LEAD_MODE=tui` 驱动（`packages/teamlead/scripts/codex-lead.sh:136-142`），标准 wrapper 又会 source 共享 `.env`（`scripts/flywheel-lead-wrapper.sh:44-74`）；manifest `backendId` + `ProgramArguments` 本身无法证明该 job 是 TUI。更直接的反例是 production Codex Infra Bot 的 TUI plist 使用 `flywheel-codex-lead-wrapper-codex-infra-bot.sh`，文件名根本不含 `tui`（`packages/teamlead/scripts/templates/com.flywheel.lead.flywheel-codex-infra-bot-lead.tui.plist:9-14`）。建议把现有 carrier 写成闭集：精确 allowlist 已知专用 TUI wrapper/launcher（包含 infra bot），标准 wrapper + codex 在当前生成形态一律视为 headless/config-drift；若未来允许标准 wrapper TUI，先增加可由 roster 读取的 per-job plist/manifest carrier，不能靠共享 `.env` 推断。presence check 也应锁定真实目标 `flywheel:=<project>-<leadId>` 后再检查对应 cmux tab，并补 infra-bot 非 `*-tui*` 文件名回归用例。

2. **[HIGH] A-Runner 的 Bridge URL、Bearer token 和 tmux 全局枚举契约仍未闭合。** Plan `plan.md:92-96` 使用 `$FLYWHEEL_BRIDGE_URL`，但传播表只加载 token（`:166`）；当前 watcher plist 只注入 `FLYWHEEL_CMUX_SUPERVISED=1`（`scripts/com.flywheel.cmux-watcher.plist.template:17-20`），所以正常 launchd 路径没有该 URL。与此同时，仅写“loopback”而不做解析/allowlist，会允许继承的任意 URL 接收 master token。应明确固定安全默认（例如 `http://127.0.0.1:${TEAMLEAD_PORT:-9876}`）或 key-specific 加载 URL/port，并在发送 token 前严格限制 `http` + loopback host + 合法 port、拒绝 userinfo/path/query/fragment；将其加入传播表和测试。Bearer header 必须像 `scripts/daily-digest.sh:127-135` 一样经 `curl --config -` stdin 传递，不能进入可被 `ps` 看到的 argv。另一个事实错误是 plan 的 `list-windows -F '#{window_id}|#{@flywheel_exec_id}'` 没有 `-a`，无法从 launchd 的非 tmux 上下文枚举所有 session，也缺少 linked alias 去重所需的 session name；应逐字采用当前实现语义：`tmux list-windows -a -F '#{session_name}\t#{window_id}\t#{@flywheel_exec_id}'`，按 distinct window id 合并 alias，多个 id 或 malformed 行一律 indeterminate。

3. **[HIGH] `reconcile_roster()` 的挂载顺序没有证明所有 mutation 都经过 WAL/linked-view 恢复闸。** Plan `plan.md:70` 只说挂入 `sync_additive()` 并覆盖空窗分支。当前代码在有窗分支先 `reconcile_existing_workspaces`，再以 `refresh_linked_sessions` 作为恢复失败时整轮 defer 的闸，之后才 create（`scripts/flywheel-cmux-sync.sh:4921-4934`）；空窗分支则在 `:4904-4918` 直接 cleanup 后返回。若 roster create/observer 在 refresh 前运行，会绕过 E2 的 indeterminate-abort/blocked-set mutation authority；若放在 refresh 后，空窗分支和恢复失败轮又可能完全不发缺窗报警。建议明确拆成两相：read-only derive/compare/episode alert 在两分支都可运行；任何 cmux create、observer create/close 必须在本轮 WAL recovery 成功并取得 blocked set 后运行，且对 blocked view 零 mutation。A-Lead“有窗缺 tab”可直接复用现有 post-refresh additive create loop，避免 roster 再造一条 create 调用路径。

4. **[MEDIUM] Observer 虽默认关闭，但其生命周期契约仍不足以安全翻开。** Plan `plan.md:99` 仍把日志来源推迟到“实现第一步”，`:100` 也只写“session 终态”而未锁定读取端点、终态 allowlist 和 404/解析失败语义。`mode=active` 中消失不等于终态：本计划明确排除的 `design_done` 仍是可重采用的非终态；若实现据 active absence 关闭，会误杀观察窗。建议二选一：本 issue 只交付 exec-id orphan 报警，把 observer 实现和 flag 移至后续；或在本 plan 中先钉死 exact durable log/rotation contract，并规定关闭前调用鉴权的 `GET /api/sessions/:id`、校验响应 `execution_id` 与 receipt 完全相等，仅对明确的不可逆 terminal allowlist 授权，404、超时、schema drift、`design_done` 都 fail-closed 保留。默认 0 只能降低当前 blast radius，不能替代启用契约。

5. **[HIGH] Rollout 的 keepalive 手动命令在当前 CLI 上必然失败。** Plan `plan.md:189` 写 `tmux-server-rescue ensure /tmp/tmux-<uid>/default`，但 CLI 要求完整的 `--verify <argv...> --create <argv...>`（`scripts/lib/tmux-server-rescue.sh:1560-1566`）；按计划命令实跑返回 rc=64 和 usage，不会 seed policy。请把 runbook 改为一个完整、现存语义合法的 ensure，例如对 canonical `flywheel` session 使用与 `claude-lead.sh:1434-1436` 相同的 verify/create argv，再由新增 postcondition 创建 sentinel；或者新增一个同样取得 socket lock 的显式 policy-enforce 子命令并测试。rollout 验收还应检查命令 rc、同一 server PID、`exit-empty off` 和 exact `=flywheel-keepalive` session，而不只是等下一次 spawn。

## Verdict

CHANGES REQUESTED — address items above
