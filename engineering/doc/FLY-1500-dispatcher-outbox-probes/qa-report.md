# FLY-1500 动作黑匣子 — QA 报告

Issue: FLY-1500
日期: 2026-07-28
基于: mapping-v2final.md（本批权威；旧 plan.md/exploration.md 已被 founder 终稿取代，仅作历史证据）

---

## 0. 验收基准的澄清

本单在实施途中被 founder 终稿改写：交付物从「dispatcher + outbox + 探针 + saga」变成
「Agent 亲手调用工具 + 通用薄壳把动作前后写进一张 `actions` 黑匣子」。因此**验收基准是
`mapping-v2final.md`（§7 增量 TDD 接缝 + §10 完成判据），不是 `plan.md`**。plan.md 里的
dispatcher/claim/probe/saga 条目按终稿属于「明确不做」，不作为缺失项计。

---

## 1. 结论

**FAIL —— 卡在 Codex code-review 硬门，不卡在行为 QA。**

行为面是干净的：§10 七条完成判据逐条成立，§7 九条接缝全部有可执行证据，我另建的 10 条
独立探针 10/10 过，补的 5 条回归测试全绿，CI 全绿。

但 Codex code review（xhigh，round 1）判 CHANGES REQUESTED，报 1 HIGH + 2 MEDIUM。
**我逐条独立复现过，三条全部成立**（见 §4.0），其中 HIGH 比 Codex 描述的更重：它能让黑匣子
把一次**不同的**动作误报成「已经做过」，同时把真实 payload/result 静默记成 `{}`——正是本批
「诚实留痕、绝不静默」这条主张要防的东西。

三条都在生产代码（`actions.ts`、迁移 DDL），按纪律**不由我这个独立 QA 自己改再自己批**，
路由回 implement 相位修，我复验。Codex 另报的 1 条 LOW 是**我自己上一次提交的测试命名过度
声称**，已在本次提交里改掉。

另有 M1/M2/L1/L2 四项不阻塞的观察（见 §4.1 起），其中 M2 是**跨单上线顺序硬约束**，无论本单
最终怎么修，都必须在合入前让 Lead 接住。

## 2. 跑了什么

| 项 | 结果 |
|---|---|
| `pnpm --filter flywheel-v2-kernel test` | 121 passed / 1 环境 flake（见下） |
| `pnpm --filter flywheel-v2-actions test` | 10 passed（原 7 + 新增 3） |
| `pnpm exec biome check packages/v2-kernel packages/v2-actions` | 干净 |
| PR #720 CI（9 个 job）| 全绿，`gh pr checks` exit 0 |
| 独立探针脚本（不复用仓内测试，10 项）| 10/10 |
| **Codex code review（xhigh，round 1）** | **CHANGES REQUESTED —— 1 HIGH + 2 MEDIUM，逐条复现属实（§4.0）** |

注：`pnpm lint` 在本机会报 646 个 error，全部落在 `.flywheel/runs/**` —— 那是 Flywheel runner
自己生成的本地产物目录，已 gitignore，不属于仓内源码。按包跑 `biome check packages/v2-kernel
packages/v2-actions` 是干净的，CI 的 Quick Gate（build + typecheck + lint）也是绿的。

**环境 flake（非回归）**：`v2-kernel/src/__tests__/public-api.test.ts > allows the built root
package and denies every internal subpath` 在整包并行跑时偶发 5s 固定超时。单独跑 3/3 通过
（1.2–1.5s），改动前的基线跑同样通过（2.19s），CI 绿。当时机器 load average 62–75。
判定：固定超时 + 高负载，与本次改动无关。

### 2.1 独立探针（不看仓内测试，自建 harness 直接打真库）

| 探针 | 证据 |
|---|---|
| 无上游 `agents` 时生产 migration 响亮失败 | 真抛 `error in trigger actions_current_actor_insert: no such table: main.agents`，事务回滚，不留半迁移库 |
| 效果已发生、结果未落库 → 行诚实停在 `intended` | `state=intended`，`result`/`completed_at` 皆空 |
| 重放 `intended` 行 | `disposition=replayed` + `state=intended`，`perform` 调用 0 次 |
| 重放 `failed` 行 | `disposition=replayed` + `state=failed`，`perform` 不重跑 |
| 世代围栏（agents 世代推进后） | 旧 token 结算抛 `CasViolation`，旧世代新 intent 被挡，原行零变化 |
| 接班世代（generation+1、新 instance）结算前代 intent | 抛 `CasViolation`，行仍 `intended` |
| terminal 不可改、行不可删 | runtime `CasViolation`；裸 SQL 的 delete / result / authorization / effect_key / 重开 **五种篡改全部被库拒** |
| 读动词零写 | `listActions` 找回 intended 行；`PRAGMA data_version` 前后不变，行数不变 |
| supersede 规则 | succeeded 前驱、无 basis、分叉、跨 envelope、无链第二 root **全拒**；合法 successor 放行 |
| 事故现场四条查询的计划 | 空库与 **3000 行 + 真 ANALYZE(STAT4)** 两种统计形态下都命中各自命名索引，无 TEMP B-TREE |

