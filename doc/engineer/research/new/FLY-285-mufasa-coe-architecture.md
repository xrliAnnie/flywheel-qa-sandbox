# Research: Mufasa COE 架构（content-area-independent）— FLY-285

**Issue**: FLY-285（收窄为 **只做 Mufasa**；Belle → FLY-297）
**Date**: 2026-06-16
**Source**: `doc/engineer/exploration/new/FLY-285-mufasa-belle-coe.md`
**Status**: research（不依赖具体内容区的架构层；内容区待 Annie 补）

> **Scope 锁定（Annie round-2 + Tadashi relay）**：FLY-285 = **只做 Mufasa COE**；Belle 拆 FLY-297。
> **Codex 决定 = path (a)**：Mufasa 保持 Codex、当**对话式协调者只派活**、不亲手起 Runner。
> **内容区 HOLD**：Annie 稍后补 Mufasa 已想好的 Leads；本 doc 只研究**不依赖内容区**的架构（内容区只是参数：content Lead 的个数/名字/label/频道）。
> **排期硬规则**：动 Mufasa config/runtime 的**实现**接 FLY-278 ship 之后；设计/research 现在推。

---

## 1. 研究问题

1. Mufasa 当 CoS/Director（path a）怎么「派活」给 content Lead？需要放松多少能力面？
2. 非 git 的 `growth` 怎么变成 content-as-code 的 Runner 项目？Runner 复用要满足什么？
3. COE 结构落到哪些具体改动点（projects.json / config.yaml / agents / cmux / bot / 频道）？
4. content repo 的「绿门」（ship gate）是什么？
5. 一个 project 里 companion（Mufasa）+ dept（content Lead）能否共存？

---

## 2. 结论速览

| # | 结论 |
|---|------|
| Q1 | **Mufasa 保持 `companion:true` + Codex 不变**，仅做**对话式协调**（在协调频道/roundtable 跟 content Lead 说要做什么）。硬能力面**零放松**；只需 `companion-safety-contract.md` 措辞微调（显式允许「对话式协调你的 content team」，仍禁亲手 Runner/Bridge/code）。 |
| Q2 | `growth` 需 `git init` + GitHub remote（PR 流必需）；加 `.flywheel/config.yaml` + `.flywheel/agents/<content-executor>.md`；projects.json 加 `projectRepo`。Runner 生命周期**原样复用**。 |
| Q3 | 见 §5 改动点清单（content-area 无关部分可现在定；content Lead 的 N/名/label/频道是参数）。 |
| Q4 | **开放决策**：ship :cool:（FLY-2）假设 CI 绿；markdown 内容 repo 可能无 CI → 选 (a) 加轻量 markdown CI 当绿门 / (b) 「绿门」= Annie 的 PR review（无 CI）。倾向 (b)+可选轻量 lint。 |
| Q5 | **能共存**（已验证，§6）：claude-lead.sh 按 `projectName+leadId` 逐 lead 判 companion；projects.json `leads[]` 可混（geoforge3d = cos+dept 混）；FLY-245 invariant 逐 lead 检。 |

---

## 3. Q1 — Mufasa-as-CoS 协调机制（path a，最小方案）

**审计的协调原型**（FLY-270 自托管 + cos-lead-rules.md + cross-dept-channel-rules.md）：
- Flywheel 里 CoS 协调 = **创建/路由 Linear issue 线程**（`/api/chat-threads/send` 按 issue 路由）+ 跨部门走 **#leads-roundtable**（@-mention 兄弟 Lead）。
- 真正起 Runner 的永远是 **dept Lead**（`canSpawnRunners:true`），不是 CoS（cos 通常 `canSpawnRunners:false`）。

**path (a) 的最小落法**：
- Mufasa（Codex companion，`canSpawnRunners:false`）**不创建 Linear issue、不调 Bridge、不起 Runner**。它只在**协调频道**（growth-core 或 roundtable）用**自然语言**告诉 content Lead「Annie 想要 X 内容」。
- **content Lead**（Claude，`companion:false`，`canSpawnRunners:true`）接到后**自己创建 Linear issue（带内容区 label）+ 起 Runner**。
- 好处:Mufasa 的**硬能力面零改动**（仍是被 FLY-245/FLY-224 sandbox 锁死的 read-only Codex companion，MCP allowlist 只 gateway，无 Linear/Bridge/Runner）→ **不撞 FLY-278、不返工、人设零损**。
- **唯一改动 = `companion-safety-contract.md` 措辞**:当前明禁「No Runner lifecycle / No Bridge actions / not an engineering Lead」。需加一句许可:「你可以**通过对话协调你的 content team**（在你的协调频道跟他们说要做什么）；但你**仍然绝不**亲自起/停 Runner、调 Bridge action、或动代码——那些由 content Lead 做。」其余禁令不变。
- Q room = 现有 #mufasa 频道(温暖 1:1 陪聊保留);协调发生在 growth-core / roundtable。

> **为什么不让 Mufasa 自己创建 Linear issue?** 那要给 Codex companion 加 Linear MCP = 放松 FLY-245 sandbox（read-exfil 面扩大，见 FLY-260）。path (a) 的精神就是**不**放松;用 content Lead 兜住「创建 issue + 起 Runner」。若日后要 Mufasa 直接建 issue,单开 issue 评估 sandbox 放松,不在本 PR。

---

## 4. Q2 — content-as-code Runner（growth → git repo）

