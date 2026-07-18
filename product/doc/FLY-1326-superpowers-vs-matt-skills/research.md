# FLY-1326 Superpowers vs mattpocock/skills — 调研 / 核心 intel

Issue: FLY-1326 (https://linear.app/geoforge3d/issue/FLY-1326/research-mattpocockskills-能否取代-superpowers-系统减重盘点-依赖-blast-radius)
日期: 2026-07-17
基于: exploration.md

> 本文件是交付主体。数字均为**实测**(读真文件 / 跑真 tokenizer),非估算。
> tokenizer = `tiktoken cl100k_base`。**byte 数 = ground truth**;token 数是 **cl100k proxy** ——
> 不是 Claude 实际计费 token(Claude tokenizer 不公开)。查不到的标 **UNKNOWN**。
>
> **v5(2026-07-17,Codex code review R1→R4 后)** —— v1–v4 共有 **6 处**实质错误,已改正并逐处标注。
> v1 三处:
> ① 「Matt 每 session 注入 0」**overclaim**(漏了 skill catalog metadata);
> ② 「Flywheel 自己的仓走不到 shipped generic」**是假的**(我把配置里名为 `general` 的键+注释当成了行为);
> ③ 矩阵把 Matt 的 **user-invoked** skill 当成了 headless runner 的等价物。
> v2/v3 再两处(R2/R3 抓出):④ 把「15×1,778」叫**下界**(实为**情景值**,真下界是 0);
> ⑤ **「唯一耦合文件 / `.flywheel/agents` 零耦合」是假的** —— 我搜的是插件名,真实耦合是**裸 skill 名**。
> v4 一处(R4 抓出):⑥ 我为修 ⑤ 做的裸名 sweep 用了 `\bbrainstorming\b`,`-` 是正则词边界 → **误把
>    `product-brainstorming` 也算成命中**,错列 `pm-executor.md`。真实活跃直接耦合 = **2 个文件**(generic + designer)。
>    **同一个查询-语义坑我栽了两次(R3 漏 / R4 误报),教训见 §blast radius。**

---

## TL;DR(实测硬结论 —— v5,经 Codex R1→R4 四轮改正)

1. **「重」的真身 = SessionStart 常驻注入,不是 skill 库。** apples-to-apples 每 session:
   **Superpowers 1,778 tok(1,370 hook 注入 + 408 catalog metadata)vs Matt 420 tok(0 hook + 420
   metadata)**。关键细节:**Matt 的 catalog(420)其实比 Superpowers 的(408)还略贵** ——
   ⇒ **省下来的 100% 全来自那个 hook,catalog 一分不省。** 这比 v1 的「1,370 → 0」更精确,也更有力。
2. **blast radius:shipped 四步流的改动点是 1 个文件,但耦合点不止 1 个,影响面比 v1/v2/v3 都大。**
   (a) `agents/generic-executor.md` 有 **3 条** fire 路径,含 **Flywheel 自己所有 label 未命中的 issue**
   (`general` 兜底的 `match.labels: []` **永不匹配** + 无 `default_agent`);
   (b) **designer 部门角色**用**裸名**调用 `brainstorming`(= 本机唯一解析到 Superpowers);
   (c) **3 个 workflow 模板 / 4 个 generic node 引用**(**flag-gated,当前 default-off**,但开旗即污染 ablation)。
   ⇒ **活跃直接耦合 = 2 个文件**(generic-executor + designer)+ 1 组 flag-gated 间接消费者。
   ⚠️ 这条我**连错三次才收敛**(v1 说 Flywheel 走不到 / v2-v3 说唯一耦合文件 / v4 误报 pm)——
   **「改动点小」和「影响面小」是两件事**,而且尺子本身要反复校准。
3. **两边哲学真对立(原文佐证),但换过去有个 v1 漏掉的硬约束**:Matt 22 个 shipped skill 里
   **13 个是 user-invoked(`disable-model-invocation: true`)= 我们的 headless runner 根本够不着**。
   只有 **9 个 model-invoked** 对 runner 可达。其中 **`writing-plans` 没有 model 可达的对应物**。

---

## 盘点 ① — Superpowers 现状

**安装形态**:本机 user 级 Claude Code 插件,`~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0`,
version **5.1.0**,Jesse Vincent(obra/superpowers),MIT。

### 1.1 每 session 注入(实测)

- `hooks/hooks.json`:**SessionStart** hook,matcher = `startup|clear|compact`。
- `hooks/session-start`:把 `skills/using-superpowers/SKILL.md`(117 行 / 5,421 bytes)整篇注入,
  包在 `<EXTREMELY_IMPORTANT>` 里,走 `hookSpecificOutput.additionalContext`。
- **实测(跑真 hook 抽真 additionalContext)**:**5,648 bytes = 1,370 tok(cl100k proxy)**。
  证据:`/tmp/sp-hook-out.json`、`/tmp/sp-injected.txt`。
- **另加 catalog metadata**:14 个 skill 的 name+description **全部 model-invoked**,
  合计 **2,300 bytes = 408 tok**,常驻在 skill 列表里。
- ⇒ **Superpowers 每 session 常驻 = 1,370 + 408 = 1,778 tok**。

注入文本的性质(逐字):
- 「**IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.**」
- **1% 规则**:「even a 1% chance a skill might apply … you ABSOLUTELY MUST invoke the skill.」
- 「Invoke … **BEFORE any response or action** … including clarifying questions.」
- 12 行 "Red Flags" 合理化对照表 + dot-graph 决策流。
- 优先级:user instructions(CLAUDE.md)> superpowers skills > default system prompt。

→ **注入的本质是「强制」,不是能力。** 能力(14 个 skill 正文,26,443 tok)按需加载。

### 1.2 14 个 skill(按需正文加载)

合计 **26,443 tok**;逐个见附表(brainstorming 2280 / TDD 2420 / systematic-debugging 2330 /
writing-plans 1405 / writing-skills 5099 / using-git-worktrees 1881 / finishing-a-development-branch
1780 / receiving-code-review 1513 / requesting-code-review 650 / subagent-driven-development 2786 /
dispatching-parallel-agents 1462 / verification-before-completion 987 / executing-plans 537 /
using-superpowers 1313)。**14 个全部 model-invoked**(0 个 user-invoked)。

---

## 盘点 ② — mattpocock/skills

**克隆实测**:commit `9603c1cc8118d08bc1b3bf34cf714f62178dea3b`(`2026-07-16 10:03:12 +0100`),无 tag。
`.claude-plugin/plugin.json` version **1.2.0**。MIT。

### 2.1 每 session 成本(**修正 —— 不是 0**)

**无 hook 注入**(三重独证):`find` 无 `hooks.json` / 无 `hooks/` 目录;grep
`SessionStart|hookSpecificOutput|additionalContext` 全空;`plugin.json` 无 `hooks` 键。
(仓内 "hook" 命中全是 skill **内容** —— setup-pre-commit / git-guardrails 往**用户仓**装 hook。)

**但 catalog metadata 非 0**(v1 漏掉,R1 抓出):plugin 装上后,**model-invoked** skill 的
name+description 常驻在 skill 列表里(否则模型不知道它们存在)。实测 shipped 22 个里
**9 个 model-invoked → 1,982 bytes = 420 tok**;22 个全算 = 3,788 bytes / 804 tok。

⇒ **Matt 每 session 常驻 = 0(hook)+ 420(metadata)= 420 tok。**

> **同一把尺的对照**:Superpowers catalog 408 tok(14 个)vs Matt catalog 420 tok(9 个 model-invoked)
> —— **Matt 的 catalog 略贵**(它的 description 带 rich trigger phrasing)。所以
> **1,778 → 420 的节省(约 1,358 tok/session),100% 来自砍掉 hook,catalog 侧反而微亏。**

### 2.2 catalog + **invocation 可达性**(决策关键)

41 个 SKILL.md;plugin 只 ship **promoted 两桶 22 个**(engineering 17 + productivity 5)。
其余(in-progress 8 / misc 4 / personal 2 / deprecated 4)不进 plugin。

**对我们(headless runner)真正重要的是 invocation** —— 逐个实测 frontmatter:

| 可达性 | 数量 | skill |
|---|---|---|
| **model-invoked(runner 够得着)** | **9** | `diagnosing-bugs`, `tdd`, `prototype`, `research`, `domain-modeling`, `codebase-design`, `code-review`, `resolving-merge-conflicts`, `grilling` |
| **user-invoked(`disable-model-invocation: true` —— runner 够不着)** | **13** | `ask-matt`, `grill-with-docs`, `implement`, `improve-codebase-architecture`, `setup-matt-pocock-skills`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `grill-me`, `handoff`, `teach`, `writing-great-skills` |

`.agents/invocation.md` 原文:user-invoked =「reachable **only by the human typing its name**」。
⇒ **我们的 headless runner 无人可打字 —— 这 13 个等于不存在**(除非 vendor 时改 frontmatter,见 plan.md)。

### 2.3 安装形态(两种 + 一个 symlink 脚本)

1. **skills.sh**:`npx skills@latest add mattpocock/skills` → **可编辑 copy**;`/setup-matt-pocock-skills` per repo。
2. **Claude Code plugin**:managed bundle,「**you subscribe rather than fork**」(README 原话)= 只读、跟随上游。
3. `scripts/link-skills.sh` → symlink 进 `~/.claude/skills` / `~/.agents/skills`,`git pull` 即更新。

> **对我们的意义**:形态 1/3 可改 frontmatter(把需要的 user-invoked 翻成 model-invoked);
> 形态 2 不可改 ⇒ 那 13 个永远够不着。**这个选择必须在臂 (b) 里钉死**(plan.md §2)。

### 2.4 哲学(逐字 README「Skills For Real Engineers」)

> 「My agent skills that I use every day to do real engineering - **not vibe coding**.」
> 「Approaches like **GSD, BMAD, and Spec-Kit** try to help by **owning the process**. But while doing
> so, **they take away your control and make bugs in the process hard to resolve**.」
> 「These skills are designed to be **small, easy to adapt, and composable**. … **Make them your own**.」

→ Matt 点名「owning the process」学派;Superpowers 按其注入原文正属该学派。**真对立**,非转述。

---

## Blast radius —— 我们对 Superpowers 的真实依赖(**v5:v1/v2/v3/v4 我连错四次才收敛**)

> **方法(v4 加强)**:所有「0 引用」结论都先跑**阳性对照**(同目录 grep `brainstorm`/`Runner` 有命中,
> 证明尺子没坏)。曾撞到一次假 0(zsh 吞未加引号 glob),加引号重跑。
> 🔴 **但阳性对照只证明尺子没坏,不证明查询语义完整** —— 本单因此漏掉了 designer 的裸名耦合(R3),
> 又在补扫时误报了 pm(R4,`\b` 匹配了 `product-brainstorming`)。**v5 sweep 口径 = 插件名 + `superpowers:`
> namespace + 全部 14 个裸 skill 名,且用连字符-感知边界 `[^A-Za-z0-9_-]` 而非 `\b`;每个命中回读上下文。**
> `.claude/skills/{flywheel-git-workflow,flywheel-escalation,linear-issue-context}` 的 "Superpowers"
> = **本 issue 自身注入的 context**(self-reference),不计。

### 🔴 v1 的错误(必须记录,因为它一度要被写进给 founder 的材料)

**v1 说**:「只在无 label 命中**且**无 `default_agent` 时 fire;**Flywheel 自己的仓根本走不到**;
只影响 sub/joycon。」→ **假的。**

**根因是我自己踩了「拿标签/注释冒充事实」**:我看到 config 里一个 agent 名叫 `general`、注释写着
「Top-level catch-all … or no executor label matches」,就**把名字+注释当成了行为**,没读
`labelsMatch()` 的实现。

**实测真相**(`AgentDispatcher.ts:311`):
```js
private labelsMatch(cfg, issueLabels) {
  for (const configured of cfg.match.labels) {      // labels: [] → 循环体一次都不执行
    if (issueLabels.includes(configured.toLowerCase())) return true;
  }
  return false;                                      // ⇒ 空数组 = 永不匹配,不是 wildcard
}
```
而 `.flywheel/config.yaml` 里 `general` 的 `match.labels: []`,且**全仓无 `default_agent`**。

### shipped-generic 的 **3 条** fire 路径

| # | 路径 | 触发条件 | 影响谁 |
|---|---|---|---|
| 1 | `dispatch()` step 3b 绝对兜底 | 无 label 命中 + 无 `default_agent` | 零配置项目(sub/joycon)**+ Flywheel 自己所有 label 未命中的 issue** |
| 2 | `dispatchByName("generic")`(`AgentDispatcher.ts:276`)| Lead 在 `/api/runs/start` 显式传 `agentName: "generic"` | 任何被显式点名 generic 的 runner(**FLY-217 当年的沙箱 QA 正是这条**)及其 retry |
| 3 | (2 的衍生)retry / resume 复用同一 agent 解析 | 同上 | 同上 |

⇒ **`general` 这个「catch-all」除非被显式点名,否则永远进不去** —— Flywheel 的 unmatched issue
**全部流向 shipped generic**(= Superpowers 耦合文件)。

> **副产品(与本决策无关,但值得单独开单)**:`general.match.labels: []` 让这个 catch-all 实际
> 不 catch,与其注释的设计意图矛盾 —— 疑似 Flywheel 配置的**真 bug**,建议 Tadashi 看一眼。

### 修正后的影响面

- ✅ **仍成立(限定语要精确)**:**shipped generic 四步流本身**的改动点只有 1 个文件
  (`agents/generic-executor.md` 99–204),可 revert。⚠️ 这**不等于**整个 B/C 臂的 change-set ——
  B/C 还必须同步改 `designer-executor.md`(见 plan.md §3),否则臂内不一致。**「一个文件」说的是那条
  shipped 四步流,不是「拿掉 Superpowers 只动一处」。**
- ❌ **不成立**(v1 错):「Flywheel 走不到」「只影响 sub/joycon」。
  真实影响面 = 零配置项目 **+ Flywheel 自己 label 未命中的 issue** + 显式 `agentName:"generic"` 的 runner。
- ⇒ **「改动点小」和「影响面小」是两件事。** 前者真,后者假。

### 🔴 v3 的错误(v4 改)—— 「唯一耦合文件」也是假的

**v2/v3 说**:`.flywheel/agents/` 对 Superpowers 引用 **0**,唯一耦合文件 = `generic-executor.md`。→ **假的。**

**根因:我的查询口径本身是错的。** 我 grep 的是插件名 **"superpowers"**,但真实耦合是**裸 skill 名**:

| 位置 | 实证 | 性质 |
|---|---|---|
| `.flywheel/agents/engineering/designer-executor.md:68` | 「surface you're redesigning. **Use `brainstorming`**.」 | 真部门角色**直接点名调用** |
| `.flywheel/agents/engineering/designer-executor.md:141` | 表格行:「Clarifying what to design + product context → `brainstorming`」 | 同上 |

**`brainstorming` 在本机唯一解析到 Superpowers**(实证:`~/.claude/skills/brainstorming` **不存在**;
唯一同名 skill = `~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0/skills/brainstorming`;
我们自己的叫 `product-brainstorming`,**不同名**)。
⇒ 卸掉 Superpowers,**designer 这个真部门角色的行为会变**(有 missing-skill fallback 不会硬挂,
但行为改变是真的)。**所以 blast radius 至少不是 1 个文件。**

> 🔴 **v4→v5 更正(Codex R4 抓出,我又踩一次同款坑)**:v4 曾把 `pm-executor.md` 也列为裸名调用 ——
> **误报。** pm-executor.md 里只有 `product-brainstorming`(我们自己的,不同名),没有裸 `brainstorming`。
> **我怎么又错的**:v4 的「裸名 sweep」我用 `grep "\bbrainstorming\b"` —— 而 `-` 在正则里**本身就是词边界**,
> 所以 `\bbrainstorming\b` **会命中 `product-brainstorming` 里的 `brainstorming` 段**。这是**同一个查询语义
> bug 在我为修它而做的 sweep 里第二次发作**。正确口径 = `(^|[^A-Za-z0-9_-])brainstorming([^A-Za-z0-9_-]|$)`
> (显式排除连字符前缀的复合词)。用正确口径重扫,**直接裸名耦合 = 仅 2 个文件**(generic-executor + designer)。

### ⚠️ 方法论教训(比这个 bug 本身更重要 —— 我栽了两次)

**阳性对照只证明「尺子没坏」,不证明「量对了东西」。**
1. **第一次**(R3):我跑 `grep brainstorm` 做阳性对照 → 它**确实命中了 designer-executor.md**,我却把这个命中读成
   「grep 工作正常」,**没问「一个 Superpowers skill 名怎么会出现在部门角色文件里」** —— 反证就在我自己的输出里。
2. **第二次**(R4):我为补上裸名口径,用了 `\bbrainstorming\b` —— 但 `-` 是正则词边界,它把
   `product-brainstorming`(我们自己的 skill)也算成了 Superpowers 命中。**在修查询-语义 bug 的 sweep 里,
   又犯了一个查询-语义 bug。**
⇒ 教训升级:**每个「命中」都要回读上下文确认是不是你要找的东西**(designer 是真的、pm 是 `product-` 前缀);
**报耦合清单时把用的正则也贴出来**,让复核者能一眼看出口径漏洞。
⇒ blast-radius sweep 口径 = 插件名 + namespace(`superpowers:`)+ **全部 14 个裸 skill 名**,
**且用连字符-感知的边界**(`[^A-Za-z0-9_-]`,不是 `\b`)。

### 完整耦合清单(v5 终版)

> 口径(v5,连字符-感知):`(^|[^A-Za-z0-9_-])<name>([^A-Za-z0-9_-]|$)`,扫 `.flywheel/agents/` +
> `agents/` + `packages/teamlead/lead-rules-base/`,14 个裸 skill 名 + `superpowers:` namespace + 插件名。

| # | 位置 | 状态 | 说明 |
|---|---|---|---|
| 1 | `agents/generic-executor.md` 99–204 | **活跃直接** | shipped 兜底的 RPC 四步流;裸名/namespace 命中 `brainstorming`/`writing-plans`/`test-driven-development`/`requesting-code-review`;3 条 fire 路径(见上) |
| 2 | `.flywheel/agents/engineering/designer-executor.md`(:68, :141) | **活跃直接** | 裸名调用 `brainstorming` ×2 |
| 3 | `packages/teamlead/src/workflow-seeds/` **3 个模板文件 / 4 个 generic node 引用**(`tpl_product_v1.yaml` ×2、`tpl_ops_light.yaml` ×1、`tpl_research_light.yaml` ×1)→ `agent_file: agents/generic-executor.md`;由 `workflow-run-snapshot.ts:214` / `workflow-engine-dispatcher.ts:192` 读取+快照+注入;default-off(`workflow-template.ts:18`) | **flag-gated,当前不消费** | **当前不消费**,但**不能从清单里消失** —— FLY-1299 若开旗,会把 workflow prompt 改动**混进** Superpowers ablation,污染实验 |
| — | `Blueprint.ts:2008` / `codex-runner-contract.md:126` | 非依赖 | **解耦说明**(「你没有 Skill 工具就手动照做」) |
| — | `CLAUDE.md:118` | 非依赖 | FLY-217 changelog,历史 |
| — | `.flywheel/agents/engineering/pm-executor.md` | **非耦合**(v4 误报,v5 删) | 只有 `product-brainstorming`(我们自己的),无裸 `brainstorming` |
| — | `packages/teamlead/lead-rules-base/*.md`(20 个) | **0** | 三口径(插件名 + namespace + 14 个裸名,连字符-感知)均 0 |

**两个易混文件**:`.flywheel/agents/general-executor.md` = 项目级(0 引用,但因 `labels: []` 永不被
label 匹配到 —— 见上);`agents/generic-executor.md` = shipped 兜底。

### 修正后的影响面(v5 终版)

- ✅ **仍成立**:**shipped 四步流的改动点是 1 个文件**(`generic-executor.md` 99–204)。
- ❌ **不成立**(v2/v3 错):「唯一耦合文件」「`.flywheel/agents/` 零耦合」「Flywheel 走不到」。
- **真实影响面** = **2 个活跃直接耦合**(`generic-executor.md` + `designer-executor.md`)
  **+ 1 组 flag-gated 间接消费者**(3 模板 / 4 node 引用,当前 default-off,开旗即污染 ablation)。
  其中 shipped 兜底本身覆盖:零配置项目 + Flywheel unmatched issue + 显式 `agentName:"generic"`。
- ⇒ **「改动点小」≠「影响面小」**,而且**影响面比 v1/v2/v3 说的都大**(但不含 pm —— 那是 v4 的误报)。

---

## 对照矩阵(v2:invocation-aware + 列语义修正)

> **列语义修正(v2)**:第③列 v1 写「我们实际用不用」= **overclaim**。prompt 引用只能证明
> **静态接线**,不能证明 runtime 真 invoke(真实 invoke 率要查 session telemetry = **UNKNOWN**)。
> 故改名「**③ 静态接线(证据)**」。
> **① 列只算 model-invoked**(user-invoked 对 headless runner 不可达);plugin 形态下不可改。

| # | Superpowers skill | ① Matt **model 可达**等价物 | ② 我们库已有 | ③ 静态接线(证据) |
|---|---|---|---|---|
| 1 | brainstorming | 🟡 `grilling`(model ✓;但语义是「盘问施压」非「探索意图」)。`grill-me`/`ask-matt`/`grill-with-docs` 全 **user-invoked ❌** | ✅ product-brainstorming + BRAINSTORM GATE | 接线:generic-executor override A → 映到我们的 GATE。**GATE 是我们的** |
| 2 | writing-plans | ❌ **无 model 可达对应物** —— `to-spec`/`to-tickets`/`wayfinder` **全 user-invoked** | ✅ `/write-plan` + writing-prds | 接线:generic-executor step 2(但 `/write-plan` 是我们的) |
| 3 | test-driven-development | ✅ `tdd`(model ✓) | ✅ flywheel-tdd | 接线:generic-executor step 3;三方重叠 |
| 4 | requesting-code-review | 🟡 `code-review`(model ✓;Matt 是 reviewer 侧) | ✅ codex-code-review(权威 gate) | 接线:OPTIONAL 自检;**权威 review = Codex gate** |
| 5 | systematic-debugging | ✅ `diagnosing-bugs`(model ✓) | 🟡 我们库无专门 debug skill | **未接进** shipped-generic 四步流 |
| 6 | verification-before-completion | 🟡 无专门 skill(散在 tdd/code-review) | ✅ QA gate + verify 规则 | **未接进**;纪律由我们的 gate + Codex 强制 |
| 7 | using-git-worktrees | ❌ 无(Matt 假定用 worktree) | ✅ 全局 git-workflow 规则 | **未接进**;worktree 是我们的**规则** |
| 8 | finishing-a-development-branch | ❌ 无(`resolving-merge-conflicts`/`to-tickets` **不覆盖** branch finishing) | ✅ flywheel-git-workflow + flywheel-land + ship gate | **明确 OMIT**(scope note 禁止交控) |
| 9 | executing-plans | ❌ `implement` 是 **user-invoked** | ✅ `/implement` | **明确 OMIT** |
| 10 | subagent-driven-development | ❌ 无 | ✅ Workflow + Agent Team | **明确 OMIT** |
| 11 | dispatching-parallel-agents | ❌ 无 | ✅ Agent Team + Workflow | **未接进**;我们用 Agent Team |
| 12 | **using-superpowers** | ❌ **by design**(Matt 零 hook,无对应物) | N/A | **这就是那 1,370 tok 注入**;唯一功能 = **强制** |
| 13 | writing-skills | ❌ `writing-great-skills` 是 **user-invoked** | 🟡 FLY-216 authoring 约定 | 基本不用 |
| 14 | receiving-code-review | ❌ 无(Matt `code-review` 是产出侧) | 🟡 codex-code-review 回环 | **未接进** |

### 矩阵读出的模式(v3 —— 措辞收紧到证据能撑住的范围)

- 我们 shipped-generic 四步流**静态接线**的 4 个里:TDD ✅ 有 model 可达对应物;brainstorming
  🟡(`grilling`,语义偏);requesting-code-review 🟡;**writing-plans ❌ 没有** —— 这是臂 (b) 的**真缺口**。
- 编排/收尾 5 个:**shipped-generic 的 scope note 明确 OMIT**,且我们有自有机器(Agent Team /
  Workflow / gate)。Matt 侧也基本无 model 可达对应物。
  ⚠️ **v2 说「两边都不需要、不影响决策」= 越界** —— 第③列只证「未接进四步流」,**不证没在用**
  (`using-superpowers` 的全局强制会让模型在命中触发时去调未接线的 skill)。**真实使用率 UNKNOWN。**
- `using-superpowers` 的**强制注入**是 Superpowers 独有、Matt 无对应物的(by design)。
  ⚠️ **v2 说「换过去唯一真正丢的就是它」= 越界**:换臂还会改变 skill **正文内容、触发措辞、
  副作用(写操作 / 派子代理 / 等真人)、产物形态**(如 Matt 的 `to-spec`/`to-tickets` 会往 issue
  tracker **发布**东西 —— 这是 `writing-plans` 没有的外部写)。
  **能说的**:强制注入是 Superpowers 独有的**那一层**,也是「重」的全部来源和 FLY-1260 的靶子;
  **但它不是**换臂的唯一差异。

### ⚠️ 未证实项(不许当结论用)

- ③ 列只证**静态接线**,**不证 runtime 真 invoke**。且 `using-superpowers` 的全局强制会让模型在
  命中触发条件时去调**未接线**的 skill(如 systematic-debugging)—— 所以「未接进 ≠ 没在用」。
  **真实使用率 = UNKNOWN,需 session telemetry。**
- 「~15 个 Claude Lead 都在消费这段 hook」= **从 launchd 注册数推的,未证**(见下)。

---

## 减重账(v2:apples-to-apples)

### 单 session 常驻成本(实测)

| 方案 | hook 注入 | catalog metadata | **每 session 常驻合计** |
|---|---|---|---|
| **(a) 现状 Superpowers** | **1,370 tok** | 408 tok(14 个,全 model-invoked) | **1,778 tok** |
| **(b) 换 Matt** | **0** | 420 tok(9 个 model-invoked) | **420 tok** |
| **(c) 都不装** | **0** | 0(仅我们自有 rules,本就在 prompt 里) | **0 tok** |

**净省**:(a)→(b) ≈ **1,358 tok/session**;(a)→(c) = **1,778 tok/session**。
**关键**:省下的**全部来自 hook** —— Matt 的 catalog(420)比 Superpowers 的(408)**还略贵 12 tok**。

> ⚠️ **这些数字的三条边界(v3 补,别越界引用)**:
> 1. **catalog 数字是「源码字段拼出来的 proxy」,不是「Claude Code 真实渲染进 prompt 的 payload」。**
>    真实注入还包含命名空间前缀、列表 wrapper、可能的 `when_to_use`、截断规则等。
>    ⇒ **408 / 420 / 「微亏 12 tok」都是 proxy 级** —— **12 tok 这种量级的差没有可信度**,别当结论用。
>    要坐实需在隔离 baseline 下分别启动三种插件状态、抓真实 `/context` delta。
>    **本单做不了这个测量:issue 的铁律是零生产变更、不装 Matt 的插件** ⇒ 留给 FLY-1299(plan.md U6)。
> 2. **1,778 是「一次 context-epoch 的 footprint proxy」,不是「一个 session 的账单」。**
>    真实账单要从每次请求的 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
>    统计,再按**各自不同费率**加上 output(cache read/write 单价不同,不能等权相加)。
> 3. **420 是「原版 shipped plugin 的 9 个 model-invoked」**。若走 plan.md 臂 (b) 的
>    **6 个 vendor 子集**(且 2 个要翻成 model-invoked、description 要重写),
>    **420 / 1,358 / 12 全部作废,必须在 frontmatter 冻结后重测**。

> 按需正文(只在 invoke 时进 context,不算常驻):Superpowers 14 个 26,443 tok;
> Matt shipped 22 个 23,128 tok。

### 舰队乘数(v3 再修 —— 我两次把推断当成了事实,这次彻底标清)

- **已证**:launchd **注册** 17 个 Lead,其中 **2 个 Codex 后端**(codex-infra-bot、mufasa)
  → **15 个 Claude 后端 Lead 已注册**。Codex 后端不吃这个 hook(不同 harness)。
- **未证(UNKNOWN)**:这 15 个是否**活跃**、各自每天 restart/compact/clear **几次**。
- ⚠️ **v2 仍有错,v3 改**:v2 把「15 × 1,778 ≈ 26,670 tok」叫作**下界** —— **不对**。
  在「是否活跃 UNKNOWN」的前提下,**真实下界是 0**(极端情况:没有一个 Lead 重启过)。
  26,670 只能叫「**若 15 个各冷启一次的情景值(scenario value)**」,不是下界。
  v2 那句「真实日耗是下界的数倍到十几倍」**完全未证,已删**。
- **能诚实说的**:
  - 单次事实(已证):**每次** startup/clear/compact,**每个** Claude session 付 1,778 tok。
  - 情景值(条件式):若 15 个 Claude Lead 各冷启一次 = 15 × 1,778 ≈ 26,670 tok。
  - 真实日耗 = **UNKNOWN**,需 session telemetry(→ plan.md U1)。
- **不依赖任何频率假设的结论**:hook 是**按 session 重复计费**的常驻税;换 (b)/(c) → **这条线归零**。
  「它到底一天烧多少」得等 telemetry,别在没数据时替它编数量级。

### 三方案对「重」的净效果

- **(a)**:唯一带 hook 注入税;买到的是「强制」。
- **(b)**:hook 税归零(-1,358/session);能力仍在但**只剩 9 个 model 可达**,且 `writing-plans` 无对应物。
- **(c)**:hook 税 + catalog 全归零(-1,778/session);完全靠我们自有 gate + 模型判断力。
  FLY-1260 命题对 (c) 有利;赌注 = 「强模型 + 我们的 gate」够不够替代那层强制。**认真一臂。**

> 三臂如何写成 FLY-1299 可执行 A/B(含臂 (b) 的钉死定义与可观测指标)→ 见 `plan.md`。
