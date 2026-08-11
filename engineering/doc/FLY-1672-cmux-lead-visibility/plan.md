# FLY-1672 cmux 看不到任何 Lead — 实施计划

Issue: FLY-1672 (https://linear.app/geoforge3d/issue/FLY-1672/bug-统一重启后-cmux-看不到任何-lead14-个全不可见-疑-per-lead-私有-tmux-server-形态与-cmux)
日期: 2026-08-10
基于: research.md

---

## 1. 一句话

把 `flywheel-cmux-sync.sh` 里那个"问窗死活却不核对答的是不是这个窗"的探针改成用 **window id** 自证目标身份，同时修掉替它圆谎的测试替身。

---

## 2. 交付边界

**做**：一个探针函数的自证改造 + 测试替身的行为矫正 + 红绿测试 + 真 tmux 集成回归。

**不做**（各有归属，不塞进本单）：

| 项 | 归属 |
|---|---|
| 全舰 dev-channels 确认框卡死（P0，Discord 实际下线） | 已上报 Tadashi，由他/founder 处置；根因在 `claude-lead.sh`，与 cmux 无关 |
| v1 期的 create-kill 循环（FLY-1659 受理链失败） | v1 承载器已随 v2 全舰切换退役；按 Tadashi 裁定记档，留给 FLY-1663 Phase 4 清理 v1 时一并删 |
| `workspace:404` 裸命令名 | 同源，本单修好后自然消失，验收时核对，不单独改代码 |
| 把 `reconcile_v2_lead_workspaces` 提到每 tick | 不需要（60s 已满足 5 分钟验收），且是"加频率" |
| **linked-view builder (`:6619`) 与 `_tmux_view_build_guard` (`:3720-3724`) 的同名 race** | **明确 scope-out，建议另开单**（后果非轻，见 §2a） |
| `select_live_view_window` (`:3298`) / legacy `refresh_linked_sessions` (`:7301`) 的同类 race | 记档不修：它们的 id 来自紧邻的快照，窗在"列举→探测"之间消失才会触发同一回退，后果只是一次 best-effort select 落空、下一轮重试，**没有**本单这种昂贵 create / 授权后果。若要彻底消除，应在后续单里把它们也改走本 helper |

**不加 feature flag**（founder 明确裁定：本单直接开）。回滚手段 = `git revert`。

### 2a. 一个必须说清楚的边界：`:6619` 不是"身份自证"，只是"名字自证"

早期草案把 linked-view builder 的探针（`:6619`）当作"代码库里已有的正确范式"。**这个说法不准确，特此更正。**它读的是 `#{window_name}|#{pane_dead}`——**名字不是唯一身份**。在隔离 tmux 3.5a 上实测：目标 `@0` 消失、而当前窗 `@1` **恰好同名且活着**时，探针返回 `@1|duplicate|0`，名字和死活**两项都通过**，随后真正的 `link-window -s '=source:@0'` 才失败。`_tmux_view_build_guard`（`:3720-3724`）是同一形状。

后果不轻。真实调用链是 `refresh_linked_sessions()`（`:7285`）→ `repair_view_invariants()`（`:7124` 起）→ `dismantle_view_display()`（`:7211`）→ `create_or_replace_view_session()`（`:7212`）：builder 是在**拆掉旧显示之后**才被调用的——也就是旧显示已经没了、builder 已写 WAL / 建了 staging 状态，才在真正的 `link-window` 上失败。（`reconcile_existing_workspaces()` 从 `:7310` 起，它**不**调用 builder；本文档早期版本把这条链归错了函数，已核实更正。）

**本单的判断是 scope-out，理由三条**：

1. 事故链是 stale-create，其权威闸是 `window_source_pane_alive`，修它就修完了这次事故
2. 同名 race 需要"目标消失 + 当前窗同名 + 当前窗活着"三重巧合，触发面远小于本次事故
3. 把三个探针一起改会让本单从"一行修复"变成"探针族重构"，blast radius 与 founder 的只减不加原则冲突

**因此本单的声明必须收窄为**：这一处修复对**本次 stale-create 事故**是充分的；它**不**声称修完了整个"探针不自证身份"缺陷类。builder 与 guard 的同名 race 建议另开单，修法是把它们的探针也升到 `#{window_id}|#{window_name}|#{pane_dead}` 三项全等，并补一条"目标 id 缺失 + 同名活窗"的回归，且必须**走到 `repair_view_invariants()` 里那条确认 mismatch 后的修复分支**（即真正到达 `:7211-7212`），否则测不到这个 fallback。

---

## 3. 改动清单

### 3.1 产品代码：`scripts/flywheel-cmux-sync.sh`

唯一一处函数体改造（`:2229-2233`）。当前：

```bash
window_source_pane_alive() {
  local sess="$1" wid="$2" dead
  dead=$(tmux display-message -p -t "=${sess}:${wid}" "#{pane_dead}" 2>/dev/null || echo "1")
  [[ "$dead" == "0" ]]
}
```

改为（用 window id 作身份判据）：

```bash
window_source_pane_alive() {
  # tmux 3.5a silently FALLS BACK to the session's current window when the
  # target window id no longer exists — it does not error. Reading pane_dead
  # alone therefore reports a long-gone window as alive (whatever the current
  # window happens to be). The probe must prove the answer describes the
  # window we asked about. window_id is the only unique identity here: the
  # linked-view builder's name-based check can still be satisfied by a
  # same-named sibling under the same fallback (see FLY-1672 follow-up).
  local sess="$1" wid="$2" observed observed_id dead
  observed=$(tmux display-message -p -t "=${sess}:${wid}" \
    '#{window_id}|#{pane_dead}' 2>/dev/null) || return 1
  IFS='|' read -r observed_id dead <<< "$observed"
  [[ "$observed_id" == "$wid" && "$dead" == "0" ]]
}
```

要点：
- 目标不存在 → tmux 回退到别的窗 → `observed_id != wid` → 判死。**这是本单修的那一件事。**
- 目标存在但 pane 是尸体 → `dead=1` → 判死。FLY-867 原有保护逐字保留。
- 探针读不出结果 → `return 1` 判死。失败方向与原实现一致（原来靠 `|| echo "1"`）。
- 函数签名与返回值语义不变，**两个调用点都不改一个字**。

### 3.1a 两个调用方的影响面（各自论证，不能只看 create 路径）

早期草案写"唯一调用方"，**这是事实错误**。实际有两个：

| 调用点 | 改严之后的行为 | 是否安全 |
|---|---|---|
| `create_workspace_for_window` (`:6766`) | 判死 → `return 0` 跳过建 workspace | **安全且正是目的**。漏建由后续事件/`sync_additive` 补上 |
| `title_source_authorized` (`:5355`) | 判死 → `return 1` 不授权 | **安全**：不授权 = 保留候选、不铸凭据、不改名、不去重，**零 mutation**。经 `reconcile_workspace_titles` 下一轮重试 |

两者的失败方向都是"少做"，没有一条会因为改严而产生破坏性动作。

**`title_source_authorized` 的回归必须打到会 mutation 的外层**：这个谓词函数自己既不写 ledger 也不调 cmux，所以"调用它、看它拒绝、断言零 mutation"是**空过断言**（它天然零 mutation，修不修都绿）。正确做法是写成 `reconcile_workspace_titles()` 层的回归，fixture 要摆出真正危险的拓扑：

- 源行指向一个**已消失**的 window id
- 源 session 的**当前窗是另一个活 pane**（这样旧代码的探针会回退并误判为活）
- Flywheel 自有的 view **仍持有那个已消失的源 id**
- 存在一个可被收编的 raw/named stock 候选

在矫正后的 mock + **未修**的产品代码下，回退必须真的走到授权/改名这条会 mutation 的路径（**红**）；修复后，reconcile 必须保留候选、ledger **逐字不变**、**零** cmux 操作（**绿**）。只有这样才同时证明了第二个调用方的行为与它声称的影响面。

### 3.2 测试替身矫正：`scripts/test-cmux-sync.sh`（**两个** mock，不是一个）

harness 有两套 tmux 替身，**两套都把"目标查不到"建模成失败/判死，与真 tmux 相反**：

| 位置 | 现状 | 矫正 |
|---|---|---|
| legacy `tmux()` (`:473-501`) | `END { if (!found) print "1" }` | 查不到目标 id 时，返回该 session **当前窗**的 `window_id|pane_dead`（约定：mock 窗列表中该 session 的第一行为当前窗，并在注释里写明这条约定） |
| topology mode (`:288-305`) | `topo_window_row … \|\| return 1` | 查不到目标窗时，回退到该 session 的 **active 行**（topology 表里已有 active 标记，直接复用） |

两套都要支持返回 `#{window_id}|#{pane_dead}` 组合格式，并各自补一条"目标缺失 + 当前窗活着"的回归。只改 legacy 一套会在 title/receipt 相关用例里留下同样的盲区。

**关于 FLY-867 的准确表述**（早期草案在这里归因错了，特此更正）：FLY-867 的两个 Fix B 用例（`:5208-5237`）用的是**存在的** window id（`@749` / `@7` / `@9`）配显式 `pane_dead` 值，它们绿是因为**只覆盖了"窗还在、pane 是尸体"这一类，从未测过"窗已消失"**。mock 的缺失分支并不是那两个用例变绿的原因——但**它会让任何人后来补的"窗已消失"用例假绿**。准确说法是：*FLY-867 漏了一整类场景，而两套 mock 会掩盖这个遗漏。*

矫正后复跑既有 cmux 套件：**期望值该改的改（它们原本断言的是错误行为），断言逻辑不许放宽**。任何因此变红的用例都要在 PR 里逐条说明是"修正了错误期望"还是"暴露了新缺陷"。

### 3.3 新增测试

**A. 单测（`scripts/test-cmux-sync.sh`），先红后绿**

| 用例 | 断言 |
|---|---|
| 回归红测（legacy mock）：目标 wid 不存在、session 当前窗活着 | 修前判"活"（复现 bug），修后判"死" |
| 回归红测（topology mock）：同上 | 同上 |
| **`reconcile_workspace_titles` 回归**（见下，不能只测谓词） | 修前走到授权/改名路径（红）；修后保留候选、ledger 逐字不变、零 cmux 操作（绿） |
| `drain_events` 混合批次（见下） | 见下 |
| 防误伤：真活窗 | 仍判活，`create_workspace_for_window` 行为逐字不变 |
| FLY-867 不回退：窗在但 `pane_dead=1` | 仍判死 |
| 失败方向：探针读不出结果 | 判死 |

**drain 混合批次用例**（防止空过——"零 new-workspace"可能因为 JSON 不可用、workspace 已存在、事件被过滤、watcher 无授权而假绿）：显式置好健康前置（cmux JSON 可用且为空、watcher 授权有效），投入 **N 条指向已消失窗的 create 行 + 1 条指向真活窗的对照行**，断言：

- 对活窗 id **恰好 1 次** `new-workspace`
- 对每个死窗 id **0 次**
- `.processing` 批次被完整消费掉
- **additive 确实跑过**的证据必须是**既有副作用**，不能是日志锚点——`sync_additive()` 与健康路径的 `reconcile_v2_lead_workspaces()` **都不打日志**，为测试新增心跳日志属于"加逻辑"，本单不做。做法见下方"additive 见证窗"，并**必须**附带"该标题没有走过事件路径"的断言

**B. 真 tmux 集成回归 —— 并入既有 real-tmux 块（`scripts/test-cmux-sync.sh:1584` 起），不新建文件**

三个理由：那个块**已经拥有私有 socket**（`TMUX_INT_SOCKET`）和保证性的 `kill-server` teardown；`test-cmux-sync.sh` **已经在 CI 里**（`.github/workflows/ci.yml:183`）；新建文件不会被 CI 自动发现，得再改 CI 清单——属于"加"。

**关键：必须让被测的产品函数真的打到那个私有 socket。**产品代码调的是裸 `tmux`，光用 `command tmux -S "$SOCK"` 建 server **不会**改变它的去向——那样测试会打到**生产 tmux**。做法是在 subshell 里覆盖 `tmux()`：

```bash
(
  tmux() { command tmux -S "$TMUX_INT_SOCKET" -N "$@"; }
  # 在此 subshell 内调用 window_source_pane_alive 做断言
)
```

步骤：建 session + 两个窗 → 记 id → 杀其中一个 → 断言已杀窗判**死**、存活窗判**活**。

**版本自适应的尺子校准**（早期草案在这里自相矛盾：一边要求裸命令必须返回 rc=0，一边又说报错的 tmux 版本也该通过——两者不能同时是无条件断言）。改为分支断言：

- 若裸 `display-message -t '=<sess>:@<已杀id>'` **回退**（rc=0）：断言返回的 `window_id` **不等于**请求的 id，并断言产品探针拒绝它 → 证明这条测试量的是真东西
- 若裸命令**报错**：接受该行为，仍断言产品探针拒绝该目标
- 两个分支下，**存活窗都必须判活**

这样在任何 tmux 版本上都是有意义的断言，不会空过也不会误红。

---

## 4. 实施顺序（TDD）

1. **先矫正 mock**（3.2），复跑既有套件，记录变红的用例并逐条判定
2. **写红测**（3.3-A 回归用例），确认它在未修产品代码时**真的红**
3. **写真 tmux 集成测试**（3.3-B），确认尺子校准分支在本机成立（本机 3.5a 应走「回退」分支）
4. **改产品代码**（3.1），跑到全绿
5. 全仓门：`pnpm lint` + `pnpm -r build` + `bash scripts/test-cmux-sync.sh` + 新增 shell 测试
6. Codex code review，循环到 APPROVED
7. PR（CLAUDE.md 里程碑 + 文档归档放最后一个 commit）

**不在生产机跑全量 vitest**（会把负载顶到压垮 Bridge）；只跑定向 shell 套件。

---

## 5. 验收（真机，不接受只有单测）

由独立 QA 节点执行，三条硬门缺一不可：

1. **可见性**：`cmux list-workspaces` 列出全部 14 个生产 Lead（13 个 v2 Claude 形态 + Mufasa 的 Codex 形态），标题是人读的 Lead 名而非裸命令串。
2. **重启后仍可见**：经一次真实重启（走 `restart-services.sh`，不手工 kickstart）后，**5 分钟内**自动恢复到第 1 条状态——证明是稳定态而非一次性修复。
3. **抗风暴**（参数必须写死，"一批"不能等于 1 条）：在一个**有界的合成 session** 里造 **≥200 条**指向已消失窗的 create 事件 + **1 条真活窗对照行**，断言：
   - watcher 在**一个 drain 周期内**排空这批（实测耗时**低于 additive 的 60s 周期**，即不再出现"排空要几十分钟"的形态）
   - 日志中**没有**任何死窗的 `Creating workspace for` 行
   - 对照行的活窗**正常建出 workspace**（没有这条对照，"全都跳过"也会看起来像通过）
   - **additive 确实解除了饥饿**——用"additive 见证窗"作证据（构造见下），不用日志

**additive 见证窗的正确构造**（早期草案在这里会空过）：只是"不手动投 create 事件"**挡不住**它出现在事件路径上——`register_session_hooks()` 装的 `after-new-window[500]` 钩子（`:7417-7419`）会给受监视 `runner-*` session 里**后续每一个**新窗自动追加一条 create 行。那样见证窗可能经 `drain_events` 建出来，**假证** additive。

正确做法：让见证窗成为**新建 session 时的第一个窗**（`new-session -n <唯一名>`），此刻该 session 的 per-session 钩子**还不存在**，不会产生 create 行。全局 `session-created` 行只会去注册钩子并跑 `self_heal_sweep_session()`，那条路径**不建**缺失的 workspace。

在符合条件的那一跳之前，必须先断言两件事：

- 见证窗的 workspace **尚不存在**
- `$EVENT_FILE` 与 `.processing` 里**都没有**该见证窗 id/标题的 create 行（**只读断言**——绝不为了满足它去改写共享的生产队列）

之后它在 `tick % 4 == 0` 的那一跳首次出现，才是有效的 additive 证据。hermetic 用例里也要镜像这条"该标题从未走过事件路径"的断言。

   两个约束：
   - 合成 session 名必须落在 `drain_events()` / `get_tmux_agent_windows()` 认的过滤器内（`flywheel` 或 `runner-*`），否则整条链根本不会看它——建议 `runner-fly1672-qa-<nonce>`，既满足过滤器又与生产 session 不撞名
   - "有界"包含**收尾**：合成 session、它产生的 workspace / ledger 行、以及带该 nonce 前缀的队列残留，验收后必须全部清掉

   注意 `sync_additive` 只在 `tick % 4 == 0` 的跳上执行，所以"同一周期"要按符合条件的那一跳来判定，不能拿任意一跳说事。

取证纪律：
- 探活一律用 `tmux -S <sock> -N`（`-N` 保证探针不会把 server 点起来）
- 修复前必须留下 before 基线（当前 cmux 侧栏截图 + `cmux list-workspaces` 输出 + watcher 日志片段），**在任何重启之前采**——重启会销毁基线
- 合成事件只投到有界的测试 session，不得污染生产 `flywheel` / `runner-*` session

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| mock 矫正后大批既有用例变红，掩盖真问题 | 逐条判定"修正错误期望" vs "新缺陷"，在 PR 里列表说明，不批量改期望值 |
| 探针改严后误杀真活窗 → workspace 建不出来 | 防误伤用例 + 真 tmux 集成测试的存活分支；且 `observed_id == wid` 对真活窗恒成立（对照组已实测） |
| 积压未排空时验收，误判修复无效 | 验收第 1 条给足观察窗口；日志里确认死窗已被跳过再判定 |
| Mufasa（Codex 形态）有独立显示缺陷 | 验收第 1 条会暴露；若确实独立，**另开单**，不塞进本单 |
| tmux 版本差异（本机 3.5a） | 集成测试用版本自适应的分支断言（§3.3-B）：回退与报错两种行为下都有意义，不会空过也不会误红 |
| `title_source_authorized` 路径改严后 title/receipt 行为退化 | 该路径失败＝零 mutation（保留候选、不铸凭据、不改名去重），由 `reconcile_workspace_titles` 下轮重试；配专门回归用例断言「拒绝授权且零 mutation」 |

---

## 7. 诚实的边界

- 本单**不能**让 Lead 恢复说话。cmux 里看得见 ≠ Discord 能对话；后者取决于 dev-channels 那个 P0 是否被处置。**两件事必须分别验收**，不要拿"侧栏有了"当"全舰恢复了"。
- 本单**不修** v1 期的建窗受理失败，只承担它留下的后果。若 v1 承载器将来被复用，那条链的问题仍在。
- 修复对存量积压的清理是**推断**（探针判死 → 跳过 → 秒级排空），未在真机等到排空验证；验收第 1、3 条覆盖这一点。
