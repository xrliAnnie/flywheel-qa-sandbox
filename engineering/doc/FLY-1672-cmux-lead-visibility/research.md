# FLY-1672 cmux 看不到任何 Lead — 调研

Issue: FLY-1672 (https://linear.app/geoforge3d/issue/FLY-1672/bug-统一重启后-cmux-看不到任何-lead14-个全不可见-疑-per-lead-私有-tmux-server-形态与-cmux)
日期: 2026-08-10
基于: exploration.md

---

## 1. 要回答的三个问题（issue 原文）

1. cmux-sync 的 Lead 发现逻辑现在读什么？与 per-Lead 私有 server 的新形态差在哪？
2. 修法：让发现逻辑理解新形态，还是让新 carrier 主动向 cmux 注册？
3. 修完真机验收：重启后仍能看到。

**探索阶段已经把 Q1 的答案翻转了**：发现逻辑读的就是新形态，且读对了。所以 Q2 的两个选项都是伪选项——真正要修的是**调度**，不是发现，也不是注册。本文档据此重定方向。

---

## 2. 现状代码事实

### 2.1 Lead 发现链（无需改动，此处仅存证）

| 位置 | 职责 | v2 支持情况 |
|---|---|---|
| `flywheel-cmux-sync.sh:608` `classify_lead_carrier()` | 按 plist 里的包装脚本名 + 后端判定承载器种类 | 已含 `flywheel-lead-wrapper-v2.sh → claude-private` |
| `:674` `derive_lead_roster()` | 遍历 launchd 里已加载的 Lead，产出 `carrier\|label\|title\|socket` 名册 | 已校验私有 socket 是否等于规范推导值 |
| `:2731` `ensure_v2_lead_workspace()` | 为一个 v2 Lead 建/改名/去重 cmux workspace | 完整实现，含世代闸与凭据账本 |
| `:2787` `reconcile_v2_lead_workspaces()` | 遍历名册里所有 `claude-private` 行调上面那个 | 完整实现 |

生产实测（见 exploration §3）：名册 14/14 正确、dry-run 会正确发出建 workspace 指令。**这条链无罪。**

### 2.2 调度链（病灶所在）

```
watch_loop()                        :8895
  每 15s 一跳
    ├─ drain_events()               :8951   ← 同步处理整批事件，不设上限
    ├─ process_pending_cleanups()   :8952
    ├─ process_close_requests()     :8954
    └─ if (tick % 4 == 0):
         sync_additive()            :8956   ← 每 60s；reconcile_v2_lead_workspaces 唯一周期入口
```

`reconcile_v2_lead_workspaces` 的全部调用点只有两处：`sync_additive_bootstrap()`（watcher 启动时一次，`:7780`）和 `sync_additive()`（`:7850`）。**第 1 步不返回，第 4 步不开始。**

### 2.3 真正的结构缺陷：存活探针在目标不存在时读的是别人

`create_workspace_for_window()` 里本来就有一道存活闸（FLY-867 Fix B，`:6766`）：

```bash
window_source_pane_alive "$source_session" "$window_id" || return 0
```

它的意图正确，但探针实现（`:2229-2233`）有先天缺陷：

```bash
window_source_pane_alive() {
  local sess="$1" wid="$2" dead
  dead=$(tmux display-message -p -t "=${sess}:${wid}" "#{pane_dead}" 2>/dev/null || echo "1")
  [[ "$dead" == "0" ]]
}
```

**它只读回 `#{pane_dead}`，从不验证读到的是不是自己要问的那个窗。**函数上方注释写着 *"Probe failure (window just vanished, tmux error) reads as dead — fail-closed"*，即作者假设窗消失时 tmux 会报错。

**tmux 3.5a 实测证明这个假设是错的**（见 exploration §4.3 三组对照）：目标窗不存在时 tmux **静默回退到该 session 的当前窗口**并返回 rc=0。生产上那个"当前窗口"恰好是永不退出的 `@1362 zsh`（`pane_dead=0`），于是**每一个已消失的窗都被判成"活着"**，闸门全部放行。

后果有两层：

1. **本单症状**：积压里 1611 条 create 事件对应的窗早已死透，却每条都真的发起一次 cmux 建 workspace（实测约 1 秒/条）→ 队列 3231 条 ≈ **54 分钟**排不空 → `sync_additive` 归零 → v2 Lead 建不出来 → cmux 侧栏空。
2. **顺带暴露**：FLY-867 想根治的 CREATE↔CLEANUP 振荡，在"窗已消失"这一类下从未真正被修好——只有"窗还在但 pane 是尸体（remain-on-exit）"那一类被挡住了。

### 2.4 本次事故相关的存活探针审计（按后果分类，非全量 `display-message` 清单）

下表只覆盖**判定窗口/pane 死活**的探针（脚本里还有查 session_group、generation、window_name 等其它 `display-message` 用法，与本次事故无关，不在此列）：

| 位置 | 目标 wid 来源 | 判定 |
|---|---|---|
| `:2205` `is_pane_alive` | 先 `list-windows` 枚举再查 | preservation-only。注意机制：静默回退返回的是**正常** `pane_dead` 值，当前窗活着时函数返回 **rc=0（判活）**，不是 rc=2；rc=2 只留给探针/清单读取失败或格式异常。两条路径都偏保留（清理方只在最终 rc=1 才动手），结论成立但机制不是 rc=2。记档不修 |
| `:2216` strict-view 探针 | 按 view session + 窗名 | 同上：回退多半表现为 rc=0 而非 rc=2；三态 API 与保留语义必须维持。记档不修 |
| `:3298` `select_live_view_window` | 来自紧邻快照枚举 | best-effort：窗在「列举→探测」之间消失仍会触发同一回退，但后果只是一次 select 落空 + 下轮重试，无昂贵动作。记档不修 |
| `:7301` legacy `refresh_linked_sessions` | 同上 | 同上（best-effort，记档不修） |
| **`:2231` `window_source_pane_alive`** | **调用方传入（可能已消失）** | **有洞——本单修这一处**；它有**两个**调用方：`create_workspace_for_window:6766` 与 `title_source_authorized:5355` |
| `:6619` linked-view build + `:3720` `_tmux_view_build_guard` | 调用方传入 | **只自证名字、不自证身份**：读回 `#{window_name}\|#{pane_dead}`。目标 id 消失而当前窗**恰好同名且活着**时两项都通过（隔离 tmux 3.5a 实测返回 `@1\|duplicate\|0`），随后真正的 `link-window` 才失败。**已知遗留，明确 scope-out，建议另开单**（见 plan §2a） |

`:6619` 的写法方向是对的，但判据选错了字段：

```bash
observed=$(tmux display-message -p -t "=${source_session}:${window_id}" \
  '#{window_name}|#{pane_dead}' 2>/dev/null) || return 1
IFS='|' read -r source_name source_dead <<< "$observed"
[[ "$source_name" == "$window_name" && "$source_dead" == "0" ]] || return 1
```

它比裸读 `pane_dead` 强（多数情况下名字对不上就会拒绝），但**名字不是唯一身份**——同名 race 下仍会被回退骗过。**本单的修法用 `window_id` 作判据，比它更强**；`:6619` / `:3720` 自己的同名 race 是已知遗留，明确 scope-out。

---

## 3. 方案对比

### 方案 A（推荐）：让存活探针自证目标身份

把 `window_source_pane_alive` 改成读回 `#{window_id}|#{pane_dead}` 并断言返回的 id 等于请求的 id，不等则判死。**判据刻意选 `window_id`——它是这里唯一的身份**，比 builder（`:6619`）那种基于名字的谓词更强：名字会被同名活窗骗过，id 不会。

- **只减不加**：不加开关（founder 已明确本单不加 flag）、不加限流器、不加计数器、不加状态文件、不加配置项、不加新函数。改动是**在既有探针里去掉一个错误的信任**，净效果是少做无用功。
- **general**：修的是探针本身，对所有调用方一视同仁；不为 Lead 或 Runner 特判，不依赖窗名形态，不依赖事件种类。
- **修根**：任何未来的"窗快速生灭"风暴都不会再淹没 watcher，不只是这一次；同时补上 FLY-867 在"窗已消失"这一类下的漏网。
- **自带存量清理**：上线后现存积压会被逐条快速判死跳过（每条一次 tmux 查询，不再有 cmux 建 workspace 的秒级开销），不需要单独的"清队列"手术。
- **失败方向正确**：探针读不出结果（tmux 报错/超时）时仍按现有约定判死。这对 create 路径是安全方向——漏建一次由 60s 的 `sync_additive` 补上；反过来"读不出就当活着"正是今天这个 bug 的形状。

代价：每条 create 事件的探针多读一个字段，无额外调用。

**为什么不用"批次快照"**：早期草案打算在 `_drain_file` 入口取一次全量窗口快照来批量判定（依据是 `drain_events` 用 `mv` 原子冻结了批次，所以批次里任何仍活着的窗必然在快照里，不存在假阴性）。这个论证成立，但方案 A 落地后它是多余的——探针一旦自证目标，逐条判定就已经正确且够快。**不做它，因为它是"加"（新增快照状态与其生命周期），而方案 A 是"减"。**

### 方案 B（否决）：让 v2 Lead 绕过 drain 走独立快路径

给 Lead 建一条不经事件队列的通道。

否决理由：**加逻辑**（新增一条与现有路径并行的分支，两条路径的一致性要另外保证）；而且**不解决饥饿本身**——Runner 的 workspace 仍然会被同一个积压堵住，只是把问题从 Lead 挪到 Runner。

### 方案 C（否决）：对 create 事件按窗名去重/合并

否决理由：**加机制**；且救不了这个场景——3231 条事件对应 1611 个**互不相同**的窗名（每轮 create-kill 的 nonce 都不同），去重压缩比接近 1。

### 方案 D（否决）：什么都不做，等积压排空

否决理由：不解决复发；且 founder 明确要求"重启后仍能看到，不是只在修完那一刻能看到"。

### 方案 E（不在本单）：把 `reconcile_v2_lead_workspaces` 提到每 tick 跑

这是"加频率"，且在 drain 仍会阻塞整批的前提下无效（15s 的 tick 根本轮不到）。方案 A 落地后，60s 的 `sync_additive` 已满足"5 分钟内可见"的验收要求，无需改动。

---

## 5. issue 里两个附带项的处置

| 项 | 处置 |
|---|---|
| `workspace:404` 裸命令名 | **同源，不单独修**。workspace 建出来后要经一次改名才成人读标题，改名依赖受理凭据；受理链断时停在裸命令名。调度修好后自然消失，真机验收时一并核对。 |
| v1 期的 create-kill 循环（FLY-1659 受理链失败） | **不在本单修**。v1 承载器已随 v2 全舰切换退役，病灶链已被整体替换；按 Tadashi 裁定记档，留给 FLY-1663 Phase 4 清理 v1 时一并删除。本单只承担它留下的后果（事件积压）。 |
| 全舰 dev-channels 确认框卡死（P0） | **不在本单修**，已单独上报 Tadashi 由他/founder 处置。根因在 `claude-lead.sh`（轮询器启动点 `:4525` 排在 v2 分支的 `wait` `:2888-2894` 之后），与 cmux 无关。 |

---

## 6. 验收判据（真机，不接受只有单测）

硬性三条，缺一不可：

1. **可见性**：`cmux list-workspaces` 能列出全部 14 个生产 Lead（13 个 v2 Claude 形态 + 1 个 Codex 形态 Mufasa），标题是人读的 Lead 名而非裸命令。
2. **重启后仍可见**：经一次真实重启后，5 分钟内自动恢复到第 1 条的状态——证明是稳定态而非一次性修复。
3. **抗风暴**：人为制造一批"窗已死但事件还在"的积压，watcher 在一个 drain 周期内跳过它们，且同一周期内 `sync_additive` 正常执行（即 Lead 建立不被拖延）。

配套单测（TDD，先红后绿）：
- **回归红测**：目标窗不存在、而 session 当前窗活着 → 修前判"活"（复现 bug），修后判"死"
- 真活窗 → 仍判活，建 workspace 路径行为不变（防止误伤）
- 窗还在但 pane 是尸体（`pane_dead=1`）→ 仍判死（FLY-867 原有保护不回退）
- 探针读不出结果 → 判死（失败方向不变）

---

## 7. 我没有验的 / 风险

- **积压排空后是否真会自动出现**：只做了 dry-run 推断（所有闸放行、会发出正确指令），未等到真实排空验证。真机验收的第 1 条会覆盖这一点。
- **Mufasa（Codex 形态）的显示路径**与 Claude Lead 不同（`codex-tui-cmux`），本次未验；验收第 1 条要求它也在列，如果它有独立缺陷，需要另开单而不是塞进本单。
- **`.processing` 那 525 KB 残留批次**的确切成因（崩溃残留 vs latch 中断保留）未追到写入时刻。方案 A 对两种成因都有效（逐条自证的探针会把两种来源的陈旧事件一律判死跳过），所以不阻塞本单，但值得记一笔。
