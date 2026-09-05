# FLY-2141 Epic 残余扫描 — 调研
Issue: FLY-2141 (https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活)
日期: 2026-09-03
基于: exploration.md

> 世界标记:main `e85eec9a8`(2026-09-03);FLY-2140 `fd5ac60c9`、FLY-2144 `4555e82bc` 均在其中。行号以该 commit 为准。本文写**合同与数字**;取舍理由在 exploration.md;做什么、按什么序、怎么证明在 plan.md。

## 0. 读法

- **✅** = 本单在代码/库里核过;**📖** = 读自兄弟单文档;**⬜** = 未核,实现节点要核。
- 「事实」= Bridge 采到的读数;「判断」= Lead 的决定。Bridge 的任何输出都只能是前者。

---

## 1. 改动面地图

| 文件 | 改动 | 新/改 | 行数量级 |
|---|---|---|---|
| `packages/teamlead/src/epic-page/residual.ts` | **新**:`summarizeEpicResidual(page, resolveOwner)` 与类型 `EpicResidualFact`、`EPIC_RESIDUAL_UNAVAILABLE_TOKENS` | 新 | ~120 |
| `packages/teamlead/src/epic-page/materialize.ts` | **新**:`materializeEpicPage()` —— fetch → facts → generate → assert → buildReceipt,**不插入回执**;route 与 scan 共用 | 新 | ~60 |
| `packages/teamlead/src/bridge/epic-residual-scan.ts` | **新**:`createEpicResidualScan(deps)` ⇒ `{ materializeForScan(project), summarizeForLead(m, leadId, trigger) }`(项目级 materialize + 插入 scan 回执 fail-soft;Lead 级 summarize 纯函数包装);**永不 reject** | 新 | ~150 |
| `packages/teamlead/src/bridge/patrol-tick.ts` | `PatrolTickDeps.epicResidual?`;pass 内 `epicOnce(project)` memo;名册空的分支;payload `epic?` 键;空轮抑制 memo | 改 | +60 |
| `packages/teamlead/src/bridge/hook-payload.ts` | `HookPayload.epic?`;`renderEpicResidualSection()`(一次 assert ⇒ `{triggerLines, factLines}`);两条 return 路径插入 | 改 | +90 |
| `packages/teamlead/src/bridge/plugin.ts` | 组 deps 注入 `epicResidual`;启动时对无绑定项目 `console.warn` 一行 | 改 | +25 |
| `packages/teamlead/src/bridge/epic-page-route.ts` | **不改**行为;改用 `materializeEpicPage`,插入回执仍在 route 自己的 `generationTails` 内且 fail-loud(纯搬家,route 既有测试字节级不变 + 1 条 insert-抛 characterization) | 改(重构) | ±40 |
| `packages/teamlead/lead-rules-base/runner-patrol-rules.md` | 新小节 §0.x「回头看 Epic 还剩什么,有位就拉一件(FLY-2141)」 | 改 | +40 |
| `packages/teamlead/lead-rules-base/department-lead-rules.md` | §0 容量小节末尾加一句交叉引用 | 改 | +3 |
| 测试 | `epic-page/__tests__/residual.test.ts`(新)、`bridge/__tests__/epic-residual-scan.test.ts`(新)、`__tests__/patrol-tick.test.ts`(追加 + 改 1 条)、`__tests__/patrol-tick-render.test.ts`(追加)、`__tests__/fly2141-epic-residual-rule.test.ts`(新) | | |

**零新增**:flag、timer、config 键、HTTP 路由、CLI 子命令、表、告警通道。

---

## 2. `summarizeEpicResidual` —— 从一份 EpicPage 算出「还剩什么」

### 2.1 输入(全部来自 2140 已有模型 ✅ `epic-page/model.ts:48–139`)

| 读的格 | 用途 |
|---|---|
| `page.items[i].identifier` | 子单号(渲染只用它) |
| `page.items[i].state.value.type` | `completed` / `canceled` 剔除 |
| `page.items[i].priority.value` | 渲染 `P<n>`;`0` 渲染 `P-`(2140 的排序把 0 放最后 ✅ `rules.ts:12–14`) |
| `page.items[i].session.value.ledger_live_count` | `running` 计数(账面);任一 remaining 子单该格 `missing` ⇒ **抛**(整块 `transient: session_ledger_unreadable`,见下文) |
| `page.ready_items.value` | ready 集合与顺序(规则 `ready.v1`,founder 已裁)⛔ 不重算 |
| `page.header.roots.value.length` | `roots` |
| `page.generated_at` / `items[i].*.observed_at`(Linear 格 = `snapshot.fetchedAt`)| 两个时间戳 |
| 子单 `labels` | ⚠️ **EpicPage 模型没有 `labels` 格**(只有 `founder_named` 布尔 ✅ `model.ts:68`)。归属需要原始 labels ⇒ `summarizeEpicResidual` 额外收 `snapshot.items[].labels`(与 page 同一次生成的快照,`generate.ts:83` 已保证 `itemFacts.length === snapshot.items.length` 且顺序一致) |

### 2.2 输出

