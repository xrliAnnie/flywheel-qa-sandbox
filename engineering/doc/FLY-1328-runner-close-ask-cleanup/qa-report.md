# FLY-1328 runner close 不清未答 ask — QA 报告

Issue: FLY-1328
日期: 2026-07-17
基于: plan.md

**结论: PASS**(1 个 MEDIUM 由 QA 补测修复;无产品缺陷)

---

## 1. 一句话

在**生产 comm.db 真快照**上,经**真 GatePoller** 跑一轮 sweep:
**pending 233 → 49(184 条尸体一轮清空,95ms)**;kill-switch=0 时同一份数据
**233 → 233 零改动**。功能真的работает。

但我发现:**A2 sweep 的生产接线(gate-poller)零测试覆盖** —— 我把它改成
「生产环境里彻底失效」,全套 90 个测试**照样全绿**。已补测钉死。

---

## 2. 复现原始故障(真生产数据)

Issue 说 HL poll `pending` 全是尸体。**实测生产
`~/.flywheel/comm/flywheel/comm.db`(只读快照,未碰生产)**:

| 指标 | 实测 |
|---|---|
| pending question 总数 | **233** |
| 其中 checkpoint-less ask | **225(96.6%)** |
| 其中 gate | 8 |
| 最老 ask | 2026-07-13(4 天前) |

**信噪比 3.4%** —— issue 描述的「工具本身被废掉」完全成立,而且比 issue 说的
「7+ 条」严重得多。

按 A2 谓词独立用 SQL 分类(不看实现,只按 plan 写的规则):

| 形态 | 条数 | 应当 |
|---|---|---|
| UUID + CommDB 行已删 + age>30m | **184** | 清 |
| UUID + CommDB 行还在(FLY-161 completed-alive) | 40 | 留 |
| 非 UUID(`qa-fly1239-78754`) | 1 | 留 |
| 有 response child | 0 | — |

---

## 3. 真机 E2E(验收 #2)—— 经**真 GatePoller**,非手搓候选集

harness: 生产快照 comm.db + 生产快照 teamlead.db + 真 `StateStore` + 真
`GatePoller.zombieGateHygienePass()`。

| 对照 | pending 前 → 后 | resolved_via 戳 | 单轮耗时 |
|---|---|---|---|
| **flag 默认 ON** | **233 → 49** | `owner_closed_sweep` × **184** | **95ms** |
| **`FLYWHEEL_ASK_HYGIENE=0`** | **233 → 233** | **0** | — |