**审计**:`run-infra.ts:494` 从 `project.projectRoot/.flywheel/config.yaml` 读配置;`WorktreeManager`(FLY-95)在 `projectRoot` 建 per-Runner worktree → **要求 `growth` 是 git repo**。`flywheel-git-workflow` skill: Runner `git push -u origin HEAD` + `gh pr create` → **要 GitHub remote**。

**改动**:
1. `~/Dev/growth` `git init` + 建 GitHub remote（如 `xrliAnnie/growth`，private）+ 首 commit（现有内容 + 目录结构 `content/<area>/`）。
2. `growth/.flywheel/config.yaml`（照 flywheel/geoforge3d）：`project: growth` / runners.default=claude / checkpoints（brainstorm/question/approve_to_ship）/ `agents:` 声明 content executor。
3. `growth/.flywheel/agents/<content-executor>.md`：内容创作 executor 提示词（产 markdown 草稿,不是代码;TDD 不适用 → executor 写法贴近 docs-executor 而非 code-executor）。
4. projects.json `growth` 加 `projectRepo: "xrliAnnie/growth"`。
5. Runner 生命周期**原样复用**:worktree → 内容 markdown → PR → review → merge。**PR = 草稿待 Annie 过目**(契合 founder-gate)。

---

## 5. Q3 — COE 结构改动点清单

**content-area 无关（现在可定）**：
- **projects.json `growth`**：加 `projectRepo`、`generalChannel`(growth-core);`leads[]` 从 [mufasa-lead] → [mufasa-lead(保持 companion:true/Codex/canSpawnRunners:false), <content-lead>(Claude/companion:false/canSpawnRunners:true/department:growth)]。
- **growth git repo + remote + `.flywheel/{config.yaml,agents/}`**(§4)。
- **companion-safety-contract.md** 措辞微调(§3)。
- **claude-lead.sh**:验证 companion+dept 混存路径(§6);大概率**无需改代码**(逐 lead 判已支持),仅需测试覆盖混存。
- **cmux**:content Lead 进 cmux 窗(照 Hiro/Asha)。
- **cross-dept-channel-rules.md roster**:加 content Lead 行(若它进 roundtable)。

**content-area 相关（待 Annie 补 → 参数）**：
- content Lead 的**个数 N**、**名字/persona**、**label**(`match.labels`)、**chatChannel + bot token**、内容目录 `content/<area>/`。
- 是否多个内容区 = 多个 content Lead，还是先 1 个 content Lead 管多区(Phase 1 建议先 1 个端到端打通)。

---

## 6. Q5 — companion + dept lead 混存（已验证可行）

- `claude-lead.sh:303-353` `_companion_query()` 按 **`projectName+leadId` 精确匹配**逐 lead 判 companion → 同 project 里 mufasa-lead 判 companion、content-lead 判 noncompanion,互不影响。
- `ProjectConfig.ts` 校验**逐 lead**;FLY-245 cross-field invariant 逐 lead 检(mufasa: companion:true+canSpawnRunners:false+codex ✅;content-lead: claude/companion:false/canSpawnRunners:true ✅)。
- 先例:`geoforge3d` 一个 project 里 cos(canSpawnRunners:false)+ product/ops dept(canSpawnRunners:true)混存。
- → **一个 `growth` project 装 Mufasa(companion CoS)+ content Lead(dept)成立,无需改 schema。**

---

## 7. Q4 — content repo 的「绿门」（开放决策）

- ship :cool:(FLY-2)在 merge 前要 CI 绿。markdown 内容 repo 默认无 CI job → ship 流的绿门没东西可过。
- 选项:
  - **(a) 加轻量 CI**:content repo 配一个 markdown lint / link-check / frontmatter 校验的 GitHub Action 当绿门。统一走现有 ship 流。
  - **(b) 绿门 = Annie 的 PR review**:内容的「正确」本就靠人审,Annie 在 PR 审稿即 merge 门;不强制 CI。但要确认 ship :cool: 流在「无 CI check」时的行为(可能需让 content repo 的 ship 跳过 CI 等待)。
- **倾向 (b) + 可选最小 lint**:内容质量靠 Annie 审;加个不阻塞的 markdown lint 防格式坏。**plan 阶段定**;可能需小改 ship/land 逻辑识别「无 CI 的 content repo」。

---

## 8. 开放问题 / 待定

| 项 | 谁定 | 何时 |
|---|---|---|
| Mufasa 内容区 + content Lead 的 N/名/label/频道 | Annie（Tadashi re-ask） | brainstorm 续 |
| content repo 绿门 (a)/(b) | plan + Codex design review | plan 阶段 |
| growth repo 名 + private + 现有内容迁移方式 | Annie 确认建 repo | plan/impl 前 |
| safety-contract 措辞精确版 | plan + Codex design review | plan 阶段 |
| Phase 1 先 1 个 content Lead 端到端打通 | 建议 | plan |
| 动 Mufasa config/runtime 实现窗口 | 接 FLY-278 ship 后 | impl |

---

## 9. 下一步

1. **等 Annie 补内容区** → 填 §5 参数。
2. **写 plan**（`doc/engineer/plan/draft/v?.?.0-FLY-285-mufasa-coe.md`）→ Codex design review。plan 要定:绿门方案、safety-contract 措辞、Phase 1 范围(建议 1 个 content Lead 端到端)、混存测试、growth repo onboard 步骤、cmux/bot/频道 provisioning、实现接 278 的顺序。
3. **implement**(TDD where applicable;混存 + safety-contract + config 校验有测试)→ PR → Codex code review → QA → ship(Annie 批)。