```ts
// rev 3(Codex R2 BLOCKER-1):discriminated union —— unavailable 分支不再被迫伪造时间
export type EpicResidualFact = EpicResidualAvailable | EpicResidualUnavailable;

export interface EpicResidualAvailable {
  schemaVersion: 1;
  kind: "available";
  generatedAt: string;          // page.generated_at(ISO)
  linearObservedAt: string;     // snapshot.fetchedAt(ISO)
  rule: "ready.v1";
  trigger: "roster" | "scope";  // "scope" = 名册为空、由范围触发(Lead 裁定要写明)
  roots: number;
  remaining: number;            // state.type ∉ {completed, canceled}(范围本身已剔 backlog)
  ready: number;                // page.ready_items ∖ running
  running: number;              // remaining 中 ledger_live_count > 0 者
  blocked: number;              // remaining − ready − running
  readyForLead: Array<{ identifier: string; priority: number; ownership: "label" | "general" }>; // ≤ 5
  readyForLeadTotal: number;
  remainingForLead: number;     // 归本 Lead 的 remaining(三态都算);名册空触发的判据与触发说明行的数
  generalCount: number;         // remaining 中 matchMethod==="general" 者(§2.3)
}

export interface EpicResidualUnavailable {
  schemaVersion: 1;
  kind: "unavailable";
  token: string;                // 恰好一个,过 isEpicResidualUnavailableToken
  trigger: "roster" | "scope";
  generatedAt: string | null;   // 失败发生在 materialize 之后(session_ledger_unreadable / epic_residual_invalid)才有真值;之前 ⇒ null
  linearObservedAt: string | null; // 同上;⛔ 禁止用 now() 冒充 Linear 观测时间
}
```

**不变量**(`assertEpicResidualFact`:schema 断言 + 渲染器共用同一函数校验;rev 3 补齐 Codex R2 HIGH-3):
- 两分支共同:`schemaVersion === 1`、`kind ∈ {available, unavailable}`、`trigger ∈ {roster, scope}`。
- available:八个计数字段(`roots, remaining, ready, running, blocked, readyForLeadTotal, remainingForLead, generalCount`)均为安全非负整数;`ready + running + blocked === remaining`;`remainingForLead ≤ remaining`;`generalCount ≤ remaining`;`readyForLead.length ≤ 5` **且** `readyForLead.length ≤ readyForLeadTotal ≤ ready`(total 可为 0);`trigger === "scope"` ⇒ `remainingForLead > 0`;`rule === "ready.v1"`;两个时间可 `Date.parse`;每项 `priority` 为 0–4 整数、`ownership ∈ {label, general}`、`identifier` 过 `PATROL_TOKEN_GRAMMAR` + 禁词表且**在数组内唯一**;顺序 = `ready_items` 顺序的子序列。
- unavailable:`token` 过 `isEpicResidualUnavailableToken`(单个,不是数组);两个时间各自为 `null` 或可 `Date.parse`。
- **identifier 策略唯一**(Codex R2 HIGH-3):不合文法 ⇒ assert 抛 ⇒ 整块 fail-closed;⛔ 不走 `canonicalPatrolToken` 的 `unsafe-<hash>` 降级(Linear identifier 形如 `FLY-2141` 天然满足文法,不满足即是数据/注入异常)。
- `running` 与 `ready` 可以**同时**包含同一张子单吗?可以:`ready.v1` 不看 StateStore(2140 §11.5)。**为避免 Lead 对一张账面在跑的子单再拉一次**,`readyForLead` **剔除** `ledger_live_count > 0` 的子单,并把它们计入 `running` 而非 `ready`;即本文的 `ready` 定义 = `page.ready_items` ∖ `running`。⚠️ 这是本单的**呈现层**收窄,⛔ 不改 `ready.v1` 本身;渲染文本写「现在可以开始的(已剔除账面在跑)」。Lead 再拉时 `runs/start` 仍会 409(✅ `xiaohongshu-scheduler.ts:244` 注释;`runs-route.ts` 既有),但那是**后置防线**,不是已验证事实。
- **`session` 格 missing(rev 2,Codex R1 HIGH-2)**:任一 remaining 子单的 `session.value === null && missing` ⇒ 无法判断它是否账面在跑 ⇒ 「已剔除账面在跑」这句话不成立 ⇒ `summarizeEpicResidual` 抛 `EpicResidualSessionUnreadableError`,整块退化为 `transient: session_ledger_unreadable`(表名只进 log)。⛔ 不把未知当空闲。已终态(completed/canceled)子单的 session missing 不影响。

### 2.3 归属

`resolveOwner(labels) → { agentId, matchMethod, canSpawn }` 由调用方注入(patrol-tick 传 `resolveLeadForIssue(projects, projectName, labels)` ✅ `ProjectConfig.ts:1076–1099`)。与名册分 Lead 用**同一函数**,两账口径一致。`matchMethod: "general"` 的含义是「**没命中任何已配置 Lead 的 label**」(labels 为空或只有无关 label 都算),落到 `project.leads[0]`,渲染标 `ownership: "general"`。

**`generalCount`(rev 2 定义,Codex R1 MEDIUM-5)** = remaining 中 `matchMethod === "general"` 的数量,**无论默认 Lead 能否派单都计**。正文措辞「未命中 Lead label <n>」,⛔ 不写「无 label」。

⚠️ `project.leads[0]` 可能是 `canSpawnRunners:false` 的 CoS(生产 flywheel 的 `leads[0]` = `flywheel-cos-lead` ✅ `projects.json`):名册那边把这种情况报成 `unowned_roster` 告警(✅ `patrol-tick.ts:119–146`)。本单**不**为此新增告警(⛔ 禁新告警层);`canSpawn === false` 只决定该子单**不进入任何 Lead** 的 `readyForLead` / `remainingForLead`,它仍在 `generalCount` 里让 Lead 看得见。

