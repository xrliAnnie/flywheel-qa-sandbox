# FLY-1787 CoS identity.md 两处过期规则 — 调研

Issue: FLY-1787 (https://linear.app/geoforge3d/issue/FLY-1787/cos-identitymd-两处过期规则-dept-label-写-union-会让-issue-变成谁都派不了-路由-roster-漏了)
日期: 2026-08-15
基于: exploration.md

本文全部结论来自当日实测(读代码 / 读 live config / 看 live 进程),不是转述 issue。逐条给出证据位置。

## R1. Bridge 判定链:两个 dept label ⇒ 谁都派不了(已核实)

`packages/teamlead/src/department-registry.ts`:

- 判定优先级(注释 L228–235,与实现一致):
  `project_unknown → lead_unknown → lead_cannot_spawn → issue_no_department_label → issue_multiple_department_labels → label_mismatch → ok`
- `isLeadInScope()` L279–288:`classifyIssue` 返回 `kind:"many"` 时,拒绝理由 `issue_multiple_department_labels`,message 原文:
  > "Issue has multiple department labels (...); **Annie must reduce to one department label before any lead can spawn.**"
- 生产链(Codex R1 更正):`runs-route.ts` L1400 实际先走 `resolveLeadForIssue()`(first-label match)再统一过 `isLeadInScope()` fail-closed;`resolveCanonicalLead()` 当前只有测试调用、未接线生产。双 dept label 的终局拒绝发生在 `isLeadInScope()`,结论(谁都派不了)不变,但证据链以 `isLeadInScope()` 为准。

⇒ issue 上同时出现两个 dept label 时,默认配置下(dept-scope gate 默认开启)**任何** lead 的 `/api/runs/start` 都被拒,修复按 Bridge 文案要 founder 介入。Bug 1 的「写 union」在已有另一 dept label 时,精确制造这个状态。

## R2. dept label 的判定集合 = 「canSpawn 的 lead」的 match.labels(已核实,比 issue 描述更精确)

`classifyIssue()` L86–97:

```ts
for (const lead of project.leads) {
    if (!effectiveCanSpawn(lead)) continue;   // ← 非 spawning lead 的 label 不参与分类
    for (const label of lead.match.labels) { ... }
}
```

`~/.flywheel/projects.json` Flywheel 项目实测(2026-08-15):

| label | lead (botUserId) | canSpawn | 是否 spawn-gating dept label |
| -- | -- | -- | -- |
| `Flywheel` | flywheel-eng-lead (`1516207680836866219`) | ✅ | **是** |
| `Flywheel-Product` | flywheel-product-lead (`1523215538820612206`) | ✅ | **是** |
| `Flywheel-Triage` | flywheel-cos-lead (`1516205086890786917`) | ❌ | 否 |
| `infra-bot` | codex-infra-bot-lead (`1523219324561522831`) | ❌ | 否 |
| `claude-infra-bot` | claude-infra-bot-lead (`1524829037825101975`) | ❌ | 否 |

⇒ **当前 spawn-gating dept-label 集合恰为 `{Flywheel, Flywheel-Product}`**。`Flywheel-Triage` 与 `Flywheel` 并存不构成 "many"(CoS 不 spawn)。这条精确化直接决定 plan 里决策表的分支条件怎么写。

- issue 中 Honey Lemon 的 botUserId 声称 `1523215538820612206` — **与 projects.json 实测一致**。

## R3. 实测事故形态(issue + Cass 的 repro comment,本调研核对其机理成立)

- **FLY-1782**:Tadashi 计划并行发车 1455+1779+1782+1781,Cass 预检六张单,五张 `["Flywheel"]`、唯 FLY-1782 是 `["Flywheel-Product"]`。旧规则字面要求补 `Flywheel`(她的下一步已是 `labels: ["Flywheel-Product","Flywheel"]`)→ 会落入 R1 的 "many" 拒绝。而该 issue 归属本来就对(HL 自己的盘点单;三方从三个独立入口——Cass 读 projects.json+gate 代码 / HL 读自己归属 / Tadashi 读标签——得到同一结论)。⇒ 旧规则在「已有另一 dept label」分支给出的动作是**反的**:该路由给对应 Lead,不该动 label。
- **这条规则难被发现的原因(Cass 原文强调)**:规则读起来毫无破绽——它甚至正确警告了「`labels` 是整体替换」这个真实陷阱并给出看似稳妥的 union 写法。危险不在读得出错,而在执行才炸。完整判定过程见 FLY-1787 Linear comment(2026-08-15,Cass 应 Tadashi 要求补充)。
- **机制层护栏既已存在**(她的验收建议 1/2 对应的测试今天就在):`start-e2e.test.ts` L590–609(双 dept label ⇒ 默认开启的 gate 下 `/api/runs/start` 403 + `issue_multiple_department_labels`)与 L634–647(单 dept label + owning Lead 的 happy path)、`department-registry.test.ts` L233–263(precedence 5/6/7:many ⇒ `issue_multiple_department_labels`、错 lead ⇒ `label_mismatch`、owning Lead ⇒ ok)。**限定**:dept-scope gate 有 `BRIDGE_DEPT_SCOPE_REJECT=off` kill-switch(`start-e2e.test.ts` L649–664 断言 off 时跳过检查返回 200),关闭时机制层不兜底 —— prompt 层禁 union 因此独立必要,不是机制层的冗余。
- **`@HoneyLemon A`**(Annie, #flywheel-core):Discord @-mention 在 raw message 里是 `<@1523215538820612206>`,不含 "Tadashi" 字样 → 旧规则 2 不触发 → 落规则 3 → 字面要求 CoS 回复。CoS 未犯错靠的是 session memory,非本文件。

## R4. CoS→Product 的路由契约已在 HL 侧存在(不是新发明)

`.lead/flywheel-product-lead/identity.md`:

- L84–85:HL 监听 `#flywheel-core`(`1516209289406971965`),遵循 Core Channel Routing。
- L96–100(HL 的 reply discipline,与 Tadashi 同款):
  > Reply **only when** the message contains `<@your-bot-id>` OR the text "Honey Lemon" (case-insensitive). Otherwise **stay silent** — Aunt Cass (CoS) is the default replier.
- L239–241(工作来源):
  > "…or **Aunt Cass routing a product issue to you in `#flywheel-core`**. Product issues carry the **`Flywheel-Product`** scope label…"

⇒ 两个关键输入:
1. CoS 在 `#flywheel-core` @ Honey Lemon 派 product issue,是 HL 侧已经写死的既有契约 — CoS 侧文件补上这条只是**对齐**,不是新协议。
2. HL 自己的 name-trigger 是 **"Honey Lemon"(case-insensitive)**。CoS 的 abstain trigger 必须**恰好镜像**它(见 plan 取舍:比它宽会造成两边都沉默的 stall,比它窄会抢答)。

## R5. 部署链:改 repo 即可,重启生效(已核实)

- live CoS 进程(`ps` 实测):`claude --agent flywheel-cos-lead … --append-system-prompt-file ~/.flywheel/lead-rules-bundles/flywheel-flywheel-cos-lead.*.md …` ⇒ identity 内容经 `--agent` 加载(`~/.claude/agents/flywheel-cos-lead.md`),`--append-system-prompt-file` 装的是 rules bundle,两条通道互不混淆。
- `packages/teamlead/scripts/claude-lead.sh` L818–841:每次 Lead body 启动时解析 `AGENT_SOURCE = ${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md`,并 `rm -f` + **`cp`** 到 `~/.claude/agents/${LEAD_ID}.md`(刻意 copy 不 symlink,防 Lead 写回 repo)。
- md5 三方一致实测:worktree 副本 = 生产 repo 副本 = `~/.claude/agents/` 部署副本 = `14e6d830df42a01f9d9a4587c51edb4a`。

⇒ **生效路径 = merge 到 main → 生产 repo pull → Lead 重启(claude-lead.sh 自动重拷)**。无需手动同步部署副本;也解释了 issue 的时间约束(搭重启车)。

## R6. 相关既有规则,避免改出矛盾

- identity.md L34 HARD RULE:CoS→Eng handoff 只走 `#flywheel-core` @Tadashi,**NEVER `#leads-roundtable`**。→ 新增的 CoS→Product 路由必须同样落在 `#flywheel-core`(HL 侧 R4 契约也正是这么写的),不得引入 roundtable。
- identity.md L36 规则头:「ordered, no semantic override」「string match is decisive」→ 修法必须保持纯字符串判定的快速路径,不能引入「每条消息先读 projects.json」这类运行时派生。
- identity.md L79:「Single dept under Flywheel → routing is simple: Flywheel engineering work → Tadashi」——与 Bug 1 同源的过期陈述(同一条「只有一个 dept」的旧假设)。修 Bug 1 而留着它会自相矛盾,必须一并改。同源残留还包括(Codex R1 #2 补齐):L55–58 triage 查询只查 `labels=Flywheel`(把 Product backlog 排除在 CoS triage 外)、L60 确认 gate 只提 Tadashi、L61–65 label-before-route 引言与建单示例无条件写 `Flywheel`、L43 括注「roster of one dept Lead」、L3/L12/L21/L34/L72/L82 的单部门措辞。
- **Prompt 叠加顺序(Codex R2 #1,决定 base 文件必须一并动)**:identity.md 经 `claude --agent` 装载(agent system prompt,在前),base rules bundle 经 `--append-system-prompt-file` 追加(在后;claude-code `buildEffectiveSystemPrompt()` 返回 `[agentSystemPrompt, appendSystemPrompt]`,live `ps` 可证)。而 `packages/teamlead/lead-rules-base/cos-lead-rules.md` 的 "Order of precedence" 节声称 identity 追加在 base **之后**、"later (project) wins" —— **与真实顺序相反**;其 default-replier 节(无 dept-Lead mention/名字 ⇒ CoS 回复)后置于 identity,会与泛化 abstain 正面冲突。⇒ base 需要显式让位 hook + 顺序声称修正(plan E14)。

## R7. 结论带入 plan(与 plan 定稿同步,Codex R2 #3 后修订)

1. Bug 1 修法 = 把「union」规则改成**基数优先(cardinality-first)、互斥、按序短路**的单选决策表:先判 ≥2 dept label(不路由;仅凭 Annie-confirmed / 等价显式记录才自修并报 Annie,否则问 Annie)→ 恰 1 个(路由给该 Lead;swap-never-add,同一证据标准)→ 0 个(补**已确认 owning Lead** 的那一个 dept label,union 仅对非 dept 标签保留)。
2. Bug 2 修法 = 规则 1/2 写实自身 bot id `1516205086890786917`,规则 2 泛化为「任何非自己的 `<@id>` mention → abstain」+ roster 表补 HL 行(name trigger 恰好镜像 HL 自己的 reply trigger)。
3. 同文件残留 E1–E4/E8–E13 一并对齐(含 triage 双 label 查询、确认 gate、建单锚点);base `cos-lead-rules.md` 加让位 hook + 顺序声称修正(E14,R6 顺序事实所迫)。
4. 验证基建 = 新契约 guard 测试 `scripts/__tests__/cos-identity-contract.test.sh`(RED→GREEN)+ 显式接入 `.github/workflows/ci.yml`(`ci-shell-suite-enumeration` 强制)+ 上线后行为观察清单(见 plan §4)。变更集 4 文件,零 TypeScript。
