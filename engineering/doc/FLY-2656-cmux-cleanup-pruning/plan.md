# FLY-2656 cmux cleanup 队列剪枝与镜像优先级 — 实施计划
Issue: FLY-2656 (https://linear.app/geoforge3d/issue/FLY-2656/修复-cmux-镜像同步器cleanup-pending-队列剪枝夹具窗不入队-ttl-过期-新窗镜像优先于清理-查-watcher)
日期: 2026-09-18
基于: research.md

## 目标

最小修复三个已证实的阻断点：把两份 runner inventory 从 tmux 3.7c 会改写的 tab 分隔改为 printable `|`；安全收敛当前 generation 中 canonical/staging 双缺失的 `claim_intent` WAL；再用单次 registry snapshot 做 cleanup admission/预剪枝，把 7 天 TTL 定义成 marker 寿命，并让第四个健康 tick 先补活 runner 镜像再处理 pending cleanup。复用 `cmux-log-episodes` 记录 TTL reap 与 bounded watcher 启动诊断，不改变任何 destructive authority。

## 文件清单

| 文件 | 改动 |
|---|---|
| `scripts/test-cmux-sync.sh` | WAL recovery、step 日志、admission/pre-prune、fallback 抑制、episode GC、watch 顺序、startup metadata 的 RED/GREEN 测试 |
| `scripts/__tests__/cmux-cleanup-lifecycle.test.sh` | 首次 registry catch-up 三轮内 `pane_dead=0` canonical runner 零 teardown；`pane_dead=1` 保留既有收敛 |
| `scripts/__tests__/fly1884-node-presence.test.sh` | owner admission/TTL 后的 node-presence cleanup 兼容回归 |
| `scripts/test-cmux-sync-hooks-integration.sh` | 隔离真实 tmux server 上的 exec/node inventory separator 回归；exact 3.7c gate 不允许 skip |
| `scripts/flywheel-cmux-sync.sh` | 双缺失 claim WAL retire、preflight step 日志、owner admission/原子预剪枝、两个 episode kind、30 天 lifecycle GC、优先调度、启动 episode |
| `scripts/flywheel-cmux-autostart.sh` | bounded 采集 launchd reason/exit/signal 并通过 env 传入 watcher |
| `engineering/doc/FLY-2656-cmux-cleanup-pruning/{exploration,research,plan,progress}.md` | 本单过程证据与恢复 cursor |
| `engineering/doc/milestones/FLY-2656.md` | 最终变更、验证、评审、PR handoff；必须是分支 literal last commit |

不改 `CLAUDE.md`，不新增 CI suite，不动 Bridge patrol阈值，不改 `cleanup_workspace_for`、orphan pin 最终 guard 或 rebind 状态机。

## Task 1：RED/GREEN — 修复 tmux 3.7c runner inventory

**测试先行：**

1. 在现有 real-tmux integration 脚本的隔离 server 上建 `runner-*` window，设置精确 `@flywheel_exec_id`；直接调用生产 `read_runner_tmux_exec_inventory` / `read_runner_tmux_node_inventory`。当前 3.7c 上 RED（format tab 变 `_`）；修复后两个 state 均为 `ok`，输出精确 execution id、`@window_id`、title、session。
2. 负例保留：字段含 `|`、重复/多 source identity、tmux census 失败仍为 indeterminate/fail closed。
3. 该 integration 已由 `scripts/qa-tmux-3.7c-compat.sh` 以 exact 3.7c + zero skip 执行；普通 `test-cmux-sync.sh` mock 另加 parser delimiter 断言，但不代替真实行为。

**最小实现：**

- 两处 `list-windows -F` 用字面 `|` 拼字段，Python 改 `split("|")`；不改输出 state schema。
- 跑 unit suite 与 real-tmux integration；host exact-3.7c gate 只在本节点允许的隔离测试内执行，不触碰生产 server。

## Task 2：RED/GREEN — 解除无实体 WAL barrier

**测试先行：**

1. 当前 generation 的合法 `claim_intent`，一次成功 `list-sessions` census 证明 canonical 与 nonce-derived stage 均不存在，并在 census 后复核 generation 未变：当前实现 RED；修复后 WAL 被删、`recover_all_view_constructions` 成功并写 audit 日志。
2. canonical 存在、stage 存在、session census 失败、generation 漂移或身份不匹配：WAL 继续保留且 fail closed。
3. `prepare_linked_view_state pre` 的 generation / WAL recovery / keeper inventory 三个失败分别留下稳定 `step=` 日志；不输出用户派生原文。
4. `sync_additive` 带双缺失 WAL 时，修复后能到达 `reconcile_existing_workspaces` 与 `reconcile_node_presence` stub，证明 rebind/create 和 snapshot publish 不再被挡。

**最小实现：**

- 在 `claim_intent` 分支中，只信一次成功的 exact session-name census；canonical/stage 双缺失后复核 `tmux_server_generation` 与 WAL generation 一致，才删 WAL、写 `[audit]` 并返回成功。不能用 `has-session` 的任意非零代表 absent，不触碰任何 tmux object。
- `prepare_linked_view_state` 为三个既有步骤分别记录失败 step 后返回 1；不改变 caller 的 fail-closed 结果。

```bash
/bin/bash -n scripts/flywheel-cmux-sync.sh scripts/test-cmux-sync.sh
/bin/bash scripts/test-cmux-sync.sh
/bin/bash scripts/__tests__/cmux-view-rebind.test.sh
```

## Task 3：RED/GREEN — admission、单次预剪枝与 conservative 抑制

**测试先行：**

1. 表驱动 admission：realtest 即使有 owner 也拒绝；ownerless `issue-<epoch>` 拒绝；owned issue fallback 与普通 owner 允许；registry 缺失/畸形为 unknown；首 timestamp/idempotency 保持。
2. 名字拒绝控制字符、`|`、空值和 >247 字节，保证后续 `cleanup:<name>` ≤255。
3. 独立 pre-prune：
   - age ≥604800 秒的格式合法 marker 不看 snapshot 直接删并记 episode；
   - 未过期 realtest/ownerless 删；unknown 时未过期行保留；malformed 行保留；
   - 原子替换在 probes 前完成，registry 每 pass 只验证/读取一次；
   - 被剪行对 `is_pane_alive`、freshness、destructive cleanup 调用均为 0。
4. conservative fallback 对 conclusive ineligible title 不创建/反复更新 `STALE_STATE`，unknown 不做新动作，owner 恢复后仍能进入原流程。
5. 1645 行首次补账安全：陈旧 terminal roster 即使与 execution/title 精确匹配，canonical runner 的 `pane_dead=0` 也必须在三轮后保持零 `kill-window`、零 close marker、零 pin/view close；改为 `pane_dead=1` 后原 terminal transaction 仍收敛。

**最小实现：**

- 固定默认 TTL 604800 秒，env 仅接受 1–365 天；测试可覆写变量。
- pass-local owner title snapshot；`mark_for_cleanup` 用 tri-state 结果决定写入。
- `prune_cleanup_pending` 用临时文件 + `mv` 先提交队列；之后原有 process loop 只处理 survivors，原 authority-lost tail replay 与 destructive gates 不变。
- conservative pass 复用一次 owner snapshot，在 pane probe/STALE_STATE 前跳过 conclusive ineligible title。
- terminal source transaction 把精确 `pane_dead=1` 作为 destructive authority 的必需条件；活 pane 只保留 episode/summary，不 teardown。

```bash
/bin/bash scripts/test-cmux-sync.sh
/bin/bash scripts/__tests__/cmux-cleanup-lifecycle.test.sh
```

## Task 4：RED/GREEN — durable lifecycle episodes 与 bounded 启动诊断

**测试先行：**

1. `cleanup-pending-ttl-reaped`、`watcher-started` 通过 validator/logger 双白名单，仍是五字段、64 位小写 sha256。
2. lifecycle row 在 30 天内保留、过期删除；view kinds 的 active-title GC 不变。测试明确 `watcher-started` 是 latest/suppressed episode，不是 append-only audit。
3. TTL target 稳定为 `cleanup:<name>` 且 ≤255；重复 evidence 走 suppression。
4. hermetic supervised autostart：fake bounded-run/launchctl/sync 验证 reason、last exit、last terminating signal；timeout/nonzero/缺字段全部降级 `unknown` 且仍 exec。
5. 直接绕过 wrapper 调 `watch_main`，恶意 env 中的分隔符/控制字符/超长值仍被清洗为合法 target；diagnostic failure 不阻止 watch。

**最小实现：**

- 两处 kind 白名单精确追加两个值；GC 一次取 `now`，lifecycle 固定保留 2592000 秒。
- wrapper 仅通过 `"$SELF_DIR/lib/bounded-run.sh" 5 launchctl print ...` 采集；加入 signal 字段，无后台/unbounded 调用。
- watcher 持 mutator lease 后清洗三字段并写 `watcher-started`；现有 restart ledger 继续保留每次启动时间。

## Task 5：RED/GREEN — 第四 tick 镜像优先

隔离运行四个健康 tick，RED 断言当前第 4 tick 顺序错误，GREEN 要求：

```text
drain:4
sync-additive:4
cleanup:4
close-requests:4
```

前三 tick 仍 drain → cleanup → close requests；create hook 继续在 drain 中即时处理。只移动第四 tick 的既有 `sync_additive` 条件块，不新增 cadence。回归现有 rebind/orphan 测试，确保 live canonical + missing linked session 重建而非 reap。

## Task 6：本地验证、code review 与 literal-last milestone

1. 进入 `test` stage并运行：

```bash
pnpm install --frozen-lockfile
/bin/bash -n scripts/flywheel-cmux-sync.sh scripts/flywheel-cmux-autostart.sh scripts/test-cmux-sync.sh
/bin/bash scripts/test-cmux-sync.sh
/bin/bash scripts/test-cmux-sync-hooks-integration.sh
/bin/bash scripts/__tests__/cmux-cleanup-lifecycle.test.sh
/bin/bash scripts/__tests__/cmux-view-rebind.test.sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

2. 检查 `git diff --check`、范围与 secrets；更新 progress。
3. 先提交代码/测试/过程文档，再写 `engineering/doc/milestones/FLY-2656.md`，把 milestone 作为 literal last commit。
4. push feature branch，进入 `code_review`，按 Codex author 协议开 `review_code` gate + `request-review --type code`；只认 `reviewVerdict`。blocking finding 修复后重跑相应 focused/aggregate，再以 milestone update 新建 literal-last commit并开新 gate。
5. APPROVED advisories 用 `ask --report` 转给 Lead。GitHub CI 受计费墙阻断，本节点不运行 `ci-full ensure`、不重试 CI。

## Task 7：PR 与 implement handoff

1. 确认远端 exact head、worktree clean、literal-last commit 只含 `engineering/doc/milestones/FLY-2656.md`。
2. 创建 PR，分列行为、根因、focused/aggregate、code review、CI billing blocker、未做 host/visual QA。
   - 明列 1645 行首次补账会恢复 node 分类并重新启用 summary TTL/cap 与 terminal transaction；QA 必须给出补账前后活 canonical runner 数不变、缺镜像数 `N → 0`（当前只读基线 14）、cleanup-pending `<50` 和 cmux 截图。
3. 完成 `[lead-instruction af2c5959-5e85-440f-98a0-86f1039d36cf]` 后以精确 id 发 DONE report，列 commits 与 PR。
4. frozen head 通过 Lead 要求的 question gate 等待；pending 不是 blocked，不 dispatch QA、不触碰生产 watcher。
5. 执行 `complete --route needs_review --pr <NUMBER>`；不得 merge、deploy、restart、operator reap 或 dispatch successor。

## 完成判据

- 真实 tmux 3.7c inventory、双缺失 claim WAL、新 admission/预剪枝、priority、startup evidence 均先红后绿；
- pre-prune 对 registry 一次读取，被剪行 probe 为零且队列先原子落盘；
- exec/node inventory 均为 `ok` 后，active canonical + missing linked session 由既有 rebind 收敛，node snapshot publish 路径恢复可达；
- lifecycle episode 保留 ≤30 天且明确为 lossy episode，逐次时间仍由 restart ledger承担；
- focused + lint + build + package aggregate 有本轮输出；exact-head code review 有效通过；
- milestone literal last、PR 已开、implement route receipt 已提交；
- host census、≤60 秒真机时间与 cmux 侧边栏截图明确留给获授权 QA，不伪称已验证。