## 3. 补的测试（本次 QA 提交）

§7 接缝里**没有可执行证据**的五处，已补：

1. `run-recorded-action.test.ts` — **崩溃窗诚实性**（§7.5 / §5 崩溃语义 3）。原有用例只覆盖
   wrapper 的 catch 路径（写 `failed`）；**真被杀的进程不会走 catch**。implement 修复已把
   用例补成完整次序：先提交 intent，真实调用一次 fake effect，刻意不写 outcome，再证明同一
   invocation 重入只读回 `intended` 且 fake effect 总调用次数仍为 1。
2. `run-recorded-action.test.ts` — **`replayed + failed` 不得冒充成功**。原有重放用例只针对
   succeeded 行；failed 行的重放才是调用方最容易误读成「已办妥」的形态。
3. `run-recorded-action.test.ts` — **§7.7 成功侧**：一次性 capability 与 intent 落同一事务真被
   消费，且随行的 `{gate_id,target_head}` 授权引用写入后连裸 SQL 都改不动（未结算 / 已结算
   两种形态都证）。implement 另补 prepare 成功消费 capability、随后 intent INSERT 因主键
   冲突失败的回归，证明整个事务回滚且 capability 仍未消费；不再只覆盖 prepare 自己抛错。
4. `actions.test.ts` — **接班世代不得结算前代 intent**。原有用例只覆盖「同一 actor token 但
   agents 世代已推进」；生产里更常见的是新 session（generation+1、新 instance）回来结算前代
   遗留行，这条路径必须同样被挡。
5. `actions-query-plan.test.ts` — **STAT4 变体断言**。原有四条断言只跑在「刚建好、从未
   ANALYZE」的空库上。FLY-1497 的 QA 已实测本仓 SQLite 开了 `SQLITE_ENABLE_STAT4`、直方图样本
   会改判 mailbox 家族的索引选择；actions 的四条事故现场读取纳入同一纪律后实测**不翻**。

另补 1 条**边界记录**用例（`treats createdBefore as a timestamp filter, not a complete keyset
cursor`），把 M1 钉死，见下。

## 4. 发现

### 4.0 阻塞项 —— Codex code review 报的三条，我逐条独立复现

复现用的是我自建的探针（不复用仓内测试），每条都带阳性对照。

#### B1（HIGH）非 JSON 运行时值被静默 canonicalize 成 `{}` → 假 replay + 假账

`actions.ts` 的 `canonicalize()` 对任何非普通对象走 `Object.entries()` 分支。`Date`、`Map`、
`Set`、只有方法的类实例的 `Object.entries()` 都是 `[]`，于是**一律序列化成 `{}`**，
`payload_digest` 全部等于 sha256("{}") = `44136fa355b3…`。

实测：

```
payload=Date -> 存 {}  digest=44136fa355b3
payload=Map  -> 存 {}  digest=44136fa355b3
payload=Set  -> 存 {}  digest=44136fa355b3
两个【不同】的 Date payload + 同一 invocationUid -> replayed（读回第一行，payload={}）
一个返回 Date 的工具 -> 黑匣子记 result={}
```

两个后果，都直击本批主张：

1. **假 replay**：`exact envelope` 比的是 `payload_digest`。两次**内容不同**的调用因为都塌成
   `{}` 而 digest 相同 → 第二次被判定为 `replayed`，wrapper 直接**短路掉 `perform`**。
   调用方拿到「这件事已经做过了」，而实际上从未做过。这是黑匣子唯一不该犯的错。
2. **假账**：真实 payload/result 被静默换成 `{}`，事后对账读到的是空壳。

**可达性不是理论**：TS 侧 `JsonValue` 确实挡得住显式的 `Date`，但工具薄壳的典型形态是
`perform: () => sdk.call()`，而外部 SDK / `JSON.parse` / `fetch().json()` 的返回类型普遍是
`any` —— `any` 满足 `Result extends JsonValue`，运行期照样可以是 Date / Map / 类实例。