---

## 3. Bridge 侧 builder —— 两层(rev 2 定稿,Codex R1 BLOCKER-1)

```ts
// epic-page/materialize.ts(新;route 与 scan 共用;⛔ 不插入回执)
export async function materializeEpicPage(
  deps: { fetchSnapshot; readItemFacts; generatePage; buildReceipt; now },
  input: { projectName; binding; apiKey; trigger: EpicPageTrigger },
): Promise<{ page: EpicPage; snapshot: LinearActiveScopeSnapshot; receipt: EpicPageRenderReceipt }>

// bridge/epic-residual-scan.ts(新)
export type EpicScanMaterialized =
  | { kind: "ok"; materialized: MaterializedEpicScope }
  | { kind: "unavailable"; token: string }
  | undefined;
export interface EpicResidualOwner { agentId: string; matchMethod: "label" | "general"; canSpawn: boolean }
export function createEpicResidualScan(deps: {
  store: Pick<StateStore, "insertEpicPageRenderReceipt" | /* readEpicItemFacts 所需 */ ...>;
  projects: ProjectEntry[]; linearApiKey?: string;
  resolveOwner: (projectName: string, labels: string[]) => EpicResidualOwner;   // rev 4:显式依赖;summarizeForLead 闭包使用
  fetchSnapshot?; generatePage?; now?; log?;
}): {
  materializeForScan(project: ProjectEntry): Promise<EpicScanMaterialized>;                 // 项目级;永不 reject
  summarizeForLead(m: EpicScanMaterialized, leadId: string, trigger): EpicResidualFact | undefined;  // Lead 级;纯
}
```

**`materializeForScan(project)`**:

| 步 | 做什么 | 失败 ⇒ |
|---|---|---|
| 0 | `resolveProjectLinearBinding(projects, project.projectName)`(✅ `ProjectConfig.ts:1017–1027`,null→undefined)或 `deps.linearApiKey` 缺 | **返回 `undefined`**(键缺席,字节不变) |
| 1 | `materializeEpicPage(...)` 内:`fetchSnapshot(apiKey, binding)`(✅ `linear-epic-query.ts:184`;默认 deadline 20s、maxItems 500),随后显式 `items.length > MAX_SCOPE_ITEMS(500)` 守卫 | `LinearUpstreamError` ⇒ `transient: linear_unavailable`;`ActiveScopeNotFoundError` ⇒ `structural: active_scope_not_found`;`EpicTooLargeError`(fetcher 或守卫)⇒ `structural: scope_too_large`;`EpicSnapshotTruncatedError` ⇒ `structural: scope_snapshot_truncated`。**这些都发生在 page/snapshot 之前 ⇒ fact 的两个时间为 `null`** |
| 2 | 内:每张子单 `readEpicItemFacts(store, project, {uuid, identifier})`(✅ `StateStore.ts:63250`;本身已 fail-soft 到 `{ok:false, table}`) | 不会抛;单格 missing 进 gaps(2140 既有);**session missing 的后果在 summarize 层判**(§2.2) |
| 3 | 内:`generatePage({…, trigger: "scan"})` + `assertEpicPage` + `buildReceipt` | `EpicPageSchemaError` ⇒ `structural: epic_page_invalid` |
| 4 | **scan 自己**调 `insertEpicPageRenderReceipt({projectName, trigger:"scan", receipt})`(✅ `StateStore.ts:9290–9330`,事务内分配 version、裁到 20 版;sql.js 同步 ⇒ 与 route 的手动生成不会交错) | **写回执失败不影响事实**:log 一行,**仍返回 `ok`**(回执是给 D 的地基,不是本单判据)。route 那边对同一失败保持 fail-loud 500(既有) |
| 任意 | 其它异常 | `{kind:"unavailable", token:"transient: epic_scan_failed"}` + log(含 error.message,⛔ 不进 payload) |

**`summarizeForLead(m, leadId, trigger)`**:`undefined ⇒ undefined`;`{kind:"unavailable", token} ⇒ { kind:"unavailable", token, trigger, generatedAt:null, linearObservedAt:null }`(materialize 之前失败,没有真时间,⛔ 不用 `now()` 冒充);`ok ⇒ summarizeEpicResidual({materialized, leadId, resolveOwner, trigger})`,其中 `EpicResidualSessionUnreadableError ⇒ { kind:"unavailable", token:"transient: session_ledger_unreadable", generatedAt: page.generated_at, linearObservedAt: snapshot.fetchedAt }`、断言失败 ⇒ 同形 `structural: epic_residual_invalid`(materialize 之后失败,保留已有真时间)。这两种是 **Lead 级**退化;同 pass 另一个 Lead 不受影响(同一份 materialized 再 summarize 一次)。

**`materializeEpicPage` 内的 500 项守卫**(rev 3,Codex R2 MEDIUM-5):fetch 之后、读六格之前显式 `if (snapshot.items.length > MAX_SCOPE_ITEMS) throw new EpicTooLargeError(...)`(✅ 与 `epic-page-route.ts:142–145` 现状同位、同常量 500),route 与 scan 共用;⛔ 不能依赖默认 fetcher 的 `maxItems`(注入的 fetcher 可绕过)。route 既有 501 项 ⇒ 422 用例零改动。

**allowlist**(精确集合,与 `CAPACITY_UNAVAILABLE_TOKENS` 同形 ✅ `machine-free-pct.ts:22–48`,但**独立常量**,不混进容量集合;八个):

