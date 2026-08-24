# Design Review — FLY-1999 plan.md (Round 1)

Date: 2026-08-23
Author: Codex
Status: CHANGES REQUESTED

## Summary

从最终 runner 子进程边界改为 `env -i` 白名单重建，是正确且能在现有架构中落地的主方向；三层防御、无新 flag/timer、精确环境集合与阳性对照也都值得保留。但当前计划对 shell 展开位置、marker compat 注入、rescue 出生环境和存量 session scrub 范围有四个会破坏正确性或让验收假绿的缺口，因此尚不能直接实施。本轮已完成源码审计与真实 `/bin/sh` 组合探针；focused Vitest 未执行，工作树缺少可调用的 `vitest`（`Command "vitest" not found`）。

## What's Good (Keep)

- 以“最终子进程 env 精确等于 allowlist”为安全不变量，替换无法长期维护的六名 denylist；这比继续追加 `env -u` 名单更符合本次事故根因。
- 静态 OS 基底与每次 launch 的显式协议名分层，变量名 fail-loud 校验，值不进入模板/argv，并区分 unset 与显式空串，边界设计合理。
- `new-window -e` 位于最终 pane 命令之前（`TmuxAdapter.ts:776-788`），因此显式注入值可在 pane shell 内按名字重建；`TMUX`/`TMUX_PANE` 也是 tmux 创建 pane 后设置的值，保留它们并非无效操作。
- 同时覆盖 direct/gated Claude 路径、Kimi/Antigravity 子类和 Codex runner TUI，并保留现有 gate token、prompt-file 与 launch budget 机制，范围选得对。
- 出生点卫生与 boot scrub 作为纵深防御可以保留；无新 feature flag、无新 timer、随正常班车部署，以及“不追溯修改已开 pane”的边界符合项目约束。
- S2/S5/S6/S8 要求真实 shell/tmux 执行、精确集合断言、污染阳性对照、幂等与零值泄漏，测试思路明显强于只匹配命令文本。

## Issues & Recommendations

1. **BLOCKER — `${VAR+"VAR=$VAR"}` 不能按计划作为现有 gate 的 argv 前缀接线。** 当前 gated 命令把完整 safe command 放在 `sh -c` 的位置参数中，脚本最终执行 `exec "$@"`（`TmuxAdapter.ts:196-208`）；shell 不会对位置参数的内容做第二次参数展开。真实 `/bin/sh` 探针确认，把字面 `${PROTOCOL_VALUE+"PROTOCOL_VALUE=$PROTOCOL_VALUE"}` 放进 `"$@"` 会原样传给 `env`，而不是读取 pane env。这会让命令形状“看起来正确”，但实际变量完全没有被重建。建议在计划中钉死两个真实执行形状：direct 统一为 `sh -c 'exec env -i ${...} "$@"' <sentinel> <binary> <args...>`；gated 在现有 gate 脚本文本内部执行 `exec env -i ${...} "$@" ["$p"]`，binary/args 继续只走位置参数，只有经过正则校验的变量名进入 shell source。S2 必须分别执行 direct、gated+prompt、gated-no-prompt 三种成品命令。现有测试没有完整 argv byte snapshot，但 `TmuxAdapter.test.ts:65-130` 仍断言“六名删除、未列秘密保留”，Kimi/Antigravity 的 `launchedBinary` 解析器也明确跳过 `env -u`（`KimiTmuxAdapter.test.ts:123-129`、`AntigravityTmuxAdapter.test.ts:69-75`）；S3 应明确更新这三处结构假设，而不只是泛称“79 测回归”。

2. **BLOCKER — “动态段 = 本次 `-e` 名集合”会漏掉现有 marker compat 协议。** 实际入口名是 `execute()`，不是计划反复写的 `startInteractive`。当没有 HookCallbackServer 时，代码把 `FLYWHEEL_MARKER_DIR` 写到 session environment，而没有放入 `new-window -e`（`TmuxAdapter.ts:451-461`）；SessionEnd hook 会读取它并回退到 `/tmp/flywheel/sessions`（`scripts/hooks/flywheel-session-end.sh:21-24`），而 watcher 使用进程启动时解析的 `FLYWHEEL_MARKER_DIR`（`packages/core/src/constants.ts:25-31`）。按当前计划洗完后，自定义 marker dir 会被静默丢弃，hook 写默认目录、watcher 看自定义目录，legacy completion 可能永远不到达。建议先把 compat 路径改为每窗显式 `-e FLYWHEEL_MARKER_DIR=<resolved value>`，再从同一个结构化 `appendPaneEnv(name, value)` helper 同时生成 tmux args 与 allowlist 名集合，避免事后解析 argv；加一条无 hook server + 自定义 marker dir 的真实 child/hook 测试。S7 也应以这个已发现消费者为起点，而不是等 sweep 后再碰运气。

