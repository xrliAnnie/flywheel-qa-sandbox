# FLY-2770 cmux 同步器失控 — 调研

Issue: FLY-2770 (https://linear.app/geoforge3d/issue/FLY-2770/cmux同步器失控-flywheel-cmux-sync-watch-给新窗口建镜像时title-stock-topology-proof)
日期: 2026-09-22
基于: exploration.md

## A. 既有的「占位符授权」先例 —— FLY-1884

`reconcile_prepared_ledger` 对 **workspace 面**已经有完整成熟的判据，`scripts/test-cmux-sync.sh`
里也有成对测试：

| 测试 | 判据 |
|---|---|
| `test_fly1884_uuid_default_title_recovers_both_faces`（6600 区） | receipt 带 UUID + workspace 标题是 `Terminal N` → 允许 `rename-workspace` **和** `rename-tab`，commit 时保留 UUID |
| `test_fly1884_legacy_default_title_never_gains_rename_authority` | 四字段 legacy receipt（无 UUID）+ `Terminal N` → **零 mutation** |
| `test_fly1884_uuid_mismatch_and_ref_reuse_block_prepared_rename` | UUID 不匹配 / ref 复用 → 零 mutation |

也就是说「UUID 绑定的 receipt 可以改 cmux 自带占位符；legacy receipt 不可以」
这条授权边界**已经是本仓库既定的、测试覆盖的设计**。FLY-2770 只是同一条边界
没有铺到 tab（surface）面。

UUID 绑定的 receipt 只可能来自两处，都是不含糊的自有物：

* `create_workspace_for_window`（10247）：`_ledger_upsert prepared … "$new_uuid"`，
  `new_uuid` 来自本次 create 前后 ref 差集的唯一新 ref；
* `adopt_birth_candidate`：先证明 births 账本里有本 view target 的出生记录。

`authorize_stock_candidate` 收编 founder 既有 stock 时写的是四字段 legacy 行
（`_ledger_upsert prepared "$generation" "$keeper_ref" "$title"`，8695），所以
**放宽 tab 面不会给 founder 自建 tab 任何改名权**。

## B. 为什么「surface 等于出生命令」这条断言过去成立、现在不成立

`complete_title_migration` 期望 surface 标题 ∈ `managed_view_command_variants()`。
真机对照（`cmux 0.61.0`）：

| workspace | 出生命令形态 | surface 标题 |
|---|---|---|
| workspace:846（老） | `env -u TMUX '…/flywheel-view-attach.sh' 'cmux-…'` | 命令串本身 ✅ |
| workspace:451（新） | `env -u TMUX FLYWHEEL_CMUX_ATTACH_TMUX_BIN='…' '…' '…' 'fwtok1-…'` | `Terminal 65` ❌ |
| workspace:452 / 847 / 850 | 同上 | 已经等于目标标题（attach 画出来后 tmux OSC 改的） |

结论：surface 标题有三种合法形态 —— 出生命令串、cmux 占位符 `Terminal N`、
attach 成功后 tmux 写的目标标题。代码只认第一和第三种。第二种是 **cmux 自己写的
默认值，不携带任何 founder 意图**，正是 `_workspace_title_is_default()`（6790）
要表达的东西。

## C. park 与 lease 的实际关系

`watcher_maintenance_checkpoint`（13913）在 marker 在时：
`release_mutator_lease` → `WATCHER_RESYNC_REQUIRED=1` → 循环 poll。
supervised watcher 另有 `maintenance_entry_allowed watch` 的等待分支
（「maintenance marker present; supervised watcher waiting without lease」，
真机日志 00:33:00 可见）。**park 的 watcher 确实不持 lease。**

拦住修复工具的是 `maintenance_entry_allowed()` 本身：

```bash
else                                   # refresh / once / reaper …
  maintenance_requested || return 0    # marker 在 → 落到下面 return 1
```
```bash
elif [[ "$mode" == "ops_rebuild" ]]; then
  …
  [[ ! -e MARKER && ! -L MARKER && ! -e QA_CLAIM && ! -L QA_CLAIM ]] || return 1
```

`publish_ops_rebuild_claim`（13500）同样在 marker 在时直接 `return 1`。

因此「park 的 watcher 占活 mutator」这个观感的真实机制是：**marker 同时被当成
"停 watcher" 和 "停一切 mutator"**。issue 要求把这两件事拆开。

三个 claim 的语义应当分层：

| 信号 | 含义 | 该拦谁 |
|---|---|---|
| `cmux-maintenance` marker（Lead 管） | 停自动 watcher 扫描 | `watch` / `once` / `reaper` 等自动通道 |
| `.qa-teardown` claim | QA 拆房，需要独占 | 所有其他 mutator（含 refresh / rebuild） |
| `.ops-rebuild` claim | 另一个运维修复正在跑 | 另一个 ops_rebuild |

`--refresh`（`refresh_linked_sessions`，纯 tmux 修复）和 `--rebuild-views`
（审计型定点重建）都是**运维手动调用**，正是 marker 在时唯一的出路。

## D. QA teardown claim 的 env 耦合

两处派生，都无独立 env：

* `scripts/flywheel-cmux-sync.sh:116`
* `scripts/test-teardown.sh:50`

`scripts/test-teardown.sh` 的注释（44-46）说明它自己就是一个完整 mutator，
和 watcher 共用 incarnation-bound lease。给 claim 独立 env
（`FLYWHEEL_CMUX_QA_TEARDOWN_CLAIM`，默认仍是派生值）即可解耦，且对生产零行为变化。

## E. 测试基建

`scripts/test-cmux-sync.sh`（12338 行）已具备：

* `MOCK_CMUX_WORKSPACES_JSON` / `MOCK_CMUX_SURFACES`（`ref;;surface_ref;;type;;selected;;title`）
* `MOCK_CMUX_MUTATE_JSON` / `MOCK_CMUX_MUTATE_SURFACES`（让 mock 真的改状态，可断言 readback）
* `MOCK_CMUX_OPS`（记录所有 cmux 变更调用，可断言「零 mutation」）
* `test_ledger_upsert` / `test_ensure_mutator_lease`

`maintenance_entry_allowed` 的现有覆盖：

* `scripts/test-cmux-sync.sh:8739-8745` —— QA teardown claim 在场时
  `maintenance_entry_allowed ops_rebuild` 对自己和外来进程的判定；
* `9072-9106` —— claim 的 stale / malformed 回收；
* `1262-1264` —— reset_mocks 里 claim 路径仍从 marker 派生，加独立 env 后默认值不变，
  该 fixture 不需要改。

`scripts/test-teardown.sh` 自身没有独立单测文件；它的 claim 常量改动由
`scripts/test-cmux-sync.sh` 的新增用例 + 一个 `scripts/__tests__/*.test.sh` 静态断言覆盖。

## F. 不做什么

* ⛔ 不动 FLY-913 护栏、不动 `~/.flywheel/state/cmux-maintenance` marker 本身、
  不 launchctl 自装任务。
* 不动 `flywheel-view-attach.sh` 的重连循环（它本来就是死循环重连，
  第 3 条需求是第 1、2 条的下游）。
* 不删 Lead 手建的 link-window 镜像；正确形态由 watcher/`--rebuild-views`
  先建后删（既有 `rebuild_view_target` 路径已是先建后删）。
