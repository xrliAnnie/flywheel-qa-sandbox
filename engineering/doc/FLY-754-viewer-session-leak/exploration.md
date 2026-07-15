# FLY-754 viewer-execid session 堆积 — 探索

Issue: FLY-754 (https://linear.app/geoforge3d/issue/FLY-754/infrarootp1-viewer-execid-session-堆积-生成源不销毁annie-眼看它们自己-attach永久解)
日期: 2026-07-01
基于: 无

## 问题

Annie 眼看着一堆 `viewer-<uuid>` tmux session 自己冒出来。Cass 实测 36 个（15 个 Jun28-30 陈旧）。要求：找到**生成源**并从源头修，不靠 reaper 收尸。

## 生产现场证据（2026-07-01 实测）

1. `tmux ls`：61 个 session，其中 **19 个 `viewer-<uuid>`**（全部 Jul 1 当天创建，04:57 → 16:30 散布），全是 grouped session（`(group runner-flywheel)` / `(group runner-test-slot-3)`）。
2. `tmux list-clients`：**0 个 client attach 在任何 viewer-\* 上**。所有真实查看走 `cmux-<窗名>` session（cmux workspace）。
3. Terminal.app：只有 1 个空窗口，**0 个 flywheel viewer tab**。
4. Bridge log（/tmp/flywheel-bridge.log）：
   - `[tmux-viewer] tab not found 1500ms after spawn — possible Terminal.app drop` ×6（含本 runner 自己的 execId e7903797）
   - `[tmux-viewer] open failed: Command failed: osascript ...`（tab 完全没建出来）
   - `[terminal-reaper] scanned=0 closed=0`（启动 reaper 按 Terminal tab 扫，没 tab 就一个收不了）
5. StateStore 抽查：`viewer-53b1f592`（FLY-741）、`viewer-6adddbae`（FLY-743）、`viewer-313ea6b2`（FLY-745）、`viewer-fe3a17ce`（FLY-748）对应 session 全部 **completed**，viewer session 仍在 —— "跑完不销毁" 实锤。
6. 16:25 Bridge 重启后，16:30 一波 5 个新 viewer（重启后的 dispatch/retry 重放） —— "reload 冒一批" 现象的来源。

## 根因链

### 谁建（生成源）

`openTmuxViewer()`（`packages/core/src/tmux-viewer.ts`）—— GEO-277/FLY-116 时代的 **macOS Terminal.app viewer**。每次 runner dispatch 由 `BlueprintContext.onTmuxWindowCreated` 回调触发（三个位点：`run-dispatcher.ts:364`、`run-dispatcher.ts:636`、`DagDispatcher.ts:92`）。流程：

1. （step 3）`setupViewerSession()` **无条件**创建 `viewer-<execId>` grouped tmux session；
2. （step 5）osascript 让 Terminal.app 开新 tab 跑 `exec tmux attach -t '=viewer-<execId>'` 并 `activate`（弹到前台 —— 这就是 Annie 看到"一个个自己 attach 冒出来"）；
3. （step 6）verify **只 log 不清理**：tab drop（本机常态）时，已建出的 viewer session 无人回收 → **出生即泄漏**。

关键 gate：FLY-650 加的 `viewerUsesTerminalApp()` 对 backend `"cmux"` **也返回 true**（byte-compat 保留旧行为），所以 cmux 生产机上每次 dispatch 照样跑完整 Terminal.app opener。

### 为啥跑完不销毁

- 销毁（`closeRunnerTerminalView` / reaper 的 `kill-session viewer-*`）只挂在 **close_runner / terminate action / post-merge / crash-reaper** 这些 Lead 驱动路径上。runner `completed` 之后、Lead close 之前，viewer 一直留着；session 走不到这些路径（或 close 前 Bridge 换代）→ 永久泄漏。
- 启动 reaper（`terminal-tab-reaper.ts`）按 **Terminal.app tab 标题**枚举——没 tab 时 `scanned=0`，`kill-session viewer-*`（:157）永远不 fire。tmux 层没有 session 级 viewer reaper。

### viewer-* 在 cmux 机器上是纯冗余

- Annie 的查看面是 cmux：`flywheel-cmux-sync.sh` 给每个 runner window 建 `cmux-<窗名>` workspace（自带 attach/self-heal/清理，FLY-102/110/169/293 一整套生命周期）。
- `viewer-<execId>` 的**唯一消费者**是那个（开不起来的）Terminal.app tab。全库 grep 无其他消费者（`CodexTmuxAdapter.ts:754` 只是注释提及；proofshot 的 `--model-viewer-url` 是 3D 模型查看器，无关）。

### 顺带查：nested-attach（`sessions should be nested with care, unset $TMUX`）

全库跑 `tmux attach` 的只有三类：
1. Terminal.app tab（fresh shell，无 `$TMUX`）—— 不可能 nested；
2. `cmux new-workspace --command "tmux attach ..."`（fresh surface）—— 同样安全；
3. cmux-sync 的 **heal/reopen 注入**（FLY-169 self-heal + FLY-254 reopen sweep）：把 `tmux attach` 当文本 send 进 surface。3-gate（managed title + 0-client + bare-shell）防误注，但 gate→send 非原子；若 focus 触发的 attach 在竞态窗口内完成，文本会打进**已 attach 的 tmux pane 内部**（`$TMUX` 已设）→ 出现 nested 报错。

结论：nested-attach 来源 = heal/reopen 注入竞态（已知面，有 final-guard 但非原子），与 viewer-* 堆积**无因果**（viewer 0 client，没人在 attach 它们）。活 pane 扫描（近 200 行）未捕到现场。建议单开 follow-up issue，不并入本修。

## 修复方向（从生成源）

1. **核心**：`viewerUsesTerminalApp()` 只对 `"terminal-app"` 返回 true —— backend=cmux 不再跑 Terminal.app opener、不再建 `viewer-<execId>`。生成源归零；FLY-650 已把 gate 集中在这一个函数，三个 dispatch 位点一次覆盖。cmux 查看体验不变（cmux-sync 全权负责）。
2. **terminal-app backend 加固**：`runOpen` 的 osascript 失败时（tab 确定没建出来）顺手 kill viewer session。verify 的 "tab not found" 路径保持 log-only（tab 可能存在只是查询失败，误杀会砍断真 attach）。
3. **兜底（迁移 + 漏网）**：Bridge 启动时加一个 session 级 viewer sweep：`viewer-*` 且 0 client 且对应 exec 在 StateStore 为终态（或无 row）→ kill。现有 19 个遗留下次 Bridge 重启自动清掉；terminal-app 机器漏网的也能兜住。viewer 是 grouped session，kill 它不碰 runner window/scrollback（都在 base session 里），安全。
4. close_runner / post-merge / terminate / crash-reaper 的现有 `closeRunnerTerminalView` 调用保持不动（对不存在的 session kill 是 benign）。

## 备选（已否）

- 保留 cmux 上的 Terminal opener、只修 tab-drop 清理：仍然每次 dispatch 弹 Terminal 抢焦点、仍与 cmux 双份查看面、复杂度全保留。否。
- 纯靠加强 reaper：issue 明说"清一万遍都复发"，生成源不掐就是收尸。否。
