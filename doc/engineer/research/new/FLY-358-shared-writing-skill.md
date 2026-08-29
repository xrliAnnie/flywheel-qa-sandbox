# Research: 共享写作 skill — Flywheel infra 层 — FLY-358

**Issue**: FLY-358（[XHS-draft] 提高 Flywheel 写作能力：共享写作 skill，供 SAP/Polaris/T.Echo/Tidal/Echo 调用）
**Date**: 2026-06-19
**Source**: 本 issue + LEARN-25 互链 comment；Asha PR #47（`xrliAnnie/sub` `content/doc/LEARN-25-affirmation-human-voice/`）
**分工**: 本文是 **infra 层**（Tadashi 指派）research：skill 格式 / 注册 / 跨项目接入 / L2 schema。**L1 内容核心（去 AI 味方法论）= Asha/Sub（PR #47），本文只消费、不重写。**

---

## 0. 一句话

把 LEARN-25 验证过的「去 AI 味」写作方法论，打包成一个**域无关、跨项目可调**的写作 skill，放进**已有**的 `flywheel-skills` 能力库（机器级、agentskills.io 标准），让 SAP / Polaris / tidal-echo / sub 等项目一处接入、各自挂自己的 domain pack，而不是各自重造。

**关键约束（Lead 确认）**：这一轮是 **plan-first** —— 出 research + plan → Codex design review → 报 Lead + Asha review。**不实现、不 merge、不碰 sub production。** 只做内部跨项目共享库（不做对外公开开源发布，见 §8）。

---

## 1. 审计：既有基建（先看清已有的，绝不从零造）

FLY-358 **不是从零起一套 skill 机制** —— FLY-214/216 已经把整套能力库基建 ship 了。本 issue = 往这套现成基建里**加一个住户**，并定义它特有的「调用方可调」接口。

### 1.1 `flywheel-skills` 能力库（已上线，FLY-216 v1.35.0）

