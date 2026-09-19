# FLY-2656 cmux cleanup 队列剪枝与镜像优先级 — 调研
Issue: FLY-2656 (https://linear.app/geoforge3d/issue/FLY-2656/修复-cmux-镜像同步器cleanup-pending-队列剪枝夹具窗不入队-ttl-过期-新窗镜像优先于清理-查-watcher)
日期: 2026-09-18
基于: exploration.md

## 1. 修正后的结论

2026-09-16 指定的六次 watcher 重启均由 Bridge patrol 在 heartbeat 超过 300 秒后判 `stalled` 并执行 `kickstart`。1405 行 cleanup-pending 的逐条 tmux/registry/snapshot 扫描解释了六次 302–359 秒停顿和重启。

但这不是 2026-09-18 缺镜像的唯一病根。现场日志证明 `sync_additive` 已被调用，却从 9 月 17 日 14:26 起反复在 `prepare_linked_view_state pre` 静默退出。只读 census 找到两个当前 tmux generation 的合法 `claim_intent` WAL；各自的 canonical `cmux-*` 与 `fwstage-*` session 都已不存在。`recover_view_construction` 对这个“无任何实体可恢复”的状态返回 1，令所有无关镜像永久 fail closed。第一条 WAL 的 mtime 正好是首次 `pass deferred` 的 14:26。

cleanup snapshot 冻结在 2026-08-25；当前 registry 1645 行全部仍为 `admitted`。这比 WAL barrier 早 23 天，独立病根是 8 月 21 日引入的两份 tmux inventory 使用 tab 分隔，而生产 tmux 3.7c 会把 format 中的 tab 输出成 `_`。因此 node inventory 与 exec inventory 都保持 `indeterminate`：前者令 snapshot publish 静默不可达，后者令 runner roster blind；rebind 又直接依赖 node inventory，所以 13 个“workspace/receipt 存在、linked session 缺失”的 runner 全被 `source-identity` 拒绝。TTL 必须只依赖 marker 年龄，且本单必须同时修复 inventory separator，单修 WAL 仍达不到镜像验收。

## 2. 六次重启证据

`~/.flywheel/restart-ledger/cmux-watcher.jsonl` 的 `gate` 记录与 `~/.flywheel/comm/flywheel/comm.db` mailbox 的 `cmux_watcher_stalled` / `kickstart` 记录相差均不足 1.3 秒：

| PT | UTC / restart seq | heartbeat age | patrol 结果 |
|---|---|---:|---|
| 13:32:26 | `20:32:26.313Z`, seq 876 | 308.6s | stalled → kickstart healthy, 新 pid 42918 |
| 13:39:56 | `20:39:56.980Z`, seq 877 | 322.8s | stalled → kickstart healthy, 新 pid 58271 |
| 13:48:04 | `20:48:04.008Z`, seq 878 | 311.2s | stalled → kickstart healthy, 新 pid 56269 |
| 14:16:46 | `21:16:46.598Z`, seq 879 | 302.2s | stalled → kickstart healthy, 新 pid 63513 |
| 14:26:31 | `21:26:31.613Z`, seq 880 | 358.6s | stalled → kickstart healthy, 新 pid 47722 |
| 15:56:32 | `22:56:32.138Z`, seq 881 | 336.4s | stalled → kickstart healthy, 新 pid 91412 |

旧 stdout 不能补证退出现场：当前 `/tmp/flywheel-cmux-watcher.log` 出生于 2026-09-17 10:23 PT，旧持久日志更早。Lead 裁定不绕 sandbox 取 unified log，而是补下一次事故所需的最小启动证据。

## 3. 两条独立因果链

### 3.1 cleanup 队列令 heartbeat 超时

`packages/teamlead/src/bridge/cmux-watcher-patrol.ts` 默认 `heartbeatStaleMs=300000`。watch loop 只在 tick 起点写 scan heartbeat，pending cleanup 热路径没有 bounded cmux call：

- `is_pane_alive(name)` 为每个 marker 重列 sessions/windows；
- `node_cleanup_freshness_allows(name, ...)` 为每个 marker 重新验证并扫描 registry/snapshot；
- 9 月 16 日队列 1405 行，其中 491 个 realtest、272 个 issue-ts，最早 8 月 27 日。

O(queue × tmux inventory + queue × registry) pass 足以超过 300 秒，与六次 heartbeat age 自洽。9 月 18 日活 watcher 最近 3000 行中 2881 行仍是 node-presence fence waiting。

### 3.2 WAL barrier 令补镜像和 snapshot 发布不可达

健康 tick 原顺序为 drain events → pending cleanup → close requests → 每第四 tick sync additive。调度反转让旧队列先饿死 sync；即使 sync 最终被调用，它还会执行：

```text
prepare_linked_view_state pre
  tmux_server_generation
  recover_all_view_constructions
  reconcile_keeper_inventory
```

生产有两个 WAL：

- `cmux-raya-raya`, `claim_intent`, mtime 2026-09-17 14:26；canonical 与 `fwstage-1789680364-...` 都不存在；
- `cmux-growth-mufasa-lead`, `claim_intent`, mtime 2026-09-17 21:20；canonical 与 `fwstage-1789705243-...` 都不存在。

两者 generation 与当前 tmux endpoint/pid/start tuple 一致。`claim_intent` 分支只处理 canonical 存在，canonical 缺失时若 stage 也缺失便直接返回 1。由于 WAL 自身是唯一残留，此状态不会随重试变化；外层只写泛化 `pass deferred`，无法看出失败步骤。

安全收敛证明：同 generation 下 exact canonical 和 nonce-derived staging name 都确证不存在，WAL 不再引用任何 live tmux object。删除 marker 不会 kill/unlink/rename；相反，只要 canonical 或 stage 存在、generation 不可读或身份不匹配，原有 preserve/block 行为不变。

### 3.3 tmux 3.7c tab 替换令两份 runner inventory 永久失败

生产 tmux client/server 均为 3.7c。只读命令 `list-windows -F $'#{window_id}\tX'` 的实际字节是 `@7310_X`，不是 tab；但：

- `read_runner_tmux_exec_inventory` 用 tab 拼 `session/window_id/exec_id`，Python 再 `split("\t")`；
- `read_runner_tmux_node_inventory` 用 tab 拼 `session/window_id/title/exec_id`，parser 同样按 tab 拆；
- 现场 43 行全部只拆出一个字段，两函数 rc=1、state=`indeterminate`；`cmux-roster-episodes` 已记录 runner roster/node inventory unhealthy；
- 该格式由 2026-08-21 的 FLY-1884 引入；snapshot 最后更新 2026-08-25 17:20，registry 最后非 `admitted` 写入为 17:24，时间线一致。

直接后果：`reconcile_node_presence` 在入口静默 return，snapshot 永久冻结；`rebind_source_candidate_for_title` 也因 node inventory rc=1 返回，所有缺 linked session 的已有 workspace 都不能 rebind，create phase 又因 workspace 已存在不会另建。

修复使用 printable `|`，与 `packages/teamlead/src/bridge/tmux-lookup.ts` 的 `TMUX_IDENTITY_SEPARATOR` 一致；两份 Python parser 本来就拒绝 session/title/exec id 含 `|`，因此仍 fail closed。必须在隔离的真实 tmux 3.7c server 上创建带 `@flywheel_exec_id` 的窗口并调用生产函数验证，普通 shell mock 输出真 tab 不足以覆盖此 bug。

WAL 与 separator 两个 barrier 都解除后，现有 `reconcile_node_presence` / `node_publish_cleanup_snapshot` 与 `rebind_missing_runner_view` 才真正可达；无需另写 snapshot 修复器或 rebind 设计。

### 3.4 1645 行首次补账的 destructive 风险

separator 修复会让 1645 行、全部仍为 `admitted` 的 registry 第一次恢复分类；这不是纯读路径。补账会创建/刷新 node summary、执行 summary TTL/cap，并让 terminal teardown 与后续 close-request 路径重新可达。与此同时现场有活 canonical runner 缺镜像，若陈旧 terminal roster 与活窗口竞态，仅凭 execution/title identity 不能获得 teardown 权威。

Lead 将该风险提升为硬约束：首次补账期间，精确 canonical runner 的 `pane_dead=0` 必须阻止 source teardown，因而也不能产生 close marker、dismantle view 或关闭 pin；只有同一 execution/session/window/title 的 `pane_dead=1` 才可继续既有 terminal transaction。现有 orphan/rebind 最终 guard 继续保护活 source，本单另加三轮 catch-up 回归，证明活窗口数量不因补账减少，同时保留 dead-pane 的原收敛路径。实现阶段不改生产 registry、不运行 operator reap。

## 4. admission、预剪枝与 fallback 语义

### 入队

候选必须是单行、无 `|`/控制字符、长度 ≤247，并在一次验证通过的 node registry 中至少有一行 `$11 == window_name`。`*-realtest-*` 即使伪造 owner 也拒绝。`issue-<epoch>` 只是诊断标签，不能单独拒绝：`packages/claude-runner/src/TmuxAdapter.ts` 在正常生产也用它作 fallback；ownerless issue 仍因无 owner 被拒绝，owned issue 必须允许。

registry 缺失/畸形是 unknown，入队 fail closed。conservative fallback 每 pass 构建一次 owner set；明确不合格的 linked session 不进入 `STALE_STATE`，unknown 则保留已有状态但不新增动作，从而不再每五分钟重造 ownerless 候选。

### 旧队列

`process_pending_cleanups` 先运行独立 pre-prune：

- 格式合法且 age ≥604800 秒：直接删 marker，并写 `cleanup-pending-ttl-reaped`；不依赖 snapshot；
- 未过期但 realtest/ownerless：直接删 marker；
- registry unknown：只做 age-based TTL，未过期 marker 保留；
- malformed marker：保持原有 preserve 行为。

pre-prune 对 registry 只验证/读取一次，并在任何 pane/node probe 前原子替换 pending 文件。TTL 只删除 marker，永不调用 `cleanup_workspace_for`；未来真实 exit 可重新产生 marker。因此 stale snapshot 不会使 TTL 越权，也不会继续冻结队列。

## 5. durable episode 与启动诊断

Lead 指定复用 `~/.flywheel/state/cmux-log-episodes`：

- 双白名单精确增加 `cleanup-pending-ttl-reaped`、`watcher-started`；
- lifecycle row 固定 30 天 GC，view row 继续 active-title GC；
- cleanup target 为 `cleanup:<name>`，输入长度上限保证 target ≤255；
- wrapper 用 `scripts/lib/bounded-run.sh 5 launchctl print ...`，采集 `immediate reason`、`last exit code`、`last terminating signal`；失败/超时/缺字段为 `unknown`，不阻止 `exec`；
- `watch_main` 在持 lease 后再次去控制字符、去 `|` 并限长，防止绕过 wrapper 污染 state。

五字段 schema 与 sha256 evidence 不变。`watcher-started` 仍是 episode store 的 latest/suppressed 语义；逐次 start timestamp 由现有 append-only restart ledger 保存，二者组合用于诊断，不把 episode store 描述成全量启动审计。

## 6. 验证边界

实现节点只做 hermetic 行为测试、lint/build/package tests 与 code review；不重启生产 watcher、不执行 operator reap、不 dispatch QA。Lead 已告知 GitHub CI 被计费墙阻断且 job 0 秒退出，不得重试；冻结 head 后通过 question gate 等 Lead。

部署后第一次补账的影响与 QA 证据必须在 PR 明列：registry 1645 行将从 `admitted` 恢复分类，node summary/TTL/cap 与 terminal transaction 会重新可达；QA 在真机贴补账前后活 runner canonical 窗口数（必须不变）、缺镜像数 `N → 0`、cleanup-pending `<50`、以及 founder cmux 侧边栏截图。当前只读现场基线为缺镜像 14；这是后续 QA 输入，不是本实现节点已完成的 host 证明。
