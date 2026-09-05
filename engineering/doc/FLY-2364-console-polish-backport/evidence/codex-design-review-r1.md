# Design Review — plan.md (Round 1)

Date: 2026-09-05
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向可行，四项实现都能落在当前生产 renderer / snapshot 投影上，且没有越过 Lead 已定的 founder-bounded scope。现在还不能实施：证据生命周期会让 GREEN 继续读取改前的 `dist`，C5 fixture 按现有描述无法得到 `8 → 2`，回环标签的绘制顺序与 bbox 验法也无法共同满足验收。

## What's Good (Keep)

- 坚持只把缺失 polish 手工合回 `fleet-console-html.ts`，不引入 `/console-next`、新路由、flag 或写路径；这与 exploration 和 FLY-2257 §8 一致。
- B6、D、A4 的落点准确：`renderProjectList`、`renderLeadRows` / `renderModelPanel`、`squadCard` 都是当前真实路径；`renderLeadRows` 也确实同时覆盖项目页和 derived group 页。
- A4 数据源判断正确：`management-dag-source.ts` 当前会填 `dispatch.current.{provider,model,effort}` 和 `dispatch.source.hint = <templateId>@<revision>`，不需要增加旁路请求。计划中的动态属性也都经过 `esc()`。
- A3 由后端按 `loop_when` 生成显示名、前端以 `loop.name || loop.id` 兼容旧后端，是与现有 `workflowNodeDisplayLabel` 一致的 source-driven 方案。`max_iterations ?? null` 和仅对 number 显示 `×N` 也符合当前 manifest / DTO。
- 不升 `MANAGEMENT_SCHEMA_VERSION` 的兼容性判断成立：这是只读追加字段，旧页面会忽略，新页面可回退到 `loop.id`；后端先于前端落地且两边都可独立回退。
- `--self-check` 必须非零、SKIP 计红、监听非 GET、保留完整管理台回归门，这些 fail-closed 原则应保留。

## Issues & Recommendations

1. **HIGH — 最终 harness GREEN 会继续运行改前 renderer。** C0 只在改代码前执行一次 `pnpm -r build`，而复制来源的 harness 在模块加载时从 `packages/teamlead/dist/.../fleet-console-html.js` import，并在进程启动时一次性执行 `const html = getFleetConsoleHtml()`。C1–C4 后计划只跑 typecheck / Vitest，没有再次 build，也没有停止并重启 C0 的后台 server；因此最终 ruler 要么看到旧 HTML 而一直红，要么依赖未写明的偶然副作用。**修正：**在最终 harness GREEN 前明确执行 `pnpm -r build`，保存并终止 RED server PID、等待退出、再启动新进程并做 readiness/fixture identity 校验；命令用 trap 清理。harness 还应拒绝非 GET（405），并把 RED、GREEN、`:9876` 写入不同 `OUT_DIR`，避免覆盖证据。

2. **HIGH — C5 fixture 与 `groupTitleCount 8 → 2` 合同不相容，且“改前恰好四红”未被构造出来。** 按当前 `renderProjectList`，6 个 singleton non-derived group 加一个 derived `Infra` 只会产生 7 个改前标题；B6 后只剩 derived 区的固定标题「分组」，即 1 个。固定标题「基础设施」只有 `unassignedCrons.length > 0` 时才出现，而 C5 没有要求该 fixture；复制的 FLY-2257 harness 反而是 `unassignedCrons: []`。另外复制来源的 `graphNode()` 用英文 id 生成 name，若 `--expect` 真按 §7 检查中文节点名，RED 会多出 A1，而不只是 B6/D/A4/A3。**修正：**把 fixture 写成确定合同：6 个中文名已正确的同名项目组、1 个 derived group、1 个合法未归属 Cron（从而确实 8→2）、明确的中文 graph node names、代表 C7 两类已映射 reason 的 flags，以及 A5 所需的一条 lay-note/零 per-card reason 前置；在改代码前断言失败集合逐项精确等于四项，而不只断言失败数。

3. **HIGH — 回环标签的逐条 path→rect→text 绘制顺序会让后画的回环线覆盖先画的标签，而所述 bbox 断言也不是有效的相交判定。** 当前两条 `tpl_code` 回环嵌套且共享 `implement` 终点；按计划在 loop 迭代内立即画标签，第二条更深的 Bé塞尔 path 会在第一条标签之后绘制，存在穿过/压住前一白底标签的路径。另一方面，整条 Bé塞尔曲线的 `getBBox()` 是大范围轴对齐包围盒；拿它与标签 rect 的 bbox 做不重叠断言，即使实际 stroke 没碰到也会因包围盒覆盖同一区域而报红，无法证明视觉安全。**修正：**两遍渲染（先画完所有 loop paths，再画所有 label rect/text）以保证标签不会被后续 path 覆盖，并给 rect 明确的 `data-loop-label-box`。若要求真实几何不相交，应沿 `getTotalLength()/getPointAtLength()` 采样下一条 stroke 与 rect 做碰撞测试；若只要求可读性，则断言 DOM paint order/无遮挡并配截图，不要用整条 path bbox。

4. **MEDIUM — `--expect` 不能按现有 §7 证明全部“证据-only”条目和回滚分支。** §2 承诺为 A5、C7 出证据，但 §7 没有 A5 的「全 panel 恰好一条 `.lay-note`、每卡 `.reason` 为 0」目标，也没有 C7 的已知 reason 正确分类及 `unmapped/unknown` 为 0；按“只对 §7 断言”的 ruler 可以漏掉两项仍然全绿。`loop.name` 缺失时回退 id、`maxIterations:null` 不显示次数也只有源码字符串守卫，没有动态兼容用例。**修正：**在 §7 增加 A5/C7 行并给 harness 对应阳性 fixture；增加一个缺 `name` 的旧 DTO 回环和一个 null 次数回环的 DOM/ruler 断言。C2 还改了 1050/780 媒体规则，至少补一档 `<=1050` 的实际浏览器断言，确认 `.lead-head` 隐藏而 Runner 卡 label 仍可见。

5. **LOW — 若干当前源码锚点和 CSS 细节需在实施前修正。** §1 写“3 个源文件”但实际列了 4 个；合同边界函数叫 `assertManagementSnapshot`，不是 `validateManagementSnapshot`；C5 应写从 `ruler-baseline.mjs` 泛化，而不是不存在的 `measure.mjs`。B6 的固定标题还包括当前 L310 的「其他」，测试也应保留它。最后，插入 `.lead-head` 后首个 `.lead-row` 不再匹配现有 `.lead-row:first-child{border-top:0}`，会在 header 下形成双线，且窄屏隐藏 header 后首行恢复一条原先没有的顶线；补 `.lead-head + .lead-row{border-top:0}`（或等价规则）并在截图中核对。

## Verdict

CHANGES REQUESTED — address items above
