# FLY-2484 进度页渲染层:Epic 卡 + 子单行 — 调研
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: exploration.md

> 成色:✅ 亲手核过(file:line / 命令输出 / 字节实测);🔶 本单裁定,可推翻。Lead 2026-09-10 已裁定分组键与合入顺序(exploration §5)。
> **v2 更正(Codex R1 后,以 plan.md v2 为准)**:§3.1 的比较器不是全序(混排合法 / 不合法 identifier 时不传递),改为元组键 `identifierKey`;§3.1 的「倒序输入」测试改为两份按 UUID 同步重排的 raw snapshot 各自走 generator;§6 的插槽 B2 改到机器进度行之后、信号行之前,Epic 审计里 `/header/roots` 改为本 root 投影(`data-source-cell`),`/header/roots` 全格只在 Lead 面板出一次;§7 的 88 张预算不再承诺,改为实测 fixed + slope 定容量(门槛 ≥ 60);页面级结论各带 `view.*.v1` 展示规则号与输入格路径。

## 1. 分层:一个纯函数的「视图模型」,再由 HTML 渲染

今天 `render-html.ts` 把「读文档 → 决定顺序 → 拼字符串」揉在一个函数里(`:468-532` ✅),排序、分组、徽标这些**可断言的事实**只能靠字符串 `indexOf` 测。本单把它拆成两层:

```
EpicPage ──buildFounderView()──▶ FounderView(纯数据,确定序)──renderEpicPageHtml()──▶ HTML
                                   ▲ 排序/分组/徽标/整块在等/跨 Epic 的全部断言在这一层测
```

| 模块 | 职责 | 依赖 |
|---|---|---|
| `epic-page/rules.ts` | **新导出** `classifyItem(item)`(从 `computeRootCounts` `:307-318` 抽出,行为不变)与 `rootOf(item, byId, rootIds)`(从 `:264-289` 抽出的 parent 链走法,同样的 `EpicPageSchemaError`) | 无新依赖 |
| `epic-page/founder-view.ts`(新) | `buildFounderView(page): FounderView`;`compareIdentifier`;分组常量 | `rules.ts`、`model.ts` 类型 |
| `epic-page/labels.ts` | 新增全部 founder 面文案(§4) | — |
| `epic-page/render-html.ts` | 重写 `renderEpicPageHtml`;保留 `renderAuditCell / renderOverviewCell / renderFreshness / renderDependencyReview / stuckSummary / waitingFounderSummary / signalList` 供 Lead 诊断面板复用;新增 `renderEpic / renderChild / renderChildAudit` | `founder-view.ts` |
| `epic-page/render-markdown.ts` | **不动** | — |

为什么不把 FounderView 写进文档合同:它是「页面怎么排」,不是事实;PRD §12 禁止「只存在于页面里的事实」,但顺序不是事实,是展示规则(和今天 Markdown 的分节顺序一样)。它不进 `assertEpicPage`、不进回执、不影响 `source_digest`。

## 2. `classifyItem` 与 `rootOf`:一处真相(✅ 对照 `rules.ts:260-334`)

```ts
export type ItemClass = "live" | "waiting" | "free" | "idle" | "done" | "canceled";
// null ⇔ state.type 不在六种已知之内(计数层写 unknown_state_type 的那种)
export function classifyItem(item: EpicItem): ItemClass | null {
  const type = item.state.value!.type;           // 校验器保证非 null(model.ts:882-888)
  if (type === "started") return "live";
  if (type === "completed") return "done";
  if (type === "canceled") return "canceled";
  if (type === "backlog" || type === "unstarted" || type === "triage") {
    const blockers = item.blocked_by.value!;     // 校验器保证非 null(model.ts:889-891)
    if (blockers.length === 0) return "idle";
    if (blockers.some(b => b.blocker_state_type !== "completed")) return "waiting";
    return "free";
  }
  return null;
}
export function rootOf(
  item: EpicItem, byId: Map<string, EpicItem>, rootIds: Set<string>,
): string | null;   // null ⇔ parent 缺(no_parent);链断/成环 ⇒ throw EpicPageSchemaError(与今天同文案)
```

