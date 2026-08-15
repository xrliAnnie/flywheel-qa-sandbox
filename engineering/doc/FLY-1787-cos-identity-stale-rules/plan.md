# FLY-1787 CoS identity.md 两处过期规则 — 实施计划

Issue: FLY-1787 (https://linear.app/geoforge3d/issue/FLY-1787/cos-identitymd-两处过期规则-dept-label-写-union-会让-issue-变成谁都派不了-路由-roster-漏了)
日期: 2026-08-15
基于: research.md

## 0. 一句话

把 `.lead/flywheel-cos-lead/identity.md` 里「单部门时代」写下的两条规则改成与现役双部门(Tadashi + Honey Lemon)一致:dept label 改为**基数优先(cardinality-first)的单选决策表**(消灭「写 union 制造 `issue_multiple_department_labels`」),Core Channel Routing 的 abstain 规则改为**任何非自己的 @-mention 一律沉默** + roster 补 Honey Lemon;同文件内同源的过期陈述(含 triage data scope / 确认 gate / 建单锚点)一并对齐;base `cos-lead-rules.md` 补**显式让位 hook** 并修正其对 prompt 叠加顺序的过期声称(E14,Codex R2 #1)。**纯 prompt 文本改动:identity.md + base cos-lead-rules.md + 新契约测试 + CI workflow 接线,共 4 个文件,零 TypeScript 改动。**

## 1. 设计原则(决定所有取舍)

1. **不改机制,只改对机制的描述。** `department-registry.ts` 行为正确(research R1/R2);错的是 prompt。
2. **保持 fast-path 契约**:该节自我声明 "ordered, no semantic override / string match is decisive"。修法必须仍是纯字符串判定——不引入运行时读 `projects.json`。
3. **消灭 staleness class,不是把 roster 从 1 行改成 2 行等下次再犯**:@-mention 形态(最危险、含 bot id)改为 roster-free 的泛化规则;只有 name trigger(变更频率低)保留手写表 + 维护不变量 + 契约测试守卫。
4. **abstain trigger 恰好镜像对方的 reply trigger**(research R4):比对方宽 ⇒ 两边都沉默(stall);比对方窄 ⇒ CoS 抢答。所以 HL 的 name trigger 就是她自己文件里的 "Honey Lemon"(case-insensitive),**不加** "HL"/"HoneyLemon" 等变体。

## 2. 变更集(prompt 文本:`.lead/flywheel-cos-lead/identity.md` + base `cos-lead-rules.md`,逐处 before/after)

> 行号基于当前 md5 `14e6d830df42a01f9d9a4587c51edb4a` 版本。E5/E6/E7 是两个 bug 的核心修复;E1–E4、E8–E13 是**同一条旧假设(「Flywheel 只有一个 dept lead」)在同文件内的其余残留**,不改会与核心修复自相矛盾;E14 是 base 文件的让位 hook(唯一的第二文件改动,见下)。

### E5(核心,Bug 2)— Core Channel Routing 规则(L38–43)

**Before(要点)**:规则 2 只认 `<@Tadashi-bot-id>` OR "Tadashi";规则 3 兜底 CoS 回复。

**After**:

```markdown
### Core Channel Routing (FLY-152, strictly enforced — ordered, no semantic override)

`#flywheel-core` is the entry point where you (Aunt Cass) + the dept Leads (Tadashi, Honey Lemon) all see messages. Evaluate each message in order:
1. **Self-reference**: contains `<@1516205086890786917>` (your own bot id) OR text "Aunt Cass"/"Cass" → **you reply**. Stop.
2. **Someone-else reference**: contains an `<@…>` mention of ANY user other than you (any id ≠ your own bot id `1516205086890786917` — mentions need NO roster lookup), OR a roster **name trigger** from the table below → **DO NOT REPLY** (the addressed party handles it; a message that @-mentions a specific user is not a "generic" message, so the default-handler premise does not apply). Stop. (Holds even if it looks generic — string match is decisive, no semantic second-guessing. This is a deliberate project-layer EXTENSION of the base FLY-152 rule, which only requires abstaining on dept-Lead mentions — see cos-lead-rules.md "Shared Channel Reply Discipline".)
3. **Default handler**: no self-reference and no rule-2 hit → **you reply** as the default handler for generic / routing / global messages.

(Base contract: `cos-lead-rules.md` "Shared Channel Reply Discipline" — this section instantiates it for the Flywheel roster below. FLY-1787: rule 2 was previously Tadashi-only, so a message @-mentioning only Honey Lemon fell through to rule 3 and the letter of the rule told you to answer her issue for her.)
```

**行为变化点(刻意的,review 请确认)**:@-mention 任何非自己的用户(包括人类,如 Annie 本人被 @)→ CoS 沉默。旧规则会回复。理由:带具体 @-mention 的消息是「点名给某人」,不是 default-handler 该接的「泛路由消息」;而枚举 bot id 的替代方案会在下一个 lead 上线时重演本 bug(infra-bot leads 今天就已存在)。

### E6(核心,Bug 2)— Roster 表(L45–49)

**After**:

```markdown
## Roster (your abstain trigger — name triggers only; @-mentions need no roster, see rule 2)

Your OWN bot id (the self-comparison value for rules 1–2): `1516205086890786917` (flywheel-cos-lead).

| Lead | Bot @-mention | Name trigger |
|------|---------------|--------------|
| Tadashi (flywheel-eng-lead) | `1516207680836866219` | "Tadashi" |
| Honey Lemon (flywheel-product-lead) | `1523215538820612206` | "Honey Lemon" (case-insensitive) |

**Maintenance invariant (FLY-1787)**: this table mirrors `~/.flywheel/projects.json` → Flywheel project leads. Each name trigger MUST exactly mirror that Lead's OWN reply trigger in their identity file (Tadashi: "Tadashi"; Honey Lemon: "Honey Lemon" per `.lead/flywheel-product-lead/identity.md`) — broader creates both-silent stalls, narrower makes you answer over them. When a Lead is added/removed: update this table AND the dept-label list in "Label-before-route" below. The `<@id>` mention form needs NO update (rule 2 abstains on any non-self mention).
```

### E7(核心,Bug 1)— Label-before-route 的 union 规则(L66–71)

**Before(要点)**:「已存在但缺 `Flywheel` 的 issue → 读现有 labels 写 union 补 `Flywheel`」。

**核心语义(Cass 原话,Tadashi 指令要求逐字写进修订;新文本的引言句必须承载它)**:

> dept label 是**单选**,不是集合。`labels = [唯一正确的 dept label] + [所有非 dept 标签]`。
> 看到别的部门的标签 ⇒ **把活交给那个 Lead**,不要给 issue 补标签。

**After**(替换 L66–71 的两个 sub-bullet;Codex R1 #1:分支必须**基数优先、互斥、按序短路**,否则双标签 issue 会先命中 "already has Flywheel" 错误分支):

```markdown
  - **Department labels are SINGLE-SELECT, not a set (FLY-1787).** The spawn-gating dept labels for Flywheel are currently `Flywheel` (Tadashi) and `Flywheel-Product` (Honey Lemon) — source of truth: `~/.flywheel/projects.json`, labels of leads with `canSpawnRunners` ≠ false (`Flywheel-Triage` and the infra-bot labels do NOT gate spawn). An issue carrying TWO dept labels is rejected for EVERYONE with `issue_multiple_department_labels`, and per the Bridge message "Annie must reduce to one department label" (`packages/teamlead/src/department-registry.ts`). So never produce a second dept label on an issue.
  - **Routing an issue that already exists** → `mcp__linear-api__get_issue({ id: "FLY-XX" })`, read `.labels`, count how many spawn-gating dept labels it carries, and take the FIRST matching case (ordered, mutually exclusive — evaluate the count first):
    1. **Two or more dept labels** (pre-existing damage) → do NOT route; the issue is already in the `issue_multiple_department_labels` dead state. Reduce to the single correct dept label yourself ONLY when ownership is already explicit (an Annie-confirmed assignment or equivalent recorded decision — never your own inference from the issue topic), keeping all non-dept labels, and report the fix to Annie; otherwise ask Annie which department owns it.
    2. **Exactly ONE dept label** → the issue belongs to THAT Lead. `Flywheel` → route to Tadashi; `Flywheel-Product` → route to Honey Lemon (@-mention her in `#flywheel-core` — 🔴 NEVER `#leads-roundtable`). Don't touch labels. Do NOT add a second dept label. Only if ownership is explicitly wrong (same evidence bar as case 1) do you **swap** (replace the wrong dept label with the right one, keeping all non-dept labels), never add, and state the swap + reason in your report to Annie.
    3. **NO dept label** → add exactly one: the dept label of the CONFIRMED owning Lead (`Flywheel` for Engineering work, `Flywheel-Product` for Product work; unclear ownership → ask Annie first). ⚠️ `save_issue`'s `labels` **replaces** the whole set (it is NOT append-only), so preserve the non-dept labels — Engineering example:
       ```
       mcp__linear-api__save_issue({ id: "FLY-XX", labels: [ ...existing NON-dept labels..., "Flywheel" ] })
       ```
       (The only case where the old "write the union" guidance survives — and only over non-dept labels.)
  - Never route an unlabeled issue and expect the receiving Lead to work around the gate — if it's not labeled, label it (case 3), then route.
```

### E1–E4、E8–E13(同源残留对齐;E11–E13 为 Codex R1 #2 补入 —— 不改会与核心修复自相矛盾)

| # | 位置 | Before(要点) | After(要点) |
|---|------|------|------|
| E1 | L3 frontmatter `description` | "route work to Tadashi" | "route work to the dept Leads (Tadashi / Honey Lemon)" |
| E2 | L12 开篇段 | "you route work to **Tadashi** (the Flywheel Engineering Lead)" | "you route work to the dept Leads — **Tadashi** (Engineering) and **Honey Lemon** (Product)" |
| E3 | L21 Role boundary | "…are **Tadashi's** responsibility" | "…are the **owning dept Lead's** responsibility (Tadashi / Honey Lemon)" |
| E4 | L34 HARD RULE 括注 | "`#flywheel-product` … is Tadashi's own channel and is not in your Discord allowlist" | "`#flywheel-product` … is **Honey Lemon's** own channel and is not in your Discord allowlist"(事实修正,禁令本身不变;HL identity L79–81 证实该频道归属) |
| E8 | L72 Assignment bullet | 只有 Tadashi 的 @-mention 模板 | 保留 Tadashi 模板,标注 "(engineering)";补一句:`Flywheel-Product` issue 同款模式 @-mention Honey Lemon `<@1523215538820612206>`(仍在 `#flywheel-core`,决策表见 E7 case 2) |
| E9 | L79 "Single dept" bullet | "Single dept under Flywheel → … → Tadashi" | "Two depts under Flywheel (FLY-1787): `Flywheel` → Tadashi; `Flywheel-Product` → Honey Lemon(`#flywheel-core` @-mention;🔴 NEVER roundtable)。cross-cutting / non-Flywheel → ask Annie" |
| E10 | L82 Event Handling | "(Tadashi's job)" | "(the owning dept Lead's job)" |
| E11 | L55–58 Triage data scope | curl 查询 `labels=Flywheel`(把 `Flywheel-Product` backlog 排除在 CoS triage 外) | `labels=Flywheel,Flywheel-Product`(该 endpoint 多 label 为 OR 语义,Codex R1 已核);注明 `project=Flywheel` 仍是 GeoForge3D 隔离的主闸。已知 pre-existing gap:无 dept label 的 issue 两版查询都不覆盖,超出本单范围,不在此修 |
| E12 | L60 Hard gate | "wait for her explicit confirmation before **assigning** anything **to Tadashi**" | "…before assigning anything **to any dept Lead**"(gate 对 Tadashi / Honey Lemon 一视同仁) |
| E13 | L61 Label-before-route 引言 + L62–65 建单示例 | "every issue you hand to Tadashi MUST carry the **`Flywheel`** scope label";建单示例无条件 `labels: ["Flywheel"]` | "every issue you hand to a dept Lead MUST carry **that Lead's** dept label"(FLY-127 gate 框架保留,`Flywheel` 的 label id 保留标注为 Engineering 的);建单示例标注 "(Engineering anchor — for Product-owned work use `Flywheel-Product`;归属不清先问 Annie)" |

**刻意不改**:L34 HARD RULE 的主体(handoff NEVER roundtable)逐字保留;L14 launch wiring、L25–32 Channel Isolation、L53–54 triage 触发词、L78 report-path-accurately、L84 起通信风格——全部不动。

### E14(Codex R2 #1)— base `packages/teamlead/lead-rules-base/cos-lead-rules.md` 让位 hook + 顺序声称修正

**为什么必须动 base**:真实 prompt 叠加顺序是 **identity 在前、base 在后** —— identity.md 经 `claude --agent` 装载(agent system prompt),base 经 `--append-system-prompt-file` bundle 追加(claude-code `buildEffectiveSystemPrompt()` 返回 `[agentSystemPrompt, appendSystemPrompt]`;live `ps` 亦可见)。而 base 现文有两处与此相抵:

- "Order of precedence" 节声称 "Your cos-lead's `identity.md` is appended **after** this file … the later (project) wins" —— **与真实顺序相反**;
- "When the cos-lead DOES reply (default replier)" 节只要求「无 dept-Lead mention 且无 dept-Lead 名字」就回复 —— 对 `@Annie` / roster 外 mention,这条**后置**文本会与 E5 的泛化 abstain 正面冲突,E5 的 "project-layer EXTENSION" 声明单方面说了不算。

**改法(最小、对无扩展项目行为保持不变)**:

1. **"Order of precedence" 节改写**:写明真实顺序(identity = agent prompt 在前,本文件经 bundle 追加在后),并把让位规则从「later wins」改为**显式契约**:"This file is the abstract contract; the project identity.md is the concrete instantiation and **wins wherever the two touch the same topic** — including when the identity declares a STRICTER abstain set than this file's default-replier rule. Prompt position does not decide precedence; this clause does."
2. **default-replier 节加第三条件**:"…AND no stricter project-identity abstain rule matches. (A project identity MAY extend the abstain set — e.g. Flywheel's 'any non-self `<@…>` mention → do not reply' — and that extension wins over this default-replier rule even though this file appears later in the prompt stack.)"

**Blast radius**:`cos-lead-rules.md` 被所有 CoS 角色装载(Simba / Aunt Cass / Triton)。两处改动均为**让位声明**:不含项目扩展的 identity(Simba 等)语义逐字不变;含扩展的(本单的 Flywheel CoS)获得无歧义的胜出依据。不改 launcher / bundle 机制。

## 3. 守卫测试(TDD 载体)

新增 `scripts/__tests__/cos-identity-contract.test.sh`(house 先例:FLY-880 `test-pm-executor-contract.sh`),对 `.lead/flywheel-cos-lead/identity.md` 做锚点断言,RED→GREEN 驱动 E5/E6/E7:

1. 含 Honey Lemon roster 行:`1523215538820612206` 且 `Honey Lemon` 同表出现;
2. Tadashi roster 行仍在(`1516207680836866219`);
3. 旧 union 危险片段 **不存在**:字面 `[ ...existing..., "Flywheel" ]`(注意区分新文本的 `NON-dept labels` 变体);
4. 单选锚点存在:`SINGLE-SELECT` 与 `issue_multiple_department_labels`;**且**(Codex R2 #2)三个 cardinality case 锚点(`Two or more dept labels` / `Exactly ONE dept label` / `NO dept label`)各自存在,并用 `grep -n` 取行号做数值比较断言顺序 `two-or-more < exactly-one < no-label`(防止未来把分支挪回非基数优先的顺序仍然假绿);
5. 泛化 abstain 锚点存在:`ANY user other than you`(或最终定稿等价句);
6. roundtable 禁令未被误删:`NEVER` + `#leads-roundtable` 仍成对出现在 HARD RULE 与 E7 case 2;
7. swap 语义锚点:`swap` + `never add`;
8. 自身 bot id `1516205086890786917` **分别锚定在三处**(Codex R2 #2:不做全文件存在性检查——那样 id 只留 roster、规则退回 `<@your-bot-id>` 占位符也会假绿):Self-reference 规则行、Someone-else reference 规则行、roster 自身 id 行,各自 scoped grep;
9. triage 双 label 锚点:`Flywheel,Flywheel-Product`(E11 的查询串);
10. base 让位 hook 锚点(E14):`packages/teamlead/lead-rules-base/cos-lead-rules.md` 含 stricter-abstain 让位句(定稿锚点短语),且旧顺序声称已不存在——负断言必须匹配 **Markdown 原串**(含反引号/强调:`` `identity.md` is appended **after** this file ``)做 `grep -F` 固定字符串检查,不得用去格式化的意译短语(否则旧句仍在也假绿,Codex R3 LOW-2);GREEN 前先临时保留旧句跑一次,验证该断言会**单独**失败。

纯 grep/固定字符串断言,不做语义解析;它守的是「这份契约文本别被后续编辑悄悄退化」,与 FLY-880 的 40k 截断红线同类。

**CI 接线(Codex R1 #3,必做)**:`scripts/__tests__/ci-shell-suite-enumeration.test.sh` 强制枚举根目录所有 `*.test.sh` 都要出现在 `.github/workflows/ci.yml` 或 manual-only inventory;本 guard 是 hermetic 的(只读 repo 文件、零外部依赖),**必须**在 `.github/workflows/ci.yml` 加显式执行项,不得进 manual-only。变更集因此为 **4 个文件**:identity.md + cos-lead-rules.md(E14)+ 新测试 + ci.yml。

## 4. 验证

**机制层护栏已存在(回应 Cass comment 的验收建议 1/2,implement 节点核跑即可、无需新写)**:
- 反例(建议 1):`start-e2e.test.ts` L590–609 —— issue 带两个 dept label 时,**默认开启的** dept-scope gate 让 `/api/runs/start` 返回 403 + `DEPT_SCOPE_REJECT` + reason `issue_multiple_department_labels`,dispatcher 不被调用;
- 正例(建议 2,含 ok 半边):`department-registry.test.ts` **L233–263**(precedence 5/6/**7**)—— multi-dept ⇒ `issue_multiple_department_labels`;单 label 错 lead ⇒ `label_mismatch`;单 dept label + owning Lead ⇒ **ok**。端到端 happy path 另见 `start-e2e.test.ts` L634–647;
- ⇒「挡住未来再有人写出 union」由两层合力:机制层上述既有测试(**默认开启的 gate 下** union 的后果被拒绝——注意 `BRIDGE_DEPT_SCOPE_REJECT=off` kill-switch 会跳过该检查,`start-e2e.test.ts` L649–664,此时机制层不兜底,**所以 prompt 层禁止 union 独立必要**)+ prompt 层本单新 guard(union 指令文本再次出现会被断言 3 抓住)。建议 3(改后文字必须能回答「别的部门已有标签怎么办」)由 E7 case 2 + Cass 原话引言直接满足。

**Pre-merge(implement 节点执行)**:
- 契约测试 RED(改前)→ GREEN(改后);
- CI 枚举门:`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh` 通过(新测试已接入 ci.yml);
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell 测试(改动是 .md + .sh + ci.yml,预期零 TS 影响,跑门是 role 纪律;E14 动了 packages/teamlead 内的 .md,需确认无既有测试对 cos-lead-rules.md 逐字断言——有则同步);
- 静态自查:diff 只落在 identity.md + cos-lead-rules.md + 新测试 + ci.yml 四个文件。

**Post-restart(ship/QA 侧观察清单,prompt 为 boot-cached,merge 后需搭 Lead 重启车生效,research R5)**:
1. `md5 ~/.claude/agents/flywheel-cos-lead.md` == 新版本(重启后 claude-lead.sh 自动重拷的铁证);
2. #flywheel-core 发一条只 @ Honey Lemon 的消息 → CoS 沉默(Bug 2 正例);
3. #flywheel-core 发一条不含任何 @/名字的泛消息 → CoS 回复(default handler 未破坏,负对照);
4. 让 CoS 对一张仅 `Flywheel-Product` 的 issue 做路由预检 → 她路由给 HL、不写 label(Bug 1 正例;FLY-1782 形态复现);
5. (Codex R1 #4 扩充)只 @ Annie 的消息 → CoS 沉默(泛化 abstain 的刻意行为);同条消息 @ Cass + @ Honey Lemon → CoS 回复(规则 1 优先);@ 一个 roster 外无关用户 → CoS 沉默(刻意静默,见 §6 残余风险①)。
- 是否为此起 529 房做隔离 E2E:**不建议**(prompt-only 改动,529 成本远超风险;上面观察清单 + 契约测试足够)——由 Tadashi 定夺。

## 5. 被否掉的方案

1. **运行时从 `projects.json` 派生 roster**(issue 里的「更稳做法」):否。identity.md 是 boot-cached 静态 prompt;该节契约是纯字符串快速路径;session 内每消息读文件加延迟 + 新失败模式(文件缺失/搬家 ⇒ 未定义行为);而 session 启动时读一次只是把 staleness 从「改文件时」挪到「boot 时」,与现状同需重启,收益为零。取而代之:mention 半边泛化(永久 roster-free),name 半边低频 + 契约测试守卫。
2. **只枚举 HL 的 bot id 加进规则 2**:否。下一个 lead 上线即重演本 bug(infra-bot leads 今天已在 roster 外存在);规则应消灭 class 而非加一个实例。
3. **改 Bridge 代码做机制层 reply-gating**:超范围。Claude Lead 的 shared-channel 纪律是 prompt 层设计(FLY-152;Codex 侧才走 mention-gate 机制),本 issue 是文档失真不是机制缺口。
4. **CoS 无条件自行清理双 dept label**:否。label 归属 = 所有权变更;只有存在 **Annie-confirmed assignment 或等价的显式记录决定**时才自修 + 报 Annie(与 E7 case 1/2 同一证据标准,绝不由 CoS 从 issue 主题自行推断),否则必须问 Annie。
5. **abstain trigger 加 "HL"/"HoneyLemon" 变体**:否。比 HL 自己的 reply trigger 宽 ⇒ CoS 沉默而 HL 也不接 ⇒ 无人应答 stall(原则 4)。

## 6. 风险与边界(诚实边界)

- **本设计做什么**:让 CoS 的字面规则与双部门现实一致;消灭 @-mention staleness class;给 name-trigger 留下带守卫的最小手写面。
- **不做什么**:不改任何运行时机制;不给 Codex/其他项目的 CoS 同步(GeoForge3D 的 Simba 是独立文件,不在本 issue);不保证 name-trigger 永不过期(第三个 lead 上线仍需改表——但契约测试 + 维护不变量把它从「靠记忆」变成「有 checklist」);不做 529 隔离 E2E(取舍见 §4);不修 triage 查询对「无 dept label issue」的 pre-existing 盲区(E11 备注)。
- **与 base 规则的关系(Codex R1 #4 → R2 #1 收紧)**:泛化 abstain 是对 `cos-lead-rules.md` "Shared Channel Reply Discipline"(FLY-152,只要求对 dept-Lead mention 沉默)的**有意 project-layer 扩展**。因真实 prompt 顺序是 identity 在前、base 在后,单靠 identity 侧声明不足以保证胜出 —— E14 在 base 侧加显式让位 hook 并修正其过期的顺序声称;对无扩展的其他 CoS(Simba / Triton)语义逐字不变。
- **残余风险**:① 泛化 abstain 会让「@ 一个不看 core 频道的 bot」的消息无人应答——该消息本就投错对象,沉默促使发送者改口,可接受;② "Cass" 出现在别人名字里(无此人)、"Tadashi"/"Honey Lemon" 被引用在 issue 标题里仍会触发 abstain——string-match-decisive 的既有代价,不变;③ E4 若 `#flywheel-product` 归属另有隐情(仅 HL 文件单方声明),错改只影响一句注释性事实,禁令语义不变。

## 7. 交付顺序(implement 节点)

1. RED:先写 `scripts/__tests__/cos-identity-contract.test.sh`,对当前文件跑,断言 1/4/5/7/8/9/10 失败、3 失败(旧片段存在);同时把它接进 `.github/workflows/ci.yml`(否则 `ci-shell-suite-enumeration` 门直接红,Codex R1 #3)。
2. GREEN:按 §2 逐处编辑 identity.md(E5/E6/E7 核心 + E1–E4/E8–E13 对齐)+ cos-lead-rules.md(E14 让位 hook),测试转绿。
3. 全仓门(§4 pre-merge,含 CI 枚举门)。
4. PR(base=main,分支现成 `flywheel-FLY-1787`),PR body 链 FLY-1787,附 post-restart 观察清单;里程碑行照常最后 commit。
5. Ship 搭重启车的时点判断交 Tadashi(issue 的时间约束节)。
