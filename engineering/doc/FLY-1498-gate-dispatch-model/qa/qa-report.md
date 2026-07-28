# FLY-1498 门与图 — QA 报告
Issue: FLY-1498
日期: 2026-07-28
基于: `plan.md`(§4 验证 / §5 完成定义)、`fly-1498-gates-dispatch.md`、`design-FINAL-v2.md`

被验 head: `c777ccae0d92fa9d7c1815aa4169b369735b1416`(PR #717)

## 0. 结论

> **最终结论(第 2 轮复测,head `317c1afb`):PASS。**
> M-1 已修复并经独立复核,详见 §6。以下 §0-§5 保留**第 1 轮**(head `c0254515`)
> 的原始判定与证据,不回改 —— 审计链要看得见曾经 FAIL 过什么、怎么修的。

**第 1 轮:FAIL** —— 一条 MEDIUM 缺陷:设计的前向迁移交接清单把「本设计已改变语义的存量表」
显式收口为**两张**(gates、thread_bindings),但设计自身的规范章节还改了第三张
`tasks`,且它新增的两个属性在 FLY-1497 已 ship 的 schema 里**没有落脚点、也没有任何
文档枚举它们的迁移**。按清单原子交付的 schema owner 会交出一个无法表达 §3.1 派发
谓词的 schema。

其余全部通过:founder 五条要求逐条落地、plan §4.1 静态一致性 31/31、仓库验证
lint/build 绿、CI 全绿、当前 head 已有合法跨族 Codex 评审记录。

## 1. 缺陷 M-1(MEDIUM)— 迁移交接清单漏掉 `tasks`,且新属性无存储归属

**证据(设计侧)**

- `design-FINAL-v2.md:32` — `tasks:稳定 DAG identity+contract+writes_repo+attempt_generation`
- `fly-1498-gates-dispatch.md:23-24` — 「每 task 有 contract、writes_repo capability、
  `attempt_generation` 与 state」
- `fly-1498-gates-dispatch.md:214` — 派发谓词直接读 `task.writes_repo = false`
- `fly-1498-gates-dispatch.md:121` — 完成合同直接读 `declared(task.contract)`

**证据(已 ship 的 schema 侧,FLY-1497)**

`packages/v2-kernel/src/migrations/0001-base-schema.ts:2-21` 的 `tasks` 表实际列为:
`id / project_id / external_issue_id / kind / state / state_version / priority /
payload / rework_of / lineage_root_id / created_at / terminal_at`,外加两个
`tasks_no_self_rework_ins|upd` 触发器。

即:**没有 `contract`,没有 `writes_repo`**;反而留着本设计明确废除的 `rework_of`
(`fly-1498-gates-dispatch.md:29`「rework 不创建 successor task 或 graph back-edge」)
与 `lineage_root_id NOT NULL`。

**证据(清单侧 —— 这条是硬伤)**

`mapping-v2final.md:104` 原话:「同一前向迁移还必须显式承接本设计已经改变的**两张**
存量表语义」,随后只列 `gates` 与 `thread_bindings`,并在 `:115-116` 要求
「这两项与 drop obligations/create actions 在 schema owner 的同一 PR 原子交付」。
`plan.md:86-87` 与 `fly-1498-gates-dispatch.md:410-414` 的清单同样只有
drop obligations / create actions / 重建 gates / 重建 thread_bindings。

跨四份文档 grep `ALTER TABLE tasks` / tasks 新增列 → **零命中**(见
`verify-design-consistency.sh` 之外的手工核查命令,记录于 §4)。

**为什么这不是吹毛求疵**

清单是**封闭计数**(「两张」)且要求**原子交付**。schema owner 照单全收地实现,
交付后 §3.1 的 `task.writes_repo` 与 §2.1 的 `task.contract` 无处可读 —— 本单最核心
的两条(合同由产出派生、派发器只认通用谓词)在 schema 层无法落地。这正是 FLY-1498
要根治的「门按名字不按内容」的镜像失败:合同被声明了,但没有承载它的列。

**建议修法(小改,不动方向)**

把 `tasks` 补进同一前向迁移的承接清单,并明确三件事:

1. `contract` 与 `writes_repo` 的存储归属(新列 / 复用 `payload` JSON —— 任选其一,
   但必须写死,否则 schema owner 无从下手);
2. `rework_of` 与 `tasks_no_self_rework_ins|upd` 的处置(既然废除 successor,是留作
   死列还是随迁移 drop);
3. `lineage_root_id NOT NULL REFERENCES tasks(id)` 的处置 —— `thread_bindings` 重建
   已经拿掉了它的消费者(`mapping-v2final.md:113` 要求不得用它「冒充」canonical
   identity),但 `tasks` 上的列与 NOT NULL 约束仍在,新建 task 仍被迫填值。

同时把「两张」改成实际张数,避免封闭计数与正文再次不一致。

**刻意未报为缺陷的相邻项(避免 over-reaction)**

- `attempt_generation`:已 ship 的 `attempts` 表有 `generation` 且带
  `UNIQUE(task_id, generation)`(`0001-base-schema.ts:37,50`),本身就是 task-local,
  大概率无需新列 —— 不当作 gap。
- 一次性 merge capability 的 subject 绑定:`capabilities` 已有 `subject_digest` /
  `action` / `attempt_generation`(`0001-base-schema.ts:129-143`),足以承载
  `{gate,effect_key,repo,pr,head,attempt_no}` 的 digest,无需新列。
- 17 张表预算:0001 的 14 张 + activations + processing_attempts + schema_migrations
  = 17;drop obligations + create actions 后仍是 17。与 FINAL §1.0、plan §2.4 一致。

## 2. 通过项

### 2.1 founder 五条要求逐条对照

| 要求 | 落点 | 结果 |
|---|---|---|
| ① 完成合同与证据同一事务 | detail §0-1、§2.3 | PASS |
| ② 合同由实际产出派生,不由节点名 | detail §2.1 派生矩阵 + 「节点名、phase、role、三段式位置都不参与派生」 | PASS |
| ③ ship 是动作,只验通用三条 | detail §4.2、FINAL §1.5「前置恰三条」+ 明列 review/QA/docs/role 与 CI 不在谓词 | PASS |
| ④ 派发器只认 DAG | detail §3.1 唯一 eligibility + 「引擎不得出现 design/implement/qa/template 名字面量」 | PASS |
| ⑤ PRD 畅通 / QA 合同是 verdict / 零场景特例 | detail §6.1、§6.2、§3.1 | PASS |
| 反 over-reaction 清单 | detail §7 九条机制表(可被 founder 逐条砍) | PASS |

### 2.2 plan §4.1 静态一致性 — 31/31

由 `qa/verify-design-consistency.sh` 机检,覆盖 ship 三条、DAG 零形状分支、废弃词汇
只出现在否定语境、detail↔FINAL 术语与**数值**一致(reconcile 5min / 6 次 /
base 2min / cap 15min / 阶梯 2-4-8-15-15 / mint 点恰二)、r5-delta 自证非权威、
17 表预算。

**阴性对照**:`--selftest` 会把三份文档故意改坏(把「前置恰三条」改成四条、把 CI
写成第四条谓词、给引擎塞回 design/implement/qa 分支、塞回 obligations/ownerLeadId
活口径、把 r5-delta 的「非权威」抹成「权威」),要求检查器**至少报 5 处失败**才算
自检通过 —— 证明这把尺子不是恒绿的空过。实测:`SELFTEST PASS — detected 5`。

检查器最初对两处**误报**(硬换行把否定词与被否定词切到不同物理行,例如
「rework **不创建** successor task」),已改为按 markdown 逻辑块折行后再匹配;这属于
尺子的缺陷,不是文档的缺陷,已在脚本注释里写明。

### 2.3 plan §4.2 仓库验证

| 命令 | 结果 |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm -r build` | exit 0 |
| `pnpm test:packages:run` | exit 1 —— 见下 |

`pnpm test:packages:run` 在 `flywheel-comm` 失败 5 例(`cli.test.ts` 的 check 4 例、
`chat-receipt.test.ts` 1 例),全部是 `Test timed out in 5000ms` 的**超时**,不是断言
失败;`pnpm -r` 在该包 bail,导致 `teamlead` 本地根本没跑
(`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`)。

判定为**既有环境态,与本分支无交集**,三条独立证据:

1. `git diff main...HEAD --name-only | grep -c '^packages/'` = **0** ——
   被测源码与测试代码与 main 逐字相同,本分支的 diff 在逻辑上不可能导致其失败;
2. 失败形态全是超时,本机当时有 24 个 session / 16 个 Lead / Bridge 在跑;
3. **干净环境对照 = 本 head 的 CI 全绿**:`.github/workflows/ci.yml:65` 的
   `Unit (heavy)` 正是跑 `flywheel-comm`,`:59-63` 三个分片跑 `teamlead`,在
   `c777ccae` 上 9 个 check 全部 SUCCESS。

按 plan §4.2 要求,不把既有债务修进本单。

### 2.4 plan §5 完成定义

| 条目 | 结果 |
|---|---|
| 三份并稿过静态一致性 | PASS(§2.2) |
| `git diff main...HEAD` 无 `packages/` 与 feature-flag 修改 | PASS(0 个 packages 文件;无 flag/config/.env 改动) |
| 仓库验证完成并记录 | PASS(§2.3) |
| docs PR 已建 | PASS(#717) |
| PR head 经跨族 code review | PASS —— 见 §3 |
| CI 通过 | PASS(9/9 SUCCESS) |

## 3. ship 前置的结构性核查(QA 角色特有)

开工第一件事核了「ship 前置在 QA 角色下结构上可否满足」,结论与旧记忆不同,记录如下:

- `~/.flywheel/teamlead.db` 在 head `c777ccae` 上**有**一条
  `status=approved / author_family=codex / reviewer_family=claude` 的记录,由 implement
  会话 `97200b03` 挣得,跨族成立。
- **FLY-1434 已把 `verify-approval` 的查询从 exec-scoped 改成 issue-scoped**
  (`packages/flywheel-comm/src/commands/verify-approval.ts:387-415`:按
  `project_name + issue_id + target_repo_identity='__main__' + head` 查,并用**作者
  会话**的 adapter 判跨族)。所以三段式 QA 会话**能**消费 implement 挣到的记录 ——
  「QA 永远继承不到 implement 记录」这条旧结论对当前代码已**不成立**。
- 仍然成立的是另一半:`auto-qa-coordinator.ts:968` 的 `isReviewableRole` 只收
  main/implement,**QA 角色自己挣不到新记录**。

因此 head 一旦漂移,新 head 的记录只能由 implement 会话挣。本轮判 FAIL 后由 implement
在同一分支修改并推新 head,记录与 QA 复验都在新 head 上重做 —— 这条路径天然绕开了
上述绑定问题。已把该结构性问题非阻塞报给 Lead(question `20d79606`),含一条诚实提醒:
新 head 若含 claude 会话的提交,诚实的评审者应是 codex,否则就是本设计
`effective_author_set` 要根治的首写者自审。

## 4. 复现命令

```sh
# 静态一致性 + 阴性对照
bash engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh
bash engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh --selftest

# M-1 证据
grep -n -A 20 "CREATE TABLE tasks" packages/v2-kernel/src/migrations/0001-base-schema.ts
grep -rnE "ALTER TABLE tasks|tasks.*(contract|writes_repo).*新增列" \
  doc/engineer/plan/v2/design-FINAL-v2.md \
  doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md \
  engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md \
  engineering/doc/FLY-1498-gate-dispatch-model/plan.md   # 零命中

# 仓库验证
pnpm lint && pnpm -r build && pnpm test:packages:run
git diff main...HEAD --name-only | grep -c '^packages/'   # 0
```

## 5. 本轮未验证 / 诚实边界

- 本单是纯设计文档,**没有可运行的产品行为**可做真机 E2E;detail §6 的 16 条验收矩阵
  是给后续实现单的合同,本轮只核了它们在文档层自洽,**没有也无法**在运行时验证。
- 一致性检查器是 grep 级的,只能证明「该出现的话出现了、该消失的口径消失了」,
  不能证明设计在语义上正确;设计正确性由 Codex 跨族评审(R1-R6 + PR head 复审)承担。
- 未把检查器接进 CI:该设计稿会被下游实现单取代,常驻 CI 守卫属于没人要的保护性
  机制(issue 的反 over-reaction 原则),故只留可手跑的证据脚本。

---

# 6. 第 2 轮复测 —— PASS

被验 head: `317c1afbc944c00f3296d4a638a936117f780f36`
TURN: `yours` phase=qa **epoch=7**(implement/epoch6 → qa/epoch7 已 CAS 交接)

## 6.0 结论

**PASS。** M-1 已修复;新增断言经**独立**反恒真复核全部有效;locale 修复复现成功;
implement 自报的本机 lint/测试失败经独立判定确为既有环境态。

## 6.1 前置(独立核验,未照单接受 Lead 转述)

| 项 | 证据 | 结果 |
|---|---|---|
| TURN | `flywheel-comm turn` → `yours phase=qa epoch=7` | ✓ |
| head / 工作树 | 本地=remote=`317c1afb`,`git status --porcelain` 0 行 | ✓ |
| 跨族评审记录 | 绑 `317c1afb`,`approved`,author=codex/reviewer=claude | ✓(同族窗口见 §6.5) |
| CI | `gh pr checks 717` **exit 0**,9/9 SUCCESS | ✓ |
| implement 已 park | `runner_declared_states` = `parked` | ✓ |

## 6.2 M-1 修复复核(对照物 = 已 ship 的 `0001-base-schema.ts`,非设计自述)

| 第 1 轮要求 | 修复后 | 结果 |
|---|---|---|
| 封闭计数「两张」改成实际张数 | MAPPING:「已经改变的**三张**存量表」 | ✓ |
| `contract`/`writes_repo` 存储归属写死 | `contract_json TEXT NOT NULL CHECK(json_valid(...) AND json_type(...)='array')` + `writes_repo INTEGER NOT NULL CHECK(writes_repo IN (0,1))`;显式**禁止**按 `kind`/节点名/phase/路径猜 `writes_repo`,来源缺失整笔 migration fail closed | ✓ |
| `rework_of` + 两个 self-rework trigger 处置 | 同一次 `tasks` rebuild 删除 | ✓ |
| `lineage_root_id NOT NULL` 处置 | 同一次 rebuild 删除 | ✓ |
| (第 1 轮刻意不报的)`attempt_generation` | 明确由 `attempts.generation + UNIQUE(task_id,generation)` 权威承载,不在 tasks 复制第二份 counter | ✓ 处理正确 |

## 6.3 反恒真复核 —— **本轮最重要的一项**

第 1 轮我的 `--selftest` 判据是 `FAIL >= 5` 的**聚合阈值**,它有个我自己的弱点:
**只要老的腐化仍被抓到就通过,新增断言即使条条恒真也照样绿**。本轮 implement 把
selftest 改成 15 条逐条定向阴性对照 —— 但**那是它自证**,不能替代独立复核。

因此我**没有采信** `--selftest`,而是自建 harness
(`qa/anti-vacuity-harness.sh`,同目录)独立复核:把三份文档 + checker 复制到
**隔离临时目录**(共享工作树全程 `git status` 0 行),对 implement 新增的**每一条**
断言,腐化**它自己声称保护的那个点**,要求**该条 label 本身**翻红。

**结果:10/10 CAUGHT,0 条恒真。** 其中一条腐化正是 M-1 回归本身
(`改变的三张存量表` → `改变的两张存量表`),确认该断言能挡住旧缺陷复发。

harness 内置 baseline 断言:隔离副本必须先 41/41 全绿,否则中止 —— 避免在一个
本来就红的副本上做腐化实验得出无意义结论。

## 6.4 locale 决定性(implement 自称已修,我复现)

| 环境 | 结果 |
|---|---|
| `LC_ALL=en_US.UTF-8` | exit 0,passed=41 failed=0 |
| `LC_ALL=C` | exit 0,passed=41 failed=0 |
| `diff` 两份输出 | **逐字相同** |

这条必须自己复现,因为它正是「尺子在某些环境下量不准」那类缺陷,而 §6.3 的全部
阴性对照都依赖这把尺子。

## 6.5 同族自审窗口 —— 结案口径(Lead 裁定,逐字保留)

绑 `317c1afb` 的评审记录是 `author=codex / reviewer=claude`,而我的 claude 提交
`c0254515` 经 `git merge-base --is-ancestor` 确认仍在该 head 历史中,故同族窗口
**客观存在**。Lead 最初要求「新 head 评审者必须是 codex」,随后自行读
`review-request-coordinator.ts:627-633` 确认当前实现做不到(reviewer 由
`adapterTypeToFamily(session.adapter_type)` 决定,取的是**发起会话**的 adapter,
不是 diff 的真实作者),遂当场改判为「显式披露,不许假装」。

我按要求核了「有没有淡化」:implement 在 DETAIL §17 / MAPPING §18 点名 request
`d323b56b`、reviewed head `04bf3335`、增量作者构成,原话有「Claude 实际审到 Claude
QA 产物」,并明写「这不等价于独立 review,也不消除同族窗口」,**没有**拿 selftest
抓到 5 处破坏当挡箭牌。**结论:是事实,未淡化。**

**Lead 裁定的结案口径(一字不改)**:

> 本 PR 存在一个**客观的同族自审窗口**,覆盖范围**仅限非产品产物**(claude QA 会话写的测试与报告 + 文档);**当前 v1 路由机制上无法消除它**(评审者由发起会话家族决定,非 diff 真实作者);**已在设计中显式披露、未淡化**;**v2 已把 product-code 情形写成 `review_family_exhausted` 硬失败**。**据此以披露结案,不构成 FAIL。**

关键支撑事实:**本 PR 零产品代码** —— `git diff main...317c1afb -- packages/` = **0 个文件**,
全部改动为 18 个 `.md` + 1 个 `.sh` + 1 个 `.html`。而设计自身的
`review_family_exhausted` 政策写死:披露对 test/docs-only 可以,对 product-code
明确不行。**所以这不是网开一面,是该政策落在了它该落的那一侧;若本 PR 含一行产品
代码,该政策自己就会判 FAIL,不需要人裁。**

## 6.6 implement 自报本机失败 —— 独立判定为既有环境态

**lint(`pnpm lint` exit 1,640 errors)**

- **tracked source 零命中**:`packages/` `scripts/` `doc/` `engineering/` 下 **0** 条。
- 全部落在 `.pnpm-store`(18 个文件,`.git/info/exclude` 已忽略)与
  `.flywheel/runs/**`(2 个文件,`git ls-files --error-unmatch` 确认 **untracked** 运行时产物;
  `.flywheel` 下真正 tracked 的 13 个文件是 agent `.md`/`config.yaml`/menus/templates,零错)。
- **增量可解释**:本会话开头(head `c0254515`)`pnpm lint` 还是 **exit 0**;是**我自己**
  随后跑 `pnpm -r build` + `pnpm test:packages:run` 把 `.pnpm-store` 填出来的。

**package tests(`pnpm test:packages:run` exit 1,5 例失败)**

四条独立证据指向环境态而非回归:

1. `git diff main...317c1afb -- packages/` = **0 个文件** —— 被测源码与测试代码与 main 逐字相同,本分支 diff 在逻辑上不可能导致其失败;
2. 5 例**全部**是 `Test timed out in 5000ms.`,**零断言失败**;
3. **两次运行失败集不同** —— 第 1 轮(`c0254515`):`cli.test.ts>check` ×4 + `chat-receipt` ×1;第 2 轮(`317c1afb`):`await-codex-gate` ×1 + `cli>check` ×2 + `chat-receipt` ×1 + `feature-flags` ×1。同机不同集 = **非确定性**;
4. **干净环境对照**:本 head CI 9/9 全绿,其中 `ci.yml:65` 的 `Unit (heavy)` 正是跑 `flywheel-comm`。

另注:`pnpm -r` 在 `flywheel-comm` bail,`teamlead` 本地未跑到
(`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`);其覆盖由 CI 的三个 teamlead 分片承担,均绿。

**结论:两项均为既有环境态,不是本单回归;按 plan §4.2,不把既有债务修进本单。**

## 6.7 诚实边界(本轮)

- 本单仍是纯设计文档,**没有可运行的产品行为**;detail §6 的验收矩阵是给后续实现单的
  合同,本轮只核其文档层自洽,**无法**在运行时验证。
- §6.3 的反恒真只证明「断言能挡住它自己声称挡的那个点」,**不证明**断言集合覆盖完整
  —— 覆盖完整性由 Codex 跨族设计评审承担。
- §6.5 的同族窗口是**真实存在**的,不因结案而消失;它对本 PR 可接受的唯一理由是
  「零产品代码 + 已披露 + v2 已 fail-closed」,这三条缺一条结论就变。
