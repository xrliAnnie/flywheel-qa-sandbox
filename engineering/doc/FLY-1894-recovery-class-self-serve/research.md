# FLY-1894 恢复类 run 状态操作 Lead 自决 — 调研

Issue: FLY-1894 (https://linear.app/geoforge3d/issue/FLY-1894/规矩机制-恢复类-run-状态操作-lead-自决-固化进-lead-rules-basefounder-only-authority-新增)
日期: 2026-08-19
基于: exploration.md

> ## ⚠️ 本文部分结论已被 plan v4 / 范围裁定 B 作废
>
> 本文是**过程记录**,保留原样以便追溯推理链。以下结论**已不成立**,不要据此实施:
>
> | 本文的说法 | 现状 |
> |---|---|
> | R5 是一条已生效的 prompt 层自决授权 | **作废** —— R5 是分类框架,当前**不授权任何机制**;唯一生效的 carve-out 是 R3 |
> | thread 报备是直接状态写的唯一审计轨 | **作废** —— consent audit 与 operator rework 的多条 receipt 都会落盘;真正无 receipt 的只是直接状态写那几步 |
> | R5 应纯判据式、不该枚举 | **作废** —— 改混合模型:判据只分类,授权靠**闭合的逐项清单**(本版为空) |
> | 三判据满足即 Lead 自决执行 | **作废** —— 分类不是授权;清单为空期间仍须 founder 授权 |
> | 「只要发生恢复类 rework 都须声明」 | **作废** —— 缺陷只在 operator 一条路(engine 路径记 `engine` 且 founder 逐字字段为 `NULL`) |
>
> 权威版本以同文件夹 `plan.md` 为准。


## 1. 装载链验证 —— 写进这个文件是否真的覆盖「全项目全 Lead」

逐条实地核过,不是推断:

| 消费者 | 代码位置 | 结论 |
|---|---|---|
| Claude Lead(cos + dept) | `claude-lead.sh:2583-2590` | ✅ append,条件仅排除 companion / external |
| Codex Lead(full-access / write-capable / infra-bot TUI) | `lead-rules-bundle.sh:382-384` `_lrb_emit "${base}/founder-only-authority.md" "$governance_required"` | ✅ 且 `governance_required=1` 时缺文件 `return 10` fail-closed |
| companion Lead(Mufasa / Belle) | `claude-lead.sh:2584` `IS_COMPANION_ROLE != true` | ⛔ 故意跳过 → 换 `companion-safety-contract.md`。**本条对它们天然 inert**(companion 不开 Runner,没有 run 可恢复) |
| external agent(Anna) | 同上 `IS_EXTERNAL_ROLE != true` | ⛔ 故意跳过 |

⇒ **「会开 Runner 的 Lead」= 100% 覆盖,零额外接线。** Annie 要的「Honey Lemon 他们大家
都是一样的处理方式」由这个装载链直接兑现。

## 2. 没有内容级测试会被这次新增打红

搜过所有引用 `founder-only-authority` 的测试:

- `lead-rules-bundle.test.ts` / `rules-bundle-truth.test.ts` / `fly350-fullaccess-deploy.test.ts` /
  `fly231-companion-launch-plan.test.sh` / `run-codex-infra-bot-tui.test.sh` / `fly1402-single-bundle.test.sh`
- 多数按 basename 断言(`toContain("founder-only-authority.md")`)
- ❌ **更正(第 5 轮 review)**:我原写「没有一条断言文件正文」是**假的**。
  `packages/teamlead/scripts/test-fly26-rules-split.sh` 的 Test 6.12 **就是内容级的** ——
  断言文件非空、含 `# Founder-Only Authority` 抬头、且 reserved 清单在两个前缀下列全端点。
  漏掉它的原因是**扫描范围**:我只 glob 了 `__tests__/` 目录,而它直接躺在 `scripts/` 下。
  **零命中只说明「我扫的范围里没有」。** 这条是实施硬约束,见 plan §7
- 搜 `"Infra Self-Heal"` / `"Fleet Restart Discipline"` / `"R3 —"` / `"R4 —"` 在 packages/scripts 下
  **零命中** —— 即 R3/R4 两个 carve-out 加进来时也没留下内容断言

⇒ ❌ **更正(第 6 轮)**:不能写「测试面为零」。正确说法是:**现有测试不覆盖 R5 的新语义**,
但 `test-fly26-rules-split.sh` Test 6.12 **是内容级的**,构成实施硬约束(H1 抬头 +
两个前缀下的全部 reserved 端点不得被动到)。因此 plan §7 既保留必跑该 shell test,
又新增七条 R5 语义的静态断言。(注:这是「我扫的范围里没有」——扫的范围 = `packages/` + `scripts/`
下所有 `.ts`/`.sh`,排除 node_modules 与 dist。)

## 3. ⚠️ 关键发现:R5 的第④步端点**在 Track 2 服务端保留集里**

这是本次调研最实质的一条,exploration 里我猜错了,实测推翻:

### 3.1 事实

`packages/teamlead/src/bridge/founder-consent/reserved-endpoints.ts:126-130`:

```ts
{ method: "POST", path: "/api/runs/:runId/rework", action: "workflow_rework", surface: "A" },
```

即死角⑮四步配方的第④步(`POST /api/runs/:runId/rework`)**是** `FounderConsentEvaluator`
的保留端点之一,不是我原以为的「不在门里」。同文件 283-291 还给它标了 class metadata:
`kind: "run_lifecycle"`、`idempotencyClass: "idempotent"`、
`postconditionVerifier: "workflow_rework_materialized"`。

### 3.2 今天为什么不冲突

`packages/config/src/decision-mode.ts:resolveDecisionMode()` 的三级优先级:
canonical env 有值即胜 → 否则 legacy alias truthy 则 `enforce` → 否则 `off`。

生产实测(`~/.flywheel/.env`):

```
FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=audit_only
```

⇒ 生产是 **`audit_only`**(不是我在 exploration §5 写的 `off`,那句作废)。
`audit_only` = 门**只写审计行、不拦请求**。所以今天 R5 第④步照常能过,prompt 层授权与
服务端不冲突。

### 3.3 但这是一个会到期的结论

`DECISION_MODE` 一旦被翻到 `enforce`,`workflow_rework` 就会被服务端按 R1/R2 的标准去要
founder consent —— 而 R5 明说这一步 Lead 自决。**两层会在那一刻互相矛盾。**

处置(本单范围内):

- R5 正文**必须**写明它是 prompt 层授权,并点名这个服务端保留端点,让读到规矩的 Lead
  知道「服务端还没跟着放行」——而不是让他撞 403 才发现。
- 服务端侧的对齐(给 `workflow_rework` 加恢复类豁免 / 按 `idempotencyClass` 分级)
  **是代码,不在本单**。作为 follow-up 上报 Lead。
- 这条同时是给 R5 段落写「会过期的结论」表的直接理由。

### 3.4 顺带澄清:第①②③步不经过任何门

四步配方里前三步是对 StateStore 的直接 SQL(`workflow_run` / `workflow_run_node` /
`sessions`),不走 Bridge HTTP,因此既不被 Track 2 拦,也没有服务端审计。
⇒ **R5 的「做完报备」不是礼貌,是这三步唯一的审计轨。** 正文要把这个理由写出来,否则
读者会把报备当可选项。

## 4. R3 先例的可复用骨架

R3(`founder-only-authority.md:317-359`)的五段结构,R5 逐段对应:

| R3 段 | R3 内容 | R5 对应 |
|---|---|---|
| 授权来源 + 窄化声明 | 「The founder (Annie, FLY-871) has authorized ONE narrow…」 | 换成 FLY-1894 / 2026-08-19 的直令 |
| 谁会真的用到 | 「只有 Codex Infra Bot 会用;companion 天然 inert」 | 「只有会开 Runner 的 Lead;companion inert」 |
| **The ONLY authorized action** | 枚举死一个动作 | **改成三条判据**(见 §5 为什么) |
| **Hard conditions (ALL must hold)** | 5 条,含证据/一次重试/审计 | 保留结构:三判据 + 报备义务 + 不确定即 gate |
| 边界钉回去 | 「Anything beyond … remains reserved under R1/R2」 | 逐字同构:恢复 ≠ 终结 |

## 5. 为什么 R5 用判据式而不是枚举式

R3 能枚举,是因为它真的只有一个动作(restart-in-place)。R5 不能:

- 死角手册里恢复类的具体手法**随引擎演化**。死角⑮的四步配方是 2026-08-19 才由 1855 实锤
  固化的;死角②(`persisted_target_missing` 自动解锁窄路)、墙⑤(rework 不铸新 attempt
  pr_binding 的三步补法)各有各的形状。枚举今天写死,下一个死角出现时规矩就哑了。
- 而**判据是稳定的**:零工作丢失 / 回引擎正常轨 / 可回退或幂等 —— 这三条不依赖引擎实现,
  它们描述的是「这个动作的可逆性与破坏半径」。
- 判据式还有一个 fail-closed 的好处:**判据拿不准 = 不满足 = 照旧走 founder**。
  枚举式的默认是「没列到的就没规定」,那是 fail-open。

⚠️ 判据式的代价必须写进正文:它把「这算不算恢复类」的判断交回给 Lead。所以正文要给
**反面清单**(哪些看起来像恢复其实是终结),否则判据会被宽泛解读。

## 6. Future autonomy roadmap 的自相矛盾

`founder-only-authority.md:445-453`(v1.29.x — strict (now))现在写着:

> - All approve / close actions route to the founder, every time.
> - **No per-issue / per-action / per-Lead exceptions.**

R5 落地后这句在字面上不成立(R3 其实已经让它不成立了,只是没人回来改)。
而 roadmap 自己预言的正是这件事:「Track 2 audit table 积累证据 → 逐类毕业」。

R5 是**第一条不靠 Track 2 语料、直接由 founder 实证下放**的授权(Annie 嫌等她慢)。
⇒ roadmap 的 v1.29.x 段要补一句承认 R3/R5 两个已生效的 carve-out,并说明它们是
**founder 直令下放**而非 Track 2 毕业。不改 = 规矩文件自己打自己的脸,Lead 读到会困惑该信哪句。

## 7. 已核事实的保质期

| 结论 | as-of | 会不会过期 | 重核命令 |
|---|---|---|---|
| 生产 `DECISION_MODE=audit_only`(门不拦) | 2026-08-19 | **会** — 翻 `enforce` 即失效 | `grep -o 'FLYWHEEL_FOUNDER_CONSENT[A-Z_]*=.*' ~/.flywheel/.env` |
| `workflow_rework` 在 RESERVED_ENDPOINTS 里 | 2026-08-19 | 低 | `grep -n 'runs/:runId/rework' packages/teamlead/src/bridge/founder-consent/reserved-endpoints.ts` |
| 无内容级测试断言本文件正文 | 2026-08-19 | 低 | `grep -rn 'Infra Self-Heal\|Fleet Restart Discipline' packages/ scripts/ --include=*.ts --include=*.sh` |
| companion / external 跳过本文件 | 2026-08-19 | 低 | `sed -n '2583,2590p' packages/teamlead/scripts/claude-lead.sh` |
| 死角⑮四步配方的 SQL 形状 | 2026-08-19(1855 实锤) | **会** — 引擎守卫改了就变 | 见 `reference_engine_deadend_states.md` 死角⑮ |

---

## 附录:普查病理学 —— 这一单栽了四次(方法论遗产)

Lead 建议把它单独留档。四次都不是粗心,是**同一个推理形状**在不同维度上重复。

| # | 我写下的断言 | 真相 | 我漏掉的那个维度 |
|---|---|---|---|
| 1 | 「**只有** operator 路径有此缺陷」 | 实际有 **4 条** rework writer,我数了 3 条 | 全集的**成员数**没数全 |
| 2 | 「**没有**内容级测试,全部按 basename 断言」 | `test-fly26-rules-split.sh` 就是内容级的,而且它会因我的改动变红 | 全集的**范围**(只 glob 了 `__tests__/`) |
| 3 | 「攻击面**已从 N 收敛为 1**」 | 根本没列普查清单;同 bundle 还有多个文件各写各的 | **压根没做普查**就宣布收敛 |
| 4 | 「全量 census 已完成」 | 文件全集扫全了,但只扫「授权词」;**祈使式动作指令里一个授权词都没有**,整类漏掉 | 全集的**语义维度** |

**共同形状**:我每次只补上一次被抓的那个维度,然后用同样的自信写下一个全称词。
一致的样本比零命中更危险 —— 零命中长得可疑,「我看了 3 条全都一致」读起来像证据充分。

**第五次差点发生**:加宽普查后,我写了条正则想把「祈使式保留动作指令」分离出来,它报了 10 条。
我拿**已知为真的那条**(`runner-patrol-rules:65-66`)做阳性对照 —— **它没被捞出来**
(指令躲在表格数据行的单元格里,提示词在表头行)。这次我判死了自己的过滤器,没采信那个 10。

**沉淀成两条硬步骤**:
1. **写全称词之前先列普查清单** —— 全集是什么、我实际看了哪些、差集为空的依据。
   全集有**两个维度**:范围(哪些文件/位置)与语义(哪些表述形态)。列不出全集,
   就把「唯一 / 没有 / 全部 / 已收敛」降级成「**我核过的这几处是……**」。
2. **判别式的过滤器必须先过已知真例** —— 未经验证的过滤器给出的「只有 N 条」,
   和真的只有 N 条**长得一模一样**。

链接:`feedback_zero_result_needs_scope_control`(已补进「一致非零样本」变种)、
`feedback_absolute_claims_cost_more_to_prove`、`feedback_positive_control_needs_its_own_control`。

### 姊妹病:收紧时忘了问「现在有谁正在合法地穿过这扇门」

同一单内也犯了三次,而且**每次都是在「堵一个洞」的那一笔上**:

| # | 我堵的洞 | 我没问的那句 | 谁补上的 |
|---|---|---|---|
| 1 | R4:Lead 不得自主发起全舰重启 | ship 后的自动重启链正在合法地穿过 | Lead |
| 2 | 关闭 Runner 必须有绑定 session 的 R2 授权 | 引擎的 ship 后 auto-close / QA 体回收正在合法地穿过 | Lead |
| 3 | AUTH-CANON 概括 R1 为「head 变化即失效」 | R1 明文保留的**受控 head carryover** 正在合法地穿过 | Codex |

第 3 次的形状最隐蔽:**我以为自己只是在「复述」R1,并没有在改它。**
但那句概括删掉了原文保留的例外 —— **概括别人的规则,本身就是在改那条规则。**

**硬步骤**:写下任何收紧条款前,先列出**当前正在合法执行该动作的所有主体**;
凡是要「复述 / 概括」另一条规则的地方,一律改成**指针**,不复述。

### 中心教训:**肯定式定义开门,能力式判据关门**

这一单十二轮设计审,绝大多数 HIGH 都可以归到同一个形状 ——
**我每写下一条「什么算合法授权」的肯定句,就等于新开一扇门**,
因为任何人都可以来声称自己命中了它。逐句加严没有用,加严出来的还是肯定句:

| 我写的肯定式定义 | 谁能声称命中 |
|---|---|
| 「或 **founder 产品级直令**能放权」 | Annie 说过的任何一句方向性的话 |
| 「**条目写进清单**即生效」 | 写条目的人就是我自己 |
| 「Track 2 不是**唯一**途径」 | 字面等于承认它是途径之一 |
| roadmap「存在**第二条来源**」 | 同第一条,原地复活 |
| 「引擎级联**继承**触发动作的授权」 | 把任意破坏性动作包装成「级联」 |

真正关门的那一条,形状完全不同 —— 它**不定义什么算授权,而是问能力**:

> **是否存在任何 Lead 可达的调用面(endpoint / CLI / MCP)能触发它?**
> 有 ⇒ 受 R2 管;只能由引擎内部调度器 / 状态迁移触发 ⇒ 在 Lead 合同辖域之外。

它之所以关得住,是因为**没有声称空间**:够不够得着是事实问题,不是解释问题。
同理,`AUTH-CANON` 的负面清单(什么**不**构成授权)也比它的正面定义更耐攻击。

**How to apply**:写安全条款时,先问「这句话是在**定义资格**,还是在**度量能力**」。
定义资格的句子每多一条,攻击面就多一处;度量能力的判据可以机械判定,多写不增加攻击面。
**能用能力式判据表达的,不要用资格式定义表达。**

### ⚠️ 补正(第 13 轮):能力式判据**只在判定单位是「这次事件」时**才关得住

上面这条被 Lead 认可后,第 13 轮立刻打回了它的第一版实现。原判据是:

> 「**是否存在**任何 Lead 可达的调用面能触发它?」

它**不可机械判定**,而且两头都错:

- **按代码路径 / 最终 sink 判** —— 自动 self-ship 与手工 restart 共用同一 transport,
  只要手工入口存在,**合法的自动链会被全部误判成「Lead 发起」**(假阳);
- **按内部状态迁移判** —— Lead 能经 API / CLI / MCP / SQL / 配置 / 消息 / 建 job
  **间接制造**迁移,于是**破坏性动作被误判成「引擎自有」**(假阴);
- 而且「**不存在** Lead 入口」是一个**完整负面**,读规则的人根本无法证明。

修正后的形状是判**本次 exact invocation 的 causal ingress**:同一个 sink 的自动入口与
手工入口**可以归不同类别**;状态迁移只有带**不可伪造的 engine-origin receipt** 才算引擎侧;
**未知 / 混合 / 无法证明来源一律 fail-closed 归 R2**。

**所以完整的教训是两层,不是一层**:
1. 用**能力式判据**替代资格式定义(关掉「声称命中」的空间);
2. **判定单位必须是「这一次事件」,不能是「这段代码」** ——
   按代码路径判会同时制造假阳与假阴,并且往往要求证明一个完整负面。

**第二层是我漏掉的那半。** 一个能力式判据如果落在错误的粒度上,
它看起来仍然客观、仍然「不依赖意图」,但依旧判不对 —— 而且因为它读起来很硬,
更不容易被质疑。