```ts
export const EPIC_RESIDUAL_UNAVAILABLE_TOKENS = new Set([
  "transient: linear_unavailable",
  "structural: active_scope_not_found",
  "structural: scope_too_large",
  "structural: scope_snapshot_truncated",
  "structural: epic_page_invalid",
  "structural: epic_residual_invalid",
  "transient: session_ledger_unreadable",
  "transient: epic_scan_failed",
]);
export function isEpicResidualUnavailableToken(v: unknown): v is string  // 文法 /^(structural|transient): [a-z][a-z0-9_]{0,47}$/ ∧ 在集合内
```

builder 与渲染器共用同一函数(2144 R5 教训:builder 产出的 token 必须逐个过渲染器的校验,单测断言)。

**成本(✅ 数字来源标注)**:
- Linear:roots 1 请求 + 每个 active 父单 ≥1 请求(50 子单/页)+ 关系溢出页;flywheel 今天 3–5 个 started 父单 ⇒ **≈4–7 请求/次**;每请求 `x-complexity`≈104(📖 2140 research §2.4 实测),小时预算 3,000,000 ⇒ 每小时 2 个 Lead × 7 ≈ 1,500 点,占 **0.05%**。
- StateStore:每张子单 ≤5 组同步投影;5–30 张 ≈ 7–40ms(📖 2140 implementation-notes);200 张 ≈ 1.4s 是 2140 记下的**警戒线**,本单不改读取形状(同 2140 裁定),但 **⬜ 实现节点要在 pass 里记一次耗时 log**(`[patrol_tick] epic scan project=… items=N ms=M`),让 D/后续性能单有数。
- 同一 pass 内每个项目**最多算一次**(memo,见 §4),两个 Lead 同项目同分钟到点共享同一份;不同分钟到点各算各的(每次都带自己的两个时间戳,⛔ 不自称同一份)。

---

## 4. `patrol-tick.ts` 的改动(精确到既有行)

### 4.1 deps(rev 2 唯一接口)

```ts
epicResidual?: {
  materializeForScan(project: ProjectEntry): Promise<EpicScanMaterialized>;
  summarizeForLead(m: EpicScanMaterialized, leadId: string, trigger: "roster" | "scope"): EpicResidualFact | undefined;
};
```

### 4.2 pass 内 memo 与调用点

```ts
const epicByProject = new Map<string, Promise<EpicScanMaterialized>>();
const epicOnce = (project) => {            // key 只按 project;一个 pass 内同项目 materialize 一次
  let p = epicByProject.get(project.projectName);
  if (!p) { p = Promise.resolve().then(() => deps.epicResidual?.materializeForScan(project)).catch(() => undefined); epicByProject.set(project.projectName, p); }
  return p;
};
const epicForLead = async (project, leadId, trigger) => {
  try { return deps.epicResidual?.summarizeForLead(await epicOnce(project), leadId, trigger); } catch { return undefined; }
};
```

两个 Lead 从同一份 materialized 切片 ⇒ **同一个 `generatedAt`**(与 2144 B16「同一 pass 两个 Lead `capacity.generatedAt` 相同」同构);回执也只写一条。

### 4.3 名册空的分支(改 ✅ `patrol-tick.ts:222–226`)

现状:

```ts
if (roster.length === 0) { failures.succeeded(...); continue; }
```

改为:

```ts
if (roster.length === 0) {
  if (!deps.epicResidual) { failures.succeeded(...); continue; }            // 未注入 ⇒ 既有行为
  const currentScheduledAt = scheduledAtOrBefore(nowMs, lead.agentId, intervalMs);
  const emptySlotKey = `${project.projectName}:${lead.agentId}`;             // rev 4:显式字符串键(与 failure tracker 同模式 ✅ L413–419);⛔ 不拼对象
  if (emptySlotSeen.get(emptySlotKey) === currentScheduledAt) { succeeded; continue; }  // 本 slot 已看过 ⇒ 不再扫
  // 先做与非空名册完全相同的 settlement 判定(previous tick 是否已服务本 slot)——复用同一段代码,⛔ 不复制
  ...若本 slot 已被服务 ⇒ succeeded; continue;
  const epic = await epicForLead(project, lead.agentId, "scope");
  if (!epic || epic.kind !== "available" || epic.remainingForLead === 0) {  // unavailable ⇒ 静默(判据固定,rev 4)
    emptySlotSeen.set(emptySlotKey, currentScheduledAt); succeeded; continue;
  }
  // 否则走下面的正常铸造路径,roster=[],loops 缺席,epic.trigger="scope"
}
```

**「归他的未完成项」的定义** = `remainingForLead > 0`(归本 Lead 的 remaining,含 ready / blocked / running 三态;§2.3 的归属规则)。`remainingForLead` 与 `generalCount` **只存在于 available 分支**(§2.2);unavailable 分支没有计数,判据就是 `kind !== "available"` ⇒ 静默。Lead 裁定原话的「范围内还有 N 件归你」渲染的就是 `remainingForLead`。

**抑制 memo**:`emptySlotSeen: Map<string, number>` 在 `createLeadPatrolTickPass` 闭包里(与 `consecutiveFailures` 同处 ✅ L404–412),键 = `"<projectName>:<leadId>"`;Bridge 重启 ⇒ 每 (project, lead) 多扫一次,可接受。**⛔ 不落库**(那就是新的状态)。**回归用例 B20**(Codex R3 HIGH-2):两个项目、同一 Lead id、同 interval、同一 pass:第一个项目该 Lead 无归属项(静默并记 memo),第二个项目有归属项 ⇒ 第二个项目**仍铸 tick**;键若碰撞此用例即红。