`computeRootCounts` 改为调用这两个函数;回归证明 = `rules.test.ts` 既有 `counts.v1` 全部用例不改一字、`generate.test.ts` 的 v1/v2 golden 不改一字、`scope-v2.test.ts` 37 条不改一字(E1 evidence ✅ 这些今天全绿)。**`computeRootCounts` 的输出逐字节不变**是本单对 E1 合同的承诺。

派生结论:「每个 Epic 卡里按徽标数出来的行数 == `root_counts[i].counts` 六个数」按构造成立,测试直接断言。

## 3. `FounderView`:形状与确定序

```ts
export interface FounderView {
  scopeUnavailable: boolean;          // #1147 合入后 = schema_version===2 && epic_scope.value===null;之前恒 false
  epics: EpicView[];                  // 只含「有未完成子单」的 root,已排序
  hiddenDoneEpics: number;            // 全做完(counts 非缺且 live+waiting+free+idle===0)的 root 数
  unattached: ChildView[];            // parent 缺的 item,已排序;通常为空
}
export interface EpicView {
  rootIndex: number;                  // /header/roots/value/N 与 /header/root_counts/N 共用
  identifier: string; title: string; url: string;
  state: { name: string; type: string };
  counts: RootCounts["counts"] | null;
  countsMissing?: { reason: "unknown_state_type"; detail: string };
  allWaitingOn: string[] | null;      // 「整块在等」:非 null ⇒ 显示;counts 缺 ⇒ null
  children: ChildView[];              // 未终态子单,已排序
  terminal: { done: number; canceled: number };   // 来自 counts;counts 缺 ⇒ 按 classifyItem 现数
}
export interface ChildView {
  itemIndex: number;                  // /items/N
  identifier: string; title: string; url: string | null;
  cls: ItemClass | null;              // null ⇒ 徽标写 state.name + (未知类型)
  stateName: string;
  blockers: Array<{ identifier: string; where: "same_epic" | "other_epic" | "outside"; otherRoot?: string }>;
                                      // 只含 blocker_state_type !== "completed" 的;升序
  progress: ProgressLine;             // §5
  signals: Signal[];                  // 原样透传
}
```

### 3.1 排序键(全序,不看输入顺序、不看时间)

```ts
const ROOT_GROUP: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 2 };  // 其它 3
const CHILD_GROUP: Record<ItemClass | "unknown", number> = { live: 0, waiting: 1, free: 2, idle: 3, unknown: 4, done: 9, canceled: 9 };
export function compareIdentifier(a: string, b: string): number {
  const m = /^([A-Za-z]+)-(\d+)$/;
  const [pa, pb] = [a.match(m), b.match(m)];
  if (pa && pb) {
    if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
    const [na, nb] = [Number(pa[2]), Number(pb[2])];
    if (na !== nb) return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;   // 码元序兜底;不用 localeCompare(不引入 ICU 变量)
}
// epics:  (ROOT_GROUP[state.type] ?? 3, compareIdentifier)
// children: (CHILD_GROUP[cls ?? "unknown"], compareIdentifier)
// blockers / allWaitingOn: compareIdentifier
```

🔶 为什么不用 `localeCompare`:`ready.v1` 用它(`rules.ts:51`),但那是文档层已裁定规则,不动;渲染层新加的序用显式数值比较,`FLY-999` 排在 `FLY-1000` 前,她按单号记位置更自然。两处序不冲突:`ready_items` 只在 Lead 诊断面板原样显示。

**稳定性证明**:键是文档字段的纯函数;`Array.prototype.sort` 在 Node ≥ 11 稳定;键相等只发生在 identifier 相同,而 `assertEpicPage` 禁止重复 identifier(`model.ts:980-987`)⇒ 序唯一。测试:同一文档两次 `buildFounderView` 深相等;把 `page.items` 与 `page.header.roots.value`(连同 `root_counts` 同步重排)倒序后再算,得到相同视图(除 `itemIndex / rootIndex` 指针);两次 `renderEpicPageHtml(page, sameNow)` 字符串逐字相同。