建议修法：`canonicalize` 对「非 null 且原型不是 `Object.prototype`」的对象、以及函数 /
`undefined` / `symbol` / `bigint` **fail loud**，不再静默降级。这跟它已有的「非有限数字抛错」
「字段为 undefined 抛错」是同一条纪律，只是漏了这一类。

> **Implement 修复（待 QA 复验）**：`canonicalize` 现拒绝非普通对象、symbol/non-enumerable
> 字段与不受支持的 primitive；Date / Map / Set / class instance 四条定向阴性对照和 wrapper
> 的 SDK result 回归均已加入。

#### B2（MEDIUM）重复 JSON key 可绕过 `retry_basis` 的**数据库**闸

mapping §7.9 明写这道闸必须由数据库自己把关（「不能只靠 TypeScript 校验冒充 DB 闸」）。
机制：**SQLite 的 `json_extract` 取重复 key 的第一个，JS 的 `JSON.parse` 取最后一个。**
把真理由写在前、禁用词写在后，CHECK 读到的是真理由（放行），而所有 JS 读者看到的是禁用词。

实测（四例带正反对照）：

```
banned word FIRST  -> DB 拒（CHECK constraint failed）        ← 闸在
banned word SECOND -> DB 接受；JS 读者看到 reason="retry"      ← 绕过
control 只写 banned -> DB 拒                                   ← 尺子没坏
control 只写 legit  -> DB 拒（UNIQUE supersedes_action_id）    ← 上一行确实落库了
```

只有裸 SQL 写入者可达（kernel 的 `canonicalize` 造不出重复 key），所以严重度 MEDIUM 而非
HIGH；但这道 trigger 存在的全部理由就是防裸写，闸上有洞就该补。

> **Implement 修复（待 QA 复验）**：数据库 CHECK 现要求 `retry_basis` 逐字等于按冻结字段顺序
> 重建的 canonical `json_object`；重复键、额外键、非 canonical 文本都无法绕过。新增裸 SQL
> 重复-key 回归直接打真实 migration。

#### B3（MEDIUM）exact-envelope 比了 mapping §4 没列的字段 → 合法崩溃重放被判 collision

mapping §4 逐字规定 envelope「只含逻辑效果字段（kind、payload digest、task/attempt 绑定、
logical key、cutover epoch），不含 action id、时间或 actor generation」。
`actions.ts:377-378` 额外比了 `supersedes_action_id` 与 `retry_basis`。

实测（同一 `invocationUid` 重入）：

```
基准文本逐字相同        -> replayed（正确）
基准文本被重新生成一次  -> THROW: action effect key collision
```

为什么这是真问题：§4 同时规定「相同调用因崩溃或同一 session 重入时**必须复用同一
invocationUid**」，且「全新 session 若没有能力恢复原 UID……不能自编 UID 假装 replay」。
于是一个 Agent 崩溃重启后重新推导 `retry_basis`（理由文本里带观测时刻、带新证据措辞是很自然
的写法）就会**撞死**：既不能 replay，也不许换 UID。额外这两个字段只在这一种情形下生效，
而这一种情形恰好是它们不该生效的那一种。

> **Implement 修复（待 QA 复验）**：exact-envelope 已只比较 mapping §4 的逻辑字段，
> 不再比较 `supersedes_action_id` / `retry_basis`；新增同 invocation 丢失/重建 retry 审计
> 元数据仍返回原 action 的回归。

### 4.1 不阻塞的观察

### M2（MEDIUM，跨单上线顺序硬约束，需 Lead 决策）

合入本 PR 后，`migrateDatabase()` 在**全新库**上会直接抛错：
`no such table: main.agents`。这是 mapping §9.1 明写的设计选择（「不创建 shadow authority，
缺上游 migration 时响亮失败」），本身正确。但它有两个必须被 Lead 接住的后果：

1. **本 PR 单独落地后，v2-kernel 的公开 `migrateDatabase` 对任何全新消费者是不可用的**，
   直到 FLY-1499 的 `agents` migration 合入。今天无害——已核实**全仓零接线**（除 v2 两包自身
   外无任何 import）、机器上**不存在任何 v2 库**（`~/.flywheel` 下无 `*v2*` 文件），所以生产
   行为零变化。但这是「合入即带一个已知红」的状态，不该由后来者撞见才发现。
2. **FLY-1499 的 `agents` migration 必须排在 0006 之前**，不能简单追加成 0007——0006 的表定义、
   两条 generation trigger 和 `foreign_key_check` 都依赖 `agents` 已存在。两单的迁移编号需要
   在合入顺序上对齐。