### 4.4 payload(改 ✅ L371–381)

```ts
const epic = roster.length === 0 ? epicFromEmptyBranch : await epicForLead(project, lead.agentId, "roster");
const payload: HookPayload = { ..., ...(capacity ? { capacity } : {}), ...(epic ? { epic } : {}), generated_at, scheduled_at };
```

`epicResidual` 未注入 / `materializeForScan` 返回 `undefined` 或 reject 或同步 throw / `summarizeForLead` 返回 `undefined` 或 throw ⇒ 无 `epic` 键(与 2144 B18 同形)。

### 4.5 顺序与并发

- 容量与 Epic 两个 builder 在同一 Lead 的铸造路径里**并行** `await Promise.all([capacityOnce(), epicOnce(project)])`;Epic builder 有 20s Linear deadline,pass 的单飞守卫(✅ L444–456)保证不叠 pass。
- ⚠️ 60s rider 上一个 pass 最长可能 ~20s(Linear 超时时);既有 `inFlight` 守卫会让下一分钟直接返回同一个 promise,不排队。**⬜ 实现节点核**:GatePoller 对 rider 的错误隔离(✅ `gate-poller.ts:674–682` 已 try/catch)。

---

## 5. `hook-payload.ts` 渲染合同

### 5.1 位置与形状(rev 2:一个受保护 renderer,Codex R1 HIGH-3)

`renderEpicResidualSection(epic | undefined): { triggerLines: string[]; factLines: string[] }`:缺席 ⇒ 两个空数组;存在 ⇒ **先** `assertEpicResidualFact(epic)`(与 builder 同一函数),**再**同时生成两组行;assert 抛 ⇒ `triggerLines: []`,`factLines: ["还剩什么=⚠️ 账面不可读(invalid_epic_residual)"]`(固定常量,⛔ 不含任何输入值)。两条 return 路径(✅ `legacyPatrolBody` L459–476;分组路径 L997–1010):`triggerLines` 紧跟首行 `[patrol_tick] 巡检时间到。` 之后;`factLines` 在 `...capacityLines` **之后**、名册声明行之前。

### 5.2 文本(逐字合同;`<…>` 为值)

```
(本轮由 Epic 范围触发:你名下账面没有未终结 runner,但范围内还有 <remainingForLead> 件归你。)      ← 仅 trigger="scope",且仅当 assert 通过
还剩什么(Bridge 按 Linear 扫 · 规则 ready.v1 已获 founder 裁定 · 判断输入,不是派单;Linear 观测 <linearObservedAt>;生成 <generatedAt>;范围=<roots> 个 active 父单):
- 范围内 <remaining> 张未完成:现在可以开始的 <ready>(已剔除账面在跑)· 等前置的 <blocked> · 账面在跑的 <running> · 未命中 Lead label <generalCount>
- 现在可以开始且归你(按 Lead 归属规则)<readyForLeadTotal> 张:<ID>(P<n>) <ID>(P<n>,general) …(+<k> more,见 flywheel-comm epic-page show --format md)
```

- 两个时间都经 `Date.parse` 校验后 `toISOString()`(Codex R1 HIGH-4);任一不可 parse ⇒ 整块退化。
- 第三行措辞「按 Lead 归属规则」(rev 3,Codex R2 HIGH-4):`ownership:"label"` 的项只写 `<ID>(P<n>)`;`ownership:"general"`(没命中 label、落到可派单的默认 Lead)的项写 `<ID>(P<n>,general)`,让 Lead 看得出哪张不是 label 命中。
- `readyForLeadTotal === 0` ⇒ 第三行写 `- 现在可以开始且归你(按 Lead 归属规则)0 张`(⛔ 不省略这一行——「0」也是事实,与 2140「founder_items 零命中也要显示」同理)。
- `kind === "unavailable"` ⇒ `factLines` 只剩一行 `还剩什么=?(<token>)`,`triggerLines` 为空(scope 触发要求 epic 可用,这组合不会出现;测试仍断言渲染器对它不抛且无触发行)。
- shape 非法(计数为负、`ready+running+blocked≠remaining`、identifier 非文法、token 不在 allowlist、`token` 非字符串或不在 allowlist、任一时间不可 parse、`readyForLead.length>5`、priority 越界、非法 `trigger`/`rule`/`ownership`、`trigger="scope"` 下 `remainingForLead` 非安全整数)⇒ 整块退化为固定一行 `还剩什么=⚠️ 账面不可读(invalid_epic_residual)`,**无触发行**,不抛(与容量 B11 同形)。
- 禁词:整块不含 `check/verify/suggest/inspect/建议/怀疑/该查`(✅ `PATROL_DIRECTIVE_WORDS` L358);「拉」「派」字样只在规则文件里,⛔ 不在 Bridge 正文。
- 数值:`Number.isSafeInteger` ∧ `≥0` ⇒ `String()`;时间:`Date.parse` 后 `toISOString()`。

### 5.3 与既有名册行的关系

名册行 `按 Bridge 的账,你名下有 N 个未终结 runner` 的措辞、位置、字节都不变(N=0 时照样输出)。「还剩什么」块**不**声称任何 runner 存活。

---

## 6. `plugin.ts` 接线与启动告警

