# FLY-1364 cmux sync QA 回修 — 验证证据
Issue: FLY-1364 (https://linear.app/geoforge3d/issue/FLY-1364/修复cmux-总修-cmux-sync-整体修好-单写锁-fail-safe-反向根因-死条目不清-重派窗口不补条目-attach-不自愈)
日期: 2026-07-22
基于: plan.md

## 1. 已存在的 code review 记录

QA 所见的 review 缺口是记录可见性问题，不是未执行：

- Round 1：question `e31fef55-87a8-46c4-b66f-ce490d660e85`，`reviewVerdict=APPROVED`，`reviewedHeadSha=02ede9f5e6571a946d6dcbcbf9d470181fe3c470`。
- Round 2：question `dc26e473-37a4-40a4-9290-37534f585d4c`，`reviewVerdict=APPROVED`，`reviewedHeadSha=042237e32bdc641ee56a48773b7df28c8f0a589d`。
- 两轮只有同一组 LOW advisory：rescue audit log 无轮转上限、informational classifier 的纯返回路径放宽但 runtime inert；无 blocking finding。

可直接复核：

```bash
node "$FLYWHEEL_COMM_CLI" check e31fef55-87a8-46c4-b66f-ce490d660e85
node "$FLYWHEEL_COMM_CLI" check dc26e473-37a4-40a4-9290-37534f585d4c
```

本 QA 回修改变测试/CI，因此回修 head 仍按流程另开新 code review；上面两条仅关闭 QA 对既有记录的误判。

## 2. Fix G green 观测环境

把 suite 按真实 CI 顺序串跑后，复现了此前「单跑绿、负载后不稳」的问题：episode 测试用 `sleep 0.3` 对比 `0.4s` 阈值，实测 critical-section hold 为 `0.546633s`，导致 normal/long 分类受机器负载支配。

回修后的测试把 episode 分类时钟限制在测试生成的 critical child 内，精确注入 `0s` 或 `2s` hold；生产库没有新增时钟 seam。以下能力仍用真实系统行为：

- kernel advisory lock 与五个真实并发 contender；
- SIGKILL 三态及 kernel lock 释放；
- queue wait `1.2s` + real hold `0.05s`，证明 wait 不计入 hold；
- alert 在锁释放后执行的真实 nonblocking probe。

本机结果：`tmux-server-rescue-instrumentation.test.sh` 为 `7 passed, 0 failed`，且紧跟 rescue lock suite 串跑仍绿。

## 3. FLY-1364 shell suite 的 CI 硬接线

`.github/workflows/ci.yml` 的 required `script-tests` job 新增唯一、无条件、不可 `continue-on-error` 的 `Test — FLY-1364 cmux sync repair` step，执行：

```bash
bash scripts/test-cmux-sync.sh
bash scripts/__tests__/tmux-server-rescue.test.sh
bash scripts/__tests__/tmux-server-rescue-lock.test.sh
bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh
bash scripts/__tests__/flywheel-cmux-install-link-only.test.sh
```

`scripts/__tests__/ci-structure.test.sh` 锁定 step 名、五条命令及顺序、无条件执行、fail-closed 结果。

主 cmux harness 默认仍强制 macOS `/bin/bash` 3.2，防止本地兼容门被 Homebrew Bash 掩盖；Linux CI 必须显式设置 `FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH=1` 才能追加现代 Bash compatibility pass。实测现代 Bash 完整矩阵：`404 passed, 0 failed`。

首次 Actions 观测同时暴露了通用 rescue suite 的两个既有 Linux 可移植性缺口：GNU awk 将 `load` 保留为 builtin 名；GNU `stat -f` 会成功输出文件系统信息而不是拒绝 BSD format。回修把 awk 入参改名为 `load_value`，并将 portable owner/mode probe 调整为 GNU `stat -c` 优先、BSD `stat -f` fallback。测试在 macOS 注入等价 GNU parser/CLI 语义，旧实现稳定复现 `32 passed, 3 failed`，修复后为 `35 passed, 0 failed`。完整五命令 CI step 本机复跑全部通过。

## 4. 真机三发核心 E2E

入口：

```bash
/bin/bash scripts/__tests__/fly1364-live-e2e.test.sh
```

环境：macOS Darwin 25.3.0 arm64，cmux `0.61.0 (73)`，真实 `/tmp/cmux.sock`。Flywheel state、ledger、lease、latch、sidecar 全落在 `mktemp` 私有根；live cmux workspace 只通过本轮返回的 exact UUID/ref 清理，并恢复测试前 selected workspace。

当前 managed sandbox 禁止 `/bin/ps` 读取自身 start identity，因此 harness 只在 probe 失败时启用生产已有的 deterministic incarnation test seam；两个 contender 仍是独立真实 PID，活性仍由真实 `kill -0` 判断。生产环境从不设置该 seam。

结果：

1. **锁验证失败 → 重建续跑**：持有经验证的全局 sole-writer lease 后注入 malformed residual ledger inner lock；writer 记录 recovery audit、重建 inner lock、连续完成两次 ledger transaction，未退出。
2. **dup watcher → 单实例胜出**：两个真实 Bash contender 同时争用私有 watcher lock；恰一 PID 写 winner，owner record 与 winner 一致，另一进程以 `already running` clean dedup 退出，winner 结束后 lease 消失。
3. **死条目 → 清理**：真实 cmux 创建 `/usr/bin/true` 已退出的 workspace，确认 sidebar entry 仍存在，rename 为唯一 title，写入当前 socket generation 的 exact-ref receipt，再走 `dismantle_view_display`；`workspace:174` 被 guarded exact-ref close，receipt 同步移除。

汇总：`Results: 3 passed, 0 failed`。

额外卫生复核：探路创建的 `workspace:173` 与正式 E2E 的 `workspace:174` 均已按 exact id 关闭；`list-workspaces` 中无 `FLY-1364-live-dead-*` 残留，测试后 selected workspace 恢复为 `workspace:154`。

## 5. R11 最终实现 head 的 fresh 回归

2026-07-22 在完成五项 xhigh finding 回修后，从同一 working tree 重新执行：

| 命令 | 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `461 passed, 0 failed` |
| `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` | `12 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `36 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-lock.test.sh` | `3 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh` | `12 passed, 0 failed` |
| `/bin/bash scripts/__tests__/flywheel-cmux-install-link-only.test.sh` | `flywheel-cmux-install --link-only: ok` |
| `/bin/bash scripts/__tests__/test-cmux-autostart-flags.test.sh` | `5 passed, 0 failed` |
| `/bin/bash scripts/__tests__/ci-structure.test.sh` | `PASS: FLY-1338 CI structure contract` |
| teamlead related Vitest(kind/router/tmux lookup) | `3 files, 57 tests passed` |
| config feature-flag Vitest | `1 file, 28 tests passed` |
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm build` | 全 workspace 通过 |
| tracked-source Biome(`git ls-files -z ... biome check --files-ignore-unknown=true`) | 通过；2 个既有 warning，0 error |

`pnpm lint` 的裸目录扫描会把本 runner 专用、已被 `.git/info/exclude` 排除的 `.flywheel/runs/**` 与 `.pnpm-store/**` 当源码格式化，产生 640 个 artifact diagnostics；改以全部 `git ls-files` 跑相同 Biome check 后 0 error，且 `--changed --since=origin/main` 对本 PR 14 个 Biome-supported 改动文件也为 0 error。

额外执行的 `tmux-server-rescue-real-tmux.test.sh` 在 managed sandbox 为 `2 passed, 4 failed`：`/bin/ps` 对自身也返回 `operation not permitted`，所以 server census 按生产合同 fail-closed 为 `unknown`；socket ownership/lsof 两项仍通过。这不是用 seam 冒充真机成功，能力级 cmux 验收另由下节真实 cmux/tmux E2E 覆盖。

## 6. R11 能力级 E2E 与拒清实发

- `/bin/bash scripts/__tests__/fly1364-live-e2e.test.sh`：Darwin 25.3.0 arm64、cmux `0.61.0 (73)`，`7 passed, 0 failed`。真实 stock exact-ref `workspace:235` 自动清理；A0B1 在 5 秒内完成 workspace/receipt/independent view/attach；杀 attach 后 49 秒自愈；runner source 退休后 view 保持；watched pane dead 后 27 秒自动关闭。
- `/bin/bash scripts/__tests__/fly1364-discord-e2e.test.sh`：真实 Discord message `1529630115615604806`，marker `fly1364-refusal-1784762638-38156`，3 秒实收并按 id GET。正文逐字校验 `[QA FLY-1364]` 标题、source kind/title/signature；cmux inventory、私有 ledger、生产 alert queue/deadletter/claims 快照均零变更。
- instrumentation 新增 outer-process 在 kernel lock 释放后、alert 前 SIGKILL 的 crash seam；下一个真实 holder 只在原 outer PID/incarnation 不再存活后 replay。五 contender 并发仍最多一次 alert，避免 live owner 与 replayer 双发。

实发告警的 exact source contract：

```text
kind=cmux_cleanup
title=cmux stock cleanup refused
signature=cmux_cleanup|stock-adoption|generation=fly1364-discord-generation|ref=multiple|normalized=FLY-1364-qa-fly1364-refusal-1784762638-38156|evidence_sha256=c6d8ee97d64cd51536229e152af2ce025e032b2c636d58fc2146954454c4159c|reason=ambiguous-normalized-title
```

### 真机探测事故与修正

首次 stock-cleanup 真机探测错误地把私有 adoption state 与未过滤的全局 cmux inventory、`grace=0` 组合，除本轮目标 `workspace:220` 外还关闭了两个非本单创建的 QA sidebar workspace：`workspace:205` (`FLY-1380-qa-claude-Opus-DAG-build-work-kind-bindin`) 与 `workspace:187` (`FLY-1423-qa-claude-Opus-engine-bug4-qa-fail-attemp`)。发现后立即中断；cmux close 无直接恢复操作，相关 design/implement workspace 与 live tmux window 当时仍在。此事故不得记作验收成功。

修正后 harness 在把 inventory 交给任何 cleanup helper 前，先按本轮返回的 exact ref + exact title 过滤；测试尾声也只允许关闭本轮记录的 UUID/ref。后续 fresh run 以 `workspace:235` 通过 7/0，且退出时无 `FLY-1364-live-*` 残留。provisional-title 诊断创建的 `workspace:230/231` 也按各自 exact UUID 关闭并复核不存在。

Discord exact-contract 收紧过程中另有一次诊断 POST 成功、随后本地 digest 断言失败；消息按 QA 约定留在隔离频道不删除。修正 literal `\\n` digest 后，以上 message `1529630115615604806` 才是最终通过证据。

## 7. R12 xhigh 增量回修

对提交 `a02a4bea` 的 fresh Codex xhigh hard-gate 提出四项 actionable finding，全部按 TDD 关闭：

1. **P1 WAL recovery mutation race**：`_retire_owned_stage` 的 unlink/kill、`_retire_create_intent_stage` 的 kill、`claim_intent` rename 现在都通过 `tmux_call_guarded`，最后一步重新验证 WAL generation + exact session id/topology snapshot。三个 generation-flip 红测在旧实现分别真实执行了 unlink+kill、kill、rename；修复后全部保留 WAL/原 session 且零 mutation。
2. **P2 lease drift/crash matrix**：mock census 改为 call-sequenced，可稳定命中 `process-census-changed`；全局 lease 新增仅测试启用的 SIGKILL seam，覆盖 quarantine rename、canonical dir create、owner publication、owner readback。下一个 contender 在同一 kernel reap mutex 下，以双快照空 census 收敛 exact stale quarantine，最终每点都只有一个有效 owner且无 quarantine 残留。
3. **P3 incident fixtures executable**：1393 fixture 现在直接驱动 redispatch create/receipt/independent view；1404 fixture 直接驱动 workspace/surface/screen/zero-client attach heal。fixture 的 expected SLA/strict view 值也进入断言，不再只验 schema。
4. **P3 autostart CI**：required `Test — FLY-1364 cmux sync repair` step 加入 `test-cmux-autostart-flags.test.sh`，structure gate 同步逐字锁定命令顺序。

红相：主 harness `462 passed, 4 failed`，四个失败恰为三个 WAL race + lease crash matrix；CI structure 因缺 autostart 命令失败。绿相：

| 命令 | R12 fresh 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `466 passed, 0 failed` |
| `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` | `12 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `36 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-lock.test.sh` | `3 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh` | `12 passed, 0 failed` |
| install link-only | `ok` |
| autostart flags | `5 passed, 0 failed` |
| CI structure | `PASS` |
| Bash syntax + `git diff --check` | 通过 |
| changed-source Biome | 14 files, 0 error |

R12 第一次 fresh live E2E 的 stock exact close 已通过，但 A0B1 full condition 超出 SLA，76 秒时报失败；trap 仅按本轮 exact UUID/ref 清理，随后 inventory 复核无 `FLY-1364-qa-live-*` 残留。未改代码的立即重跑为 `7 passed, 0 failed`：stock `workspace:240` exact close、A0B1 create/receipt/view/attach 5 秒、kill-attach heal 51 秒、source retire 后 view 保持、watched pane dead 后 27 秒 exact cleanup。首轮 76 秒不可作为成功证据，保留为真机瞬态记录；最终 capability pass 使用第二轮完整 7/0 输出。

本轮未重发 Discord，因为 R12 只改 tmux WAL/lease/test/CI，不改 alert kind/title/signature 或 delivery；exact-contract 实发仍以 message `1529630115615604806` 为证。

## 8. R13 xhigh 增量回修

对提交 `133151c4` 的下一轮 fresh Codex xhigh hard-gate 提出五项 actionable finding，全部按 TDD 关闭：

1. **P1 WAL source-gone escrow 身份丢失**：旧路径在源 session 消失后调用 `escrow_view_session` 重新读取当前 generation，可能把 tmux 重启后的同名 replacement stage rename 成 keeper。`escrow_view_session` 现在可接收调用方已授权的 generation、session id、完整 topology snapshot；WAL source-gone 路径必须逐字匹配三者才允许任何 inventory/rename mutation。
2. **P1 Discord 零 mutation E2E 漏掉 guarded chokepoint**：隔离实发脚本除 `cmux_call` 外，现在同时覆盖 `cmux_call_guarded` 与 direct `cmux`；任一路径被触发都会写 mutation log 并让验收失败。CI structure test 静态锁定两个覆盖函数存在，防止测试回退为只拦读路径。
3. **P2 Bash 3.2 outer PID race**：旧 fallback 在 command substitution 中启动 `/bin/sh`，记录的是已退出的中间 shell PID，导致 live owner/replayer 同时投递。新实现让 direct child 把其 `$PPID` 写入 token-unique、0600 probe，再由真实 outer invocation 读取；不再用错误的 `$$` fallback。回归直接断言记录 PID 在 acquisition 前仍存活，并把五 contender episode 重复四轮。
4. **P2 real-tmux suite 缺 CI**：required `Test — FLY-1364 cmux sync repair` step 新增 `tmux-server-rescue-real-tmux.test.sh`，且 structure gate 锁定命令顺序。
5. **P3 1385/1402 fixture 硬编码**：共享 fixture loader 现在读取 `tmux_sessions`/`tmux_windows` 构建 executable topology；1385/1402 行为测试从 fixture 读取 workspace ref/title、`expected.adopt_after_two_passes` 与全部 raw-title controls，不再只消费 `workspace_json`。

红相（生产文件未改前）：

- 主 harness：`466 passed, 1 failed`；旧代码真实执行 `rename-session -t =fwstage-r13-source-gone fwkeeper-13-fwstage-r13-source-gone`，随后删除 WAL，精确复现 authority 换代。
- rescue instrumentation：`12 passed, 1 failed`；Bash 3.2 记录 PID 已死亡，start identity 为空。
- CI structure：因缺 real-tmux 命令以及 Discord guarded/direct mutation 覆盖而失败。

绿相（fresh，同一 working tree）：

| 命令 | R13 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `467 passed, 0 failed` |
| `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` | `12 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `36 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-lock.test.sh` | `3 passed, 0 failed` |
| rescue instrumentation（4 个独立进程各跑一次） | 每次 `13 passed, 0 failed`；每次内部含 4 轮 × 5 contender |
| install link-only | `flywheel-cmux-install --link-only: ok` |
| autostart flags | `5 passed, 0 failed` |
| CI structure | `PASS: FLY-1338 CI structure contract` |
| teamlead related Vitest | `3 files, 57 tests passed` |
| config feature-flag Vitest | `1 file, 28 tests passed` |
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm build` | 全 workspace 通过 |
| Bash syntax、`git diff --check`、本轮 tracked-source Biome | 通过 |

`pnpm lint` 仍会扫描 runner 私有、git 排除的 `.flywheel/runs/**` 与 `.pnpm-store/**`，本轮 fresh 结果为 640 errors / 17 warnings；显式检查本轮 8 个 tracked 变更文件时为 0 error（Biome 支持的 JSON 1 文件被检查，其余 shell/YAML 按 `--files-ignore-unknown=true` 跳过）。这与 R11 已记录的 workspace artifact 问题一致，没有改写或删除这些 runner 资产。

本地 `tmux-server-rescue-real-tmux.test.sh` 仍为 `2 passed, 4 failed`：managed sandbox 下 `/bin/ps` 对真实 tmux server 返回空，process census 按合同 fail-closed 为 `unknown`；socket ownership 与 symlink normalization 两项通过。本轮没有放宽 suite，改由 required Linux CI 给出可读进程表环境中的 authoritative result。

本轮没有重跑真实 Discord POST，也没有重跑 live cmux 全生命周期：R13 没有改变 alert kind/title/signature/delivery 或正常 create/heal/cleanup 路径，只收紧 E2E 的 mutation interceptor、WAL crash recovery 与 rescue bookkeeping。R12 的真实 Discord message `1529630115615604806` 和 fresh live `7 passed, 0 failed` 证据继续有效；独立 QA runner仍按 plan §7.7/§7.8 全量重测。没有新增外部消息或 live cmux mutation。

## 9. R14 xhigh 增量回修

对提交 `516cb29c` 的 fresh Codex xhigh hard-gate 提出四项 actionable finding，全部按 TDD 关闭：

1. **P1 Linux CI 临时目录**：required CI 已接线的 real-tmux suite 原先硬编码 `/private/tmp`，Linux runner 会在进入能力断言前失败。suite 现在从 `${TMPDIR:-/tmp}` 建 portable root，仅在 Darwin 单独运行 `/tmp -> /private/tmp` symlink normalization 子例；CI structure test 锁定不再出现 `/private/tmp` 的 `mktemp`，且 normalization 条件必须为 Darwin-only。
2. **P2 1385/1402 fixture 不完整**：两个 fixture 现在直接编码完整 workspace inventory、tmux session/window topology、初始 ledger/adoption、必须保留的 controls、期待告警理由、最小 adopt 数与 keeper 终态。新增行为测试完全从 JSON 加载，第一周期必须零 mutation，第二周期逐 exact ref 清理所有目标；随后逐字比较剩余 refs、告警理由、keeper 数以及空 ledger/adoption。1385 的 3 个 owned dead view 进入 keeper escrow，foreign view 保留并告警；1402 的 canonical raw/normal 两项清理，ambiguous/invalid 三项保留并告警。
3. **P3 Bash 3.2 PID probe crash residue**：token probe 不再先删同名路径，noclobber 碰撞时 fail closed；每次 instrumentation 初始化最多收割 32 个超过 600 秒、regular、非 symlink、token 严格匹配的 probe。测试生成 40 个 stale probe，证明只删 32，同时保留 fresh、symlink 与 malformed-token controls。
4. **P3 A0B1 告警正文过时**：移除已不成立的 `Legacy create` 文案，正文现在逐字报告 `Exact-ref receipts remain mandatory` 与真实 topology（`strict-independent` 或 `grouped-rollback`）。durable latch 测试覆盖三个进入 episode 和两种 topology 的完整 alert argv。

红相（生产修复前）：

- 主 harness：`465 passed, 4 failed`，分别命中旧 A0B1 文案、fixture schema 缺失、1385/1402 完整场景缺失。
- rescue instrumentation：`12 passed, 1 failed`，缺 crash-stranded probe 的 bounded safe sweep。
- CI structure：缺 portable temp-root 与 Darwin-only normalization 合同。

绿相（fresh，同一 working tree）：

| 命令 | R14 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `469 passed, 0 failed` |
| `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` | `12 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `36 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-lock.test.sh` | `3 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh` | `14 passed, 0 failed` |
| install link-only | `flywheel-cmux-install --link-only: ok` |
| autostart flags | `5 passed, 0 failed` |
| CI structure | `PASS: FLY-1338 CI structure contract` |
| teamlead related Vitest | `3 files, 57 tests passed` |
| config feature-flag Vitest | `1 file, 28 tests passed` |
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm build` | 全 workspace 通过 |
| Bash syntax、`git diff --check`、base-diff tracked-source Biome | 通过；Biome 检查 14 个 supported tracked 文件，0 error |

本地 real-tmux suite 已从 portable `${TMPDIR}` root 启动完整测试，macOS normalization 子例通过；managed sandbox 仍因 `/bin/ps` 不可见而得到 `2 passed, 4 failed`，四项均为既有 fail-closed `unknown` 路径。required Linux CI 将在可读进程表环境验证这项 P1 修复。

R14 没有发送 Discord、没有创建或关闭 live cmux workspace：告警 delivery/refusal contract 与 live create/heal/cleanup 路径未改。真实能力证据仍为 R12 的 live `7 passed, 0 failed` 与 Discord message `1529630115615604806`；独立 QA runner按 plan §7.7/§7.8 全量重测。

## 10. R15 xhigh 增量回修

对提交 `7ec5a07e` 的下一轮 fresh Codex xhigh hard-gate 提出三项 actionable finding，全部按 TDD 关闭：

1. **P1 正常 strict-view 构造缺 generation guard**：`create_or_replace_view_session` 现在在 WAL 打开前固定 tmux generation、完整 source-session snapshot、exact source window id/title/live 状态；`new-session`、两个 `set-option`、`link-window`、`kill-window`、`select-window`、`rename-session` 每一步都以该 source authority 加当前 stage 完整 snapshot 作为真正的 last-operation guard。canonical claim 还在同一 guard 内复验名称未占用；写入 `claimed_complete` 后、删除 WAL 前再复验 generation/source/canonical snapshot。`_linked_view_matches` 可选绑定 exact window title 与 generation，normal/recovery 路径均使用。pre-stage generation flip 现在零 tmux mutation；mid-build flip 在下一边界停止、保留 recovery WAL、绝不 link/claim。
2. **P2 1404 fixture 由测试手工补 authority**：fixture 现在字面编码 source 与独立 strict view 的 session ids、owner/marker、共享 exact window、current-generation committed receipt。schema gate 锁定这些字段；attach-heal 测试只通过共享 topology/initial-state loader 载入 JSON，不再 `topo_add_session`、`topo_add_window` 或 `test_ledger_upsert` 注入缺失条件。
3. **P3 shared TypeScript A0B1 fallback 仍过时**：LeadWatchdog title/body 移除 `half-open` 与 `legacy linked views`，改为 exact-ref receipt + `strict-independent`/`grouped-rollback` topology 语义；新增 exact-copy Vitest。

红相：

- 主 harness：`467 passed, 4 failed`。两个 generation flip 在旧代码下均完成 stage/link/kill/rename 并删除 WAL；另两项为 1404 schema 缺失与 literal fixture 无法 heal。
- LeadWatchdog：`1 failed, 73 passed`，收到旧标题 `cmux safety flags are half-open`。

绿相（fresh，同一 working tree）：

| 命令 | R15 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `471 passed, 0 failed` |
| `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` | `12 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `36 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-lock.test.sh` | `3 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh` | `14 passed, 0 failed` |
| install link-only | `flywheel-cmux-install --link-only: ok` |
| autostart flags | `5 passed, 0 failed` |
| CI structure | `PASS: FLY-1338 CI structure contract` |
| teamlead related Vitest | `3 files, 57 tests passed` |
| LeadWatchdog exact-copy/full file Vitest | `1 file, 74 tests passed` |
| config feature-flag Vitest | `1 file, 28 tests passed` |
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm build` | 全 workspace 通过 |
| Bash syntax、`git diff --check`、base-diff tracked-source Biome | 通过；Biome 检查 15 个 supported tracked 文件，0 error |

R15 不改 Discord delivery/refusal signature，也没有创建或关闭 live cmux/tmux 资源；真实能力与实发证据沿用 R12，独立 QA runner按 plan 全量重测。

## 11. R16 xhigh 增量回修

对提交 `b8dd0a64` 的下一轮 fresh Codex xhigh hard-gate 提出三项文案/测试隔离 finding，全部关闭：

1. **rollback conversational copy 不完整**：config registry 不再声称单设 `FLYWHEEL_CMUX_LINKED_VIEW=0` 即回到 grouped legacy；exact copy 明确 A0B1 默认仍由 `STRICT_VIEW` 保持独立视图，完整 grouped rollback 必须同时设 `FLYWHEEL_CMUX_STRICT_VIEW=0`。registry Vitest 锁定全文。
2. **founder brief 被 amend 推翻但仍像当前设计**：HTML 顶部新增不可忽略的 founder-approved AMEND supersession banner，明确下文只是 R5 历史快照、当前唯一权威为 `plan.md` amend；逐项列出 stock adoption automatic close authority、view lifetime、attach heal、watcher singleton、lease rebuild+continue 已并入本单，禁止以下文操作或判断验收。
3. **主 harness 内嵌 hook integration 触达默认 tmux server**：真实 hook expansion 子例现在只使用 `${TMPDIR_ROOT}/tmux-hook-integration.sock`，所有绕 mock 的命令均显式 `command tmux -S "$TMUX_INT_SOCKET"`；正常、skip 与 EXIT trap 都执行 private `kill-server`。CI structure gate 切出该 integration block，拒绝任何未带 exact private socket 的 `command tmux`。

红相：config Vitest `1 failed, 27 passed`，收到旧 grouped rollback 描述；CI structure 因没有 private socket 合同失败。

绿相：

| 命令 | R16 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `471 passed, 0 failed`；real hook integration 在 private socket 验证 exact session/window fields |
| config feature-flag Vitest | `1 file, 28 tests passed` |
| CI structure | `PASS: FLY-1338 CI structure contract` |
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm build` | 全 workspace 通过 |
| `git diff --check`、base-diff tracked-source Biome | 通过 |

本轮真实 tmux 仅限测试自建 private `-S` socket；没有访问默认 Flywheel/user server，没有 cmux 或外部告警副作用。

## 12. R17 xhigh 增量回修

对提交 `e4e2cf97` 的下一轮 fresh Codex xhigh 只剩一项实质 finding：另外两个真实 tmux harness 虽用 PID 唯一 `-L` label 与 default server 隔离，但没有统一到 exact private `-S` path。现已关闭：

- `test-cmux-sync-hooks-integration.sh` 在自己的 `mktemp` root 下使用 `tmux-hooks-integration.sock`；preflight、shim、每场 reset、fail-closed kill 与 EXIT cleanup 全部显式 `-S`。
- `fly1364-live-e2e.test.sh` 的 tmux wrapper 改为 `-S "$TEST_ROOT/tmux-live.sock"`；现有 exact cleanup 继续通过 wrapper kill private server。
- CI structure 同时读取 embedded hook、独立 hook integration、live E2E 三个文件，拒绝任何 label-derived `-L`，并锁定 exact private socket assignment/shim/wrapper。

红相：CI structure 明确失败 `hook suite must not use label-derived tmux sockets`。绿相：CI structure PASS；Bash syntax PASS；独立 hook integration 在新 exact `-S` socket 上 `12 passed, 0 failed`；四个相关 harness 中已无 `tmux -L`/wrapper `-L`。

xhigh 另指出它被要求审到代码 commit `e4e2cf97`，因此没包含随后由 progress CLI 自动提交的 ledger 更新；这是审阅 target 选择问题，不是代码/ledger 实态缺口。下一轮直接审 `git rev-parse HEAD`，包含所有 progress-only commit。

## 13. R18 xhigh 文档收口

对包含 progress metadata 的 exact HEAD `cd9627b6` 做 fresh Codex xhigh 后，没有实现 finding，只剩一项 LOW 文档漂移：权威 `plan.md` 仍写五 shell matrix/三 rescue，workflow 注释仍写 hook harness 使用 `-L`。现已更新：

- plan §7.8 逐项列出 required FLY-1364 七命令（main、rescue base/lock/instrumentation/real-tmux、install、autostart），另列 exact-private-`-S` hook integration；本地全量同步包含四套 rescue、hook、LeadWatchdog/config Vitest、typecheck、tracked-source Biome 与 build。
- workflow 注释改为 exact `-S` path under private temp root；实际命令与 structure gate 不变。

`ci-structure.test.sh` fresh PASS，YAML 可解析，`git diff --check` PASS。xhigh 对该 exact HEAD 的实现复核为：strict-view guards、WAL/lease、stock adoption/refusal、四 fixture、attach heal、singleton/lifetime/dedup、rollback copy、founder supersession、PID sweep、Linux paths 与 CI wiring 均无 actionable implementation issue。

## 14. R19-R21 标准 xhigh 硬门回修

R19 仅收窄 plan 的 private-socket structure contract 文案；R20 对 exact HEAD `5d440004` 的 fresh Codex xhigh 增量复核返回 `NO ACTIONABLE FINDINGS`。随后按 Lead 要求改由仓库标准 `flywheel-codex-with-fallback` 以 `gpt-5.6-sol`、`xhigh` 对完整 amend diff 起审。managed sandbox 禁止 wrapper 原有 `/dev/fd` process substitution，因此只在 `/tmp` 副本把输出改为普通临时文件缓冲；profile rotation、429/auth/model fallback 与 repo 均未改。

标准 wrapper 首轮因嵌套 read-only sandbox 无法运行 `git rev-parse` 而 fail closed，没有产生代码 finding。将 frozen candidate `c08fa8760c2cfb904fa3784b40cf05dc47b1290f` 以 explicit force-with-lease 推到 PR #671 后，在外层 managed sandbox 保护下关闭内层重复 sandbox 重跑；reviewer 独立核对 exact HEAD、完整 diff、相关测试与 typecheck，提出一项 instrumentation ordering finding：旧 committed-decision replay 在 release clock 之前运行，重放的进程/文件/网络告警延迟会被误算进当前已释放的 kernel-lock hold。

按 TDD 关闭：

- 红相：新增注入式 replay-latency 回归把 acquisition 固定为 `100.000000`；release clock 在 replay 前返回 `100.050000`、在 replay 后返回 `100.750000`。旧实现错误记录 `holdSec=0.750000` 并发送 `tmux_rescue_hold`，suite 为 `14 passed, 1 failed`。
- 生产修复：`flock`、`lockf`、Python fcntl 三个 backend 都在保存 rc 后立即捕获 release timestamp；旧 decision replay 仍只在 kernel lock 已释放且本次 acquisition receipt 存在时执行；捕获值作为显式参数传给 `_tmux_rescue_after_lock`。直接调用者仍保留安全 fallback clock。
- 绿相：同一注入回归记录 `holdSec=0.050000` 且零告警；instrumentation `15 passed, 0 failed`、rescue base `36 passed, 0 failed`、lock backend `3 passed, 0 failed`、`git diff --check` 通过。

本轮不改 cmux mutation、Discord delivery contract 或 live topology，也没有发送外部告警或操作 live cmux/tmux 资源。下一步将对包含本修复与 ledger 的新 exact HEAD 重跑标准 xhigh hard gate，并以该 head 的 required CI 为准。

## 15. R22 exact-head CI 回修

标准 `codex-with-fallback` xhigh 对 `e1141f032823820406782a2ffa7cf6027e698c80` 返回结构化 `APPROVED`、零 findings；PR #671 同一 head 的首次 required CI 暴露一项 Linux/modern-Bash 缺口：`self_heal_sweep_all` 只声明但未初始化 strict-only 标量，`FLYWHEEL_CMUX_STRICT_VIEW=0` 时普通 agent-window sweep 在 Bash 5 `set -u` 下读取 `strict_names` 会 fatal。macOS Bash 3.2 将未赋值 local 当空串，因此本地历史矩阵没有暴露。

按 TDD 关闭：新增 strict-view rollback 子例，在普通 agent window 存在、strict view 关闭时直接跑 production sweep。Homebrew Bash 5.3 红相为 `strict_names: unbound variable`；生产修复只把 local 初始化为 `strict_names=""`。同一 modern-Bash 矩阵与 system Bash 3.2 矩阵均 fresh `472 passed, 0 failed`。

同次 CI 的 Teamlead shard 另有一项不在本 diff 路径的 FLY-1041 retire-on-rebind 断言偶发失败（3134 tests 已通过后，读取 q1 为 undefined）；本地 exact test file fresh `6 passed, 0 failed`，未为该 flake 改生产代码。新 head 将重跑完整 required CI 决定是否需要进一步处理。

## 16. R23 socketless Linux fixture 回修

`f710d0802d5afc9e3f4da5107ebd303c16e6cecc` 的 required CI 证明 Teamlead 三 shard 全绿，确认上一轮 FLY-1041 单测为非本 diff flake；Script Tests 则在新 nounset 回归通过后继续暴露第二项 harness 环境耦合。1404 sole-holder fixture 用 production `cmux_socket_identity` 生成 receipt；Linux runner 无本机 cmux socket，generation 为空，strict live-source heal 无 authority（且 CI 的 errexit 边界会提前终止）。本机原先有真实 socket，所以 472/0 证据没有覆盖 CI 的 socketless 条件。

修复仅限 test fixture：1404 strict-heal cluster 保存 production identity 函数，在 cluster 内安装确定性 generation seam；seam 同时读取 `MOCK_SOCK_IDENT` 与既有 `mock-ident.override`，因此 literal receipt、后续 live-source authority 与 final-client-probe generation flip 都走同一受控时序；cluster 后恢复 production 函数。没有修改 watcher 生产代码。

验证显式设置 `CMUX_SOCKET_PATH=/tmp/fly1364-nonexistent-cmux.sock`：Homebrew Bash 5.3 全矩阵 `472 passed, 0 failed`，system Bash 3.2 全矩阵 `472 passed, 0 failed`。旧 fixture 在同一 socketless 条件下于 sole-holder cluster 失败；新 fixture 不再依赖宿主 cmux。

## 17. R24 Linux real-tmux 双向证据回修

`e6328a8dac25084814b819664631fe18e353ae39` 的 required Linux Script Tests 在前述 1404 fixture 通过后，暴露 real-tmux suite 的两项独立平台缺口：

1. Ubuntu `lsof -a -p <pid> -U -Fn` 的真实 name-field 字节为 `n/tmp/.../recognize.sock type=STREAM`；旧解析把精确的 ` type=STREAM` 尾字段当成 pathname，导致 exact owner 不匹配。
2. Linux saturated server 的 `tmux display-message` 会阻塞到现有 6 秒上限；旧逻辑在独立 `ps+lsof` 扫描之前就把 `scanComplete=false` 固定，随后即使得到唯一 exact owner 也只能返回 `unknown`。这与 pathname 解析不是同一根因。

红相（production 修复前）：hermetic rescue suite 新增真实 Linux 尾字段 fixture 与「client timeout + complete exact owner」fixture，结果 `36 passed, 2 failed`；后者明确得到 `candidatePids=[6162]` 但 `scanComplete=false`、ensure rc 4，而验收要求 saturated hold rc 2。

修复保持安全边界不变：

- lsof 只剥离真实输出的精确 ` type=STREAM` 尾字段，不接受任意 `type=*` 猜测。
- reachability timeout 与 ownership scan completeness 分离。timeout 仍保留 `timedOut=true` 作可观测性；只有 socket inode 存在、完整扫描得到唯一 exact owner 时判 `saturated`。零 owner、socket 不在或扫描不完整仍为 `unknown`；多个 owner 仍为 `ambiguous`。没有增加 timeout，也没有放宽 real suite 的 rc 2 断言。
- real-tmux suite 新增反向真机用例：SIGKILL 私有 tmux server，确认 stale socket inode 留存；快速拒绝且完整零-owner 扫描必须判 `dead`，随后 ensure 必须让 exact socket path 由新 server generation 持有并通过独立 inspect+lsof 复验。它与 saturated hold 并排锁定「活着绝不替换、真死必须恢复」两侧。

本地 fresh 结果：

| 命令 | R24 结果 |
|---|---|
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `38 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-instrumentation.test.sh` | `15 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-lock.test.sh` | `3 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue-real-tmux.test.sh` | lsof exact-owner 与 macOS symlink 两项通过；其余因 managed sandbox 下 `/bin/ps` 无输出而 fail-closed `unknown`，由 required Linux CI 验证 |

required Linux CI 首轮已给出双向能力证据：real server scan、lsof exact owner、reachable、SIGKILL stale-inode `dead` + verified create、saturated verdict 全部通过，ensure 也返回严格 rc 2。唯一红项是 harness 用 `stat -f ... || stat -c ...` 取 inode；GNU `stat -f` 会成功返回不断变化的 filesystem 统计而不进入 `-c` fallback，造成相同 inode `618017 -> 618017` 的假失败，dead-replace 的“不相等”也会因此假阳。harness 现按 `uname` 显式选 Darwin `stat -f '%i'` 或 Linux `stat -c '%i'`。

第二轮 Linux 证明 dead inspect、ensure `created`、new PID 全部正确，但 ext4 可以在 unlink/rebind 后立即复用同一个 inode number（实录 `799886 -> 799886`），所以「inode 数值必须变化」本身不是合法能力断言。dead 侧现改为独立验证 post-ensure inspect=`reachable`、reachablePid 为不同的新 generation，且 lsof 证明该新 PID 持有 exact normalized socket path；saturated 侧仍要求 rc 2、action=`hold_saturated` 且 inode 数值不变。这样直接验证 namespace/path ownership，不把 allocator 行为当产品合同。

R24 所有 socket 均在测试私有 `${TMPDIR}`；没有访问默认 Flywheel/user tmux server，没有 cmux 或 Discord 外部副作用。

## 18. R27 structured review round 3 回修

此前 relay 卡住的 structured review round 3 对 `e6328a8d` 有一项 HIGH：`_snapshot_live_mutator_processes` 每次从命令替换调用，Bash 子 shell 的 PID 不等于 `$$`、argv 却与顶层 mutator 相同；旧 census 只排除 `$$`，因此把自己的 census plumbing 当成独立 mutator。旧 `_mutator_command_matches` 又以任意 command substring 匹配脚本名，连 `zsh -c` prose 也可命中。结果 stale/malformed lease 的两次 census 永远非空或漂移，rebuild+continue 在真实进程树上不可达。

按 TDD 关闭：

- 保存 production census 函数供 hermetic harness 直测；fixture 构造顶层 `$$`、child、grandchild、独立真实 mutator 与 `zsh -c` prose 五行。红相保留 own child/grandchild 与 prose，完整 Bash 3.2 matrix 为 `472 passed, 2 failed`。
- `_mutator_command_matches` 只接受 direct `flywheel-cmux-sync[.sh]` 或 `bash|sh <exact-script>` argv shape，且第一个业务参数必须是空（once）或受支持 mutator verb；不再从任意 prose substring 推导进程身份。
- production census 改读 `pid,ppid,command`，从 `$$` 迭代闭包完整 descendant set，再做 exact mutator 过滤；因此 Bash 3.2 command-substitution child 即使保留顶层 `$$` 也会因 PPID ancestry 被排除。另有真实 `ps` 双快照用例；managed 本机 process-table 不可读时明确走 skip 分支，required Linux CI 必须实际执行。

同轮两个值得立即收口的 LOW 也按红绿关闭：

- rescue source 现在以 `FLYWHEEL_TMUX_RESCUE_ALERT_BIN` > 既有 `FLYWHEEL_ALERT_BIN` > rescue default 的顺序选 adapter，不再覆盖 host 已选的共享 alert binary。红相 38/1，绿相 rescue base `39 passed, 0 failed`。
- shared `flywheel_alert` 给 alert child 显式 `</dev/null`。红相中 child 从 here-string loop 偷走 `second`，loop 只见 `first`；绿相 loop 两行均处理且 child 零输入。

`tmux-rescue-audit.log` 无上限的 LOW 不在本轮盲加 truncate/rotate：audit 在 kernel lock 释放后可被多个进程并发写，未经独立设计的 size-check + truncate 会丢相邻 invocation 证据。它保持 non-blocking advisory，交由 Lead 决定独立 bounded concurrent rotation follow-up。

本地 fresh：

| 命令 | R27 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `475 passed, 0 failed` |
| `FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH=1 /opt/homebrew/bin/bash scripts/test-cmux-sync.sh` | `475 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `39 passed, 0 failed` |

R27 仅做 process census 与 alert adapter 隔离，没有操作 live cmux/tmux workspace，也没有发送外部告警。

## 19. R28 Linux 真进程树、rollout 与最终门状态

`f6ab89e7f5f2c18cf7efaed72dca06613a134d4d` 的 required CI run
`29984071789` 全绿。Script Tests job `89131970038` 在 Ubuntu 真实
`ps` 进程树上实际执行（非 hermetic fake）：

- production census 的 command-substitution child / grandchild 全部被 ancestry
  排除，独立 mutator仍可见；
- `zsh -c` 中只含脚本文字的 prose 不再被判成 mutator；
- 两个真实 snapshot 都排除了 marker-bearing invocation descendant；
- 主 Bash matrix `475 passed, 0 failed`，rescue base `39 passed, 0 failed`；
- killed-server stale socket 的 `dead → ensure created → 新 PID exact-owner`
  与 saturated live server 的严格 rc=2 均通过。

这关闭了 structured review round 3 的 HIGH：malformed/stale lease 的
rebuild+continue 在真实 Linux process census 上已经可达，同时 live mutator
仍不会被 steal。

Lead 对 pre-existing live-source receipt advisory 的裁定是保持 §7.6 安全
边界，不新增从活源铸 receipt 的权限；但 rollout 必须显式 recycle
pre-deploy tab。权威执行命令与失败策略已写入 `plan.md` §7.10：在旧 watcher
退出、新 watcher bootstrap 前，消费人工复核的 exact-ref manifest，逐 ref
关闭旧 tab，再由新 binary `--once` 重建仍 live 的 tab 和 committed receipt。
该命令是部署操作员授权，不扩大周期 watcher 的 title-based mutation authority。

Codex `gpt-5.6-sol` xhigh 已对 amend 全量 head `e6328a8d` APPROVED、零
findings。两个 profile 一度无法登录，随后 Lead 真机确认 `school` 容量恢复并
撤销临时 deferred 裁定；最终候选固定 `school`，必须补齐
`e6328a8d..HEAD` 的 `gpt-5.6-sol` xhigh。已完成的 5.5 review不计硬门。
exact-head required CI 与跨厂商结构化 review继续并行；独立 QA/founder gate
仍在后续阶段执行。

## 20. R29 5.6-sol xhigh HIGH 回修

固定 `school` profile 后，标准 wrapper 以 `gpt-5.6-sol`、`xhigh` 审阅精确
head `6fbd634c8d810fadc71014c9526d8f76dc1b2cf4`，返回
`CHANGES_REQUESTED`，两项 HIGH 与一项 ledger MEDIUM：

1. interpreter 前置 `-e/-x/-euxo pipefail` 时，旧 mutator matcher漏掉独立
   live mutator；malformed lease可能据此误判 ownerless并重建。
2. `lsof` rc=1 同时表示 filtered-empty 与 generic error；旧实现只凭 live PID
   就接受 non-ownership，错误时可能把 socket判 dead并启动替代 server。
3. progress仍写 xhigh deferred，与 Lead 恢复 `school` 容量的裁定冲突。

按 TDD 关闭：

- mutator fixture加入独立
  `/bin/bash -euxo pipefail /opt/flywheel-cmux-sync.sh --once`、own-tree flagged
  child 与 `bash -lc` prose。红相 matcher rc=1；生产 parser现在扫描
  interpreter flags/operand直到 exact script，任何含 `c` 的短选项簇立即拒绝，
  因而 flagged live mutator保留、`-c/-lc` prose与自己的完整 descendant tree
  排除。
- rescue fake同时建模 lsof 的真实两种 rc=1：filtered-empty后独立
  `lsof -Fp` 可枚举 exact `p<pid>`，以及 permission/tool error使该 probe也
  失败。旧实现为 `40 passed, 2 failed`，会把 rc=1 error判成 dead；生产现在
  只有 bounded unfiltered PID probe rc=0且含 exact header时才返回明确
  non-ownership，其余 error=`scanComplete=false`、verdict=`unknown`、零 create。
- progress cursor已撤销 deferred措辞，明确下一步为新 head 的 5.6-sol xhigh。

fresh 绿相：

| 命令 | R29 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh` | `475 passed, 0 failed` |
| `FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH=1 /opt/homebrew/bin/bash scripts/test-cmux-sync.sh` | `475 passed, 0 failed` |
| `/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `42 passed, 0 failed` |
| `/opt/homebrew/bin/bash scripts/__tests__/tmux-server-rescue.test.sh` | `42 passed, 0 failed` |
| rescue instrumentation / lock | `15 passed, 0 failed` / `3 passed, 0 failed` |
| hook integration / install link-only / autostart / CI structure | `12/0` / ok / `5/0` / PASS |
| Bash syntax、`git diff --check` | 通过 |

本地 real-tmux仍为 `2 passed, 5 failed`：managed sandbox 的 `/bin/ps` 对真实
server返回空，故 server census按合同 fail-closed `unknown`；exact lsof
ownership与 symlink normalization通过。required Linux CI必须实际执行真实
进程表与新 rc=1 regression后才可放行。

R29 没有操作 live cmux workspace、默认 tmux server或外部 Discord；所有
socket与 mutation均限于测试私有目录/fixture。

## 21. R30 filtered lsof split-outcome 回修

`gpt-5.6-sol` xhigh 对精确 head
`5943981d87bb8de0d788dbbe6b331691fb545e5e` 复审后指出：R29 的
`-Fp` 二次调用只证明 PID 可枚举，若第一次 filtered `-U` 调用单独报 rc=1
错误、第二次 PID probe成功，仍可能错误接受 non-ownership。

新增 fake 精确区分两次调用：filtered `-U -Fn` 输出诊断并 rc=1，但随后
`-Fp` 成功。旧实现红相仍为 `40 passed, 2 failed`：direct predicate返回
non-owner，integrated inspect把 live candidate判 `dead`。

生产修复给每次 lsof invocation使用独立 `mktemp` diagnostics sidecar：

- timeout仍返回 typed timeout；
- 任意非空 stderr都将该次扫描标为 incomplete；
- filtered rc=1 只有在 diagnostics为空、PID仍 live、第二次 bounded `-Fp`
  rc=0、diagnostics为空且含 exact `p<pid>` 时才是明确 non-owner；
- 每条正常/失败返回路径都删除 sidecar；无法创建/清空 sidecar时 fail-closed。

fresh 结果：system Bash rescue `42 passed, 0 failed`，modern Bash rescue
`42 passed, 0 failed`，instrumentation `15 passed, 0 failed`，lock
`3 passed, 0 failed`，Bash syntax与 `git diff --check` 通过。主 cmux生产代码
未在 R30 改动；R29 的 Bash 3.2/5.3 `475/0` 继续覆盖 census修复。无 live
cmux/default tmux/Discord副作用。