### 3.2 Epic 归属、隐藏、「整块在等」

1. `rootIds = Set(roots.value[].identifier)`,`byId = Map(items by identifier)`;对每张 item `rootOf(...)`:得 root ⇒ 归入;null ⇒ `unattached`。
2. 每个 root:`counts = root_counts[i].value?.counts ?? null`;`open = counts ? live+waiting+free+idle : children.filter(非终态).length`;`open === 0` ⇒ 不进 `epics`,若 `counts` 非缺则 `hiddenDoneEpics++`(counts 缺且 open===0 也隐藏,不计数 —— 极端情况:它没有任何未终态子单又有未知类型子单,按未知类型子单**未终态**处理 ⇒ open>0 ⇒ 显示;所以这个分支实际不可达,写测试固定)。
3. `allWaitingOn`:`counts && counts.live === 0 && counts.free === 0 && counts.idle === 0 && counts.waiting > 0` ⇒ 该 Epic `children` 中 `cls === "waiting"` 的 `blockers[].identifier` 并集,`compareIdentifier` 升序;否则 null。⛔ 不看 `dependency_review.all_blocked`(那是范围级、且只看 isSchedulable 的子单;这里是 Epic 级、含 backlog),两者定义域不同,不混。
4. `terminal`:`counts ? {done, canceled} : 现数`。

### 3.3 blocker 的「在哪」

```
blocker.in_scope === false                       ⇒ "outside"        文案「(范围外)」
blocker.in_scope === true:
  byId.get(blocker.identifier) 不存在            ⇒ "outside"        (合同上不该发生:in_scope 的定义就是在 items 里;守卫,不抛)
  rootOf(那张 item) === 本子单的 root             ⇒ "same_epic"      无后缀
  否则                                            ⇒ "other_epic"     文案「(在 FLY-ROOT)」,otherRoot = 那个 root
  rootOf 为 null(blocker 自己 no_parent)         ⇒ "other_epic"     otherRoot 写「没挂 Epic」的文案
```

只列 `blocker_state_type !== "completed"` 的 blocker(与 `classifyItem` 的 waiting 判据同源);canceled blocker 也算「没做完」—— 与 counts.v1 / ready.v1 一致(E1 exploration §2.3 已裁),Lead 诊断面板里的 `canceled_blocker` 条目仍在,页面不再另判。

## 4. 文案(全部走 `labels.ts`,零人名)

| key | 文案 | 参数 |
|---|---|---|
| `section.epics` | 在做的 Epic | — |
| `section.epics_count` | {n} 个(全做完的不列;状态照抄 Linear) | n |
| `epic.hidden_done` | 另有 {n} 个 Epic 全做完,不列 | n |
| `epic.none` | 范围内没有还没做完的 Epic | — |
| `epic.scope_unavailable` | Epic 范围不可用,这一版没有 Epic 卡 | — |
| `epic.unattached` | 没挂 Epic(取数时它的父单为空) | — |
| `counts.live` | {n} 在跑 | n |
| `counts.waiting` | {n} 等依赖 | n |
| `counts.free` | {n} 可起跑 | n |
| `counts.idle` | {n} 未开始 | n |
| `counts.total` | 共 {n} | n |
| `counts.missing` | 计数缺失:不认识状态类型 {type} | type |
| `epic.all_waiting` | 整块在等 {blockers} | blockers |
| `epic.terminal_tail` | 另有 {tail}(不列) | tail =「N 张已完成」「M 张已取消」用 · 连接;两者皆 0 不出这一行 |
| `child.live` | 在跑 | — |
| `child.waiting` | 等 {blockers} | blockers =「FLY-A / FLY-B」,>3 个 ⇒「FLY-A / FLY-B / FLY-C 等 {n} 张」 |
| `child.free` | 可起跑 | — |
| `child.idle` | 未开始 | — |
| `child.unknown_type` | {state}(未知类型) | state = state.name |
| `blocker.outside` | (范围外) | — |
| `blocker.other_epic` | (在 {root}) | root |
| `blocker.unattached` | (没挂 Epic) | — |
| `progress.live` | 到「{node}」· 第 {attempt} 次 · 会话 {status} | node / attempt / status,任一缺写「不知道」 |
| `progress.live_no_run` | 在跑(引擎还没报节点) | — |
| `progress.waiting` | 被 {blockers} 挡着,没起跑 | blockers |
| `progress.free` | 原本等 {blockers},它已经做完了 —— 现在没人挡着 | blockers = 全部 blocker(都 completed) |
| `progress.idle` | 还没起跑 | — |
| `progress.missing` | 执行事实缺失:{reasons} | reasons = 缺失格的 reason 去重 |
| `progress.source` | 机器测的 | — |
| `section.lead_panel` | 给 Lead 看的诊断(默认收起) | — |
| `audit.linear_issue` | Linear issue {id} | id |
| `audit.seen` | 看到 {at} | at |
| `audit.source_updated` | 源 {at} | at |