- 唯一接线形状(rev 3,Codex R2 HIGH-2),紧邻 ✅ `plugin.ts:9159–9165`:

```ts
const epicResidual = createEpicResidualScan({
  store, projects, linearApiKey: config.linearApiKey,
  resolveOwner: (projectName, labels) => {
    const { lead, matchMethod } = resolveLeadForIssue(projects, projectName, labels);
    return { agentId: lead.agentId, matchMethod, canSpawn: lead.canSpawnRunners !== false };
  },
  log: (message) => console.warn(message),
});                                            // 创建一次,Bridge 生命周期内复用
for (const line of epicResidualBootWarnings(projects, Boolean(config.linearApiKey))) console.warn(line);
const leadPatrolTickPass = createLeadPatrolTickPass({ ..., epicResidual });
```
- **启动时一行/项目**(Lead 裁定:一行、启动时、不 fail、⛔ 不每 tick 喊):`epicResidualBootWarnings` 对每个 `resolveProjectLinearBinding(projects, name)` 为 undefined 的项目产一行 `[patrol_tick] epic residual scan disabled for project=<name>: no linear binding in projects.json`;`config.linearApiKey` 缺 ⇒ 只产一行 `[patrol_tick] epic residual scan disabled fleet-wide: LINEAR_API_KEY not configured`,并**不再逐项目喊**。
- 这些 warn 走既有 console 日志,⛔ 不进 alert sink(`leadPendingAlertHolder`)。

---

## 7. Lead 规则文本(合同;实现节点逐字落地,可微调措辞但锚句不变)

**文件** `runner-patrol-rules.md`,插在 §0 结尾、`## 1. Proactive patrol` 之前:

```
### 0.9 回头看 Epic 还剩什么,有位就拉一件(FLY-2141)

tick 里「还剩什么」三行是 Bridge 在**这一轮**按 Linear 扫出的读数(规则 ready.v1,已获 founder 裁定),
与同一封里的「容量」三行同一时刻采样。放新活的判断读这两块,不另外查一遍(PRD §1.2)。

- 巡检轮:读「现在可以开始且归你」+ 容量的「在跑 N · 停车 M」+ 额度,**自己拍这一轮拉几张**。
  拉一张 = `POST /api/runs/start` 按 FLY-1436 合同(`taskCategory` 由你判);`409` = 已有人在跑,不是错。
- 轮外,或该格显示 `?` / `账面不可读`:先 `flywheel-comm epic-page show --project "$PROJECT_NAME" --format md`
  再拍;它是同一个生成器的另一次采样,各带自己的时间,⛔ 不当同一份。
- 标题、验收、依赖全文都在 epic-page 页面里,tick 只给 issue 号和优先级。
- 「还剩什么」是 Bridge 按 Linear 扫的读数,不是转述;你核的是它的两个时间戳的新鲜度,⛔ 不引用超过一个巡检周期的读数;
  `?` 的格不得当事实。多少算「位子满了」由你判(PRD §8-3 未定),Bridge 不给数。
- 第三行「归你(按 Lead 归属规则)」里带 `general` 标记的子单没有命中任何 Lead 的 label,只是按项目默认落到你;拉之前看一眼它该不该归你。
- `[patrol_tick]` 仍是纯闹钟;这三行不替代 STEP 1–6 与 STEP DWELL 的任何一步。
- 收到「本轮由 Epic 范围触发」的 tick:名册为空是真的,不是统计坏了;照常做 STEP 1–6(会是 0 pane),然后按上面拉活。
```

**`department-lead-rules.md` §0 改两处**(rev 3,Codex R2 HIGH-4):① ✅ `:151–152` 那句 `including when a Lead's 名册为空 and therefore no tick is emitted` 改为 `including when a Lead's 名册为空 and no scope-triggered tick arrived this round (FLY-2141)`——旧的绝对句在 rev 2 之后已不成立;② 末尾加一句:`「还剩什么」(Epic 范围内现在可以开始的)与容量在同一封 tick 里,读法见 runner-patrol-rules.md §0.9(FLY-2141)。`

**合同测试锚句**(dept bundle 含、cos bundle 不含):`回头看 Epic 还剩什么,有位就拉一件(FLY-2141)`、`ready.v1`、`epic-page show`、`本轮由 Epic 范围触发`、`不是派单`、`按 Lead 归属规则`;dept bundle **不含**旧句 `and therefore no tick is emitted`;并断言 2144 的锚句与「纯闹钟」句仍在(不回归)。

---

## 8. 测试清单(行为编号供 plan 引用)