- 184 = 我独立 SQL 预测的候选数,**逐条对上**;
- 非 UUID 的 `qa-fly1239-78754` **确实幸存**;40 条活行 ask 幸存;
- **无 batch 上限、单轮清空**(验收 #2 的合同)—— 95ms,plan §6 担心的
  「首轮 178 次 StateStore 触碰」实测不构成问题;
- kill-switch 那行是**同 harness 同数据的 A/B 对照** —— 证明尺子两个方向都准,
  不是「负向断言空过」。

> ⚠️ **过程诚实记录**:我第一版 harness 报「233 → 233」。差点当 bug 报。
> 实为**我自己的 harness 坏了**两处:①`vitest.setup.ts`(FLY-493)每个测试
> 强制重置 `FLYWHEEL_COMM_DIR`,压过我的 HOME 重定向 → poller 打开的是不存在的
> 库、catch 掉 → 0ms 空跑;②`new StateStore()` 写错,正确是
> `await StateStore.create()` → `store.getSession` 抛错 → 整个 sweep 被
> gate-poller 的 catch 吞掉。修完后我用**独立 SQL 谓词分桶**预测 167,真 sweep
> 退休 167 —— 尺子与被测物互证之后,数字才敢写进报告。

---

## 4. 变异测试(证明绿测不是空过)

### 4.1 A1 级联(db.ts)—— 5 变异 / 4 杀死

| 变异 | 结果 |
|---|---|
| 删 15min grace 谓词 | ✅ KILLED(3 红) |
| gate 的 `resolved_via` 不受 flag 守卫 | ✅ KILLED |
| 整条 ask 级联无视 kill-switch | ✅ KILLED |
| forensic TTL 无视 protection 分档 | ✅ KILLED |
| 删 `NOT EXISTS(response child)` | ⚪️ SURVIVED |

最后一条 **不是覆盖缺口,是 equivalent mutant**:实测
`insertResponse`(db.ts:951)是**全仓唯一**写 `type='response'` 的地方,且**同一
事务内**必调 `markQuestionTerminalDisposed` → 「有答案 + relay_state 非
terminal_disposed」这个状态不可达 → `NOT EXISTS` 是纵深防御,删了行为不变。
T4 断言的**产品合同(答过的 ask 不动)真成立**。故不报缺陷。

### 4.2 A2 生产接线(gate-poller.ts)—— 2 变异 / **2 条全部存活** 🔴

| 变异 | 既有 4 文件 80 测 | + 我补的接线测 |
|---|---|---|
| 候选过滤器回退成 `q.checkpoint != null`(**ask sweep 生产上彻底失效**) | 🔴 **80 passed(全绿)** | ✅ KILLED(2 红) |
| 删 `sweepBookkeeping` 守卫(**ASK-only 会清掉 watchdog unreachable episode**,plan §4.1 / Codex R2 #4 明令禁止) | 🔴 **80 passed(全绿)** | ✅ KILLED(1 红) |

未变异基线 85/85 全绿。

---

## 5. 发现

### F1 — MEDIUM(**QA 已补测修复**):A2 sweep 的生产接线零覆盖

`ask-hygiene.test.ts` 直接调 `runZombieGateHygiene(...)` 并**手搓
`pendingGateQuestions`**。这证明了 sweep **函数**对 —— 但生产里没人手搓候选集,
是 `GatePoller.zombieGateHygienePass` 现建的。**那道缝一条测试都没有。**

危害是**静默**的:把过滤器改回 `q.checkpoint != null`,FLY-1328 在生产上
**一条 ask 都不会清**(功能等于没上线),而 CI 全绿、没有任何红灯。
这正是 [[feedback_vacuous_green_fixture_disables_the_thing_asserted]] 的形态:
**测了函数,没测产品**。

**修复**:新增 `packages/teamlead/src/bridge/__tests__/ask-hygiene-poller-wiring.test.ts`
(5 例,经真 GatePoller + 真 CommDB + 真 StateStore):
① 经 poller 真退休一条 ownerless ask(钉候选过滤器)
② `FLYWHEEL_ASK_HYGIENE=0` 经 poller 不动它
③ ASK-only 不碰 watchdog bookkeeping(**先断言 sweep 真跑了**再断言没调 —— 阳性对照在前)
④ watchdog ON 的反向对照(证明 spy 真能捕获)
⑤ CommDB 行还在的 ask 经 poller 幸存(FLY-161)

**注**:代码本身**没错** —— 生产数据 E2E 证明接线是通的。这是「将来会静默坏掉
且没人知道」的风险,不是当下的 bug。

### F2 — LOW:代码注释里的生产数字已过期

`zombie-gate-hygiene.ts` 的 chronology 注释写:

> "of 184 sweep candidates, **83 have NO terminal_at** ... failing open would
> forfeit **~45%** of the backlog"

**我今天实测同一生产库**:候选 **184**(对上),但无 `terminal_at` 的是
**158(~86%)**,不是 83(~45%)。

`ZERO are in the post-terminal shape` 这条**核实为真(0 条)** —— 所以
**结论成立,而且比注释写的更强**(fail-open 会白扔 86% 而非 45%)。只是引用的
数字是旧快照。建议更数或改成「实测无 post-terminal 形态;fail-open 会放弃绝大
多数存量」这类不易腐的表述。不阻塞。

### F3 — INFO:StateStore 新增一个重量级模块导入(**假设已被我证伪**)

`StateStore.ts:12` 新增 `import { askHygieneEnabled } from "flywheel-comm/db"` ——
main 上 StateStore **完全没有**这个导入(只有注释里提到)。为了一个 3 行 env 读,
把 ~2900 行的 CommDB 模块拉进 teamlead **最被广泛 import 的模块**。

我一度怀疑它拖慢了 `terminal-thread-archive` 的 5s 超时测试(branch 前 5 次里
挂 2 次、main 4 次全绿)。**加样到 branch 11 次 / main 10 次后信号翻转**:
branch 挂 2/11、main 挂 2/10 —— **两边同样挂,与 FLY-1328 无关**,纯 load
(实测 load 33.9)。**假设证伪,不作为缺陷。**

保留为观察:若日后想收窄,把 `askHygieneEnabled` 放进一个叶子模块(如
`flywheel-comm/src/ask-hygiene-flag.ts`)由 db.ts 再导出,即可保住 plan 要的
「单一真相」又不牵动整个 db.ts。纯建议。

---

## 6. 既有失败:全部与 FLY-1328 无关(**有 main 基线为证,非引用记忆**)

| 失败 | 判定依据 |
|---|---|
| `ship-eligibility.test.ts` 16/28 红 | **在 origin/main 干净 worktree 上同样 16/28 红**;文件与 main **逐字节相同**;不在本 PR diff |
| `terminal-thread-archive` M9 | branch 2/11 挂,**main 2/10 挂** → 两边同款 load flake |
| `worktree-quarantine` ×2 | 单独跑 **5/5 全绿** → load flake(真 git,5s 超时) |
| `statestore-ghost-realprobe` | 真 tmux + 5s 超时,load 33.9 → 同款 |

---

## 7. 验收逐条

| plan §0 验收 | 结论 | 证据 |
|---|---|---|
| ① 单测 + kill-switch sentinel 全绿(含突变验证) | ✅ | flywheel-comm 16/16;teamlead ask-hygiene 相关 90/90;A1 变异 4/5 杀(第 5 为 equivalent mutant);**A2 接线 0/2 → 补测后 2/2 杀** |
| ② 真机单轮清空存量 | ✅ | 生产快照 **233→49**,184 戳,**95ms**,非 UUID/活行/新 ask 全留 |
| ③ 投递合同(诚实版) | ✅ | grace 谓词变异 KILLED;M12 relay-failure 场景在既有测试中 |
| ④ `FLYWHEEL_ASK_HYGIENE=0` 逐字段回退 | ✅ | 生产数据 A/B:**233→233 + 零 resolved_via**;gate `resolved_via` 受 flag 守卫(变异 KILLED) |
| ⑤ 取证两层 | ✅ | forensic TTL 分档变异 KILLED;`commdb_ask_disposed` 幂等事件合同测试在 |
| ⑥ lint + CI + Codex + 独立 QA | ✅ CI 已补(见 §10) | lint:我的新文件 + FLY-1328 触及文件 biome(仓库 pin 2.1.4)干净。**CI:round 1 我只核了 lint 没核 CI —— 那是真缺口,round 2 已补成实证**(§10)。Codex `-sol` 补审仍 pending,Tadashi 已知悉并列入晨报 |

**⑥ 的未了项(交 Tadashi 判,不是我的权限)**:progress.md 自述
「**Formal gpt-5.6-sol review PENDING not waived**(fleet freeze / school quota)」,
只跑了 Claude stopgap review。按 [[feedback_dont_waive_codex_review_when_available]],
正式 Codex code review 要不要补、还是 Tadashi 明示豁免 —— **由 Tadashi 拍**。
`pnpm lint` 全仓红,但红的全是**本 PR 未触及**的文件
(`DirectEventSink.test.ts` / `StateStore.fly1185-lifecycle.test.ts` /
`heartbeat-quiet-suppression.test.ts` / `engineering/doc/FLY-1066-*.mjs` 的
`suppressions/unused` 与 `noCommaOperator`)—— 若 CI 卡这个,是既有债不是本单引入。

---

## 8. 生产安全

- 全程只读生产:`sqlite3 ... mode=ro` + `.backup` 取快照,所有跑动都在
  scratchpad 副本上;
- **完跑后复核生产 `comm.db`:无 `resolved_via` 列、pending 仍 233、mtime 未变**
  —— 我没有 sweep 到生产;
- 变异测试全部 `cp` 备份 → 改 → 跑 → 立即还原,`git diff` 复核**逐字节还原**;
- 建的两个 baseline worktree 已 `git worktree remove`。

---

## 9. 部署提醒(转给 ship 窗)

flag 默认 ON,随下次 Bridge 重启生效;生效后**第一轮 patrol(~60s)**就会把
存量清掉(实测 95ms / 184 条)。回滚 = `FLYWHEEL_ASK_HYGIENE=0` + 重启,无需回码。

---

## 10. Round 2 — CI 阻塞 + 新 head `d3aa5a8c0` 复验

### 10.1 我 round 1 的缺口(自认)

验收⑥ 我**只核了 lint,没核 CI**,只写「⚠️ 见下」就过去了。CI 当时**已经是红的**
(`16abef383` 就红),我没看。这是真缺口,不是事后诸葛。下面是补的实证。

### 10.2 阻塞:`package-onboard` gate① secret 扫描

`Build & Test @ 6b596cac9` FAIL → FLY-1062 payload smoke →
`[package-onboard][error] gate①: secret-like content in release tree`,
扫描器报 `[vendor-token] (redacted)`。

归因(全部查证,非推测):

| 问题 | 结论 | 证据 |
|---|---|---|
| 我(QA)的提交带的? | **否** | 同一条在 `16abef383`(我提交前)一模一样地挂;test+doc 被 gate③ 排除,进不了 release tree |
| main 的债? | **否** | main 在 merge-base `02db03271` 与 tip `9c8d57f84` **都绿**;同期 FLY-1329/1327/1323 全绿,**只有 FLY-1328 红** |
| 本票代码够得着 release tree? | **是** | allow 清单含 `dist/run-bridge.js`(bundle),`zombie-gate-hygiene.ts` 被打包进去 |

### 10.3 真根因(implement `d3aa5a8c0` 修,我独立复验)

**功能名自己伪造了一个 OpenAI key 前缀。**
`ask-hygiene-…` 里,`ask` 的末两字母 + 连字符 = **`sk-`**;vendor 正则
`sk-(proj-)?[A-Za-z0-9_-]{20,}` 要求其后 ≥20 个词字符:

| 字符串 | `sk-` 之后 | 命中? |
|---|---|---|
| `ask-hygiene-retire-intent-` | `hygiene-retire-intent-` = **22** 字符 | 🔴 **命中 = 元凶** |
| `ask-hygiene-retired-` | `hygiene-retired-` = 16 字符 | 未命中(**只是没超阈值**) |
| `ask_hygiene_retire_intent_`(修后) | 无 `sk-` | ✅ 未命中 |

修法 = 连字符改下划线。**我用 `fleet-sanitize.sh` 里的真实正则做 A/B 独立验证,
外加阳性对照**(确认扫描器真能打中旧串,即尺子没坏)—— 三项与上表逐格吻合。
代码注释自称 outcome id「只是运气好没超阈值」——**核实为真**,注释诚实。

### 10.4 新 head `d3aa5a8c0` 复验结果

| 项 | 结果 |
|---|---|
| **CI @ `d3aa5a8c0`** | ✅ **Build & Test pass(18m50s)+ FLY-1062 payload pass** ← 验收⑥ 的实证 |
| 全部 FLY-1328 测试 | ✅ **90/90** |
| 两条接线变异(§4.2) | ✅ **仍双双 KILLED**(85/85 未变异;`gate-poller.ts` 与 round 1 逐字节相同) |
| **生产快照 E2E 重跑** | ✅ **233 → 49,184 戳 `owner_closed_sweep`,93ms** —— 与 round 1 **逐格一致**,event-id 改名未动行为 |
| 旧连字符 id 残留 | ✅ **零**(grep 全仓非-dist) |
| intent/outcome 前缀自洽 | ✅ `ask_hygiene_retire_intent_` / `ask_hygiene_retired_` 与 `outcomeIdPrefix` 配对一致 —— 改一半会静默坏掉 reconcile 配对,已专门核 |

**迁移风险 = 无**:该 feature 从未上过生产(生产 `comm.db` 无 `resolved_via` 列,
已核),故不存在旧格式 `ask-hygiene-retired-*` 历史事件需要兼容。

**结论:功能 PASS 维持(Tadashi 裁定不翻),ship-ready 现在为真。**
