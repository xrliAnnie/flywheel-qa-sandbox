# FLY-1461 QA executor 硬规矩:529 房真 Discord N-to-N — 实施计划

Issue: FLY-1461 (https://linear.app/geoforge3d/issue/FLY-1461/qa-executor-md-关单前必须跑-529-房真-discord-n-to-ndiscord-capable-单自记忆不靠-lead)
日期: 2026-07-24
基于: exploration.md, research.md
Status: draft(待 codex-design-review)

---

## 0. 目标(一句话)
把"凡 Discord-capable 单,QA 必须在 529 QA Room 跑真 Discord N-to-N 才算完"这条硬规矩,以 QA runner **自带指令**的形式写进 `.flywheel/agents/engineering/qa-executor.md`——让每个 QA runner spawn 即自带,不靠 Lead 记忆、不靠概率性 memory 检索。

## 1. 范围决策(Surface assumptions)

| 决策 | 结论 | 理由 |
|------|------|------|
| 改哪个文件 | **仅** `.flywheel/agents/engineering/qa-executor.md` | runtime 加载版(`.flywheel/config.yaml:166`);runner spawn 时 `readAgentFile` 现读,改完即对新 spawn 生效,零重启 |
| 动不动根目录 `agents/qa-executor.md` | **不动** | 那是 shipped/project-agnostic 默认版(`agents/qa-executor.md:7`),给无自有 qa agent 的下游项目;529 是 Flywheel 内部设施,写进去=给下游无法执行的指令(scope discipline) |
| 插入形态 | **新增独立小节** `## Discord-capable changes → …`,放在 `## CRITICAL rules` 之后、`## Work loop` 之前 | 规矩含判据+机制+反模式+豁免,塞进单条 bullet 太挤、易被忽略 |
| 现有 `:19` "Real-machine E2E" bullet | **加一句指针**指向新小节 | 避免两处规矩漂移打架;把泛化的 "user-facing flow" 具体化到"Discord-capable → 529 N-to-N 强制" |
| 守卫测试 | **加**一个最小 grep sentinel `scripts/__tests__/test-qa-executor-529-nton-contract.sh` + 接 CI | FLY-880 先例(md 规矩改动配 grep 守卫);直接服务 Annie "自记忆不靠 Lead" 的**耐久性**目标——CI 守卫比 md 本身更耐久,防未来编辑误删。**不是**"引擎硬门"(不 gate pipeline、不改 runtime 行为),不违反 Annie "不加引擎硬门" |
| 语言 | INSERT TEXT 用**英文** | 匹配现有文件(全英文);CLAUDE.md:代码/agent md 用英文 |

**字节预算**:现文件 3.3KB,新增约 2KB → ~5.3KB,远在 `readAgentFile` 40k-char 截断内(守卫测试的 40k byte sentinel 会持续保护)。

## 2. 实现步骤

### Step 1 — 编辑 `.flywheel/agents/engineering/qa-executor.md`

**1a. 升级现有 bullet(第 19 行)**,在末尾追加指针:
> 原:`- **Real-machine E2E for user-facing flows** — Discord / Bridge / Lead behavior observed live (\`feedback_qa_e2e_standards\`); API-returns-200 is not a product pass. Browser surfaces → **Claude-in-Chrome**, not Playwright (\`feedback_qa_must_use_claude_in_chrome\`).`
>
> 改为:同上句末尾追加 → ` For any **Discord-capable** change this is concrete and mandatory — see **"Discord-capable changes → run real Discord N-to-N in the 529 QA Room"** below.`

**1b. 在 `## CRITICAL rules` 段之后、`## Work loop` 之前,插入新小节**(最终 INSERT TEXT):

```markdown
## Discord-capable changes → run real Discord N-to-N in the 529 QA Room (MANDATORY, self-owned)

**This is your standing rule — you own it, not your Lead.** If the change you are verifying touches any Discord surface, a real Discord N-to-N run in the 529 QA Room is part of "QA done". It is NOT optional and it does NOT wait for a production deploy. Do not rely on your Lead to remember this — it is your job as the QA Runner.

- **Discord-capable judgment** — the change is Discord-capable (→ you MUST run the 529 N-to-N) if its diff touches any of: Discord **send** / **relay** (Runner↔Lead↔founder) / **render** (thread title · badge · pinned header · status line) / **founder interaction** (approve · ship · gate Q&A) / **roundtable** (#leads-roundtable participation / auto-thread) / **cross-Lead or cross-Runner coordination**. When in doubt, treat it as Discord-capable.
- **No deploy gate — the 529 QA Room exists precisely to test real Discord WITHOUT touching production (FLY-529).** NEVER frame live Discord E2E as "test after we deploy" or "blocked on the deploy gate". You deploy the **candidate PR head** into an isolated slot and run it there; production is never touched. Calling live e2e a post-deploy step is a misread of what the 529 Room is for.
- **How you run it** (candidate head → isolated slot → real Discord, zero prod touch):
  - `scripts/test-deploy.sh <slot> --from-branch <the-PR-branch>` deploys the reviewed head into `/tmp/flywheel-test-slot-<slot>` (sandbox clone + test bot token + isolated channels — production config is never touched). Add a **second real Lead** with `--extra-lead <otherSlot>:<deptLabel>` — a single Bridge with ≥2 real Leads IS the N-to-N topology. Use `--mode roundtable` / `--alerts` for the roundtable / alert mirrors.
  - Drive a real Runner into the slot with `scripts/inject-linear-issue.sh <slot> <issue-id>`; the scenario drivers (`scripts/qa-fly-60-driver.sh`, `scripts/qa-fly-1189-*`, `scripts/qa-fly-529-*-smoke.sh`) reuse this same infra.
  - For render / thread / relay behavior, a **module-driven** real-Discord harness (real compiled fn + real bot token + real thread POST/GET, zero mock) is the lightest path — use `scripts/qa-fly-907-real-discord-e2e.mjs` as the template.
  - Do the **founder-side** actions (approve / ship-gate / posting in Discord) yourself via **Claude-in-Chrome** on the founder's real logged-in session, and capture BEFORE→AFTER→VERDICT evidence (screenshots / gif_creator export). Run the `chrome-repair` preflight first.
  - **Isolation guardrail**: any isolated Bridge you start MUST set `FLYWHEEL_DELIVERY_SECRET_PATH` (otherwise it wipes the production delivery secret — latent corruption). See `packages/qa-framework/README.md` and memory `reference_qa_529_runner_injection_gotchas`.
- **No Discord surface? Say so — never silently skip.** A pure-config / no-Discord-surface change is exempt from the 529 N-to-N run, but you MUST state it explicitly in your report: "no N-to-N surface — verified via <X>" (X = the real check you ran: unit / CI / isolated harness). Silence reads as "skipped", which is not allowed.
```

### Step 2 — 新增守卫测试 `scripts/__tests__/test-qa-executor-529-nton-contract.sh`
- 精确镜像 `test-pm-executor-contract.sh` 结构(`#!/bin/bash` + `set -euo pipefail`,`assert_contains` = `grep -qF`,`assert_max_bytes` 40000)。
- **needle 一律不带反引号**(FLY-372 zsh footgun)。
- 断言(锚定**稳定关键词**,非整句,避免措辞微调即挂):
  1. 文件存在 + < 40000 bytes(截断红线 sentinel)。
  2. `529 QA Room`(529 房点名)。
  3. `N-to-N`。
  4. `Discord-capable`(判据锚)。
  5. `--from-branch`(候选 head 部署入口,证明"不部署生产")。
  6. `--extra-lead`(N-to-N 拓扑关键 flag)。
  7. 反模式锚:`deploy gate`(存在于"NEVER frame … blocked on the deploy gate"句)。
  8. 豁免锚:`no N-to-N surface`(豁免话术)。
  9. `Claude-in-Chrome`(founder-side 机制)。
  10. 现有 `:19` bullet 的指针已挂上:`529 QA Room` 出现在 "Real-machine E2E" 之后(可用两次 grep 或直接锚存在性)。
- 输出 `RESULT: N passed, M failed` + `[ "$FAIL" -eq 0 ]`。

### Step 3 — CI 接线
- 在 `.github/workflows/ci.yml:363`(`bash scripts/__tests__/test-pm-executor-contract.sh`)**相邻**加一行:
  `run: bash scripts/__tests__/test-qa-executor-529-nton-contract.sh`(同一 job step,或紧随其后的独立 step,照现有格式)。

### Step 4 — 归档 doc 文档
- 本单三件套(exploration/research/plan)+ progress 随分支 commit,PR 合入 main(doc-flow: docs travel with branch)。

## 3. 验证(证据驱动)

| 验证项 | 方法 | 通过标准 |
|--------|------|----------|
| 守卫测试绿 | `bash scripts/__tests__/test-qa-executor-529-nton-contract.sh` | `RESULT: N passed, 0 failed`,exit 0 |
| pm-executor 守卫未回归 | `bash scripts/__tests__/test-pm-executor-contract.sh` | 仍 exit 0(我没碰它;确认无副作用) |
| 字节预算 | `wc -c .flywheel/agents/engineering/qa-executor.md` | < 40000 |
| 语法/lint | `pnpm lint`(全仓)+ `bash -n` 守卫脚本(用 `/bin/bash` 3.2 跑,PATH 上是 bash 5,memory `reference_bash32_vs_path_bash_syntax_check`) | 干净 |
| bash 3.2 兼容 | `/bin/bash scripts/__tests__/test-qa-executor-529-nton-contract.sh` | 通过(生产=Mac bash 3.2) |
| codex code review | `/codex-code-review`(xhigh,gpt-5.6) | APPROVED |
| **本单不需要跑 529 N-to-N** | 本改动**无 Discord 面**(纯 prompt-text md + bash 守卫 + CI yaml),按新规矩豁免话术:**"无 N-to-N 面,已用守卫测试 + lint + codex review 验"**——在 PR/报告里明说,不静默跳过(吃自己的狗粮) | 报告含该豁免声明 |

**Annie 的行为级验证(交付后,非本 PR 内)**:改完后观察后续某个 Discord-capable 单的 QA 是否**自动**跑了 529 N-to-N(不需 Lead 提醒)——那次自动跑 = 生效铁证。本 PR 无法自证这一点(它验的是"规矩已在 runtime 文件里"),行为铁证在下游 QA 单出现。

## 4. 风险 / 回滚

| 风险 | 缓解 |
|------|------|
| 措辞过硬导致 QA 对"确无 Discord 面"的单也强跑 529 | 豁免话术明确"pure-config / no-Discord-surface → 声明豁免即可";判据只圈 Discord 面 |
| 守卫测试锚定整句 → 未来正常改文即挂 | 只锚**稳定关键词**(529 QA Room / N-to-N / --from-branch / deploy gate / no N-to-N surface),非整句 |
| 被当成"引擎硬门"违反 Annie 指令 | 守卫测试**不 gate pipeline**、不改 runtime 行为,只在 CI 断言 md 文本存在;明确区分于 Bridge/StateStore 强制 |
| 回滚 | 纯文档 + 测试 + CI yaml 改动,`git revert` 即可;无 runtime 状态、无迁移 |

## 5. 不做(scope discipline)
- 不改根目录 shipped `agents/qa-executor.md`(下游项目无 529 房)。
- 不加 Bridge/StateStore/gate 引擎强制(Annie 明令"不加引擎硬门")。
- 不改其它 executor md(engineer/pm/designer/prototype/product-designer/general)。
- 不动 `.flywheel/config.yaml` 路由。
- 不做三段式(Annie:generic runner 即可)。