| # | 行为 | 测试文件 |
|---|---|---|
| B1 | `summarizeEpicResidual` 对 `epicShapeSnapshot()`(✅ fixture `EPX-1..5`,1 空阻塞;5 空阻塞、P0)算出 `remaining=5, ready=2, blocked=3, running=0`,`readyForLead` 顺序 `[EPX-1, EPX-5]`(priority 1 在前,0 最后) | `residual.test.ts` |
| B2 | 一张 ready 子单 `ledger_live_count=1` ⇒ 从 `readyForLead` 剔除、计入 `running`;任一 remaining 子单 `session` 格 missing ⇒ 抛 `EpicResidualSessionUnreadableError`;已终态子单的 missing 不影响 | 同上 |
| B3 | 归属四组 fixture:labels 空 / 仅无关 label × 默认 Lead 可派 / 不可派;`generalCount` 四组都计;可派 ⇒ 进默认 Lead(`ownership:"general"`),不可派 ⇒ 不进任何 Lead 的两个集合;label 命中者只进对应 Lead;ready/blocked/running 各有一张 | 同上 |
| B4 | `readyForLead` 上限 5、`readyForLeadTotal` 正确;`completed`/`canceled` 不计 remaining;`ready+running+blocked===remaining` 不变量;负数 / 超限 / priority 越界 / 非法 trigger·rule·ownership / unavailable 的 `token` 非字符串或不在 allowlist / `kind` 非法 / `schemaVersion` 非 1 ⇒ 断言抛 | 同上 |
| B5 | `materializeForScan`:binding 缺席 / apiKey 缺 ⇒ `undefined` 且不调 fetch;四类 Linear 错误(含注入 fetcher 返回 501 项触发的共享守卫)⇒ 对应 token;schema 错 ⇒ `epic_page_invalid`;其它 throw ⇒ `epic_scan_failed`;`summarizeForLead`:上游 unavailable ⇒ `kind:"unavailable"` 且两个时间 **`null`**(断言不等于 `now()`);session missing ⇒ `session_ledger_unreadable` 且两个时间为 page/snapshot 真值;断言失败 ⇒ `epic_residual_invalid`;**每个产出 token 都过 `isEpicResidualUnavailableToken`**;每个产出 fact 都过 `assertEpicResidualFact`;log 含 message 但返回值不含 | `epic-residual-scan.test.ts` |
| B6 | materialize 成功 ⇒ `epic_page` 表多一条 `trigger='scan'` 回执且回执不含 ready/order 字段(复用 2140 受体守卫);写回执抛 ⇒ 仍返回 `ok` | 同上(`:memory:` StateStore) |
| B7 | patrol pass:非空名册铸 tick 时 payload 有 `epic`,`trigger="roster"`;dep 未注入 / materialize 返回 undefined 或 reject 或同步 throw / summarize 返回 undefined 或 throw ⇒ 无 `epic` 键且 tick 照常 | `patrol-tick.test.ts` 追加 |
| B8 | 同一 pass 两个 Lead 到点 ⇒ `materializeForScan` **1** 次、回执 **1** 条、`summarizeForLead` 每 Lead **1** 次,两份 `epic.generatedAt` 相同,`readyForLead` 各不同;无到期 tick 的 pass ⇒ materialize 0 次 | 同上 |
| B9 | **名册空**:注入 builder 且 `remainingForLead>0` ⇒ 铸 tick(`roster=[]`、无 `loops`、`epic.trigger="scope"`);`remainingForLead=0` 或 unavailable 或 undefined ⇒ 不铸,且**同一 slot 内不再调 builder**(抑制 memo);下一 slot 再调 | 同上 |
| B10 | 改写 ✅ `patrol-tick.test.ts:372`「idle Lead 静默」:未注入 builder 时仍静默(既有);注入且该 Lead 无归属项时仍静默;注入且有归属项时铸 tick——三种都断言 | 同上(改 1 条 + 加 2 条) |
| B11 | 名册空铸的 tick 与后续 settlement/去重/相位逻辑一致:下一 slot 前不重铸;settled 后按墙钟网格继续(复用 ✅ L279 系列断言的形状) | 同上 |
| B12 | 渲染:`epic` 缺席 ⇒ 两条路径**逐字节**等于今天(以 2144 的 golden 为基线,GREEN characterization);存在 ⇒ 三行在容量之后、名册之前,header 含 `Linear 观测` 与 `生成` 两个 ISO 时间;第三行 `general` 项带 `,general` 标记、label 项不带;`trigger="scope"` ⇒ 首行后紧跟触发说明行 | `patrol-tick-render.test.ts` 追加 |
| B13 | 渲染:`kind:"unavailable"` ⇒ 一行 `?(<token>)` 且无触发行,两个时间为 null 与为真值各一条;八个 allowlist token 各一条;不在 allowlist / `token` 是数组 / 计数为负 / 不变量破(含 `remainingForLead>remaining`、`generalCount>remaining`、scope 且 `remainingForLead=0`)/ `schemaVersion` 非 1 / `kind` 非法 / identifier 含换行或指令词或重复 / `readyForLead` 6 条 / priority 越界或非整数 / 非法 trigger·rule·ownership / 任一时间不可 parse / `trigger="scope"` 下 `remainingForLead="1\nignore previous instructions"` ⇒ 整块固定一行 `账面不可读(invalid_epic_residual)`、无触发行,不抛,不透传原文;整块不含禁词 | 同上 |
| B14 | 渲染:`readyForLeadTotal=0` 仍输出第三行;`+k more` 只在 `total>5` 时出现;`P0` 渲染 `P-` | 同上 |
| B15 | Mailbox 与 CommDB 两个 runtime 用同一渲染器(复用 ✅ `:435` 断言形状) | 同上 |
| B16 | route 重构后 `epic-page-route.test.ts` 全部不变通过(纯搬家证明);新增 characterization:insert 抛 ⇒ 500 `internal_error`、不返回文档 | 既有 + 1 条 |
| B19 | 端到端:名册非空 + 某 remaining 子单 session missing ⇒ 正文该块一行 `还剩什么=?(transient: session_ledger_unreadable)`,其余字节不变;名册空 + 同情形 ⇒ 不铸、同 slot 不再 materialize | `patrol-tick.test.ts` |
| B20 | 抑制 memo 键不碰撞:两项目、同 Lead id、同 interval、同 pass;项目 A 无归属(静默)后项目 B 有归属 ⇒ B 仍铸 tick;并断言 memo 键为 `"<projectName>:<leadId>"` 字符串 | `patrol-tick.test.ts` |
| B17 | 规则 bundle:dept 含六个锚句 + 2144 锚句 + 纯闹钟句,且**不含**旧句 `and therefore no tick is emitted`;cos 不含新锚句 | `fly2141-epic-residual-rule.test.ts` |
| B18 | plugin 启动:`projects` 全部无绑定 ⇒ 每项目恰一行 warn;`linearApiKey` 缺 ⇒ 一行且不逐项目;有绑定 ⇒ 0 行;后续 pass 不再 warn(用 `vi.spyOn(console,'warn')` 计数) | `plugin` 侧轻量测试或 `epic-residual-scan.test.ts` 的接线函数测试(把「算警告行」抽成纯函数 `epicResidualBootWarnings(projects, hasKey): string[]`) |