建议：在合入顺序上与 FLY-1499 显式协调（mapping §0.1 已给顺序，但迁移编号这一层没写死）。

> **Lead 最终裁定（2026-07-28）**：分析核过、采纳。裁定四条：
> 1. **合入顺序：FLY-1499 先合，FLY-1500 后合。**
> 2. **迁移编号：1499 固定占用 `0005-agents-config-mailbox-rebuild`；1500 删除未发布、
>    零消费者的 `0005-commands-dispatch-bookkeeping`，`0006-actions-black-box` 保持原号。**
> 3. **在 1500 的 PR 描述里写死这条依赖**，别让它单独被合；ship gate 呈给 founder 时
>    也会写明「必须在 1499 之后」。
> 4. **验收加一条**：两单都合入后，`migrateDatabase` 在**全新库**上必须能跑通。
>    （现在这条红是暂时的、有前提的，不能带着上线还没人记得。）
>
> ⇒ 这条新增验收项属于**两单合入后**的复验范围，本单单独复验时无法满足（上游未合），
> 我在最终复验时会显式标注它是「跨单待验」而不是「已验」。

### M1（MEDIUM，读路径边界）—— **已知限制 + 硬触发条件（Lead 裁定）**

> **Lead 裁定（2026-07-28）**：本轮不改，理由成立；**但必须记成「已知限制 + 触发条件」，
> 不是飘着的 advisory**：
> **在第一个真实消费者接入之前，`listActions` 必须变成真正的 keyset 游标。**
> 理由原话：静默丢行是那种「上线半年后才发现」的缺陷。
>
> ⇒ 谁第一个消费 `listActions`（预计是批次 3 的事故现场读取），**接入前先把
> `createdBefore` 换成 `(createdBefore, createdBeforeId)` 复合游标**，同时更新
> mapping §5 冻结的公开 options。本仓已有回归用例
> `treats createdBefore as a timestamp filter, not a complete keyset cursor` 钉住边界，
> 改完那条用例会变红，正好作为「合同已同步更新」的提醒。



`listActions` 的 `createdBefore` 是**时间戳过滤器，不是完整 keyset 游标**。排序是
`(created_at DESC, id DESC)`，而公开 options 只有 `createdBefore`；当多行共享同一
`created_at` 时（同一毫秒写入完全可能），用「上一页最后一行的 createdAt」翻页会**静默丢掉**
同刻的其余行。实测：三行同 `created_at`，`limit:2` 第一页拿到 2 行，第二页拿到 **0 行**，
第三行永远看不到（不带游标的完整读取仍能看见三行——数据没丢，丢的是这种翻页用法）。

黑匣子的全部意义是事故后诚实对账，而唯一的事故现场读取动词在最朴素的翻页用法下会悄悄少
给行——这与本批「绝不静默」的主张相抵。

**不判 FAIL 的理由**：mapping §5 把公开 options **逐字冻结**为当前这一组，实现与已评审合同
逐字一致；且今天零消费者，不存在可达的错误行为。修它等于放宽一个已冻结的公开合同
（加 `(createdBefore, createdBeforeId)` 复合游标），属于设计侧决定，不该由 QA 用 kickback 逼。
已补测试把边界钉死：将来有人加复合游标，那条用例会变红，提醒同步更新合同。

### L1（LOW，占位常量）—— 已按 Lead 要求加注释

`fence.ts` 新增的 `FENCE.capabilityConsume` 常量：未从包 index 导出、无任何调用方、无任何测试。
它是给 FLY-1498 留的位（mapping §3 明写保留），但以「无人执行的 SQL 字符串」形态存在——
谓词若有错，合入时不会有任何信号。

> **Lead 裁定**：确认是给 FLY-1498 留的位，**保留**；但要在代码里写明是占位，
> **否则下一个人会当死代码删掉**。
>
> ⇒ 已在 `fence.ts` 的该常量上方加注释，写明 placeholder for FLY-1498、不要当死代码删、
> 以及「谁接线谁负责补第一个调用点和测试」。这是本次 QA 唯一一处碰生产代码的改动，
> **纯注释、零行为**，且不在 implement 当前修复的文件集内（它在改 `actions.ts`）。

### L2（LOW，迁移链空转）—— 已按 Lead 裁定删除

