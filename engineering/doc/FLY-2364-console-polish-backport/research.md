# FLY-2364 管理台 8 条 polish 合回生产 — 调研

Issue: FLY-2364 (https://linear.app/geoforge3d/issue/FLY-2364/2356p0-把原型里已改好的-8-条-polish-合回生产管理台9876dag-节点中文-label-按-nodetype-取色)
日期: 2026-09-05
基于: exploration.md

## 1. 生产渲染器的结构(改动落点)

`packages/teamlead/src/bridge/fleet-console-html.ts`(`main` @ `641734888`,712 行)由三段模板字符串拼成,`getFleetConsoleHtml()` 只做 `HEAD + STATE_JS + APP` 三段相加(L706-712):

| 段 | 行 | 内容 | 本单动它吗 |
|---|---|---|---|
| `MANAGEMENT_CONSOLE_STATE_JS` | L12-135 | 无 DOM 的纯函数(`flagReading`、`nodeMetrics`…),FLY-2257 设计成可在 node 里 `eval` 单测 | 否 |
| `MANAGEMENT_CONSOLE_HEAD` | L137-198 | HTML 骨架 + 压成三行的 CSS | 是:追加 3 条规则(`.lead-head`、`.lead-row .field>label`、`.bind-tag`) |
| `MANAGEMENT_CONSOLE_APP` | L200-704 | IIFE,取数与渲染 | 是:4 个函数各改几行 |

页面只读一个口 `/api/fleet/snapshot`(schema 2,页面收到不同版本号直接抛「管理台已更新,请刷新页面」L268);写路径 `stage/apply/progress` 一概不碰。

## 2. 四处改动逐个查源

### 2.1 B6 · 项目栏同名分组标题(`renderProjectList`,L287-316)

- 数据:`snapshot.presentationGroups`(非 `derived` 的 6 个)每组 `label` + `projectIds`;生产今天 6 组全是「一组一项目、组名 == 项目名」(`flywheel`→`project/flywheel` …),所以 8 个标题里 6 个是废话。
- 现状 L296 无条件 `html+='<div class="group-title">'+esc(group.label)+'</div>'`。
- 原型 L397-399 的规则:`visible.length===1 && group.label.toLowerCase()===visible[0].name.toLowerCase()` ⇒ 不印标题。这条规则只影响那一行标题,项目按钮、`data-project`、搜索过滤都不变。
- 注意搜索:`visible` 是按查询过滤后的列表,一个多项目分组被搜到只剩 1 个同名项目时也会省掉标题 —— 这是正确行为(标题此刻同样是废话)。
- 后面三个标题「分组」「基础设施」「全局」(L303/310/313/314)不是项目组,不动。预期 8 → 2(今天:分组 + 基础设施;`extensions` 为空所以「全局」不出现)。

### 2.2 D · 模型页列头与措辞(`renderLeadRows` L366,`renderModelPanel` L370,`renderGroupDetail` L496)

- `renderLeadRows` 对每个 Lead 行调 `modelControl(lead.dispatch,"lead","公司 → 型号 → effort",true,true)`;`modelControl` 总会渲染 `<div class="field"><label>公司 → 型号 → effort</label>…`(L335-350),所以每行印一遍。
- `renderGroupDetail`(dept 分组页)也走 `renderLeadRows`,改一处两页同时生效。
- 现有 CSS 已有同类先例:`.dag-row .field>label{display:none}`(L148)。原型做法一致:加 `.lead-row .field>label{display:none}` + 在 `.lead-list` 顶部插 `<div class="lead-head"><span>Lead</span><span>公司 → 型号 → effort</span></div>`,列头 grid 与 `.lead-row` 同款 `minmax(145px,.55fr) minmax(420px,1.45fr)`。
- 「Runner 默认」那张单卡(L375)保留自己的 label,它不是列表。
- 措辞:L372 `'该项目的 Lead 统一展示在 '+labels.join(" / ")+'（'+groupedCount+' 个）'` → `'另有 '+groupedCount+' 个 Lead 归在「'+labels.join(" / ")+'」分组下，不在这张表里。'`。`groupedCount = project.leads.length - visibleLeads.length`,今天 flywheel = 5 - 3 = 2,数字来源不变。
- ≤1050px 的媒体查询把 `.lead-row` 折成单列(L196),列头在窄屏要 `display:none`,否则两个 span 会挤成一行假列头。780px 断点同理。

### 2.3 A4 · 「模板绑定」小标(`squadCard`,L419-433)

- 每个可选模型的节点行:L430 `'<div class="dag-row"><strong>'+esc(name)+'</strong>'+modelControl(node.dispatch,"workflow","stage 模型",false,false)+'</div>'`。
- **绑定值的真源就在 `node.dispatch`**(`management-dag-source.ts` L119-160):`dispatch.current = {provider, model: node.model(持久化拼写), effort}` 直接来自模板 manifest 该节点的 `vendor/model/effort`;`dispatch.source.hint = "<templateId>@<revision>"`(如 `tpl_code@12`);`dispatch.canonicalModel` 是显示用规范 id。原型靠 `/api/console-next/templates` 另取 `bind` 的做法在生产上多余 —— snapshot 里已经是同一份数据。
- 小标内容:`模板绑定`,`title` 属性 = `"模板绑定 " + source.hint + " · " + current.provider + " / " + current.model + (effort ? " / " + effort : "")`,全部 `esc()`。`current` 是**已落盘**的值,页面草稿改了下拉不影响它 —— 这正是「模板绑死的是什么」的语义。
- `esc()` 只转 `& < > "`,`title` 用双引号包,安全。
- 不做的部分:收窄下拉选项(S2)。小标只标来源。

### 2.4 A3 · 回环线的显示名与次数(`dagGraph` L379-417;后端 3 处)

- 页面 L405-409:`graph.loops.forEach` 画贝塞尔曲线,`data-loop=<id>`,**没有任何文字**。今天生产 4 条回环 path、0 个 `<text>`。
- 数据:`ManagementDagGraphLoop = {id, from, to, maxIterations: number|null}`(contract L203-205);`management-dag-source.ts` L112-117 从 manifest `loops[]` 映射,`max_iterations ?? null`。manifest 回环还带 `loop_when: "qa_fail" | "review_fail" | "founder_feedback_kickback"`(`workflow-template.ts` L73-81),这是后端对「这条回环是什么」的**权威枚举**,但 snapshot 现在不带。
- 生产 6 个模板里只有 `tpl_code` / `tpl_simple_code` 有回环,各两条:`qa_retry`(qa→implement)、`founder_rework`(founder_gate→implement),`maxIterations` 均为 `null`;dag-source 单测里有 `maxIterations: 3` 的阳性用例(L91)。
- 显示名从哪来:三个选项
  1. 前端按 `loop.id` 映射中文 —— 原型做法(`l.id==="qa_retry"?"QA 失败重来":"打回重做"`),是前端编词,与 A1 的原则相悖,否决。
  2. 前端直接印 `loop.id`(`qa_retry`)—— 不编词,但 founder 看到的是英文变量名,与其余全中文的图不一致,否决。
  3. **后端拥有显示名(选它)**:`workflow-display-labels.ts` 已经是节点显示名的后端权威(`label → 历史映射 → id`,L37-46),按同一模式加 `workflowLoopDisplayLabel(loop)`:manifest 回环没有 `label` 字段,所以按 `loop_when` 枚举给名:`qa_fail`→「QA 失败重来」、`review_fail`→「评审失败重来」、`founder_feedback_kickback`→「创始人打回重做」,枚举外退回 `loop.id`。contract 的 `ManagementDagGraphLoop` 追加 `name: string`,dag-source 映射时填上。
- 次数:页面只在 `typeof loop.maxIterations==="number"` 时追加 ` ×N`;`null` 就只有名字,**不出现任何表示「无限」的字**。
- 追加字段是否要升 `MANAGEMENT_SCHEMA_VERSION`:不用。纯追加、老页面不读它;新页面对缺字段退回 `loop.id`(回滚后端时不炸)。`publish-fable-template-alias.ts` L188 只比对版本号,不受影响。
- `ManagementDagGraphLoop` 的消费者(全仓 grep):`management-dag-source.ts`(生产者)、`management-dag-source.test.ts`(两处 `toEqual` 精确匹配,要补 `name`)、`fleet-console-html.ts`(读者)、FLY-2257 `evidence/harness.mjs`(fixture,可不动,但本单自己的 fixture 会带 `name`)。没有别的读者。
- 绘制:标签放在回环最低点中央,`<rect>` 白底 + `<text>` 9.5px(原型 L646-648 的做法),`loopDepth = loops.length*24+14`(L392)已为每条回环留了 24px 竖向空间,标签高 17px 放得下,不改尺寸公式。

## 3. 测试现状与要补的断言

`packages/teamlead/src/__tests__/fleet-console-html.test.ts`(11 个用例,字符串级)锁住的合同里与本单相关的:
- 禁止出现 `/api/console-next`、`FLY2071_LAYOUT`、`renderRoles(`、`role-link`、`.squad:after`、`${` → 原型里的 `bind-tag` 实现不能连带把这些搬进来。
- 必须含 `esc(node.name)`、`graph.loops.forEach`、`lay-note`、`ENG_NODE_TYPES`、四列 Flag grid → 不动。
- `Function(script)` 语法检查 → 新增 JS 必须能通过。

除字符串级测试外,管理台还有一族 **happy-dom 真 DOM 测试**(设计段第一轮漏看,Codex 评审时补核):

| 文件 | 与本单的关系 |
|---|---|
| `management-console-dom.test.ts`(1023 行,`// @vitest-environment happy-dom`,L95 起一份完整 fixture snapshot:1 个同名单项目组 `flywheel` + 1 个 derived `Infra`、`tpl_code` 带两条回环 `qa_retry maxIterations:3` / `founder_rework null`) | **两处会被 D 直接打红**:L518、L748 `toContain("该项目的 Lead 统一展示在 Infra")`,措辞改了必须同步改断言。B6/A4/A3 的 DOM 级断言都该加在这里(fixture 已经具备全部阳性条件) |
| `management-console-projection-dom.test.ts` | 只数 `[data-edge],[data-loop]`,回环加 `<text>` 不影响 |
| `management-console-visual-regression.test.ts` | 锁窗口壳、三个下拉宽度、FLY-2054 harness 字符串;不受影响 |
| `management-console-ui-contract.test.ts` / `page-switch` / `snapshot` / `contract` | 纯函数 / 页面切换 / 后端聚合;不受影响(contract 测试不逐字段校验 loops) |

要补(见 plan):字符串级:同名分组规则、`lead-head`、`bind-tag` 的数据来源串、回环 `loop.name||loop.id` 与 `maxIterations` 守卫、`不限次` 禁止词;DOM 级(`management-console-dom.test.ts`):同名组标题不渲染而「分组」标题仍在、`.lead-head` 计数与行内 label `display:none`、tpl_code 卡 `.bind-tag` 数 = 3 且 `title` 含 `模板绑定`、两条回环的 `text[data-loop-label]` 文本分别为「QA 失败重来 ×3」「创始人打回重做」(fixture 加 `name`)、以及 fixture **不带** `name` 时退回 `qa_retry ×3`;dag-source 单测补 `name`;`workflow-display-labels` 单测补回环三枚举 + 未知枚举退回 id。

## 4. 复测尺子与环境

- Playwright:全局 `~/.npm-global/lib/node_modules/playwright` 1.58.1;浏览器 `~/Library/Caches/ms-playwright/chromium_headless_shell-1234`。runner 的 `$TMPDIR` 过长会让 socket 失败,跑前 `TMPDIR=/tmp/fly2364`(已在设计段验证可跑)。Playwright MCP 插件在 runner 里不可用(socket 目录 109 字节 + 共享浏览器被占)。
- 合入前:FLY-2257 `evidence/harness.mjs` 用 `packages/teamlead/dist/.../fleet-console-html.js` 的 `getFleetConsoleHtml()` + 内存 snapshot 起只读服务(`127.0.0.1:18857`)。本单复制一份到自己的 `evidence/`,fixture 改成:6 个「一组一项目同名」分组 + 1 个 derived 分组 Infra(2 个 Lead)、`tpl_code` 形状带两条回环(一条 `maxIterations: 3`,一条 `null`)。
- 合入后:同一把尺子指向 `http://127.0.0.1:9876/`(生产 Bridge 只在 updater 窗口部署,ship report 里的 :9876 数字要等部署后再量)。
- 尺子必须带否定臂:跑一次 `--self-check`,对 **未激活的 DAG 页**(`display:none`)断言宽度 > 0,必须红;任何非 GET 请求计红;每臂缺前置就 fails++,不允许 SKIP 静默(FLY-2313 教训)。
- worktree 现在没有 `node_modules`,实现节点先 `pnpm install --frozen-lockfile`(主 checkout `~/Dev/flywheel/node_modules` 已有 store,离线也快);跑测试**必须排除** `**/tmux-viewer.macos.test.ts`(会真开 Terminal.app)。

## 5. 风险

| 风险 | 判断 |
|---|---|
| 后端追加 `name` 撞上正在飞的其它分支改 contract | 追加一个字段一行,冲突面极小;真撞了以 `main` 为准重放 |
| `.lead-row .field>label{display:none}` 把别处的 label 也藏了 | 选择器限定在 `.lead-row` 内;`Runner 默认` 卡在 `.grid .card` 里不受影响。尺子断言 Runner 卡 label 仍可见 |
| B6 让「只剩一个项目」的搜索结果没有分组上下文 | 组名与项目名相同,上下文本来就是零信息;多项目组搜到 1 个时组名 ≠ 项目名的仍然印 |
| 回环标签与下一条回环线重叠 | 每条回环各占 24px 深度,标签 17px 居中;fixture 阳性用例两条回环各带标签,截图核 |
| Flags 页高达不到 1.7 屏 | 不在本单改(exploration §4,已报 Lead) |
