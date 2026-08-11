# FLY-1672 cmux 看不到任何 Lead — 独立 QA 报告

Issue: FLY-1672 (https://linear.app/geoforge3d/issue/FLY-1672/bug-统一重启后-cmux-看不到任何-lead14-个全不可见-疑-per-lead-私有-tmux-server-形态与-cmux)
日期: 2026-08-10
基于: plan.md

---

## 0. 判决

**PASS**（对 PR #800 所改的那一件事）——附三条必须一起读的边界，见 §6。

验证 head：`d0bafb7938677b85d543febd9e89ff4191666643`（PR #800，QA 开始与结束各核一次，全程未动）。

---

## 1. 被测对象的真实体量

生产代码改动 = **整份 diff 只有一个函数体**（`git diff origin/main...HEAD -- scripts/flywheel-cmux-sync.sh` 逐字比对确认，无第二处）：

```
window_source_pane_alive():
  旧: 读 '#{pane_dead}'                 → 只问死活，不问"你答的是哪个窗"
  新: 读 '#{window_id}|#{pane_dead}'    → 断言 observed_id == 请求的 id
```

其余改动是 `scripts/test-cmux-sync.sh`（两套 mock 矫正 + 3 条新用例）、`CLAUDE.md` 一行、文档。**零 TypeScript 改动**。

调用面独立审计（不采信 plan 的自述）：

| 事实 | 我的核验方式 | 结果 |
|---|---|---|
| 该探针只有 2 个调用方 | `grep -n window_source_pane_alive` 全文件 | ✅ 仅 `title_source_authorized:5358` + `create_workspace_for_window:6769` |
| 传进去的第二参一定是 `@id`、不会是窗名 | 审 create 事件产生器（hook `:7422` 写 `create\|#{session_name}\|#{window_id}\|#{window_name}`）+ 全部 6 处 `create_workspace_for_window` 调用点的 `wid` 来源 | ✅ 全部来自 `#{window_id}`；没有任何路径把窗名塞进 id 位（若有，改严后会静默漏建，是真回归） |
| v2 Lead 建 workspace 的路径**不**经过该探针 | 在 `ensure_v2_lead_workspace` / `reconcile_v2_lead_workspaces` 全域搜索 | ✅ 不经过 → 本修复对 v2 Lead workspace 既不帮忙也不伤害（这条对 §6 很关键） |

---

## 2. 病根：在**生产** tmux 上只读复现（最硬的一条）

生产 tmux 3.5a、只读、零改动（`-N` 保证不会把 server 点起来）：

```
wid=@30858  旧格式 rc=0 out='0'          → 旧探针判「活」   ← 这就是 bug
            新格式 rc=0 out='@1362|0'    → 身份不符，新探针判「死」
wid=@30857  同上
wid=@1362   新格式 out='@1362|0'         → 判「活」（真活窗，无误伤）
wid=@25246  新格式 out='@25246|0'        → 判「活」（Mufasa 的真窗，无误伤）
```

`@30858` / `@30857` 是今天 11:57 那批临时窗口，watcher 日志 13:05 记录它们 `exited 893s ago`——早已不存在。tmux 3.5a **静默回退到该 session 的当前窗 `@1362 zsh`**（一个永不退出的 shell），所以旧探针对**每一个**已消失的窗都回答"活着"。研究文档对根因的判断属实。

### 2.1 事故规模也在生产日志里坐实了

`/tmp/flywheel-cmux-watcher.log`（只读）：

- 临时窗 `flywheel-flywheel-eng-lead.p-<nonce>` 由 `packages/teamlead/scripts/claude-lead.sh:2298` 的监护器建出，每个 Lead 每 5–8 秒一个。
- 11:22–12:50 这段窗口内，watcher 为这类**早已消失**的窗真的发起了 **4515 次**建 workspace，峰值 **115 次/分**。
- 单条延迟实测：nonce `1786388230` 的窗生于 **11:57:10**，它的建 workspace 在 **12:50:47** 才被处理 → **积压滞后 53 分 37 秒**。每条最后都以 `WARN: isolated view build deferred` 收场（白干）。
- 这条正是 plan 说的"第 1 步不返回，第 4 步不开始"——`sync_additive`（Lead workspace 的唯一周期入口）被饿死。

**补充说明（写给不熟悉这条链的人）**：旧代码并没有真的建出一堆垃圾 workspace，因为更下游的 linked-view builder 还有一道基于**窗名**的校验会拦下来。旧代码的伤害是**白烧时间**——每条约 1 秒，把队列拖成几十分钟，从而饿死 Lead 那条路。

---

## 3. 修复效果：真 tmux、真产品代码、200 条量级的 A/B

台架（`scratchpad/storm-harness.sh`）：私有 tmux socket 上真建真杀 200 个窗 → 拿它们的真 `@id` 造 200 条 create 事件 + **1 条指向真活窗的对照行** → source **真的产品脚本**（`origin/main` 一份、PR head 一份）→ 调真的 `drain_events`。

> 打了什么桩，明说：**只有 `cmux` 这个 CLI 被换成记录器**（在 founder 的真 cmux 里建 200 个 workspace 是破坏性动作，不能做）。**所有死活判定都由真 tmux 作答**——被测的就是这一层。`tmux` 全程指向私有 socket，生产 tmux/cmux 零触碰。

| 指标 | 改前（origin/main） | 改后（PR #800 head） |
|---|---|---|
| 投入事件 | 201 条（200 死窗 + 1 活窗对照） | 201 条（同一形状） |
| 排空耗时 | **255 秒** | **95 秒** |
| 对死窗记下 `Creating workspace for` | **200 次**（bug 逐条复现） | **0 次** |
| 对活窗对照行 | 1 次 | **1 次**（无误伤） |
| cmux 调用总数 | 404 | 204（省掉 200 次） |
| `.processing` 残留 | 0（批次吃干净） | 0 |

三条结论：① 死窗全部被挡在最上面那道闸，② 活窗行为逐字不变，③ 同一批次快 **2.7 倍**、少 200 次 cmux IPC。

---

## 4. 测试本身可信吗（防空过）

| 检查 | 做法 | 结果 |
|---|---|---|
| 套件在 PR head 是否真绿 | `/bin/bash scripts/test-cmux-sync.sh`（macOS bash 3.2，26 分钟） | **571 passed, 0 failed**（实施者写的是 570，实测 571） |
| 新用例是不是"怎么改都绿" | 把**产品修复单独撤回**（`scripts/` 整目录复制到沙箱，只把那一个函数体换回 origin/main 版本；矫正后的 mock 与新用例逐字保留），整套重跑 | **567 passed, 4 failed** —— 且 4 条**全部**是 FLY-1672 新增的那 4 条，无一条旁落 |
| 相邻套件 | `scripts/__tests__/fly1663-cmux-v2.test.sh` | 10 passed, 0 failed |
| CI（PR head） | `gh pr checks 800` | 9/9 全绿（含 Script Tests 14m46s、Quick Gate build+typecheck+lint） |

红检里逐条变红的内容（改前 → 错误行为被逐字记录下来）：

| 用例 | 撤回修复后的实际输出 | 它证明了什么 |
|---|---|---|
| 真 tmux 集成回归 | `✗ real tmux liveness identity mismatch gone_rc=0 live_rc=0` | 改前的探针在**真** tmux 私有服务器上对已杀窗返回 rc=0（判活） |
| 探针身份契约 | `✗ identity contract observed=[@1\|0] legacy=0 topology=0 live=0 dead=1 unreadable=1` | **两套** mock 的回退模型下都判活（`legacy=0 topology=0`），而"窗在但尸体"和"读不出"两条旧保护仍成立 |
| 混合批次风暴 | `✗ mixed drain stale=8 live=1 witness=1 …` | 8 条死窗行**逐条真的发出了** `new-workspace` |
| 标题授权回归 | `✗ vanished source inherited title authority rc=0 ops=[rename-workspace --workspace workspace:1672 …]` | 第二个调用方（`title_source_authorized`）改前会给已消失的源**真的发出一次 rename 变更** —— 这条打在会 mutation 的外层，不是空过的谓词断言 |

**两次跑的差集恰好是这 4 条**（有修复 571/0，无修复 567/4）——说明 mock 矫正没有顺手放宽别的断言。

---

## 5. issue 原始假说被推翻——独立复核过

issue 主怀疑是"cmux 的 Lead 发现逻辑还在按旧的共享 tmux server 方式找"。我拿**生产的 launchd + manifest 真状态**只读跑了一遍 `derive_lead_roster`：

```
state=ok
15 行：14 行 claude-private（每行都带各自的 per-Lead 私有 socket 路径）+ 1 行 codex-tui-cmux（Mufasa）
```

**发现逻辑完全认识新形态**。这个假说不成立，plan 的重定向是对的。

---

## 6. 诚实边界（三条，必须和 §0 的 PASS 一起读）

### 6.1 本 PR 修不了 founder 抱怨里的"另一半"

生产此刻（积压已自然排空、`sync_additive` 每 60 秒正常在跑、事件队列文件已不存在 = 稳态）：

| 状态 | 数量 | 明细 |
|---|---|---|
| 侧栏有、且是人读的 Lead 名 | 11 / 15 | — |
| 侧栏有、但标题是裸 attach 命令 | 3 / 15 | `flywheel-flywheel-cos-lead`、`flywheel-flywheel-product-lead`、`personal-assistant-belle-lead` |
| 侧栏里根本没有 | 1 / 15 | `growth-mufasa-lead`（codex-tui-cmux 形态） |

生产 watcher 日志此刻**每 60 秒**稳定刷这三行：

```
WARN: v2 Lead workspace reconcile deferred title=flywheel-flywheel-cos-lead
WARN: v2 Lead workspace reconcile deferred title=flywheel-flywheel-product-lead
WARN: v2 Lead workspace reconcile deferred title=personal-assistant-belle-lead
```

这条路径（`ensure_v2_lead_workspace`）**不经过本 PR 改的探针**（§1 已核）→ **本 PR 无法让这 4 个变好，也不会让它们变坏**。

**因此 plan §5 验收第 1 条（"列出全部 14 个生产 Lead，标题是人读的 Lead 名"）不会因为合入本 PR 而达成。** 这不是本 PR 的缺陷，是范围事实；但必须在告诉 founder"修好了"之前说清楚，否则她打开 cmux 会发现还是缺。**建议另开单**承接这 4 个。

### 6.2 plan §2 里有一句话是错的，建议合入前改掉

plan §2 表格写：`workspace:404 裸命令名 | 同源，本单修好后自然消失`。

实测**不成立**：当前 7 个裸命令名的 runner workspace（424/423/442/441/440/439/443），它们的源窗 `tmux list-windows` 显示**全部活着**（`pane_dead=0`）。源窗活着 → 新旧探针给出**完全相同**的答案 → 本修复对这些标题**一个字都不会改**。真正的原因在别处（生产日志同时在刷 `periodic linked-view refresh inconclusive; pass deferred`）。

CLAUDE.md 里实施者后来加的那行（把 display-name 判到另一单）方向是对的，但和 plan §2 自相矛盾；文档会随 PR 合进 main，建议统一口径。

### 6.3 抗风暴那条的数字要按实测说

plan §5 第 3 条要求"实测耗时**低于** additive 的 60s 周期"。本机（load ≈ 10–14）实测 **201 条 = 95 秒**，**没有**低于 60 秒。

但该条的**意图**（不再出现"排空要几十分钟"）是达成的：生产实测的旧形态是**单条滞后 53 分钟**，改后同量级批次 95 秒——差两个数量级。残余下限是每条事件仍要付一次 `workspace_exists_for`（一次 cmux JSON IPC，生产实测 0.21–0.30 秒 + 一次 python3 解析），这一段本 PR 没有也不打算优化。

**建议**：把该条验收改成"批次排空进入秒/分量级、且日志中零死窗 create"，而不是钉死 60 秒——60 秒这个阈值和机器负载强相关，会让一个正确的修复在忙机器上被判红。

### 6.4 只有合入 + 部署后才能验的（留给 post-merge QA）

- 验收第 2 条：走一次真实 `restart-services.sh`，5 分钟内自动恢复。**生产跑的是 main 的代码**（`~/.flywheel/bin/flywheel-cmux-sync` → `~/Dev/flywheel/scripts/flywheel-cmux-sync.sh`，生产仓 HEAD `d32a9919` 不含本修复），所以合入 + `git pull` 前无法验。
- 生产环境下带真 cmux 的排空速率（我的台架把 cmux 换成了记录器）。
- 上游风暴源本身：监护器每 5–8 秒一个临时窗（`claude-lead.sh:2298`），本 PR 只拆掉了 cmux 侧的放大器，没有也不该动上游。风暴若再起，watcher 不会再被饿死，但窗口churn 仍在。

### 6.5 无 Discord 面

本 PR 的 diff 只碰 cmux/tmux workspace 同步与其测试，**不触及 Discord 的发送 / relay / 渲染 / founder 交互 / roundtable / 跨-Lead 协调**任何一条。因此**豁免 529 N-to-N 真机跑**——明说，不是跳过。对应的真机场地换成了真正承载这个功能的那一层：**生产 tmux 只读探测 + 隔离私有 socket 上的 200 条真 tmux E2E**。

---

## 7. 证据清单

全部落在 `engineering/doc/FLY-1672-cmux-lead-visibility/qa-evidence/`（随分支合进 main，不依赖临时目录）：

| 证据 | 文件 |
|---|---|
| 生产 tmux 只读新旧探针 A/B | `probe-ab-production.txt` |
| 生产 cmux 基线 + tmux 版本 | `baseline-cmux.txt` |
| roster 15 行 + roster↔cmux 逐条映射 | `roster.txt`、`roster-vs-cmux.txt` |
| 200 条风暴 A/B 结果 | `storm200-OLD.txt`、`storm200-NEW.txt` |
| 风暴台架本体（可复跑） | `storm-harness.sh` |
| 套件（PR head） | `suite-NEW-summary.txt` → 571 passed / 0 failed |
| 红检（撤回修复后重跑） | `suite-REDCHECK-summary.txt` → 567 passed / 4 failed，4 条逐条列出 |
| founder 一页报告 + 三张图源码 | `../qa-ship-report.html`、`q1/q2/q3-*.mmd` + `.svg` |
| CI | `gh pr checks 800` → 9/9 pass |