migration `0005-commands-dispatch-bookkeeping` 从未进过 main、也从未被任何真实库应用过，
0006 紧接着把它加的列与索引全部删掉。全新库因此要先建再删一遍 commands/probe 簿记。
mapping §3 以「已提交迁移受 checksum 约束」为由保留它——该理由对**已发布**的迁移成立，
对一条只活在本分支、无任何应用实例的迁移不成立。非阻塞，只是链上多一跳空转。

> **处置**：逐列/逐索引审计确认零存活消费者后整条删除；0006 同步删掉只为清算 0005
> 新增索引/列的 DROP，保留对 0001 历史 commands/observed 字段的前向清理。

### 顺带记录的一个正面事实

`actions_terminal_once` 的谓词是 `OLD.state <> 'intended' OR NEW.state NOT IN
('succeeded','failed') OR ...`，因此它实际拦下的是**一切非结算的 UPDATE**，不只是「terminal
重写」。不可变范围比字段清单看起来更宽。反过来说：断言「哪一条 trigger 先报错」是脆的
（SQLite 同事件多 trigger 触发顺序未定义），补的测试因此只断言「被拒 + 值未变」。

## 5. 逐条对照 §10 完成判据

| 判据 | 证据 |
|---|---|
| 无 `packages/v2-dispatcher`，仓内无 dispatcher/claim/probe/saga 运行时代码 | 目录不存在；`pnpm-lock.yaml` 无残留；kernel 运行时源码 grep 零命中 |
| 动作事实只有 `actions`，无 commands / receipt event 双账，共享 domain `events` 仍在 | fresh 表集合断言：有 `actions` 与 `events`，无 `commands`/`command_dependencies`/`obligations` |
| 通用薄壳可证明 intent-before-effect、outcome-after-effect | 效果执行期间读到 `intended`；成功/抛错分别补 succeeded/failed |
| 崩溃窗只留 `intended`，无自动副作用或虚假成功 | 独立探针 + 新增回归用例双证 |
| query 与 write 是分开的公开动词，查询不触发 action | `PRAGMA data_version` 前后不变 |
| 世代旧写 / terminal 重写 / effect-key envelope 冲突 / 无证据·分叉 supersede 均 fail closed | 五类全部实测被拒 |
| 跨单运行时合同恰为 mapping §11 两条；C5、heartbeat/agents、ship gate 各守 owner，本单无第三条 | 仓内依赖审计：本单只读 FLY-1499 `agents`；零 C5 import/复制；零 ship-gate 查询或批准逻辑 |

## 6. 我没验的（诚实边界）

- **真实外部副作用**（GitHub / Discord / Linear / 进程）一次都没发生过：本批交付的是黑匣子与
  薄壳，`perform` 全部是测试替身。这是设计边界（终稿把外发交还给 Agent），不是漏测。
- **与 FLY-1499 真 `agents` migration 的集成**：上游未合入，测试里用的是冻结 DDL fixture。
  真集成留给合入顺序对齐后（见 M2）。
- **`~/.flywheel` 生产库上的迁移**：不存在 v2 库，无从演练。

## 7. Codex code-review 记录的归属（Lead 裁定，改了我原来的打算）

我原本的打算是「我这个 QA 会话跑 review，再请 implement 会话把记录挣下来」。**Lead 否掉了**，
理由我认：

> `ba28c072` 上的增量是 QA 这个 claude 会话写的（5 条回归测试 + QA 报告）。
> **QA 去 review 它 = 自审**；而且把「QA 跑的 review」记成 implement 挣的记录，
> **记录的作者归属就是假的** —— 这正是 FLY-1498 的 `effective_author_set` 在根治的病。

**改后的分工**：

- **implement（`d20d8c54`）在最终 head 上跑 cross-family Codex code review 并挣记录。**
  它是 reviewable role，且 codex 家族对该 head 是诚实的评审者（增量作者是 claude）。
- **我不跑 review**；复验时只**核对那条记录绑的 head 对不对、家族是不是 codex**。
- 我对 `isReviewableRole`（auto-qa-coordinator 只收 main/implement）的判断 Lead 确认成立，
  但**不在本单范围，不去动它**。

**旧 gate `8e9ad630` 已被 Lead 宣告 stale，不许复用**；ship 前必须以 **QA park 时的 exact
head** 重开新 gate。

一个诚实的备注：我这轮**已经**跑过一次 Codex review（xhigh，round 1），它报出的 1 HIGH +
2 MEDIUM 是真的、也已被我独立复现，这份**发现**保留并作为修复依据；但按上面的裁定，
**它不构成可入库的 review 记录**——记录要由 implement 在最终 head 上重新挣。
这两件事分开：发现的价值不依赖记录的归属，记录的归属也不能拿发现来顶替。
