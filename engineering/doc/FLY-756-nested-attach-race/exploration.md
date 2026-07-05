# FLY-756 cmux-sync heal/reopen 注入竞态 → nested-attach — 探索

Issue: FLY-756 (https://linear.app/geoforge3d/issue/FLY-756/infra-cmux-sync-healreopen-注入竞态-runner-pane-里出现-nested-attach)
日期: 2026-07-02
基于: 无（上游线索来自 engineering/doc/FLY-754-viewer-session-leak/exploration.md 的 nested-attach 一节）

## 问题

Annie 2026-07-01 点开 cmux 的 FLY-754 workspace，pane 是死的：循环
`tmux attach -t '=cmux-FLY-754-…-viewer-execid-session'` **4 次全被
`sessions should be nested with care, unset $TMUX` 拒掉**，掉回空 shell。

关键澄清（勿混淆）：目标是 `cmux-*` **linked session**（cmux-sync 域），**不是**
`viewer-<uuid>` session。名字里的 "viewer-execid-session" 只是 FLY-754 issue 标题的
slug。FLY-754 PR #413 修的是 `viewer-<uuid>` 生成源，与本 issue 是**两个 session 族，
互不覆盖**。

## 根因

`tmux attach` 报 `sessions should be nested with care` 的**唯一触发条件**：跑 attach 的
那个 shell **环境里带 `$TMUX`**（tmux 用 `$TMUX` 环境变量判断"是否已在 tmux 内"）。

全 codebase 跑 `tmux attach` 的只有三类（FLY-754 已审计，本 issue 复核确认）：

| # | 位点 | 是否可能 nested |
|---|------|----------------|
| 1 | Terminal.app tab (`run-issue.ts` / `e2e-tmux-runner.ts` 的 `do script "… tmux attach"`) | 否 — fresh Terminal shell，无 `$TMUX` |
| 2 | **cmux workspace 启动命令**（`flywheel-cmux-sync.sh:1864` `new-workspace --command "tmux attach …"`） | **是** — surface shell 继承 cmux 进程 env；若 cmux 从 tmux 内被拉起 → `$TMUX` 已设 |
| 3 | **cmux-sync heal/reopen 注入**（`flywheel-cmux-sync.sh:1139` `heal_send_attach`，把 `tmux attach` 当文本 `cmux send` 进 surface） | **是** — ① surface shell 继承的 `$TMUX`；② gate→send 竞态注入进已 attach 的 pane |

Annie 的 4 连拒 = 初始 create attach（类 2）+ heal/reopen 重试（类 3，`REOPEN_ATTEMPT_LIMIT=3` 吻合）。
现场佐证：成功 attach 的**新** surface shell 实测 env 里 `TMUX=` 为 0 个，挂掉的**旧**
surface shell 当时带 `$TMUX` → 假设成立。

### 类 3 的竞态（gate→send 非原子）

`self_heal_workspace_ref`（:1169）三道 gate（managed 标题 + 0-client + bare-shell）
通过后调 `heal_send_attach` 发 `cmux send`。**0-client gate（:1182）与实际 send（:1159）
之间有一段 bookkeeping 窗口**，focus 触发的 attach 可在此窗口内完成 → 文本打进**已 attach
的 pane**（`$TMUX` 已设）→ nested 报错。

现状：FLY-254 已为**升级路径**（`HEAL_RENDER_ESCALATE=1`）加了 send 前最后一刻的
`_heal_send_final_guard`（0-client re-check，跑在 `cmux_call_guarded` 里当 cmux 前的
genuine last op）。但**普通 heal 路径（非升级）NO guard**（:1159 注释明写 "byte-compatible:
no guard"）—— 竞态窗口在普通路径上仍然敞开。

## 要修（issue 三条）

1. **环境卫生**：类 2、类 3 的 attach 命令前置 `env -u TMUX`（比 `unset TMUX;` 更原子、
   单条命令、不残留改动 shell env）→ 无论 surface shell 是否继承 `$TMUX`，`tmux attach`
   子进程都看不到它。**直接治 Annie 的 4 连拒 dead pane。**
2. **gate→send 原子化**：让普通 heal 路径也走 `_heal_send_final_guard`（即在 send 前最后
   一刻 re-check 0-client）。复用 FLY-254 已有、已 Codex-reviewed 的 guard 机制，把两条注入
   路径**统一成单一 guarded send**（既满足"最后一刻 re-check"，又强化 FLY-254 "只能有一条
   注入路径" 的不变式）。
3. **回归**：self-heal（FLY-169）与 reopen sweep（FLY-254）既有 292 个测试不回退。

## 一个 scope 问题（待 Lead 拍）

`packages/teamlead/src/bridge/tmux-lookup.ts:119` 的 FLY-560 rescue 命令
（`tmux attach -t '=<session>'`，pin 到 Discord thread 供 Annie **手动**复制粘贴）有
**相同 nested 失败模式** —— Annie 恰恰会把它粘进那个 cmux dead surface（带 `$TMUX`）。
但它是 FLY-560 的独立 feature、有自己的测试断言、且是"用户手动路径"非"自动注入竞态"。

倾向：**核心修保持 2 个 cmux-sync 位点**（issue 明确点名的）；是否顺手给 FLY-560 rescue
命令也加 `env -u TMUX`（低风险、同症状、需改一处用户可见字符串 + 对应测试）留给 Lead 决定。

## 备选（已否）

- 只加环境卫生、不动原子化：治了继承 `$TMUX` 的类 2/3，但类 3 的"注入进已 attach pane"
  竞态仍在（虽然加了 `env -u TMUX` 后即使注入进 attached pane 也不会再报 nested——文本进的
  是 Claude prompt 而非 shell——但那是"往 Claude prompt 打字"的另一种坏，正是 FLY-254
  guard 要防的）。→ 两条都做。
- 把 heal 改成非文本注入（直接 tmux attach 到 surface pty）：cmux surface 不是裸 pty，
  没有此 API；改动面远超 issue。否。
