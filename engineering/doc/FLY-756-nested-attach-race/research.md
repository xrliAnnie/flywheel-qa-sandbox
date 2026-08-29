# FLY-756 cmux-sync nested-attach — 调研

Issue: FLY-756 (https://linear.app/geoforge3d/issue/FLY-756/infra-cmux-sync-healreopen-注入竞态-runner-pane-里出现-nested-attach)
日期: 2026-07-02
基于: exploration.md

## 1. 两个 in-scope 注入位点（复核确认）

`scripts/flywheel-cmux-sync.sh`：

| 位点 | 行 | 现状 |
|------|----|------|
| create attach | `new-workspace --command "tmux attach -t '=${view_session}'"` | 无 `env -u TMUX` |
| heal/reopen 注入 | `printf -v attach_cmd "tmux attach -t '=%s'\n"` → `cmux send` | 无 `env -u TMUX`；普通路径无 send-前 final-guard |

全仓 `tmux attach` 复核（`grep -rn "tmux attach"`）：其余命中都是
- Terminal.app `do script`（`run-issue.ts:393`、`e2e-tmux-runner.ts:210`）— fresh Terminal shell，无 `$TMUX`，类 1；
- `tmux-lookup.ts:119`（FLY-560 rescue 命令，pin 到 Discord thread 供 Annie 手动粘贴）— **同 nested 失败模式**，Lead 批准一并加 `env -u TMUX`；
- 纯注释 / spike 脚本 / e2e，非生产注入。

## 2. Bisect —— 谁放大了竞态（Lead 现场线索：昨天下午/晚上激增）

**结论：bug 是长期存在的；FLY-293 #404 是激增放大器。**

### 2a. bug 非昨天引入 —— 长期存在

`git show a800af16^:scripts/flywheel-cmux-sync.sh`（FLY-293 落地**前**）两个 attach 位点
**已经**没有 `env -u TMUX`：
```
857:  printf -v attach_cmd "tmux attach -t '=%s'\n" "$view_session"          # heal
1582: if ! cmux_call new-workspace --command "tmux attach -t '=${view_session}'"; then  # create
```
普通 heal 路径缺 final-guard 也是老状态（final-guard 是 FLY-254 于 2026-06-12 加的、
**仅升级路径**）。→ 昨天的改动没引入 bug，只可能放大暴露。

### 2b. 时间线高度吻合 —— FLY-293 #404 是唯一嫌疑

`git log -- scripts/flywheel-cmux-sync.sh`：

| commit | 时间 | 说明 |
|--------|------|------|
| **a800af16 (FLY-293 #404)** | **2026-07-01 15:38** | orphan-pin reaper |
| db880ff5 (FLY-280 #274) | 2026-06-16 16:36 | 上一次改动，早 ~2 周 |

Annie 现场 = 2026-07-01 **16:31**。FLY-293 落地在其**前 ~1 小时**，且是 ~2 周内**唯一**
一次 cmux-sync 改动。"昨天下午/晚上激增" 与此吻合。

### 2c. 放大机制（证据 + 假设，分级标注）

**证据（高置信）**：FLY-293 **新引入了周期性全局 `cmux refresh-surfaces` 广播**。
对比 `a800af16^` vs 现状 refresh-surfaces 调用点：
- **前**：只在 heal 命中（`live window actually healed`，条件触发）+ drain 路径；
- **后**：`reap_orphan_workspace_pins`（:789）与 `reap_orphan_pins_oneshot`（:870）在每次
  关掉 ≥1 个 orphan pin 后**无条件广播** `refresh-surfaces`，且 reaper 被 wire 进
  `sync_additive`（~60s 周期 reconcile 的 empty+normal 双分支）+ `sync_once`。

生产实测 FLY-293 首扫要清 ~29 个 orphan pin（47 workspaces / 18 live sessions）—— 首次
周期 sweep 会连续 `close-workspace` 一批 + 广播 `refresh-surfaces`。

**假设（中置信，标注为假设）**：新的周期性全局 repaint + 一批 pin-close 带来的
focus/render churn，(a) 让 heal 的 bare-shell 探测在 surface 重绘瞬间更易误判、
(b) close 活跃邻居 pin 可能移动 cmux selected workspace → 正是 FLY-254 guard 注释点名的
"focus-triggered attach" 竞态源——而普通 heal 路径**从未**有 send-前 final-guard。两者叠加
把长期竞态的触发频率显著抬高。

**操作性放大器（旁证）**：exploration 记录 16:25 Bridge 重启后 16:30 一波 5 个新
workspace（dispatch/retry 重放）——重启重放 = 一批 create-attach 齐发，若该 session cmux
继承了 `$TMUX`，每个都 nest-fail。这是环境/操作放大，与 FLY-293 的代码放大叠加。

### 2d. 对修复的意义

修复**不依赖**哪个 commit 放大：`env -u TMUX` 从源头掐断"继承 `$TMUX`"路径（两个 attach
位点 + FLY-560 rescue），统一 guarded send 掐断注入竞态。FLY-293 的 reaper 本身是正确的
（清 orphan pin），**不回退**；本 issue 治的是它放大暴露的那个更底层的注入卫生问题。

## 3. 复用的既有机制（不重造轮子）

- `cmux_call_guarded <guard_fn> <cmux args…>`（:228）— guard 作为 cmux 前 genuine last op。
- `_heal_send_final_guard`（:271）— generation pin（`HEAL_SWEEP_GEN_IDENT` 未设时跳过，普通
  模式即跳过）+ 最终 0-client re-check。`GUARD_BLOCK_RC`：1=fail-closed，2=client 出现（healed）。
- 统一到单一 guarded send 后：普通模式获得 final-guard；升级模式 byte-identical。

## 4. 测试面（TDD 目标）

现有 292 测试（`/bin/bash scripts/test-cmux-sync.sh`，macOS bash 3.2）全绿是回归基线。
新增/改断言：
1. create attach 命令含 `env -u TMUX`（新 assert，改 `MOCK_CMUX_OPS` new-workspace 断言）；
2. heal attach 命令含 `env -u TMUX`（改现有 :1914 send 断言）；
3. 普通 heal 路径：0-client gate 后、send 前 client 出现（mock `view_session_client_count`
   在 final-guard 时返 >0）→ **不 send**（竞态被 final-guard 挡）；
4. FLY-560 `buildAttachCommand` 单测：cmux 与 fallback 两分支都含 `env -u TMUX`（vitest）。