`page.title` 保持「项目执行页面」不改(固定页标题变动会影响既有断言与 Lead 认知;改标题不在本单)。

## 5. F5 「在跑到哪一步」的成分与出处(每段能指回字段)

| 段 | 字段 | 缺时 |
|---|---|---|
| 「到「X」」 | `run.value[0].current_node_label`(`label_source` 不显示,进审计格) | `run.value` 空 ⇒ 整句用 `progress.live_no_run` |
| 「第 N 次」 | `attempt.value[0].attempt` | 空 ⇒ 「不知道」 |
| 「会话 S」 | `session.value.latest[0].status` | 空 ⇒ 「不知道」 |
| 任一格 `value === null`(statestore_error) | — | 整句 `progress.missing`,列 reason;⛔ 不猜 |

`gates / carriers / land / ledger_live_count` 不进首屏,只在审计格(今天首屏那句 `executionSummary` 原样保留在审计 details 的 `run` 格之后,作为「机器原话」一行,`data-cell="/items/N/execution"`?—— ✗ 不加新 data-cell,它不是 Cell;直接作为审计 details 顶部一行纯文本,`render.test.ts` 的 `ledger_live_count` 断言改为在该 details 内查找)。

信号:`signals` 非空时在进度行下加一行 pill(沿用 `signalList`),`waiting_founder` 与其它分开两行(与今天卡内两行同义);空则不出行(⛔ 不写「无」占位,首屏只放有事的)。

## 6. HTML 结构(具体标记)

