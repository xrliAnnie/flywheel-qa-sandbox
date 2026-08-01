# FLY-1578 Lead cmux 会话被 group 在一起 — 调研

Issue: FLY-1578 (https://linear.app/geoforge3d/issue/FLY-1578/运维修复-14-个-lead-的-cmux-会话被-group-在一起-每个-lead-看到的是别人的窗口)
日期: 2026-07-31
基于: exploration.md

---

## 1. 调研目标

exploration 已定位根因（授权收据死锁）。本文回答实现前必须先钉死的四个问题：

1. 现成机器有哪些？哪些能直接复用、哪些必须新写？
2. 「收编（adopt）」在哪个接缝插入最小、最安全？
3. 「验 pane 实际进程」具体验什么？tmux 能给出的判别式是什么？
4. 回归测试挂在哪套 harness 上？

---

## 2. 现有机器盘点（`scripts/flywheel-cmux-sync.sh`，6776 行）

| 能力 | 函数 | 行 | 状态 |
|---|---|---|---|
| 隔离视图构造（私名 staging → 原子改名） | `create_or_replace_view_session` | 4626 | ✅ 已有且生产跑通 |
| 拆除视图（关 cmux 标签 + 拆 tmux 壳） | `dismantle_view_display` | 4513 | ✅ 已有 |
| 拓扑不变量巡检 + 修复 | `repair_view_invariants` | ~5190 | ⚠️ 检测对，修复卡死 |
| 视图拓扑断言 | `_linked_view_matches` | 3417 | ⚠️ 只验拓扑，不验 pane 进程 |
| 会话快照（sid/grouped/active/owner/marker/members） | `_view_session_snapshot` | 3286 | ✅ 已有 |
| 账本读 | `ledger_committed_ref` / `ledger_refs_for_title` | 3816 / 3824 | ✅ 已有 |
| 账本写（lease 保护的事务） | `_ledger_upsert` / `_ledger_remove` | 3796 / 3809 | ✅ 已有 |
| 受管窗口清单（源会话枚举） | `get_tmux_agent_windows` | 506 | ✅ 已有（扫 `flywheel` / `runner-*` / `v2-*`） |
| cmux 清单（只读，rc 严格区分） | `get_cmux_workspaces_json` | 1042 | ✅ 已有，失败返非零而非空 |
| 告警 | `_alert_cmux_cleanup` | 143 | ✅ 已有（投递链归 FLY-1577） |

**结论：拆除、重建、账本事务、清单读取、告警全是现成的。缺的只有一块 —— 一条能给遗留 view 合法自证权威的通道。** 这决定了改动量应该很小。

---

## 3. 接缝定位：改动落在哪一块

`repair_view_invariants()` 里的这一段是唯一需要动的判定：

```bash
if [[ "$grouped" == "1" && -z "$owner" && -z "$marker" ]]; then
  current_refs=$(ledger_refs_for_title "$cmux_generation" "$title")
  if [[ -z "$current_refs" ]]; then
    _alert_cmux_cleanup "cmux legacy grouped migration refused" ...
    continue                       # ← 在这里插入「先试着收编」
  fi
fi
```

改成：**没有收据 → 先尝试收编 → 收编成功就继续走原有的 dismantle/rebuild；收编不成立 → 保持原来的拒绝 + 告警。**

这样做的三个好处：

1. 原来的 fail-closed 语义**一个字不改** —— 收编不成立时行为逐字等同于今天；
2. dismantle / rebuild / 账本事务全部复用，无新拓扑代码；
3. 收编是**常驻能力**而不是一次性迁移脚本 —— 这一点是硬要求，见 §6.1。

---

## 4. 收编的取证条件（为什么这不是「发明权威」）

原 refusal 保护的风险是：*把不属于 Flywheel 的 cmux 标签页（founder 手建的、pre-upgrade 撞名的）当成自己的给拆了。*

收编要求下面四条**同时**成立，任一条不成立即退回拒绝：

| # | 条件 | 取证来源 | 今天生产实测 |
|---|---|---|---|
| C1 | title `T` 是受管源会话里一个**活窗口**的名字 | `get_tmux_agent_windows`（已在 repair 的 plan 输入里） | 14/14 命中 |
| C2 | `cmux-T` 存在、`grouped=1`、`owner` 空、`marker` 空 | `_view_session_snapshot`（已算好） | 13 个命中，belle 不命中（已隔离） |
| C3 | cmux 清单**读取成功**（rc=0），且带 title `T` 的 workspace **恰好 1 个** | `get_cmux_workspaces_json` + 同 `dismantle_view_display` 的 title 匹配（含 `env -u TMUX tmux attach -t '=cmux-T'` 原始形态） | 14 个 title 全部 count==1，零歧义 |
| C4 | 该 view 的窗口集合 ⊆ 源会话窗口集合（即它确实是这个源的 group 视图） | 快照的 `members` vs 源会话窗口列表 | 命中（members 恰是 `flywheel` 的 14 个窗口） |

**C1+C2+C4 证明 tmux 侧这个壳是 Flywheel 管的**（一个非受管的 founder 会话不会既叫 `cmux-<受管窗口名>` 又和受管源会话同组）。
**C3 证明 cmux 侧那个标签页唯一、无歧义**，因此「关掉它」不可能误伤别人。

这组证据 **不弱于** create 时写下的那张收据 —— create 时的收据本质也只是「我刚建的这个 ref 对应这个 title」。所以这是取证方式的替换，不是安全等级的降级。

歧义分支（C3 失败：≥2 个同 title / JSON 读不到）**逐字保留现有的 refuse + `_alert_cmux_cleanup`**。

### 4.1 账本写法

收编成功后：

```bash
_ledger_upsert committed "$cmux_generation" "$adopted_ref" "$title"
```

`_ledger_upsert` 已经带：mutator lease 断言、inner lock、同代次同 title 唯一性冲突检查（FLY-1446 E1，在同一事务内判重，避免 TOCTOU）。**不需要新的并发原语。**

### 4.2 收编失败必须回滚

若收编写了收据、但随后的 `dismantle → rebuild` 没能把拓扑收敛到隔离态，必须 `_ledger_remove` 掉这张收据 —— 否则留下一张「说自己拥有、实际没管住」的假收据，比没有更糟（下一轮会基于假收据直接拆）。

---

## 5. 「验 pane 实际进程」怎么验

### 5.1 现状的漏检面

`_linked_view_matches` 断言：`grouped==0 && active==wid && owner==源 && marker==0 && members==wid`，外加可选的 `window_name` + `pane_dead`。

**全是拓扑与命名，没有一条看 pane 里跑的是什么。** Cass 那次「16 个窗口全回来了 —— 窗口数对、内容全错」就是这个家族：她的检查器比的是 tmux↔cmux **数量**，数量恰好齐。

### 5.2 tmux 能给的判别式

```bash
tmux display-message -p -t "=<session>:<@wid>" '#{pane_pid}|#{pane_current_command}|#{pane_dead}'
```

关键性质：**grouped 会话共享的是同一批 window/pane 对象**，所以 `pane_pid` 在 grouped 视图里和源是相等的 —— **pid 相等无法单独区分 grouped 与隔离**。

⇒ 判别式必须是合取：

| 断言 | 抓什么 |
|---|---|
| `members == {wid}`（唯一窗口） | 抓 grouped 串台（本 issue 的症状） |
| `pane_pid(view:active) == pane_pid(源:wid)` | 抓「壳对了但指到别的 pane / 重建时接错」 |
| `pane_dead == 0` | 抓死 pane（FLY-177 处理过的家族） |
| `pane_current_command` 不是裸 shell（`zsh`/`bash`/`sh`） | 抓「标签页活着、里面是空 shell」 |

前三条足以覆盖本 issue 的验收；第四条是 Cass 那条教训的直接落地 —— **让「内容对不对」变成机器断言，而不是靠人记得去看。**

### 5.3 写进哪里

- `_linked_view_matches` 增加 pane 断言 → 让 create 的 ready gate 和 repair 的健康判定同时受益；
- 巡检侧：健康判定不得只由数量得出。这条要有一个**测试**去锁 —— 光写注释锁不住。

---

## 6. 关键约束与坑

### 6.1 代次会翻盘 —— 收编必须常驻

`cmux_socket_identity()` = `stat -f '%d:%i:%B' <socket>`（设备号:inode:创建时间）。**cmux app 一重启就换代次，全部旧收据一次性失效。**

⇒ 如果只写一个「一次性迁移脚本」把现有 13 个救回来，下次 cmux 重启后同一个死锁**原样重新武装**。收编必须是巡检里的常驻分支。

（生产实证：账本里 21 行全部属于同一个当前代次，历史代次的行已被清掉；`workspace:173/175` 两条 `prepared` 僵尸行指向早已消失的 ref，每 tick 刷 `prepared ledger ref absent ... preserving`。）

### 6.2 收敛需要 ≥2 个 tick，且标签页会闪

`repair_view_invariants` 里 `dismantle_view_display` 关掉 cmux 标签页并拆 tmux 壳，`create_or_replace_view_session` 只重建 **tmux** 侧；cmux 标签页要等下一个 tick 的 `create_workspace_for_window` 才建回来（那时会正常写收据）。

⇒ 13 个一起修 = 侧边栏一次性抖动。**建议限速**（每 tick 至多 N 个，N=2~3），代价是收敛慢几个 tick，换 founder 可见面的稳定。tick 间隔约 25s，13 个 / 3 ≈ 5 轮 ≈ 2 分钟，可接受。

### 6.3 双重确认已经存在，别重复造

`view_mismatch_confirmed` 要求 mismatch 连续两次一致才动手（防抖）。日志里能看到 `Invariant mismatch pending second conclusive pass:` —— 收编路径要走在这个确认**之后**，不要绕过它。

### 6.4 mutator lease 是全局单写者

`_ledger_upsert` 前置 `assert_or_reuse_owned_lease`。巡检本身已持有 lease，收编在同一进程内，无需额外获取。但**一次性手工脚本**若在 watcher 运行时写账本会被 lease 拒掉 —— 这是又一条「不要写一次性迁移脚本」的理由。

### 6.5 环境变量 `FLYWHEEL_CMUX_LINKED_VIEW=0`

`~/.flywheel/.env:136`。今天被 `strict_view_enabled() = LINKED_VIEW || VIEW_INVARIANT` 的或关系兜住（FLY-1364 R6 就是为堵 A0B1 加的），**实际未生效**；`~/.flywheel/state/cmux-flag-state` 记着 `A0B1|1`，说明代码自己已经把这个组合判为 split-brain 并告警过。

删除它 → 默认 1 → A1B1 → **与今天实际行为逐字一致**，是行为中性的运维改动。不删则留着一根「未来某天把生产打回 grouped 默认」的拉杆。

---

## 7. 测试面

| 层 | 位置 | 内容 |
|---|---|---|
| 单元 / 桩 tmux | `scripts/test-cmux-sync.sh`（已有 7000+ 行 harness，含 tmux 调用日志 `TOPO_JOURNAL` 断言） | 收编判定的真值表：C1–C4 各自失败时**必须**退回拒绝且**零 tmux 变更**（journal 为空）；四条同时成立时才写收据 |
| 真 tmux 集成 | `scripts/test-cmux-sync.sh` 的 real-tmux 段（已有 `tmux new-session -d -t ... -s cmux-...` 造 grouped 夹具的先例，见 5160 / 5667 / 6436 行） | 造一个真 grouped view → 跑巡检 → 断言收敛为 `grouped=0, members=={wid}` |
| 事故重放 | `engineering/doc/FLY-1272-cmux-tab-pane-mismatch/qa/qa-fly1272-incident-replay.sh` 已有**正是本 issue 拓扑**的 CONTROL 夹具（`new-session -t <source>` 造 legacy grouped） | 直接复用其造夹具手法 |
| pane 进程断言 | 同上 | 夹具里让 view 指向别的窗口 / 裸 zsh → 断言检查器报警；**只比数量的断言必须测出「假绿」** |
| 违反注入（验收 #4） | 新增 | 手工 `tmux new-session -t <源> -s cmux-<title>` → 断言产出一条告警 |

**空过绿风险提示**：real-tmux 段在沙箱里会 skip（harness 里已有 `tmux new-session failed (sandbox) — skipping` 分支）。收编的核心断言**不能只放在会被 skip 的段里**，否则 CI 常绿但什么都没测。

---

## 8. 与 FLY-1577 的耦合（只有一处，且不阻塞）

本单产出的告警走 `_alert_cmux_cleanup` → 落 alert queue；**送不送得到人眼前是 FLY-1577 的范围**（`meta-alert.sh` / `lib/bounded-run.sh` 补进 `converge-flywheel-bin.sh` 的 `FILES`）。

⇒ 本单验收只能验「告警被产出」（queue 里有条目 / 日志有行），**不能**验「Annie 收到了」。两单改不同文件，无依赖，可并行。

---

## 9. 尚未取证的部分（诚实标注）

- **7/31 00:55 那 12 个 grouped 会话由哪个进程创建，未能取证。** 覆盖该时间窗的 watcher 日志已在 FLY-1577 处置时被清空（22MB），`/tmp/flywheel-cmux-sync.log` 无时间戳。
- 我能证明的是：**当前**创建路径产出隔离视图（belle-lead 对照组 + 机制），以及**当前**修复路径永久拒绝收敛（13/13 每 tick 复现）。
- 修复设计因此刻意做成**对创建者不可知**：不论未来什么路径又造出 grouped view，检查器抓得到、repair 收敛得了。这比追凶更耐用，也是本单验收 #4（手工制造违反 → 检查器抓到）要锁住的性质。