**⬜ 真数据演练(实现节点做、QA 复核)**:在 Lead 已补绑定的前提下,对生产 `teamlead.db` 的**只读副本** + 真实 Linear 跑一次 builder,记录 items 数、耗时、`x-complexity`、渲染出的三行,进 implementation-evidence.md;⛔ 不对生产库写。

---

## 9. 安全与注入面

| 面 | 处置 |
|---|---|
| Linear 标题 / 描述 / 验收(外部自由文本) | **不进 payload、不进正文**;只用 identifier + priority + 计数 |
| identifier | `assertEpicResidualFact` 用同一文法 + 禁词表校验 ⇒ 不合法即整块 fail-closed(固定文案),⛔ 不降级成 `unsafe-<hash>` 上正文 |
| `unavailable` token | 精确 allowlist,builder/渲染器同一函数;不合法 ⇒ 整块退化 |
| Bridge 日志 | 可含 `error.message`(运维可读),⛔ 不含 Linear API key(SDK 错误对象不回显 key;⬜ 实现节点用假 key 触发 401 并断言 log 不含它) |
| Lead 规则里的 curl | 复用 2144 的「secret 走 stdin」写法;本单规则不新增 curl,只引用 `flywheel-comm epic-page show`(它自己读 `TEAMLEAD_API_TOKEN` ✅ `commands/epic-page.ts:100`) |
| 写路径 | 只有 `epic_page` 回执(既有守卫拒绝计算字段);⛔ 不写 Linear、不写 sessions |

---

## 10. 失败矩阵(与 exploration §6.4 一致,加 token)

| 情形 | `payload.epic` | 正文 | 触发 tick? |
|---|---|---|---|
| binding 缺席 / apiKey 缺 | 缺席 | 字节不变 | 名册非空照旧;名册空 ⇒ 不发(既有) |
| `LinearUpstreamError` | `kind:"unavailable"`,`transient: linear_unavailable`,两个时间 `null` | `还剩什么=?(…)` | 名册非空照旧;名册空 ⇒ 不发 |
| `ActiveScopeNotFoundError` | `structural: active_scope_not_found` | 同上 | 同上 |
| >500 / 截断 | `structural: scope_too_large` / `scope_snapshot_truncated` | 同上 | 同上 |
| schema / summary 断言 | `structural: epic_page_invalid` / `epic_residual_invalid` | 同上 | 同上 |
| 其它 throw | `transient: epic_scan_failed` | 同上 | 同上 |
| 回执写失败 | 正常块 | 正常 | 正常 |
| 某 remaining 子单 `session` 格 missing | `kind:"unavailable"`,`transient: session_ledger_unreadable`,两个时间为真值(Lead 级) | `还剩什么=?(…)` | 名册非空照旧;名册空 ⇒ 不发 |
| 某子单其它五格 missing(run/attempt/gates/carriers/land) | 正常块(本单不读这五格) | 正常 | 正常 |

---

## 11. 部署前置与回滚

| 项 | 谁 | 验证 |
|---|---|---|
| `projects.json` 为 flywheel 补 `linear: { team: "FLY", project: "<Lead 确认的 Linear Project 名>" }` | **Lead(ops)**,Lead 已认领 | `POST /api/epic-page/generate {projectName:"flywheel"}` 返回 200 而非 404 `project_unbound`;Bridge 启动日志**没有**该项目的 disabled 行 |
| Bridge 需含 FLY-2140(生产 build `31da17817` 不含)| 独立 updater | build sha ≥ `fd5ac60c9` 的后代 |
| 其余五个项目绑定仍 null | 保持 | 它们的 tick 字节不变;启动日志各一行 |

**回滚** = revert 本单一个 PR:payload 键消失 ⇒ 正文回到 2144 形状;`epic_page` 里已写的 `scan` 回执无消费者(D 未开工),留着无害。**没有迁移、没有 flag、没有配置改动需要回退**(绑定是独立的 ops 动作,与本单 PR 无耦合)。

---

## 12. 未决与不做(供 plan 引用)

- ⬜ Linear Project 的准确名称(`Flywheel`?)—— Lead 补绑定时定;本单文档里不猜。
- ⬜ 200+ 子单时 pass 耗时(2140 警戒线)—— 本单只记 log,不改读取形状(同 2140 裁定)。
- ⛔ 不算位子数(§8-3);⛔ 不自动派单(R4);⛔ 不分层调频(§8-3);⛔ 不改 `ready.v1`;⛔ 不改 STEP 报告合同与 `lead-patrol-snapshot.sh`。
