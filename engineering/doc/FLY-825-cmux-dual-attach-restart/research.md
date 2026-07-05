# FLY-825 cmux 重启后同一 lead session 冒出两个 attach 视图 — 调研

Issue: FLY-825 (https://linear.app/geoforge3d/issue/FLY-825/infracmux-重启后同一-lead-session-冒出两个-attach-视图重复-tab-命令当-tab-名-heal-send)
日期: 2026-07-03
基于: exploration.md

Tadashi 已通过 BRAINSTORM GATE 确认根因判断（create-vs-create race）+ 修复方向（进程内
互斥/去重）+ 孤儿 watcher（pid 64108）并入本 issue 一起修。本文档补齐实施前需要的两块
调研：（A）孤儿 watcher 的具体触发点；（B）现有测试框架里怎么最小成本地补一个能复现
"同一 tick 内两条路径都判断 workspace 不存在"的回归测试。

## A. 孤儿 watcher 的触发点

`scripts/flywheel-cmux-install.sh`（launchd 配置/重装脚本）:

```bash
launchctl bootout "gui/$(id -u)/$WATCHER_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null
```

脚本自己的注释承认这里有个"两条启动路径"的竞态，靠 `acquire_watcher_lock` 的
supervised 分支兜底："the single-instance lock keeps the two start paths race-safe"。
这个兜底**确实**防住了两个进程同时真正跑 `watch_loop`（新实例发现旧实例还活着 + 是
watcher，就一直 `sleep 15; continue` 排队等，日志证实 pid 57958 从 14:31 起排到现在，
从未真正进入 `watch_main`）——但它**没有**防住"旧进程被 `bootout` 之后其实没死透，
变成一个 launchd 不再追踪的孤儿常驻进程"这件事本身。`launchctl bootout` 不保证同步
杀死目标进程（尤其目标在做阻塞系统调用或者信号处理有延迟时）；`bootstrap` 紧跟着就建
新 job + 起新进程，不等旧进程真正退出。生产实测：pid 64108（今天 00:01 起、launchctl
list 已不再认领它）就是这样一个孤儿，且从时间点看（凌晨 00:01）疑似是某种每日例行
重装/重启在触发这条 bootout→bootstrap 序列，不止今天一次。

`scripts/fleet-capture.sh` 会调用 `flywheel-cmux-install.sh`（其余全仓再无其它调用点），
但具体是谁在什么节奏下触发 fleet-capture.sh 不在本次修复范围内深挖——不管上游触发源
是什么，**下游这条 bootout→bootstrap 序列本身有竞态窗口，这是可以直接修的点**，不需要
先搞清楚上游调度。

### 修复方向

给 `flywheel-cmux-install.sh` 的这一步加一个"确认旧进程真正退出再 bootstrap"的
有界等待：`bootout` 之后，若旧进程的 PID（从锁文件读，或者直接按命令行 pattern 精确
匹配 `flywheel-cmux-sync --watch`）仍存活，轮询等待（例如 ≤5s，每 200ms 探一次），若
超时仍未退出则显式 `kill`（先 TERM 后 KILL，不越权杀无关进程——只杀确认是
`flywheel-cmux-sync --watch` 命令行的 PID）。这样新实例永远不会碰到"旧进程还活着"的
情况，`acquire_watcher_lock` 的 supervised 等待分支就成了纯粹的防御性兜底，不再是
唯一防线。

不改 `acquire_watcher_lock` 本身的锁逻辑（它的 TOCTOU 处理已经过多轮 Codex review，
本身没有发现新 bug）——只堵上游"该死的进程没死透就催生新实例"这个源头。

## B. create-vs-create 竞态的测试设计

### 现有测试框架回顾（`scripts/test-cmux-sync.sh`, bash 3.2 兼容，无 bash 4 关联数组）

- 全部测试直接 `source` 主脚本后调用其内部函数（不是黑盒子进程测试），通过一组
  `MOCK_*` 全局变量驱动假的 `tmux()` / `cmux()` 命令替身。
- `MOCK_CMUX_WORKSPACES_JSON` 是当前"cmux workspace 列表"的快照；**`cmux new-workspace`
  这个 mock 不会自动把新 workspace 塞进这个 JSON**——它只是把调用记录追加到
  `MOCK_CMUX_OPS`（测试用来断言"发生了什么调用"）。因此已有测试验证
  `create_workspace_for_window` 的 rename/verify-attach 逻辑时，都是通过预先摆好
  "建前"和"建后（含 `MOCK_SLEEP_HOOK` 在 sleep 时机切换 JSON）"两份快照来模拟。
- 既有 Test 13c（`# Test 13c: ANTI-POLLING regression — sync_additive (60s periodic)
  must NOT self-heal`）已经验证了 `sync_additive` 不会做 `self_heal`，但**没有**任何
  现有测试覆盖"`drain_events` 的 create 分支和 `sync_additive` 的 missing-workspace
  分支在同一次调用序列里，针对同一个 window_name，各自判断『不存在』并各自调用
  `create_workspace_for_window`"这个场景——这正是本次要补的回归测试，也是过去没有
  测试覆盖到这个 bug 的原因。

### 新增测试思路

1. **RED（复现 bug）**：直接调用序列 `create_workspace_for_window "flywheel" "@1210"
   "growth-mufasa-lead"` 两次（模拟 drain_events 和 sync_additive 各自决定要建），
   `MOCK_CMUX_WORKSPACES_JSON` 全程保持 `{"workspaces":[]}`（模拟两次调用各自的
   "建前"快照都看不到对方——不需要精确复刻 cmux 的 eventual-consistency 细节，只需要
   证明"两次连续调用会不会互相察觉"）。断言：`MOCK_CMUX_OPS` 里 `new-workspace` 只
   出现**一次**（不加互斥的话，改动前的代码这里会失败——出现两次）。
2. **GREEN**：加进程内去重后，第二次调用应该在自己的存在性判断之前就被短路，直接
   return（记一条 log，不产生任何 `new-workspace` / `rename-workspace` cmux 调用）。
3. 需要覆盖的边界：
   - 去重记录要有 **有界 TTL**（不能永久拉黑一个 window_name——如果这个 Lead 真的
     关闭很久之后又开了同名新窗口，必须能重新建）。用短 TTL（几十秒量级，覆盖
     "同一 tick 内"以及"跨一两个 tick"的重复，不影响分钟级之后的正常重建）。
   - 去重记录要按 `(session, window_id, window_name)` 还是只按 `window_name`？
     `window_name` 就够——因为 cmux workspace 本身是按 title（即 window_name）
     去匹配存在性的，两次重复调用锁定的正是同一个 window_name。
   - 需要一个新的 `gc_*_state_file` 收尾（跟 HEAL_STATE / STALE_STATE 一样的既有
     模式），防止状态文件无界增长。
4. 复用既有 `reset_mocks` / `pass` / `fail` 测试辅助函数，不新增测试框架代码。

### 孤儿 watcher 修复的验证方式

`flywheel-cmux-install.sh` 目前没有对应的 bash 测试文件（`scripts/__tests__/` 下现有
的是 daemon-install-verify，跟这个不是一回事）。鉴于该脚本会真的碰 `launchctl`（有
`FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL=1` 测试逃生口），倾向于给"等待旧进程退出"这段
新增逻辑写一个独立、不碰真实 launchd 的小函数 + 对应 bash 测试（mock `kill -0` /
`ps` 的行为），而不是尝试端到端起停真实 launchd job。

## 结论

两处改动都定位清楚、改动范围小、都能在现有 bash 3.2 测试框架下写 TDD 覆盖。可以进入
plan.md。