```html
<main>
  <!-- 插槽 A:attention(#1147),见 §8 -->
  <header data-generated-at="…">
    <div class="eyebrow">项目执行页面</div><h1>{project} · 项目执行页面</h1>
    <div class="lede"><span>{n} 个在做的 Epic</span><span>{items} 张子单</span><span>生成时间: …</span><span>已获 founder 裁定的规则 scope.v2</span></div>
    <div class="freshness-age" data-opened-age>你打开时它已 0 分钟旧</div>
    <details class="audit"><summary>3 格出处与时间</summary>…header 三格(不变)…</details>
  </header>
  <div class="section-title"><h2>在做的 Epic</h2><span>{n} 个(全做完的不列;状态照抄 Linear)</span></div>
  <details class="epic" data-root="FLY-2441" data-state-type="started">        <!-- 无 open 属性 -->
    <summary>
      <span class="e-st" data-state-type="started">In Progress</span>           <!-- roots.value[i].state.name 原话 -->
      <a class="mono e-id" href="https://linear.app/…">FLY-2441</a>
      <span class="e-n">{title}</span>
      <span class="e-c">0 在跑 · 3 未开始 · 1 可起跑 · 共 11</span>
      <span class="e-wait">整块在等 FLY-2445</span>                              <!-- 仅 allWaitingOn 非 null -->
    </summary>
    <div class="e-b">
      <!-- 插槽 B1:root lead_note(#1148) -->
      <div class="kid" data-item="FLY-2459" data-class="waiting">
        <div class="kid-h"><span class="s s-waiting">等 FLY-2445 (在 FLY-1143)</span><a class="mono" href="…">FLY-2459</a><span class="kid-t">{title}</span></div>
        <div class="kid-a">↳ 被 FLY-2445 挡着,没起跑 <span class="src">机器测的</span></div>
        <!-- 信号行(仅非空) -->
        <!-- 插槽 B2:item lead_note(#1148) -->
        <details class="audit"><summary>15 格出处与时间</summary>
          <div class="audit-head"><a href="{url}">{url}</a> · 机器原话:{executionSummary}</div>
          <div class="audit-cell" data-cell="/items/7/parent"><b>父单</b> <code>FLY-2441</code> <span>Linear · issue:{uuid} · parent · 看到 {observed_at} · 源 {source_updated_at}</span></div>
          … 共 15 格(parent,title,url,state,priority,blocked_by,blocks,acceptance,founder_named,session,run,attempt,gates,carriers,land)…
        </details>
      </div>
      <div class="kid-tail">另有 5 张已完成 · 2 张已取消(不列)</div>
      <details class="audit"><summary>2 格出处与时间</summary>
        <div class="audit-cell" data-cell="/header/roots">…(与今天 renderAuditCell 同款)…</div>
        <div class="audit-cell" data-cell="/header/root_counts/2">…counts.v1 · 已获 founder 裁定的规则 · 由 … 推出…</div>
      </details>
    </div>
  </details>
  <p class="epic-hidden">另有 2 个 Epic 全做完,不列</p>                           <!-- 仅 hiddenDoneEpics>0 -->
  <!-- unattached:同一张卡结构,summary 只有「没挂 Epic(…)」,仅非空时 -->
  <details class="lead-panel"><summary>给 Lead 看的诊断(默认收起)</summary>
    {renderFreshness} {ready-card} {stuck} {waiting_founder} {dependency_review} {scope roots} {founder/done/gaps}   <!-- 今天的总览区原样,data-cell 不变 -->
  </details>
</main>
<script nonce="__CSP_NONCE__">…只更新 [data-opened-age];#1148 合入后其淡化逻辑并入同一块…</script>
```

- `data-cell` 属性一个不少:8 个根格在 lead-panel;每张**已列出**子单 15 格;每张 Epic 卡 `/header/roots` + `/header/root_counts/i`。`render.test.ts:452` 的逐格对拍(值 / 出处标记 / observed_at)对 `htmlBlock(html, "/items/0/title")` 切到下一个 `data-cell=` 为止 ⇒ 每格自含 `issue:{uuid}`、值、`observed_at`;URL 只在 `audit-head` 出一次。
- 所有插值经 `escapeHtml`(✅ 转义 `& < > " '`,`xhs-review-html.ts:24-31`);URL 只经 `safeLinearLink`(`https://linear.app/` 前缀白名单,`render-html.ts:40-44` ✅)进 `href`。
- 唯一脚本块;不引外部资源;不自带 CSP。

## 7. 字节预算(实测推算,plan §7 以 fixture 复测)

| 项 | 今天(✅ 实测) | 设计后(🔶 估) |
|---|---|---|
| style | 3.8KB | ~5KB(加 epic / kid / lead-panel 类) |
| header | ~2KB | ~2KB |
| Lead 诊断区 | 79KB(36 张时;派生 `from` 指针 ≈250 B/张) | 不变:~45KB 固定 + 250 B × 全部 items |
| 每张未终态子单 | 10.7KB | ~5KB(可见行 ~1.2KB + 审计 15 格 × ~230 B + `audit-head` ~0.3KB;`acceptance` 值只出 ≤240 字预览) |
| 每张终态子单 | 10.7KB | **0**(只进计数行) |
| 每张 Epic 卡壳 | 0(只有 pill) | ~0.8KB + 2 格审计 ~1KB |
| 今天的真数据(7 根 / 36 张 / 18 未终态) | 469,843 B | ~ 5 + 2 + 54 + 90 + 13 ≈ **165KB** |
| 天花板 | 45 张(任何状态) | ≈ 90 张未终态子单(全部 items 60 张时);超限仍 `epic_html_too_large` 停上一版 |

