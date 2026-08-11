# FLY-1672 cmux 看不到任何 Lead — 探索

Issue: FLY-1672 (https://linear.app/geoforge3d/issue/FLY-1672/bug-统一重启后-cmux-看不到任何-lead14-个全不可见-疑-per-lead-私有-tmux-server-形态与-cmux)
日期: 2026-08-10
基于: 无

---

## 0. 一句话

cmux 侧栏空不是 cmux 坏了、也不是 Lead 死了：cmux 的 watcher 被 3231 条**已经死掉的旧窗事件**堵住，而唯一负责把新形态 Lead 建进 cmux 的那段代码，排在这个队列后面，永远轮不到。

---

## 1. 本单诊断期间发生的形态切换（必须先讲，否则后面的证据会自相矛盾）

诊断在 11:20–12:10 之间进行，中途生产形态被 founder 换掉了一次。时间线：

| 时刻 | 事件 | 我观察到的形态 |
|---|---|---|
| 08:34 | 统一重启（上线 FLY-1663 + FLY-1655） | Lead = **v1 carrier**（共享 tmux server 的 `flywheel` session 开窗） |
| 11:20–11:44 | 我的第一轮诊断 | 15 个 plist 全部指向 `flywheel-lead-wrapper.sh`（v1） |
| 11:39–11:57 | **founder 拍板执行 FLY-1663 v2 carrier 全舰切换**（14/14 零失败） | Lead = **v2 carrier**（每个 Lead 一个私有前台 tmux server） |
| 11:57–12:10 | 我的第二轮诊断 | 14 个 plist 全部指向 `flywheel-lead-wrapper-v2.sh`（v2） |

因此本文档里凡涉及"当时观察到"，都标注了 v1 期 / v2 期。**结论以 v2 期（当前生产形态）为准**，v1 期的发现归档为历史证据。

术语（第一次出现即解释）：
- **carrier（承载器）**：launchd 启动一个 Lead 时实际执行的那个包装脚本。v1 把 Lead 开进一个全机共用的 tmux 里；v2 给每个 Lead 单独开一个 tmux。
- **tmux server**：一个常驻后台进程，负责持有若干终端窗口。"共享 server" = 所有 Lead 挤在同一个里；"私有 server" = 一个 Lead 一个。
- **socket**：私有 tmux server 对外的接入点文件，路径形如 `~/.flywheel/sock/fw-<lead>-<hash>.sock`。
- **watcher**：`flywheel-cmux-sync --watch`，常驻进程，负责把 tmux 里的窗口同步成 cmux 侧栏里的 workspace（工作区条目）。

---

## 2. 症状复核（v2 期，2026-08-10 12:05）

`cmux list-workspaces` 实测只有 7 条，**14 个生产 Lead 一条都没有**：

```
workspace:394  tadashi-live          ← eng-lead 的旧手工窗，不是受管 Lead 行
workspace:409  FLY-1573-design       ← 都是 Runner
workspace:410  FLY-1574-design
workspace:411  FLY-1672-design
workspace:412  FLY-1676-design
workspace:413  FLY-1574-implement
workspace:414  FLY-1573-implement
```

同一时刻 Lead 侧的事实（用 `tmux -S <sock> -N` 只读探针，`-N` 保证探针不会把 server 点起来）：

```
ALIVE fw-flywheel-claude-infr-….sock  main|82117|0
ALIVE fw-flywheel-flywheel-co-….sock  main|98945|0
… 共 14/14 全部 ALIVE，pane_dead=0
```

**所以：14 个 Lead 的 tmux server 全部健在，cmux 一个都没显示。这确实是纯可见性问题——但只在 v2 切换之后才成立。**

---

## 3. issue 原假设的裁决

> issue 猜测："cmux 的 Lead 发现逻辑可能还在按旧的共享 tmux server 方式找。"

**裁决：发现逻辑（roster）无罪，且已经完全支持 v2。** 实测把生产脚本 source 进来跑 `derive_lead_roster`：

```
rc=0 STATE=ok
claude-private|com.flywheel.lead.geoforge3d-ops-lead|geoforge3d-ops-lead|/Users/…/sock/fw-geoforge3d-ops-lead-4f6ff936768743e1.sock
… 13 行 claude-private + 1 行 codex-tui-cmux（Mufasa）
```

roster 精确认出了 14 个 Lead 的私有 socket。**形态识别这一层是对的。**

进一步做了一次**全只读 dry-run**（真读生产 cmux，所有会改动的调用全部换成打印桩），验证真正建 workspace 的那段（`ensure_v2_lead_workspace`）在当前环境下是否可行：

```
gen='16777230:481313503:1785814861'   ← cmux 世代标识读到了
CMUX_LEAD_ADDRESS_AVAILABLE=1         ← 地址助手在位
=== flywheel-claude-infra-bot-lead ===
  canonical: env -u TMUX '…/flywheel-lead-attach.sh' '…/fw-flywheel-claude-infr-….sock'
  candidates rc=0: []                 ← 确认 cmux 里当前没有它的行
  WOULD-MUTATE op=new-workspace args=--command env -u TMUX '…attach.sh' '…sock'
```

**所有安全闸全部放行，它会正确地发出建 workspace 的指令。**所以 v2 显示逻辑不是"没写"，也不是"写错"，而是**没被调用到**。

---

## 4. 真因：事件积压把周期任务饿死

### 4.1 watcher 的调度形状

`watch_loop()` 每 15 秒一跳，每跳依次做：

1. `drain_events` — **同步**处理事件队列文件里的**整批**事件
2. `process_pending_cleanups` / `process_close_requests`
3. **每 4 跳（=60 秒）才跑一次** `sync_additive`

而 `reconcile_v2_lead_workspaces`（把 v2 Lead 建进 cmux 的唯一周期入口）只出现在 `sync_additive` 和启动时的 `sync_additive_bootstrap` 里。

**关键：第 1 步不做完，第 3 步永远开始不了。**

### 4.2 队列有多大

```
/tmp/flywheel-cmux-events              258 KB   3231 行
/tmp/flywheel-cmux-events.processing   525 KB   ← 上一批还没消化完的残留
```

事件种类分布：

| 种类 | 条数 |
|---|---|
| `unlinked`（窗没了） | 1615 |
| `create`（新窗） | 1611 |
| register / exited | 5 |

每条 `create` 事件都会真的去调一次 cmux 建 workspace。watcher 日志实测吞吐 **约 1 秒 / 事件**：

```
[cmux-sync 12:04:54] Creating workspace for: joycon-typeless-joycon-lead.p-1786384410-…
[cmux-sync 12:04:55] Creating workspace for: tidal-echo-sub-lead.p-1786384417-…
[cmux-sync 12:04:55] Creating workspace for: geoforge3d-cos-lead.p-1786384418-…
…（12 秒处理约 12 条）
```

3231 条 ≈ **54 分钟**才能排空。期间 `sync_additive` 一次都跑不到 → v2 Lead 一个也建不出来。日志里 `v2 Lead` 相关记录数：**0 条**，与推断一致。

### 4.3 这些事件是什么 —— 以及为什么既有的存活闸没挡住

窗名里的 nonce 时间戳换算下来是**约一小时前**，而处理时刻是 **12:04** —— watcher 正在为**早已死掉的窗**建 workspace，每条都以 `WARN: isolated view build deferred` 收场。**这批工作 100% 是无用功。**

这里本该有一道闸拦住它。`create_workspace_for_window()`（`:6759`）在 FLY-867 就加了：

```bash
window_source_pane_alive "$source_session" "$window_id" || return 0
```

**但这道闸对"窗已经消失"这一类完全失效**，原因是探针本身有缺陷（`:2229-2233`）：

```bash
window_source_pane_alive() {
  local sess="$1" wid="$2" dead
  dead=$(tmux display-message -p -t "=${sess}:${wid}" "#{pane_dead}" 2>/dev/null || echo "1")
  [[ "$dead" == "0" ]]
}
```

它假设"窗没了 → tmux 报错 → `|| echo 1` → 判死"（函数上方的注释原文就是这么写的：*"Probe failure (window just vanished, tmux error) reads as dead — fail-closed"*）。

**实测证明这个假设在 tmux 3.5a 上是错的**——目标窗不存在时 tmux 不报错，而是**静默回退到该 session 的当前窗口**：

```
$ tmux display-message -p -t '=flywheel:@999999' '#{window_id} #{window_name} dead=#{pane_dead}'
@1362 zsh dead=0          ← 编的 id，rc=0，读到的是别人
$ tmux display-message -p -t '=flywheel:@28465'  '#{window_id} #{window_name} dead=#{pane_dead}'
@1362 zsh dead=0          ← 真实的已消失窗，同样回退到 @1362
对照 ↓
$ tmux display-message -p -t '=flywheel:@30679'  '#{window_id} #{window_name} dead=#{pane_dead}'
@30679 growth-rafiki-lead.p-… dead=0   ← 真活窗才返回自己
```

于是：**窗一旦消失，探针读到的是那个永远活着的 `@1362 zsh` 的 `pane_dead=0`，判定"活着"，闸门放行。**注释写的行为和实际行为相反——这是它的先天缺陷（birth defect），从 FLY-867 起就在，只是以前没有足够大的死窗洪水把它暴露出来。

**这才是本单要修的那一处。**它同时解释了两件事：为什么积压里全是死窗还要一条条真的去建；以及为什么 FLY-867 想根治的 CREATE↔CLEANUP 振荡在"窗已消失"这一类下从未真正被修好。

### 4.4 这批事件从哪来（v1 期的病）

v1 期的实测（历史证据，形态已退役）：除 Tadashi（老 body 从 8/8 存活）和 Mufasa（Codex 形态）外，其余 Claude Lead 从 08:34 起一直在 **create-kill 循环**——新建的 claude body 活约 15 秒就被拆掉重来。ops-lead 到 11:39 已经 `[restart #593]`。

- 今天 `Claude launched in tmux window` 日志：**0 次**（最近一次是昨天 15:30）
- `~/.flywheel/pids/*.claude.tmux`（成功受理的凭据）：生产 Lead **全部缺失**
- `*.claude.pending` 全部冻在 `client-recorded` 状态（= 走到"记下了 tmux 客户端"，没走到"受理完成"）
- Bridge 的 `tmux_hold` 表当天全部是 `{"reason":"launch_guard_failed","exitCode":3}`

用 race 探针实测到死法顺序是「**窗先消失、进程还残留**」，即窗是被主动 `kill-window` 拆的，不是 claude 自己退的：

```
TRACK 11:52:12 win=@30779 pid=59648 name=tidal-echo-tidal-echo-cos-lead.p-…
S     11:52:17 win=0 pid=1
>>> WINDOW GONE FIRST (external kill-window), pid lingers
```

每轮 create-kill 产生 1 条 create + 1 条 unlinked。3 小时 × 十余个 Lead ≈ 3231 条，与队列实测吻合。

**因此完整因果链是：v1 期的建窗受理失败 → create-kill 循环 → 事件洪水 → watcher 被淹 → v2 切换后新形态 Lead 排不上队 → cmux 侧栏空。**

### 4.5 一个自愈的好消息与一个坏消息

- **好消息**：v2 形态的 Lead 不在共享 tmux 里开窗，所以事件源已经关掉了，积压不再增长，理论上排空后会自愈。
- **坏消息**：排空要约 54 分钟，而且这 54 分钟里 watcher 在为死窗做无用功；更糟的是，只要这类循环再发生一次，同样的饿死会重演。**这不是可以靠"等"解决的问题。**

---

## 5. 顺带发现（同处但独立，已单独上报）

### 5.1 P0：全舰 Discord 实际下线

逐个私有 socket 只读抓屏，**13/14 个 Lead 停在 dev-channels 确认框**（唯一例外 belle-lead 正常）：

```
WARNING: Loading development channels
--dangerously-load-development-channels is for local channel development only…
Channels: server:flywheel-inbox
❯ 1. I am using this for local development
  2. Exit
Enter to confirm · Esc to cancel
```

ops-lead 这屏从 11:46 起 20 分钟无变化。**Lead 进程活着但没进入可对话状态 = Discord 实际下线。**

代码级根因：自动按确认的后台轮询器在主循环里启动（`claude-lead.sh:4525`），而 v2 分支在 `_launch_claude` 内部 `wait` 子进程直到 claude 退出才返回（`claude-lead.sh:2888-2894`）。也就是 **v2 下轮询器只会在 claude 结束之后才起，等于永不生效**。

这是 FLY-1663 的集成缺口，比 cmux 可见性更紧急，已单独上报 Tadashi 由他/founder 处置。

### 5.2 `workspace:404` 裸命令名

issue 提到的 `env -u TMUX tmux attach -t '=cmux-FLY-202-…'` 裸命令名，与本单同源：workspace 建出来之后要经过一次改名才变成人读的标题，改名依赖受理凭据；受理链断掉时就停在裸命令名。**修好受理与调度后这条自然消失**，不需要单独的改名补丁。

### 5.3 FLY-1663 的 QA 盲区

FLY-1663 的验收验的是"Lead 能不能起来"（3/3 无人值守 PASS），没有验"起来之后 cmux 看不看得见"、也没有验"起来之后能不能说话"。issue 里这个判断是对的，且被 5.1 再次坐实。

---

## 6. 待确认 / 我没有验的

- 积压排空后 v2 Lead 是否真的会自动出现在 cmux —— 只做了 dry-run 推断，未等到真实排空。
- `.processing` 那 525 KB 残留批次的确切来源（是崩溃残留还是被 latch 中断保留），只读到文件本身，未追到写入时刻。
- Mufasa（Codex 形态）在 cmux 里的显示路径与 Claude Lead 不同，本次未验。