- **库**: `xrliAnnie/flywheel-skills`（私有 GitHub repo）。分层定调（Annie）：Flywheel = orchestration layer；本库 = capability layer，半径 = 每台机器**所有** Claude/Codex session，flywheel 只是消费者之一。
- **格式**: 每个能力 = 一个标准 skill 目录，`SKILL.md`（[agentskills.io](https://agentskills.io) frontmatter：`name` / `description` / `allowed-tools` / `metadata.skill-author` / `metadata.skill-version`），可带 `scripts/`（可执行脚本与「何时用/怎么用」同目录随库分发）。
- **两层分类轴**（Annie 拍）:
  - `skills/generic/` — 离开 Flywheel 语境对任何 session 仍有意义（轴是「谁用得上」，不是「调了什么」）
  - `skills/flywheel/` — 只有编排中的 Lead/Runner 才会触发（gate / landing signal / issue 上下文类）
  - **安装后扁平化**（`~/.agents/skills/<name>`，无 tier 子目录）→ 跨 tier 名字必须唯一。
- **现有住户**（repo 实际 tree，4 个）: `generic/{video-watch, founder-html-delivery}`、`flywheel/{flywheel-land, xiaohongshu-learning}`。

### 1.2 分发与发现（零自研，已在跑）

- **同步**: 各机 launchd `com.flywheel.skills-update` 每天一次（+ 开机 `RunAtLoad`）跑 `~/.flywheel/bin/skills-sync.sh`：
  - 段 1 `npx -y skills@1.5.10 add xrliAnnie/flywheel-skills --all -g -y`（幂等装/更新，300s 看门狗）
  - 段 2 期望集 = repo git tree（机器格式，绝不解析 CLI UI 输出）
  - 段 3 prune（upstream 删了的）+ Codex 扇出（`~/.agents/skills/` canonical → symlink → `~/.claude/skills/` + `~/.codex/skills/`，只扇本库 managed 名单）
  - **三段 fail-closed**：任一获取段失败 → 只告警，绝不删已装 skill。
- **发现**: agentskills.io 标准 —— `name` + `description`（frontmatter）由 harness 自动注入 context（便宜，每条 ≤1536 字符预算）；body 只在模型 `Skill` 调用时才加载（贵的部分 lazy）。`description` 写「何时用」= 模型自主触发依据。
- **热加载**: 改已有 skill 正文 → 运行中 session 下次调用即生效（零重启）；新增 skill → 官方 live change detection 热发现（前置 = 顶层 skills 目录在 session 启动前存在，sync `mkdir -p` 保证）。
- **结论**: 一个 skill 装进 `flywheel-skills/skills/generic/` → 次日 sync → **全机所有 session（含每个项目 Lead/Runner）天然可见可调，零 per-project 安装**。这正是「跨项目接入」的机制，已经存在。

### 1.3 治理（已有 CI 门）

- 一切改动走 PR（脚手架 commit 之外无直推 main）。`.github/workflows/skill-guard.yml` 五道门全绿才 merge：frontmatter lint（`name` == 目录名）/ description 触发词 guard / shellcheck（零豁免）/ blocklist 命名冲突 / founder-html-delivery contract fixture。
- 回滚 = revert 库 main（≤1 天全机收敛）。
- 某机/某 Lead 关某 skill：用其工作目录 `settings.local.json` 的 `skillOverrides`，不改库。

### 1.4 命名空位核查

`blocklist.txt` 无 writing/voice/human/slop/affirm 类占用；现有 4 个 skill 名无冲突。→ 新写作 skill 名可用（候选 `human-voice-writing`，待 §6 定）。

---

## 2. 消费：Asha 的内容核心（PR #47，我吃这个）

Asha 在 `xrliAnnie/sub` PR #47（OPEN，`content/doc/LEARN-25-affirmation-human-voice/`）已产出**经实证的**方法论。其 `flywheel-skill-design.md` 明确把 infra 交给我：「具体 schema（YAML/JSON）、skill 调用约定、文件结构由 FLY-358 infra 层定」。

我消费的、不重写的部分（L1 内容核心）：

- **核心论点**: 「AI 味」由 **prompt** 决定，不是引擎决定。LEARN-25 实证（3 引擎 × 2 主题 × baseline/tuned）：旧 prompt 下换引擎收益很小；换「去 AI 味」prompt 后**三家都跳级，Codex 综合最佳**（最像真人 + 最守边界）。
- **去 AI 味 6+1 条**（域无关 craft，few-shot 按 domain 换）：具体>空泛 / 打破模板 / 禁用词表 / 真人语气+个性 / 字少画面多 / persona 开场 / constraints 照旧。
- **prompt 骨架**（填空模板，`{}` = 调用方钩子）。
- **双引擎 workflow**: assemble → Codex‖Gemini 并行 → gate_cmd 复查 → human review 仲裁。
- **铁律**: 生成越像人，越要守 gate（口语化顺手带否定、具体化漂向特定人 —— LEARN-25 实测 Gemini 调优稿就栽这两坑）。`gate_cmd` + human review 两道不可跳。

**已验证的 tuned prompt 实体**（`proof-founder/prompt-founder-tuned-60.txt`）直接印证 L1/L2 切分：
- 「HOW TO KILL THE AI FLAVOR」整块（6+1 条全文 + 「翻译腔尤其禁」）= **域无关 L1（常量）**。
- persona 开场 / TASK+buckets / FORBIDDEN wordlist / before→after few-shot / BOUNDARIES = **域特定 L2（变量，每 pack 不同）**。

→ 我的 driver 的活 = 把 L1（skill 自带）+ L2（pack）**机械拼**成这同一个结构。

---

## 3. 引擎事实（L3 driver 依据，本机实测）

| 引擎 | 调用 | 备注 |
|---|---|---|
| **Codex**（默认/首选） | `codex-with-fallback exec --skip-git-repo-check "$prompt"` | gpt-5.5；`codex-with-fallback` 5-profile 限流轮换（全局 rule）；在 repo 目录跑会吸 AGENTS.md 进 stdout → 从中性目录跑或抽末尾答案块 |
| **Gemini**（对照） | REST `generativelanguage…/models/gemini-2.5-pro:generateContent?key=$GOOGLE_API_KEY` | CLI free-tier OAuth 已弃用 → 走 API key；纯 CLI 不碰浏览器；`GOOGLE_API_KEY` 在 `~/.zshrc` |
| 本机可用性 | `codex-with-fallback` `gemini`(0.46.0) `codex` 均在 PATH | Asha `samples/run.sh` 是双引擎调用的可借鉴参考 |

**已知坑**（写进 driver/skill ops note）：Gemini 会照抄 few-shot 范例 → prompt 骨架尾部必须有「write your own, don't reuse these example lines」+ 多给几对降权重。

---

## 4. gate_cmd 契约（L2 钩子，参考 sub style-lint.sh）

`xrliAnnie/sub` `content/scripts/style-lint.sh` 是 gate 的参考实现，定义了我要的契约：

- **签名**: `bash style-lint.sh [<file>...]`（也支持 `--all` / 默认 changed-only）。
- **退出码**: `0` = clean / nothing in scope；`1` = violations（打印 `file:line`）；`2` = usage。
- **作用域**: **项目特定** —— 只扫 `content/projects/**/affirmations.md` 的编号行，查 negation + Chinglish 黑名单；**不扫** docs/briefs/packs（那些合法含「不要 X」边界文本）。

→ **这证实「项目特定 gate」必须是 caller-supplied（L2）**：每个项目的越界规则不同（肯定语 positive-only/SP-safe vs 歌词无 ownership/零文本复用）。**两层 gate（Asha baseline + Codex R2 闭合后）**：① **skill 自带 baseline-lint**（不可禁，跑 L1 安全 baseline 的机械可检子集 = 否定 + forbidden 核心）；② **caller `gate_cmd`** 只管项目特定检查（skill 提供「挂载点 + 运行 + 尊重退出码」机制，不预设项目规则）。driver 两层都跑、各自结果都报；`gate_cmd` 退出码 0 过 / 1 违例 / 2,126,127,其它 = config 错（不静默丢、报 violations 给人审）。**两层都过也不 auto-accept，human review 是最终仲裁。**

---

## 5. L2 domain-pack schema（核心 infra 交付 — 待 Asha PR #47 对齐字段命名）

把 Asha §4 钩子表落成**具体 YAML schema**（调用方在自己 repo 写 pack；skill 定义接口）。**跨部门契约草案 → 报 Tadashi → roundtable 已回（3 条纳入，见 §5.0）→ PR #47 对齐字段命名后冻 v1。**

### 5.0 Asha roundtable 三条硬约束（纳入 schema 设计）

1. **append-only L1 安全 baseline（fail-closed 安全属性）**：`forbidden_words 核心 / positive-only / SP-safe / lyric≠affirmation` = **L1 不可删 baseline**（skill 自带 `assets/baseline.yaml`，内容源 = Asha）。**pack 的 `forbidden_words`/`constraints` 只能 additive；schema 无 override/disable 字段**。两处安全闭合（Codex R2 两 HIGH）：**(a) prompt 精度** —— pack 内容（含 `output.tail`）先渲染、**L1 baseline 作末位不可放松块**（LLM 后指令覆盖前指令，baseline 必须在末位）；**(b) 两层 gate** —— skill 自带 baseline-lint（永远跑、不可禁）+ caller `gate_cmd`（项目特定）。**畸形/敌意 pack → 仍施加完整 baseline（fail-closed），baseline preflight 缺失即 abort**。
   - 调和原「绝不写死 L1」：不写死的是**某个 pack 的具体规则**（如 founder 现在时）；通用安全护栏（positive-only/SP-safe 当命名 profile）合法在 L1。
   - universal vs domain-scoped profile（`safety: [affirmation-safe|lyric-safe]` opt-in 但不可弱化）= **Asha 内容域，PR#47 对齐**；机制（append-only/fail-closed）我承诺。v1 先全局 baseline。
2. **gate_cmd = 编排「人审 + 机械 lint」，不自动化质量阀**：driver **绝不 auto-accept**（即便 gate exit 0），human review 不可跳；「去AI味判定」= human/founder。
3. **L1 当带版本会演进源消费，不冻 snapshot**：L1 craft/baseline 标 `source: LEARN-25 @ <commit>`、read-only、re-sync；不冻上游未决项（`engines.primary` 默认 Codex 但可配；schema 待对齐才冻 v1）。

### 5.1 schema（YAML pack；driver 以 `ruby -ryaml -rjson` normalize→`jq` 解析，本机 `yq` 无/`jq`+`ruby` 有）

```yaml
schema: 1                      # pack schema 版本（向后兼容；指向活的 L1 源版本）
id: sub-affirmation-founder    # 项目内唯一
lang: en                       # en | zh | ...

# WHO（L1 craft 第6条 persona 开场注入）。text / ref 二选一（互斥；都缺或都给 → 拒）
persona:
  text: |                      # —— inline 形式
    You are NOT an assistant ... you ARE a specific woman ...
  # ref: voices/founder.yaml   # —— 共享形式：相对【本 pack 文件】解析；voice 文件最小 schema = `text: |`；
                               #     ref 不得逃逸 project_root。lyric pack + affirmation pack 指同一文件 = 统一 voice

brief: |                       # WHAT + tone
  Write affirmations for a hidden subliminal track ... 4 buckets ...

forbidden_words:               # 【ADDITIVE】叠加在 L1 baseline forbidden 核心之上（只增不减；"翻译腔尤其禁"是 L1 常量）
  - abundant
  - radiant
  # ...

few_shot:                      # before→after 范例（driver 自动追加 "write your own, don't reuse"）
  - { before: "I am a confident and powerful founder.", after: "I build like someone who already knows it works." }
  # ...

constraints:                   # 【ADDITIVE】叠加在 L1 baseline 护栏之上（不能减/覆盖 baseline）。生成时注入 + 人审时呈现
  - rule: "present tense; no money amounts/deadlines"
    why:  "pack boundary"
    checked_by_gate: false     # 纯 metadata：「意图被 gate 复查」；gate_cmd 才是权威（不构成 enforcement）
  # 注：positive-only / SP-safe 不在此重写 —— 它们是 L1 baseline，driver 无条件施加；pack 只在其上叠加域特定项

gate_cmd: "bash content/scripts/style-lint.sh"
  # 跑完必过的项目自带 gate。driver 以 `<gate_cmd> <abs_draft_path>` 从 resolved project_root 跑。
  # 退出码（参考 sub style-lint.sh）：0=pass / 1=内容违例 / 2,126,127,其它非0 = gate/config 错（infra 失败≠脏稿）。
  # 语义 = 机械安全 lint + 编排人审；【不是】自动判 de-slop 质量的 judge。

output:
  count: 60
  format: numbered             # numbered | lines | free
  tail: "Output ONLY the bucket headers and the 60 numbered lines. No preamble."

engines:                       # 可选覆盖；默认 primary=codex / contrast=gemini（Annie 未最终拍引擎默认 → 可配非不可变）
  primary: codex
  contrast: gemini
```

**driver（`scripts/dual-write.sh --pack <pack.yaml> [--project-root <dir>]`）行为**：
1. **preflight（fail-closed）**：`ruby`+`jq` 在位；**`assets/baseline.yaml` 存在/可解析/版本/护栏非空（缺 baseline 绝不跑，Codex R2-3）**；`GOOGLE_API_KEY` 在位；`gate_cmd` 可执行；**resolve `project_root`**（`git -C $(dirname pack) rev-parse --show-toplevel` → 最近含 `.flywheel/writing` 祖先 → `--project-root`，Codex R2-4）→ 任一缺则 fail-fast。
2. **parse+校验**：ruby→json→jq 取值；必填缺失 fail-fast；`persona.text`∧`persona.ref` 互斥校验；ref 相对 pack 解析且不逃逸 project_root。
3. **merge = pack 内容先渲染 + L1 baseline 作【末位、不可放松】块追加**（HIGH-1：LLM 后指令覆盖前指令 → baseline 必须在末位，措辞写明 pack 不得放松底线）→ 解析 persona → 拼完整 prompt（pack 占位 + few-shot「write your own」+ 末位 baseline 护栏块）。
4. **并行引擎**：Codex `codex-with-fallback exec --cd <neutral_dir> --skip-git-repo-check --output-last-message <draft>`（保 5-profile 限流轮换；机读捕获，不刮 stdout）‖ Gemini REST + `jq` 区分生成文本 vs API 错误（auth/429/safety/empty）；`--engine both` 一成一败的退出+呈现语义定义。
5. **两层 gate（HIGH-2）**：① skill 自带 `baseline-lint.sh <abs_draft>`（永远跑、pack 不可禁 → 失败 = baseline 违例）；② caller `gate_cmd <abs_draft>`（project_root cwd，与引擎 neutral cwd 分离 → 退出码三分类 pass/违例/config 错）。两层结果都报。
6. **输出双稿 + 两层 gate 结果 + 机械 lint → 强制 human review（不可跳最终仲裁，driver 绝不 auto-accept）**。失败路径显式分类报错，不静默吞。

---

## 6. 跨项目接入模型

- **注册**: skill 进 `flywheel-skills/skills/generic/<name>/` → PR 过 skill-guard 五门 → 次日 sync → 全机可见。零 per-project 安装。
- **调用**: 任何项目的 Lead/Runner 按名字触发 skill（`description` 命中 / 显式 Skill 调用），传 `--pack <自己 repo 的 pack 路径>`。
- **可调（per-project tunable）**: 每个项目在自己 repo 写自己的 pack（L2）= 调优点。建议约定路径 `<project>/.flywheel/writing/packs/<id>.yaml` + 共享 voice `<project>/.flywheel/writing/voices/<name>.yaml`（skill 不强制位置，只取路径参数；约定写进 onboarding 指引 + 提供模板 pack）。
- **skill 名**: 候选 `human-voice-writing`（kebab、无冲突、描述目标）。`description` 前置触发场景（「生成的稿一眼假 / 去 AI 味 / 让文本读起来像具体的人写的 / humanize AI text」）。**名字 + description 措辞待 Codex/Lead 复核。**

---

## 7. 统一 voice（issue B —— schema 机制）

Asha §5：多个 caller 共享同一 persona → 不同 domain 产出听起来像同一个人（统一 voice，不统一 text）。infra 机制 = schema 的 `persona.ref` 指向共享 voice 文件：肯定语 pack 与歌词 pack 都 `ref: voices/founder.yaml` → driver 解析同一 persona block 注入。**但 `constraints` 仍各 pack 独立**（歌词挂「无 ownership/零文本复用」，肯定语挂「positive-only/SP-safe」）→ 统一 voice，文本各管各。验证靠 Asha 的「同一个人 test」+ 各自 gate_cmd。

---

## 8. 开源库（Lead 拍：只做内部，不做对外公开）

- **做**: 内部跨项目共享库 = 放进 `flywheel-skills/skills/generic/`，本就遵循 agentskills.io 开放标准、天然可移植给各项目调。这就是 Annie 要的「供各项目调用」。
- **不做**（plan 标 future / out-of-scope，待 Annie 产品决策才启）: 对外公开开源发布 —— scope 大很多（脱敏 / license / 独立 public repo / 剥离 Annie 私有 persona），且碰私有 persona 敏感面。**本轮不设计不实现。**

---

## 9. 风险 / 注意

- **不重造**: 全部走既有 `flywheel-skills` 基建（格式/分发/CI/扇出），本 issue 只加住户 + 定 L2 接口。任何「新机制」冲动都要先回查 §1 是否已有。
- **跨部门字段打架**: L2 schema 是 infra(我) × 内容(Asha) 的接缝。Lead 要求 schema draft 先报他 → roundtable 敲定 → 我再在 PR #47 对齐字段命名。**不 solo 定死字段。**
- **gate 不可跳**: driver 必须跑 gate_cmd 且不静默吞错（违例标红给人审）；human review 是最终仲裁。生成优化抬高天花板，不替代 gate。
- **引擎限流/噪音**: Codex 走 `codex-with-fallback`；从中性目录跑避免 stdout 噪音；Gemini 走 API key REST。
- **版本归属**: 实现主体落 `flywheel-skills` 仓（skill `metadata.skill-version` v0.1.0），**不 bump flywheel 仓 VERSION**；flywheel 仓这边只有本 research/plan 设计文档（+ 可能的 onboarding 指引）。plan 文件名 version 为占位、待 ship 复核。
- **过度工程**: backlog 性质 + boring/obvious 原则 —— driver 与 schema 要简单可读，别造复杂抽象。

---

## 10. 下一步

- [x] 审计既有 flywheel-skills 基建 + 消费 Asha PR #47 + 引擎/ gate 事实
- [x] brainstorm gate：理解 + 方向 + 开源 scope —— Lead 确认（方向 1-5 全对，只做内部库）
- [ ] 写 plan（`doc/engineer/plan/draft/`）含 L2 schema 落地、driver、注册、onboarding、测试策略
- [ ] L2 schema draft 报 Tadashi（跨部门契约）+ PR #47 对齐 Asha 字段命名
- [ ] Codex design review（loop 到 approved）→ 报 Lead + Asha review
