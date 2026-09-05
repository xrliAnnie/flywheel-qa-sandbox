# FLY-2364 管理台 8 条 polish 合回生产 — 实施计划

Issue: FLY-2364 (https://linear.app/geoforge3d/issue/FLY-2364/2356p0-把原型里已改好的-8-条-polish-合回生产管理台9876dag-节点中文-label-按-nodetype-取色)
日期: 2026-09-05
基于: research.md

## 0. 一句话

在生产渲染器 `packages/teamlead/src/bridge/fleet-console-html.ts` 上补齐原型里还没落地的 4 处小改(B6 项目栏去重标题、D 模型页列头与措辞、A4「模板绑定」小标、A3 回环显示名 + 有次数才写次数),后端只追加一个只读字段(回环 `name`);其余 4 条(A1/A2/A5/C7/C8)已由 FLY-2257 落地,本单只在 `:9876` 上用同一把尺子出证据。`console-next-html.ts` 不进 `main`。

范围经 Lead(Tadashi)2026-09-05 两次裁定:① 已落地条目只出证据不重做;② Flags 页不压行高,验收项改写(§7)。

## 1. 边界

- 只改 4 个源文件 + 4 个测试文件 + 本文件夹下的证据脚本:
  - `packages/teamlead/src/bridge/fleet-console-html.ts`(HEAD 段加 3 条 CSS,APP 段改 4 个函数)
  - `packages/teamlead/src/bridge/management-console-contract.ts`(`ManagementDagGraphLoop` 追加 `name`)
  - `packages/teamlead/src/bridge/management-dag-source.ts`(回环映射填 `name`)
  - `packages/teamlead/src/workflow-display-labels.ts`(新增 `workflowLoopDisplayLabel`)
  - 测试:`fleet-console-html.test.ts`(字符串级)、`management-console-dom.test.ts`(happy-dom 真 DOM,fixture 在 L95;**其 L518 / L748 断言旧措辞,D 改后必须同步**)、`management-dag-source.test.ts`、`workflow-display-labels.test.ts`
- 不加路由、不加 flag、不加写路径、不动 `MANAGEMENT_SCHEMA_VERSION`、不动 Flags 页任何 DOM、不动 `lay-note` 文案、不碰 S1–S5。
- 不合并、不删原型分支、不重启 Bridge。

## 2. 三栏对账(QA 按栏验)

| 栏 | 条目 | 本单动作 |
|---|---|---|
| **FLY-2257 已做** | A1 中文 label、A2 按 type 取色、A5 说明只写一次、C7 原因分类、C8 CLI/列名/「四种」去重 | 不改代码;`evidence/ruler.mjs` 在 `:9876` 出数(§7) |
| **本单做** | A3 回环显示名 + 次数守卫、A4 模板绑定小标、B6 项目栏去重、D 模型页列头 + 措辞 | C1–C4 |
| **FLY-2257 明写不做、本单接** | A4(其 plan §8 第 4 条)、B6(§8 第 6 条) | 同上,已含在 C1/C3 |

## 3. 稳定标识与显示标签(前端 DOM 合同,测试与尺子只认左列)

| 东西 | 稳定标识 | 显示标签(可改文案) |
|---|---|---|
| 项目栏分组标题 | `.project-rail .group-title`(同名单项目组**不渲染**该元素) | `group.label` |
| Lead 列表列头 | `.lead-list > .lead-head`(恰好 2 个 `span`) | `Lead` / `公司 → 型号 → effort` |
| Lead 行内 label | `.lead-row .field>label`(DOM 保留,CSS 隐藏) | 不变 |
| 分组说明 | `[data-panel="model"] .group-note` | 「另有 N 个 Lead 归在「X」分组下，不在这张表里。」 |
| 模板绑定小标 | `.dag-row strong > .bind-tag[data-bind-source="<templateId>@<revision>"][title]` | `模板绑定`;`title` = `模板绑定 <hint> · <provider> / <model>[ / <effort>]` |
| 回环标签 | `svg text[data-loop-label="<loop.id>"]` | `loop.name`(缺省 `loop.id`)+ 仅当数字时 ` ×N` |
| 回环线 | `[data-loop="<loop.id>"]`(FLY-2257 已有,不变) | — |

## 4. Chunk 划分(每个可独立 commit、独立回退)

### C0 · 环境与红线(不产出代码)

harness 在**进程启动时**从 `packages/teamlead/dist/bridge/fleet-console-html.js` import 并一次性执行 `getFleetConsoleHtml()`,所以「改了源码」对一个已在跑的 harness 毫无作用 —— 每次量数字前都要 **重新 build + 重启 harness**,证据脚本 `evidence/run.sh` 把这个生命周期固化下来(trap 清理,不留孤儿进程):

```bash
pnpm install --frozen-lockfile
# evidence/run.sh <label>:
#   1. pnpm -r build
#   2. 若 /tmp/fly2364/harness.pid 存在:kill 并等待退出(最多 10s,超时报错)
#   3. 后台启动 harness.mjs,写 PID;轮询 GET /__fixture 直到 200(最多 15s),并核对返回的
#      {fixtureId:"fly2364-v1", htmlSha256} —— htmlSha256 必须等于当前 dist 文件里 getFleetConsoleHtml() 的 sha256,
#      否则说明量的不是这份代码,直接失败
#   4. TMPDIR=/tmp/fly2364 OUT_DIR=/tmp/fly2364/<label> CONSOLE_URL=http://127.0.0.1:18857/ node ruler.mjs --expect
#   5. trap:kill harness,删 PID
bash engineering/doc/FLY-2364-console-polish-backport/evidence/run.sh self-check   # 否定臂:同一生命周期内跑,见下
bash engineering/doc/FLY-2364-console-polish-backport/evidence/run.sh red          # 改前:失败集合必须 == {B6, D, A4, A3}
```
- `run.sh self-check` 走**同一套** build → 停旧 → 起新 → `/__fixture` 身份校验的生命周期(不是在 harness 被 trap 杀掉之后裸跑 ruler),然后执行 `ruler.mjs --self-check`,要求它**非零退出且 stdout 含精确串 `SELF_CHECK_FAILED_AS_EXPECTED: HIDDEN_DAG_WIDTH`**;连接被拒、导航超时、readiness 不通过、或任何别的报错都算 self-check **自身失败**(退出非零但没有那串 ⇒ run.sh 报 `self-check invalid`),否定臂不能因为错误的原因「成功地失败」。
- 停旧 harness 前先核 PID 身份:`ps -p <pid> -o command=` 必须含 `harness.mjs`,否则不发 kill(PID 可能已被别的进程复用),只删陈旧 PID 文件。
先写 C5 的 harness/ruler/run.sh 再改代码:改前 `--expect` 打印的**失败集合必须逐项精确等于** `{B6, D, A4, A3}`(不是「4 个红」这种计数),这是 RED;多一项(比如 A1 因 fixture 名字是英文而红)或少一项都算尺子坏了,先修尺子。RED / GREEN / `:9876` 三次运行写三个不同的 `OUT_DIR`(`/tmp/fly2364/red`、`/green`、`/prod`),互不覆盖。

### C1 · B6 项目栏同名分组标题(前端,APP `renderProjectList`)

- 在 `html+='<div class="group-title">…'` 前加:`var redundant=visible.length===1&&String(group.label).toLowerCase()===String(visible[0].name).toLowerCase();if(!redundant){…}`。
- 测试(`fleet-console-html.test.ts` 新用例「hides a group title that only repeats its single project name」):`expect(html).toContain("visible.length===1&&String(group.label).toLowerCase()===String(visible[0].name).toLowerCase()")`;并保留 `分组` / `其他` / `基础设施` / `全局` 四个固定标题串(L303 / L310 / L313 / L314)。
- DOM 测试(`management-console-dom.test.ts` 新用例):fixture 里 `flywheel` 组只含同名项目 `flywheel` ⇒ `.project-rail .group-title` 的文本列表**不含** `flywheel`、**含** `分组`;`[data-project="project-1"]` 仍恰好 1 个;把 fixture 项目名临时改成 `flywheel-app` 再渲染一次(阴性对照),标题 `flywheel` 必须出现。
- 尺子:harness 上 `groupTitleCount` 8 → 2;`projectCount` 不变。

### C2 · D 模型页列头与措辞(前端,HEAD CSS + APP `renderLeadRows` / `renderModelPanel`)

- CSS(追加到 L148 那行末尾,不改既有规则):`.lead-row .field>label{display:none}.lead-head{display:grid;grid-template-columns:minmax(145px,.55fr) minmax(420px,1.45fr);gap:14px;padding:7px 12px 6px;font-size:9px;font-weight:700;color:#9a9aa2;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid #ececf0}.lead-head+.lead-row{border-top:0}`;两个媒体查询(1050 / 780)各加 `.lead-head{display:none}`。
  - 为什么要 `.lead-head+.lead-row{border-top:0}`:插入列头后首个 `.lead-row` 不再是 `:first-child`,既有 `.lead-row:first-child{border-top:0}` 失效,会在列头下面出现双线;窄屏列头 `display:none` 后元素仍在 DOM,首行也仍不是 first-child,同一条规则一并解决。截图核:1600 宽列头下方单线;1000 宽无列头、首行无顶线。
- `renderLeadRows`:`'<div class="lead-list"><div class="lead-head"><span>Lead</span><span>公司 → 型号 → effort</span></div>'+…`。空列表分支不变(没有行就没有列头)。
- `renderModelPanel`:`groupNote` 文案改为 `'另有 '+groupedCount+' 个 Lead 归在「'+esc(labels.join(" / "))+'」分组下，不在这张表里。'`。
- 测试:含 `lead-head`、含 `.lead-row .field>label{display:none}`、含 `另有 '+groupedCount+' 个 Lead 归在`、不含 `统一展示在`。
- DOM 测试(`management-console-dom.test.ts`):**改** L518 与 L748 的 `toContain("该项目的 Lead 统一展示在 Infra")` 为 `toContain("另有 1 个 Lead 归在「Infra」分组下")`(fixture 里 project-1 的 groupedCount = 2 - 1 = 1;project-2 = 1 - 0 = 1,实现时以 fixture 实算为准);新增断言:`#detail .lead-list .lead-head` 恰好 1 个且含 `公司 → 型号 → effort`;`getComputedStyle(.lead-row .field>label).display === "none"`(happy-dom 会应用页面 `<style>`,`page-switch` 测试已依赖这一点);Runner 默认卡 `.grid .card .field>label` 的 `display` 不是 `none`;Infra 分组页(`[data-group="infra"]`)的 `.lead-head` 也恰好 1 个。
- 尺子:`leadHead` 0 → 1(每个 `.lead-list` 一个)、`visiblePerRowLabelCount` 3 → 0、Runner 默认卡 label 仍可见(`runnerCardLabelVisible === true`)、`groupNote` 以「另有」开头;另在 **1000×900 视口**只加一条断言(Lead 2026-09-05:窄屏一档只加一条):`.lead-head` 的 `display === "none"` 且 Runner 卡 label 仍可见;双线/顶线问题靠 1600 与 1000 两张截图核,不再加几何断言。

### C3 · A4 模板绑定小标(前端,HEAD CSS + APP `squadCard`)

- CSS:`.bind-tag{margin-left:7px;padding:1px 6px;border-radius:999px;border:1px solid #dcd6f5;background:#f4f2fd;color:#5b51a8;font-size:9px;font-weight:650;vertical-align:1px;white-space:nowrap}`。
- APP 新函数(放在 `squadCard` 前):
  ```js
  function bindTag(managed){
    var c=managed&&managed.current;if(!c||!c.model){return "";}
    var hint=managed.source&&managed.source.hint?String(managed.source.hint):"";
    var text="模板绑定 "+(hint?hint+" · ":"")+(c.provider||"?")+" / "+c.model+(c.effort?" / "+c.effort:"");
    return '<span class="bind-tag" data-bind-source="'+esc(hint)+'" title="'+esc(text)+'">模板绑定</span>';
  }
  ```
  `squadCard` L430 的 `<strong>` 内容改为 `esc(name)+bindTag(node.dispatch)`。`hint` 缺省(测试 fixture 的 `managed()` 没有 `source.hint`)时不留孤立的「 · 」。
- 数据来源只有 `node.dispatch.current` / `node.dispatch.source.hint`(snapshot 已有,research §2.3),不加请求。
- 测试:含 `bind-tag`、含 `managed.source.hint`、不含 `/api/console-next`(既有断言)。
- DOM 测试(`management-console-dom.test.ts`,新用例「labels every template-bound model row with its persisted binding」):现有 `tpl_code` fixture 的 `dag.nodes` 只有 1 条(`implement`,`current.model="fable"`,`canonicalModel="claude-fable-5-1"`),所以先给 fixture 补成 3 条 agent dispatch(`design` / `implement` / `qa`,`targetId` 各自唯一,其中 `design` 的 `dispatch.source` 带 `hint: "tpl_code@1"`,另两条不带 hint);断言:`.dag-row strong .bind-tag` 数 === `.dag-row` 数(=3);`implement` 行的 `title` 含 `fable`(**持久化拼写,不是下拉框里的 canonical id `claude-fable-5-1`** —— 小标显示的是模板真源的原样值);`design` 行 `data-bind-source === "tpl_code@1"` 且 `title` 含 `tpl_code@1 · `;不带 hint 的两行 `data-bind-source === ""` 且 `title` 匹配 `/^模板绑定 [a-z]/`(没有孤立的「 · 」)。既有「draws explicit graph endpoints」用例里的 `select[data-model-part]` 计数从 3 改成 9(3 行 × 3 个下拉),这是 fixture 扩充的连带更新,不是行为变化。
- 尺子:harness 上 `bindTags` 0 → 等于 `.dag-row` 数;任一 `title` 以 `模板绑定 ` 开头且含 `@`。

### C4 · A3 回环显示名与次数守卫(后端追加只读字段 + 前端)

后端(先做,前端才有字段可读):
1. `workflow-display-labels.ts` 新增
   ```ts
   const LOOP_WHEN_LABELS: Readonly<Record<string, string>> = {
     qa_fail: "QA 失败重来", review_fail: "评审失败重来", founder_feedback_kickback: "创始人打回重做",
   };
   export function workflowLoopDisplayLabel(loop: { id: string; loop_when?: string }): string {
     return LOOP_WHEN_LABELS[loop.loop_when ?? ""] ?? loop.id;
   }
   ```
2. `management-console-contract.ts`:`ManagementDagGraphLoop` 追加 `name: string;`(注释:backend-owned display label;additive,no schema bump)。
3. `management-dag-source.ts` L112-117 回环映射加 `name: workflowLoopDisplayLabel(loop)`。
4. 测试:`workflow-display-labels.test.ts` 三枚举各一 + 未知枚举退回 id + 缺 `loop_when` 退回 id;`management-dag-source.test.ts` 两处 `loops` 的 `toEqual` 补 `name`(`qa_retry`→「QA 失败重来」、`founder_rework`→「创始人打回重做」),`maxIterations: 3` 的用例保留。
5. 追加字段不升 `MANAGEMENT_SCHEMA_VERSION`;已核 `assertManagementSnapshot`(contract L331 起)只校验 `schemaVersion` / `modelCatalog` / `sources`,不逐字段看 `graph.loops`,所以追加 `name` 不需要改校验器(实现时 grep 一次确认仍然如此)。

前端(`dagGraph` L405-409 回环循环):
- **两遍渲染**。第一遍(现有 `graph.loops.forEach`)只画 path,并把每条回环的 `{loop, mx, depth}` 收进 `labels[]`;第二遍在所有 path 之后、`</svg>` 之前统一输出标签,保证任何回环线都不会压在标签上(SVG 后画的在上面)。每个标签:`var lbl=String(loop.name||loop.id)+(typeof loop.maxIterations==="number"?" ×"+loop.maxIterations:"");svg+='<rect data-loop-label-box="'+esc(loop.id)+'" x="'+(mx-lw/2)+'" y="'+(depth-9)+'" width="'+lw+'" height="17" rx="4" fill="#fff" stroke="#e6e6ec"></rect><text data-loop-label="'+esc(loop.id)+'" x="'+mx+'" y="'+(depth+3)+'" text-anchor="middle" font-size="9.5" fill="#86868b">'+esc(lbl)+'</text>';`,`mx=(cx(from.index)+cx(to.index))/2`,`lw=Math.min(108,Math.max(62,NW-6))`。
- 不改 `loopDepth`/`height` 公式(每条回环已留 24px)。
- 可读性验证只认**绘制顺序 + 截图**,不做几何不相交断言:标签框就压在自己那条回环的最低点上(`y = depth-9 .. depth+8`,而曲线在 `t=0.5` 处 `y ≈ depth-3`),白底框盖住自己的线正是这个画法的预期;任何「path 不得进入 label box」的采样断言在 GREEN 时必然把 A3 判红(Codex R2 算过:`baseBottom=58, depth=70` 时曲线中点 `y=67.25` 落在框内)。整条 path 的 `getBBox()` 同样不用。
  1. **绘制顺序**(DOM 测试 + ruler 各一条):卡内最后一个 `[data-loop]` 的 `compareDocumentPosition` 在第一个 `[data-loop-label-box]` 之前 ⇒ 没有任何回环线画在任何标签之上。
  2. **截图**(ruler):`tpl_code` 卡两条回环两个标签的局部放大截图进证据目录,人眼核「两个标签文字完整、互不遮挡」。
- 测试:含 `loop.name||loop.id`、含 `typeof loop.maxIterations==="number"`、不含 `不限次`、不含 `打回（不限次）`、不含前端写死的 `qa_retry`。
- DOM 测试(`management-console-dom.test.ts`):fixture 两条回环加 `name`(`qa_retry`→「QA 失败重来」,`founder_rework`→「创始人打回重做」);断言 `tpl_code` 卡 `svg text[data-loop-label]` 恰好 2 个,文本依次为 `QA 失败重来 ×3`、`创始人打回重做`(第二条 `maxIterations: null` ⇒ 无 `×`);再渲染一次**去掉 `name`** 的 fixture(模拟后端回滚),文本退回 `qa_retry ×3` / `founder_rework`,页面不抛错;`[data-edge],[data-loop]` 计数仍为 6(既有断言,`<text>` 不带这两个属性)。
- 尺子:harness 上 `tpl_code` 卡 `loopTexts` = `["QA 失败重来 ×3","创始人打回重做"]`(fixture 一条给 3、一条 null);第三张卡 `tpl_legacy_loop` 的回环 fixture **故意不带 `name`**(模拟后端回滚),其标签必须是原样 `legacy_retry`;`unlimitedText` 0;几何采样断言见上。

### C5 · 证据脚本与验收跑

- `evidence/harness.mjs`:从 FLY-2257 的复制,fixture 改写成**确定合同**(`fixtureId: "fly2364-v1"`,`GET /__fixture` 返回 `{fixtureId, htmlSha256}` 供 run.sh 核对;非 GET 一律 405):
  - 6 个非 derived 分组,每组恰好一个项目且 `label === project.name` + 1 个 derived「Infra」(2 个 Lead)+ `unassignedCrons` 恰好 1 条合法记录(让「基础设施」标题出现)⇒ 改前标题 6 + 分组 + 基础设施 = **8**,改后 **2**;
  - graph 节点 `name` 一律写中文(「设计(工程)」「实现」「QA 验证」「创始人门」「合入」「产品设计」…),不用复制来源那个 `id.replaceAll("_"," ")` —— 否则 A1 会在 RED 时一起红,失败集合就不等于四项;
  - `tpl_code` 5 节点两回环(`qa_retry` `maxIterations:3` + `name`;`founder_rework` `null` + `name`);`tpl_simple_code` 4 节点;`tpl_legacy_loop` 3 节点一条回环 `legacy_retry`,**不带 `name`**;产品侧 3 张 generic 卡;所有 agent 节点 `dispatch.source.hint = "<templateId>@1"`;
  - 项目 3 个 Lead(1 个可见 + 2 个 Infra)+ Runner 默认卡;
  - flag 4 条:`writeCapability.reason` 分别命中 `read-only`、`use flywheel-comm feature-flags set`(两类已映射 → C7 的 `unmapped/unknown` 必为 0)、一条可写、一条带 `project_row` 覆盖。
- `evidence/ruler.mjs`:从设计段的 `ruler-baseline.mjs` 泛化:`CONSOLE_URL` 可指 harness 或 `:9876`;`--expect` 按 §7 目标逐项断言,输出**失败项 id 集合**(如 `FAIL: B6,D,A4,A3`)与 `n 项 / m 红`(SKIP 计红);`--self-check` 对未激活的 DAG 页断言 `.dag-scroll` 宽度 > 0 必须失败并非零退出;监听所有请求,出现非 GET 立即计红;额外跑一次 1000×900 视口(C2 的窄屏断言);输出 `metrics.json` + PNG 到 `OUT_DIR`。
- `evidence/run.sh`:C0 描述的 build → 重启 harness → 核 `htmlSha256` → 跑 ruler 的生命周期脚本,`set -euo pipefail` + `trap`。
- `evidence/README.md`:命令、期望值、RED/GREEN/`:9876` 三个 `OUT_DIR`、以及「:9876 的数字要等 updater 部署后再量」的说明。
- 全量门:
  ```bash
  pnpm lint
  pnpm -r typecheck
  pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fleet-console-html.test.ts src/__tests__/management-console-dom.test.ts src/__tests__/management-console-projection-dom.test.ts src/__tests__/management-dag-source.test.ts src/__tests__/workflow-display-labels.test.ts
  pnpm --filter flywheel-teamlead exec vitest run --exclude '**/tmux-viewer.macos.test.ts'
  ```
  (`flywheel-teamlead` 是 `packages/teamlead/package.json` 的 `name`。)

## 5. 顺序与提交

C5 的 harness/ruler/run.sh 先落(`run.sh red` ⇒ 失败集合 == {B6,D,A4,A3})→ C1 → C2 → C3 → C4 后端 → C4 前端 → `run.sh green`(它自己会重新 build 并重启 harness;失败集合必须为空)→ C5 的 README 与证据提交。每个 chunk 一个 commit,前缀 `feat(FLY-2364):` / `test(FLY-2364):`。每个 commit 后 `pnpm -r typecheck` 必须绿。

## 6. 迁移与回滚边界

- 前端三处纯渲染改动:回退 = revert 对应 commit,无状态。
- 后端 `name` 字段:纯追加。老页面(部署前已打开的 tab)不读它;新页面对没有 `name` 的 snapshot(后端回滚)退回 `loop.id`,不抛错。`schemaVersion` 不变,所以 FLY-2257 的版本握手不会误报「请刷新」。
- 没有数据写入、没有 StateStore 变更、没有 flag。

## 7. 验收(实现节点交付时逐项给证据;QA 用同一把尺子在 `:9876` 复测)

| 项 | 09-01 原型 :18971 | :9876 今日(改前) | 本 PR 目标(harness 与 :9876 均要) |
|---|---|---|---|
| 项目栏分组标题 | 2 | 8 | **2** |
| 项目栏高度 | 321px | 928px(栏满高,量法不同) | 不作数字验收;改为「6 个项目按钮全部在首屏可见」 |
| DAG 有图 | 9 节点 | 工程页 9 个 `.dag-chip`,4 条回环 path | 不变 |
| 执行节点可区分颜色 | 4 | 工程页 3 + 产品页 generic 1 = 4 | 不变(跨两个分页各量一次) |
| 节点名(A1) | 后端中文 label | 全中文,`founder gate` 0 处 | 不变。harness:工程页 `.dag-chip .dc-n` 文本列表**精确等于** fixture 写入的中文 label 列表(`设计(工程)`、`实现`、`QA 验证`、`创始人门`、`合入`、…);`:9876`:等于 snapshot `graph.nodes[].name` 逐一对应;两处都另断言 `founder gate` / `land`(英文形态)出现 0 次 |
| 说明只写一次(A5) | 1 条 | `.lay-note` 1 条;每卡 `.squad .reason` 0 | 不变:`.lay-note` 恰好 1、`.squad .reason` 恰好 0(两个分页各量一次) |
| Flag 原因分类(C7) | 已映射 | 「系统没有给原因」0、「没认出这条原因」0 | 不变:两者均 0,且 `lock-chip` 文本全部落在 `LOCK_KINDS` 的已知标签集合内 |
| 「不限次」 | 0 | 0 | **0,且回环有后端显示名,`×N` 仅当 `maxIterations` 是数字;缺 `name` 的回环退回 id** |
| 模板绑定小标 | 有 | 0 | **每个 `.dag-row` 一个,`title` 含 `<templateId>@<revision>`** |
| 模型页列头 | 有 | 0 | **每个 `.lead-list` 一个;行内 label 可见 0;Runner 卡 label 仍可见** |
| 分组说明措辞 | 「另有 N 个…」 | 「统一展示在…」 | **「另有 N 个 Lead 归在「X」分组下，不在这张表里。」** |
| Flags:可见 CLI 原文 | 0 | 0 | 0 |
| Flags:「类别」列 / `feature` 标签 | 0 | 0 | 0 |
| Flags:「四种」写死 | 0 | 0(动态「有 2 种」) | 0 |
| Flags 页高 | 1600px(1.7 屏,21 条,无状态句) | 2214px(2.21 屏,23 条,每行含 09-02 定义的状态句) | **如实报数,不设上限**(Lead 2026-09-05 裁定,不压行高) |
| 页面报错 | 0 | 0 | 0(console error + pageerror + 非 GET 请求三者都是 0) |
| `tsc` / lint / 聚焦 5 个测试文件(C5 命令)/ 管理台全套 | 原型没跑 | — | 全绿,附命令输出 |

## 8. 决定不做(不是遗漏)

| 事项 | 处置 |
|---|---|
| Flags 行紧凑化 | Lead 裁定不做;状态句是 founder 09-02 定义 |
| 回环显示名写进 manifest(`loops[].label`) | 改 manifest 校验与所有模板 seed,超出 polish;后端映射 `loop_when` 已是权威枚举 |
| `lay-note` 文案改写 | FLY-2257 测试锁定;内容已一行且不含实现细节 |
| 收窄 DAG 节点下拉到模板白名单(S2) | 需后端只读口,结构性 |
| `console-next-html.ts` / PR #1030 去留 | 归 Lead / HL |

## 9. 安全

- 所有进 HTML 的动态串(`group.label`、`hint`、`provider/model/effort`、`loop.name`、`loop.id`)一律过 `esc()`;`title` 与 `data-*` 用双引号包。
- 无新请求、无写路径;尺子脚本只发 GET,遇非 GET 计红。
