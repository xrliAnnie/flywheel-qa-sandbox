# FLY-1260 Harness 瘦身审计 — 报告素材源 + 冒烟记录

Issue: FLY-1260 (https://linear.app/geoforge3d/issue/FLY-1260/research-harness-实验室-1提示词技能瘦身审计-评测框架无评测数据不动生产提示词)
日期: 2026-07-15
基于: inventory.md、annotation-table.md、eval-framework-proposal.md

本文件 = `report.html` 的**文字素材源**（卡片文案 + 章节内容）+ **发布前冒烟记录**。与 HTML 同步；HTML 改文案必须同步改这里。

## 1. 报告结构（对应 plan §4）

| 章节 | 内容 | 状态 |
|---|---|---|
| 头部 | 铁律声明（无评测数据/审计假设）+ 使用说明（初始全未审、不预选） | ✅ |
| 摘要 | 「三句话」+ S02 注入构成条形图 + 总上下文全貌表（互斥不加总、原始 vs 装配常驻分列） | ✅ |
| 卡片区 | 11 张瘦身候选卡，按审计优先级启发式排序（明标启发式，非收益预估） | ✅ |
| 必须留 | 21 条契约层块 + 逐条一句理由 | ✅ |
| 评测框架 | 12-run 提案摘要 + **范围决策问题**（(a) 保范围 / (b) 纳入角色文件）指向 proposal | ✅ |
| 局限 | 7 条 caveat（含审计深度不齐、层 C 未审、任务集缺格、证据不得混用、链接版本化） | ✅ |
| 汇总条 | 建议改/不动/未审/已留言 + 一键复制导出 | ✅ |

## 2. 卡片清单（11 张，与 HTML 的 CARDS 数组一一对应）

卡片 ID = `层:路径:块锚点`（跨版本稳定，Round N 靠它迁移已选/已评）。

> **R2 变更（Codex code review 后）**：卡片从 11 → **10**——删掉 `founder-only-authority.md:future-autonomy-roadmap`（HIGH-3：该节含现行时态权限守卫，是**权限边界**不是纯未来叙事，移入「必须留」）。字节按精修口径更新。

| # | 卡片 ID | 归类 | 实测字节 | 可动 | 深度 |
|---|---|---|---:|---|---|
| 1 | `C:packages/teamlead/lead-rules-base/department-lead-rules.md:reply-discipline-trio` | 部分砍 | 20,909 | 待定 | 结构 |
| 2 | `B:agents/generic-executor.md:pipeline-stages` | 砍候选 | 1,281 | 1,281 | 逐字 |
| 3 | `B:agents/generic-executor.md:critical-rules` | 部分砍 | 2,062 | ~1,000 | 逐字 |
| 4 | `B:agents/generic-executor.md:skills-you-can-assume` | 砍候选 | 946 | 946 | 逐字 |
| 5 | `B:agents/generic-executor.md:override-c` | 部分砍 | 549 | ~350 | 逐字 |
| 6 | `B:agents/generic-executor.md:when-youre-being-used` | 砍候选 | 716 | 716 | 逐字 |
| 7 | `B:agents/generic-executor.md:superpowers-intro` | 部分砍 | 1,272 | ~600 | 逐字 |
| 8 | `B:agents/generic-executor.md:interaction-principles` | 砍候选 | 515 | 515 | 逐字 |
| 9 | `A:packages/edge-worker/src/Blueprint.ts:base-flow` | 砍候选 | 553 | ~400 | 逐字 |
| 10 | `A:packages/edge-worker/src/Blueprint.ts:pipeline-preamble` | 部分砍 | 1,012 | ~200 | 逐字 |

**排序口径**：审计优先级启发式 = 可动字节 × 常驻权重。**明确标注为启发式**，报告里不称「预估收益/节省」——没有 A/B 数据，砍了省多少、会不会变差，都不知道。

## 3. 核心文案（三句话）

1. **Blueprint 层几乎没有瘦身空间（可动 <4%）。** 去掉角色文件后的 15,764 字节里 75.6% 是 Lead/契约层，按公式本就该留。想在这砍 = 砍安全边界。这条几乎不需要评测：是结构性事实。
2. **真正的体量在角色文件（48.8%）和 lead-rules（dept 常驻 114KB）。** 角色文件约 23% 是纯删候选（其中 ~18% 重复上下文，复述 Blueprint 块 / skill 列表 / CLAUDE.md），加部分压缩可动约 1/3。最值得优先 A/B。
3. **「skills 太大」是错觉。** 178KB 里常驻只有 description 共 5,625 字节（31.6× 差）。砍 body 省不到常驻 token——真问题是 body 的 SOP 形状压不压制判断力，属另一类实验。

## 4. 发布参数（Lead 给定，plan §0）

```
flywheel-comm publish-report --html report.html --project flywheel \
  --channel 1526749610771484712 --title 'Harness 瘦身审计 · 互动版'
```

- `--channel` = 本 issue 的 thread。这是对「Runner 不 publish founder 物料」纪律的**指令性例外**（Annie 直令 + Lead 给定参数）。
- **每轮发布生成新 token URL**，不存在同链接更新。thread 最新一条 = canonical，旧链接留作历史（7 天 retention 自然过期）。
- 跨版本批注不丢：稳定卡片 ID + issue 级 localStorage schema（`FLY-1260:audit:v1`），同 origin 新版页自动导入未变 ID 的已选/已评。

## 5. 发布前冒烟记录（M4 + M5 Codex code review 后 R2/R3 复测）

**Codex code review（R1，xhigh）CHANGES REQUESTED，10 findings（3 HIGH）**，全部核实为真并已修复，R2 复测通过：

| # | 级别 | finding | 修复 | R2 验证 |
|---|---|---|---|---|
| HIGH-1 | 覆盖门 fail-open | 双引号源扫描看不见模板字面量块头 → S02 把 review 两门折进 approve-gate | 注册缺失锚点 + capture-driven fail-closed 第③道门（对真实捕获查孤儿）；加固后又抓出 2 个漏块一并注册 | 脚本 28 锚点全覆盖、0 孤儿；approve-gate 5,349→4,392 |
| HIGH-2 | 导入批注不可编辑 | 卡片先渲染再 `load()`，handler 闭包引用被 load 换掉的旧 state 对象 | load() 挪到渲染前 + handler 改 `get(c.id)` 现取 | **edit-after-import 持久化 PASS**（真机验） |
| HIGH-3 | 权限边界泄进砍候选 | `future-autonomy-roadmap` 含现行时态守卫，误列砍候选 | 移出卡片区 → 「必须留」；修正注入声明（companion 不装） | 卡片 11→10，无 future-autonomy 卡 |
| MED | S06 非生产保真 | auto-QA 用了 15KB generic 角色 | `agentName:"qa"` → shipped qa 6,149 | S06 25,725→16,869 |
| MED | manifest 证据不足 | ctor 只存 keys、缺 env/hash | 全 ctor 值 + inheritedPromptEnv + assetHashes + toolchain | manifest 已含 |
| MED | prevIds 基线丢失 | save 用当前 ids 覆盖 prevIds | 分开持久化 prevIds + 版本跃迁判定 | **同版 reload 后 prevIds 仍在 PASS** |
| MED | 畸形 storage 绕过诚实契约 | 只校验外层 shape | 逐卡归一化 choice∈{yes,no,null}、comment 为 string | **malformed 归一化 PASS** |
| LOW | S12 note 与数据矛盾 | note 说抑制了 gate | 已改回准确表述（仅 preamble 被抑制） | — |
| LOW | lead bundle 未含 trim/join | 只求和 | rawSum + assembled 两列并报 | manifest note 已改 |
| LOW | B15 字节低估近 10× | Scope note 被并进 override C，记 ~65 | 精修锚点，B15=560，层-B 小计对账到 15,005 | — |

**环境**：本地 `python3 -m http.server` @ 127.0.0.1:8766 + Claude-in-Chrome 真浏览器（Playwright 在本机因 socket 路径超长不可用）。测试后服务已停。

### 5.1 结构 / 体量预检（脚本断言，R2）

| 项 | 结果 |
|---|---|
| UTF-8 字节 | 40,007 / 524,288 ✅（publish-report 硬限的 7.6%） |
| 完整文档结构 | `<!doctype>` + `<head>` + `<meta charset>` + viewport ✅ |
| `<script nonce="__CSP_NONCE__">` | 恰好 1 处 ✅ |
| HTML 注入 sink（`.innerHTML=`/`outerHTML`/`insertAdjacentHTML`/`document.write`） | **零** ✅（只用 textContent / value / createElement） |
| 内联事件处理器（`onclick=` 等） | 零 ✅（全 addEventListener） |

### 5.2 对抗性转义冒烟（`harness/escaping-fixture.html`，R2 **11/11 PASS**）

fixture = 从**真 report.html** 派生（注入一张每个字段都带恶意文本的卡），因此测的是**真代码路径**，不是 mock。载荷含：引号、`<img onerror>`、闭合 script 标签、`__CSP_NONCE__` 字样、HTML 实体、Unicode/emoji/RTL。

| 断言 | 结果 |
|---|---|
| 注入的 `<script>` 未执行（`window.__PWNED__` undefined） | PASS |
| `document.title` 未被劫持 | PASS |
| 零 `<img>` 元素被创建 | PASS |
| 无 `BROKEN OUT` 的 `<h1>` 元素 | PASS |
| 文档内恰好 1 个 `<script>` | PASS |
| 恶意文本**作为字面文本**渲染（img / 闭合标签 / h1 / 实体 / nonce 字样 / Unicode / 引号 / `<b>`） | PASS ×9 |

> 结论：源文本（提示词/规则原文）无论含什么字符，都只会作为文本显示，不会变成标签或代码。

### 5.3 交互冒烟（真 report.html，R2 全绿）

| 断言 | 结果 |
|---|---|
| **10 张卡**渲染（R2 移除 future-autonomy 后） | PASS |
| **初始态全部未审**（未审=10，建议改=0，不动=0） | PASS |
| **零预选**（所有 toggle `aria-pressed=false`） | PASS |
| 无 future-autonomy 卡（HIGH-3 已移除） | PASS |
| 点击 toggle + 留言 → 汇总正确 | PASS |
| localStorage 持久化 + 选择正确 + prevIds 字段存在 | PASS |
| 导出为合法 JSON | PASS |
| **未审在导出里是显式 `null`** | PASS |
| 导出带「审计假设」证据标签 | PASS |
| 复制状态如实提示 | **见 5.4** |

### 5.4 复制按钮 — 两种路径都验过（这是 FLY-385 踩过的坑）

| 路径 | 行为 | 判定 |
|---|---|---|
| **程序化点击**（无用户手势 → 剪贴板权限被拒） | 状态显示「复制失败 —— 内容已展开，请手动全选复制」，导出框展开、内容完整（3,815 字节） | ✅ **如实报失败**，不谎报成功；且给了可用退路 |
| **真人点击**（Claude-in-Chrome 真实鼠标点击） | 状态显示「✓ 已复制」（绿），导出框内容被选中 | ✅ 真的复制成功 |

> 这正是 plan §4 要求的「成功/失败如实提示」。**没有假绿**。

### 5.5 跨版本批注迁移 + HIGH-2/MEDIUM 修复冒烟（R2，全绿）

模拟「上一版（R0）留下的状态」：一个仍存在的卡片 ID + 一个新版已移除的 ID + 一条**畸形** entry（`choice:false` + 非字符串 comment）。

| 断言 | 结果 |
|---|---|
| 上一版的选择/留言被导入并在渲染时应用 | PASS |
| 畸形 entry 被归一化（`choice:false`→null、非串 comment→""，不污染汇总） | PASS |
| **HIGH-2：导入后再编辑（choice + 留言）持久化到 localStorage** | **PASS** |
| 编辑后汇总正确反映 | PASS |
| **MEDIUM：版本跃迁后 prevIds = R0 的卡片集** | PASS |
| **MEDIUM：同版 save+reload+edit 后 prevIds 仍保留（不被当前 ids 覆盖）** | **PASS** |
| 导出 `diffVsPrevVersion.removed` 正确列出已移除 ID | PASS |
| 未审导出为显式 null | PASS |

> 结论：R1 的「导入批注不可编辑」（HIGH-2）与「同版 reload 后基线丢失」（MEDIUM）已在**真机**验证修复——Annie 在 Round N 打开新链接、导入上一版批注后**还能继续编辑并保存**，且迁移 diff 跨 reload 不丢。

### 5.6 尚未验证（诚实声明 —— 留 M6）

| 项 | 为什么现在验不了 |
|---|---|
| **hosted 页（CSP nonce 真注入后）交互** | 需先 `publish-report`。M6 发布后必须复测一遍（本地裸文件 CSP 不生效，两态不等价——FLY-385 就是栽在这个差别上） |
| Annie 真机（手机）复制体验 | 只有她的设备说了算 |

### 5.7 R3 复测（Codex code review R2 后 — land-path 保真 + 数字源单一化）

Codex code review（R2，xhigh）在 R1 修复上又抓出问题，全部核实为真并已修：

| # | 级别 | finding | 修复 | R3 验证 |
|---|---|---|---|---|
| HIGH | SkillInjector 保真 | 盘点脚本传 `undefined` SkillInjector → base-flow 走 no-land 分支（373 B），但生产写代码 runner 实际都 land（本 session 自证带 land 6 步） | 脚本改「注入成功」stub 镜像生产 land 路径；另立 S16 覆盖 no-land 边界 | base-flow 373→**553**；S02 30,605→**30,785**；角色 49.1%→**48.8%**；契约 76.5%→**75.6%**（headline 三条结论一字未改） |
| MED | 手抄数字漂移 | report.html 的 MANIFEST + 每卡 `bytes` + 摘要数字是手填的，R1→R2 与重算的 `inventory-data.json` 漂移过 | 新增 `harness/assert-report-sync.mjs`：从 committed data + manifest 重算所有数字，逐一断言在 report.html 里逐字出现；**M4 preflight 必跑，不过不 publish** | 断言 **PASS**：MANIFEST provenance + S02 分解（30,785 B / 48.8% / 75.6%）+ lead bundles + skills + 10 张卡 `bytes` 全对上 |

**M4 preflight（发布前必跑，全绿才 publish）**：
```
node harness/assert-report-sync.mjs      # 源单一化断言：report.html 逐字对齐 data/manifest
biome check harness/assert-report-sync.mjs harness/inventory.mjs   # lint 绿（biome 2.1.4，repo 同版）
```

> R3 只动了盘点保真（land 分支）+ 加了防漂移断言，**没改任何结论**。S15/S16 两个边界场景（keepalive-off、no-land fallback）一并补进矩阵，场景 14→16、锚点仍 28。转义 / 交互 / 迁移三类冒烟在 R2 已真机全绿，R3 未改这些代码路径，结论沿用；hosted 页交互仍留 M6 发布后复测。

## 6. 与铁律的一致性自查

| 铁律 | 自查 |
|---|---|
| 无评测数据不动生产提示词 | ✅ 本 PR 零生产文件改动（只增本 doc 文件夹）；每条建议标「审计假设」 |
| 不预选 = 不把我的建议冒充 Annie 的决定 | ✅ 初始全未审（冒烟断言 3 已证）；未审在导出里是显式 null |
| 不称「预估收益」 | ✅ 排序明标「审计优先级启发式」 |
| 契约层不进砍候选 | ✅ 23 条契约块全在「必须留」章节，无一进卡片区（R2 撤回了误列的 future-autonomy roadmap） |
| 审计深度诚实 | ✅ 每卡带「深度：逐字/结构/口径」标签；层 C 9 文件明确标未审、不给归类 |
