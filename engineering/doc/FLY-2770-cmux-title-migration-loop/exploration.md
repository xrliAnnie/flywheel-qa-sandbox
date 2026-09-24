# FLY-2770 cmux 同步器失控 — 探索

Issue: FLY-2770 (https://linear.app/geoforge3d/issue/FLY-2770/cmux同步器失控-flywheel-cmux-sync-watch-给新窗口建镜像时title-stock-topology-proof)
日期: 2026-09-22
基于: 无

## 1. 现场取证（真机，2026-09-22 00:4xZ）

`cmux 0.61.0`。read-only 取证（未动 marker、未夺 mutator lease）：

```
$ env -u TMUX cmux --json list-pane-surfaces --workspace workspace:451
  surfaces[0].title = "Terminal 65"          ← cmux 自带占位标题
$ env -u TMUX cmux --json list-workspaces
  workspace:451 title = "flywheel-codex-infra-bot-lead"   ← workspace 面已改名成功
$ cat ~/.flywheel/state/cmux-view-ledger
  prepared|<gen>|workspace:451|flywheel-codex-infra-bot-lead|10A91D8B-...  ← 永远停在 prepared
```

watcher 日志（`/tmp/flywheel-cmux-watcher.log`，`surface drift` 共 4231 行）：

```
[18:23:52] WARN: title migration surface drift ref=workspace:451
  expected_raw=env -u TMUX FLYWHEEL_CMUX_ATTACH_TMUX_BIN='…' '…/flywheel-view-attach.sh'
              'cmux-flywheel-codex-infra-bot-lead' 'fwtok1-…'
  observed=Terminal 65; preserving receipt
[20:47:16] WARN: prepared title migration deferred ref=workspace:451 …; preserving receipt
```

三个 Codex 载体 Lead 的判官现状（复现成功）：

| target | status | reasons |
|---|---|---|
| raya-raya | inconclusive | ownership_unproven（a1-topology / pane-identity / client-count=not-measured / WARN receipt-uuid-unattributable birth:missing）|
| growth-mufasa-lead | fail | surface_mismatch |
| flywheel-codex-infra-bot-lead | inconclusive | probe_unavailable（外加 receipt observed=prepared）|

## 2. 病根：cmux 占位标题 "Terminal N" 没有被 tab 面接受

`scripts/flywheel-cmux-sync.sh` 里 tab（surface）改名的唯一通道是
`complete_title_migration()`（8142）。它在真正 `rename-tab` 之前要求**观察到的
surface 标题必须等于出生命令（birth command）的某个变体**：

```bash
if ! _managed_view_command_in_variants "$surface" "$canonical_raw"; then
  log "WARN: title migration surface drift … preserving receipt"
  return 1
fi
```

这条断言的本意（FLY-1605）是「别去改 founder 自己命名的 tab」。问题在于
**cmux 给新建 surface 的初始标题是它自己的占位符 `Terminal N`，不是命令串**。
只有当 `tmux attach` 真正画出画面、tmux 用 OSC 把标题改成 window name 之后，
surface 标题才会变成目标标题（那时走 `surface == title` 短路直接 commit）。
attach 一旦没画出来（view session 还没建好 / 已 attach 失败 / surface 已死），
surface 就永远停在 `Terminal N`，于是：

* `complete_title_migration` 永远 return 1 → receipt 永远 `prepared`；
* `reconcile_prepared_ledger`（8880）每一轮重跑，永远 deferred；
* prepared 行迟迟不 commit，最终被 restored-adoption / prepared-stall 回收
  （日志 18:23:19 `restored adoption minted synthetic committed receipt` →
  `guarded close workspace=workspace:251`），
  紧接着 18:23:53 `Creating workspace for: raya-raya` 重建一个新的 →
  **关掉→重建→又卡 prepared→再关掉** 的圈，每圈在侧边栏留一个空壳。

关键不对称（这就是真正的 bug）：同一个函数 `reconcile_prepared_ledger` 里，
**workspace 面**已经识别了这个占位符，而 **tab 面**没有。8951 行：

```bash
if _workspace_title_is_default "$observed"; then        # ^Terminal [0-9]+$
  if _workspace_uuid_valid "$workspace_uuid"; then
    canonical_raw="${provisional}"$'\n'"${observed}"    # 把占位符加进可接受变体
    observed="__DEFAULT__"
```

但当 workspace 面**已经改名成功**（正常情况，`rename-workspace` 先于
`rename-tab`），走的是 `"$title")` 分支，传给 `complete_title_migration` 的是
不含占位符的 `$provisional` → 必然 surface drift。
`create_workspace_for_window`（10292）传 `$attach_cmd` 也一样不含占位符。

`_workspace_title_is_default()`（6790）已经存在，只是没被 tab 面用上。

## 3. 第二个病：park 的 watcher 把修复工具一起锁死

`maintenance_entry_allowed()`（13877）：

* mode 不是 `watch` / `ops_rebuild` 时 → `maintenance_requested || return 0`，
  marker 在就 `return 1`。`--refresh` 因此在 marker 在时直接被拒。
* mode 是 `ops_rebuild`（`--rebuild-views` / `--converge-runners`）时：
  `[[ ! -e MARKER && ! -e QA_CLAIM ]] || return 1` —— **marker 在就拒**。

而 watcher 在 marker 在时（`watcher_maintenance_checkpoint`，13913）其实**已经
主动 release 了 mutator lease**，lease 是空的。也就是说：park 的 watcher 并没有
真的占着 mutator，是 `maintenance_entry_allowed` 把修复工具一并拒了。
摘掉 marker 才能修 → 摘掉 marker watcher 就复活刷空壳 → 死结（Lead 9/22 04:5xZ 实测）。

## 4. 第三个病（附带修）：QA teardown claim 没有独立 env

`scripts/flywheel-cmux-sync.sh:116` 与 `scripts/test-teardown.sh:50` 都写死：

```bash
CMUX_QA_TEARDOWN_CLAIM="${CMUX_MAINTENANCE_MARKER}.qa-teardown"
```

claim 路径由 marker 路径派生且没有自己的 env → 「把 marker 指到临时路径」
（为了绕开住场 watcher）会同时把 claim 也搬走，两件事被耦合。

## 5. 重启后 Lead 面板要手接

`flywheel-view-attach.sh` 本身是死循环 `has-session → attach → sleep 2`，
私有 tmux server 重生后它会自己重连。9/22 十四个里九个死，真实原因是
**view session（`cmux-<title>` grouped session）没被重建**——watcher 被 park /
被第 2 节的死结困住，helper 只能一直显示「视图暂不存在」。
即第 3 条需求是第 1、2 条的下游。

## 6. 结论（待 research/plan 确认）

1. 让 tab 面接受 cmux 自带占位符 `Terminal N` —— 但只在 receipt 是
   **UUID 绑定**（= 本 watcher 自己建的、或有 birth 记录的）时；legacy
   （无 UUID）receipt 保持严格命令面证明，绝不碰 founder 的 tab。
2. park（marker）≠ 活 mutator：`--refresh` / `--rebuild-views` 在 marker 在、
   且没有 QA teardown claim 时可用。
3. `CMUX_QA_TEARDOWN_CLAIM` 给独立 env。
4. 阴性：rename 真失败时保持「不再造、只告警一次」。