3. **BLOCKER — server-birth helper 在三个现有调用面上不能按 2.3 所述直接保证“精确 canonical env”。** `TmuxAdapter` 的 sync/async exec 封装会把 `opts.env` 合并回 `process.env`（`TmuxAdapter.ts:2061-2078,2123-2138`），Codex runner TUI 的 async spawn options 根本没有 `env` 且生产代码只传 `stdio`（`codex-runner-tui-window.ts:350-365,411-415`）。更关键的是，rescue CLI 本身依赖 `FLYWHEEL_TMUX_RESCUE_*` 控制项（`tmux-server-rescue.sh:63-76,184-207`），随后又 export 多个 `_TMUX_RESCUE_*` 内部变量（`:1022-1037,1637-1638`），最后才执行 `create_argv`（`:713-715,749-750`）；只用 washed env 启动 rescue 既会丢其调优/告警契约，也仍会把内部变量带进新 server。其 argv validator 还要求 create argv 以 `tmux` 开头（`:503-522`），不能无设计变更地塞入 `env -i`。建议把“rescue 控制环境”和“真正执行 tmux create 的出生环境”拆开：保留 rescue 所需控制项，在 rescue 内部、仅对 `create_argv`/`guarded_create` 的实际 exec 应用 exact canonical env，或显式扩展其受测协议；TS 的非-rescue 出生点则提供 replace-not-merge 的 exec seam。S5 需覆盖 server absent/reachable 两分支、rescue 内部变量不落入 global env、显式 `-S` socket/override 不漂移，以及 canonical PATH 使用展开后的绝对 HOME 而非字面 `~`。

4. **HIGH — boot scrub 只处理 global 与 `=flywheel`，遗漏实际生产 runner sessions，并且“固定名单”的通配写法不可直接执行。** 生产 TmuxAdapter session 是 `sanitizeTmuxName("runner-${project.projectName}")`（`run-infra.ts:975`），已有 session 保存自己的环境；只清 global 和 Lead 的 `flywheel` session，旧 `runner-*` session 仍可把 secrets/身份名和旧 PATH 注入新窗。pane allowlist 会挡非白名单秘密，但会合法保留 session 的 PATH，所以当前 scrub 也不能兑现 canonical PATH。另据 research 的名单定义，`FLYWHEEL_CODEX_LEAD_*`、`FLYWHEEL_LEAD_*`、`DISCORD_*` 是前缀规则，不是 `tmux set-environment -u` 可理解的 glob。建议从 `projects` 精确派生受管 session 集合（`flywheel` + 每个 sanitized `runner-*`），对 global 和每个已存在的受管 session 同时删名并设置 canonical PATH；先读取 `show-environment` 的名字，经同一变量名校验后按 exact names + prohibited prefixes 过滤，再逐个 unset。把 scrub 的明确挂点放在 `startBridge()` 最早的同步 boot/pre-admission 段、任何 runner/Lead child spawn 之前（当前入口 `plugin.ts:4243`），并尽可能用单个 tmux command queue 完成每个 scope，测试“scrub 与 new-window 并发”时最终 child boundary 仍安全。`.env` 路径也应与 wrapper 一致，解析 `${FLYWHEEL_STATE_DIR}/.env`（`flywheel-bridge-wrapper.sh:30-48`），不要硬编码 `~/.flywheel/.env`。

5. **MEDIUM — 命令预算估算偏低，当前 S1 还没有覆盖真实最坏形状。** 对计划列出的 31 个静态名按拟议 `${VAR+"VAR=$VAR"}` 生成并加上 `exec env -i ... "$@"`，实测已是 955 bytes，而非“约 700B”；动态 transport/extraPaneEnv/compat 名、gate 脚本、prompt 元数据和长路径还会继续叠加到现有 12,288-byte 总预算（`TmuxAdapter.ts:94-97`）。这不必改变设计，但 S1 应从生产 `envArgs` 构造器生成所有动态名，并分别对 direct/gated、Kimi 最大 `NODE_OPTIONS`、长合法 cwd/gate/prompt 路径运行现有 `assertLaunchCommandBudgets`；同时保留 oversize 在 durable launch commit 前 fail-loud 的断言。计划中的风险表和容量数字应按实测更新。

## Verdict

CHANGES REQUESTED — address items above