预算测试(plan §6):8 根 × 各 11 张未终态子单 = 88 张,标题 120 字、验收 4,096 B、各 3 条 blocker、run/session/attempt 有值 ⇒ 断言 ≤ 524,288;并保留今天的 60 张用例。实现时把这两个数与真数据重放字节写进 evidence。

## 8. 两个插槽的接口(Lead 要求:输入字段 / 渲染位置 / 空值行为)

| 插槽 | 输入 | 位置 | 空值 |
|---|---|---|---|
| A · attention(#1147 `renderAttention(page, now)`) | `page.schema_version === 2` 时的 `page.attention[] / page.discord / page.epic_scope`;v1 文档无此字段 | `<main>` 第一个子节点,在 header 之前,**不在任何 `<details>` 内** | v1 文档:输出空串(E3 骨架自带 `renderAttentionSlot = () => ""`);合入 #1147 后该函数体替换为它的 `renderAttention`。`scopeUnavailable` ⇒ E3 的 Epic 区输出 `epic.scope_unavailable` 一句,lead-panel 只含 freshness |
| B1 · root lead_note(#1148 `renderLeadNotes(root.lead_note, now, fadeDays)`) | `header.roots.value[i].lead_note?: Cell<string>[]`、`page.lead_note_policy?.value.fade_after_days` | Epic 卡 `.e-b` 第一个子节点(子单行之前) | 字段缺或空数组 ⇒ 空串;⛔ 不出「暂无判断」占位(PRD F12) |
| B2 · item lead_note | `items[i].lead_note?` | 子单行进度行与信号行之后、审计 details 之前 | 同上 |

E3 骨架里两个插槽是三个显式命名的函数调用点,函数体在 #1147 / #1148 合入后由实现体替换为它们的实现;它们的样式块并入同一个 `<style>`;#1148 的脚本段并入同一个 nonce 脚本。数据层(生成 / 校验)完全不碰。

## 9. 测试基线(要动的文件与理由)

| 文件 | 今天 | 要做 |
|---|---|---|
| `rules.test.ts` | `counts.v1` 用例 | 不改;新增 `describe("classifyItem")` 六类 + 未知 ⇒ null;`rootOf` 三种(直达 / 孙单 / 缺) |
| `__tests__/founder-view.test.ts`(新) | — | 分组序、组内数值序、`FLY-999` < `FLY-1000`、两次深相等、倒序输入同视图、隐藏全做完、`hiddenDoneEpics`、`allWaitingOn`(三种:全等 / 有 idle 不算 / counts 缺不判)、blocker 三种 where、未知类型子单 cls null 且 Epic 不隐藏、no_parent 进 unattached、行数按徽标 == counts |
| `render.test.ts` | §exploration 1.5 列的 7 条 | 改写:卡数 = 未终态数;首屏零 `open`;徽标文案;整块在等在 `<summary>` 内;跨 Epic 后缀;`lead-panel` 在最后一张 Epic 之后;两次渲染逐字相同;15 格 data-cell;`ledger_live_count` 在审计 details 内;新增 88 张预算用例 |
| `labels.test.ts` | 机制 | 加:所有新 key 可渲染、参数缺失抛错 |
| `fixtures/epic-shape.ts` | `epicShapeSnapshot / V2` | 新增 `epicShapeSnapshotV3()`:3 根(started / started 全做完 / started 只有 waiting 子单)、子单覆盖六类 + 跨 Epic blocker + 范围外 blocker + no_parent 一张;`itemFacts` 给 live 子单真 run/attempt/session |

`generate.test.ts / model.test.ts / scope-v2.test.ts / residual.test.ts / statestore-epic-page.test.ts / epic-page-route.test.ts / epic-page-publisher.test.ts` 零改动 —— 跑一遍确认(数据层没动)。

## 10. 与 E1 evidence 中「未完成」项的关系

E1 evidence 明写「本单不渲染 parent / root_counts」「瘦身列为 E3 候选」;本单正是那两项。E1 的 44 张天花板记录随本单作废,由 plan §7 的新实测替换。
