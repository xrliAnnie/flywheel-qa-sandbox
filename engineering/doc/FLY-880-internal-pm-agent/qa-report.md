# FLY-880 QA 报告 — 对内 PM agent(product-designer-executor.md 扩写)

Issue: FLY-880 (https://linear.app/geoforge3d/issue/FLY-880/pmbuild-建对内-pm-agent-协作式产品思考者互动模型-pm-skills-prd-输出按-fly-679-设计)
日期: 2026-07-05
基于: plan.md(Codex design review Round 1 APPROVED),commit 787ad509(HEAD 前,role .md 扩写)

## 1. 验证范围

本 PR(#450)交付 plan.md §2 交付物「2」——本仓部分:

- `.flywheel/agents/engineering/product-designer-executor.md` 扩写(41 → 249 行,13168 字节)
- 守卫测试 `scripts/__tests__/test-pm-executor-contract.sh` + CI 接入
- doc-flow 文件夹(exploration/research/plan/progress)

**明确不在本 PR 范围内**(plan.md §1 out of scope / §2 交付物「1」):
- `flywheel-skills` repo 的 13 个 vendored PM skill(独立仓、独立 PR,plan Step 1)——**尚未落地**,见 §4。
- Product pipeline 形态 / PM 验收 gate(FLY-830)、对外 PM 卫星 bot、793 引擎改动 —— 均在 role .md「Boundaries」段声明不做,本 PR 未触碰。

## 2. 静态验证(真跑,非只读代码)

### 2.1 守卫测试

```
bash scripts/__tests__/test-pm-executor-contract.sh
```
→ **16/16 PASS**:40k 注入截断红线(实测 13168 bytes)、Mode A 全部锚点(产品共创/有定见/gate question/BLOCKING vs non-blocking 区分/prd.md/no-three-stage/create-issue/FLY-830 边界)、Mode B 存续锚点(codex-design-review/design/flywheel-comm ask)全部通过。

### 2.2 全仓 lint

```
pnpm lint
```
→ **0 errors**,14 warnings(全部是既有文件里的 pre-existing 告警——`runner-idle-watchdog-quiet.test.ts` 的 biome-ignore 失效提示 + `qa-fly-863-codex-hold-signal-e2e.mjs` 未用 import——与本 PR 改动文件完全无关)。

### 2.3 CI 工作流

`.github/workflows/ci.yml` 新增的 "Test — FLY-880 PM executor role contract" 步骤与仓库现行 bash-harness 模式(`bash scripts/__tests__/*.sh`)一致,零外部依赖,已本地验证跑绿。

## 3. Runtime 事实核查(独立子 agent,逐条对源码核实)

role .md frontmatter 注释 + body 里对 runtime 机制做了 5 条具体声称。由于这些声称若不准确会误导未来读这份 prompt 的 Runner,派了一个独立事实核查子 agent(不共享本次对话上下文)逐条 grep/读源码核实,而非只信 research.md 的自述引用:

| # | 声称 | 结论 | 证据 |
|---|------|------|------|
| 1 | `readAgentFile()` 原样注入、40k 处截断 | **CONFIRMED**(一处措辞精度提示,非缺陷) | `Blueprint.ts:1841-1882` 无 YAML 解析;`Blueprint.ts:1483` `agentContent.slice(0, 40_000)` 是 **char** 级;守卫测试的 `assert_max_bytes` 量的是 UTF-8 **byte**(≥char 数),故测试红线比真实截断点更保守,不会漏判,只是命名可以更精确 |
| 2 | label 路由:`pm`/`product`/`doc`/`docs`/`design`/`ux`/`designer` → `product-designer`;`research`/`plan` → `engineer` | **CONFIRMED** | `.flywheel/config.yaml:150-156`(product-designer match.labels)+ `:136-142`(engineer 含 research/plan)+ `AgentDispatcher.ts:200-231,292-299`(真实 dispatch 匹配逻辑,非仅声明式配置) |
| 3 | `no-three-stage` label 精确名(小写连字符)、能 opt-out 793 三段式 | **CONFIRMED**(且发现一条运营重要信息) | `three-stage-policy.ts:43` 常量精确匹配;`:45-66` 该 label 在检查 `pipelineConfig.three_stage` **之前**生效,单测 `three-stage-policy.test.ts:128-135` 覆盖。**`flywheel` 项目 `pipeline.three_stage: true` 当前确实开着**(`.flywheel/config.yaml:164-169`,2026-07-04 生效)——role .md 里的纪律不是防御性文字,而是此刻真实生效的行为约束 |
| 4 | `skills:`/`model:`/`permissionMode:` frontmatter 均不被 runtime 消费(纯文档性) | **CONFIRMED** | `AgentConfig` 类型(`types.ts:123-152`)无 `skills` 字段;`SkillInjector.inject()`(`SkillInjector.ts:23-35`)固定注入 5 个模板,与 per-agent skills 列表无关;`model:` 走 label > `roles.<role>.model` > env(`role-adapter-resolver.ts:165-231`);`permissionMode` 硬编码 `bypassPermissions`(`Blueprint.ts:1556`) |
| 5 | `gate question`(阻塞)与 `flywheel-comm ask`(非阻塞)是两条不同原语 | **CONFIRMED** | `gate.ts:174-223` 的 `gateInner()` 轮询 CommDB 直到有回复或超时;`ask.ts` 写一行即返回,无轮询,文档字符串明写 "Non-blocking question"(line 13) |

**结论:5 条声称全部 CONFIRMED,未发现事实性错误**;role .md 不会以过时/错误的机制描述误导未来读它的 Runner。

## 4. 行为模拟(独立子 agent,验证 prompt 是否真的诱导出契约行为)

Mode A 的核心风险不是代码正确性,而是"这段 prompt 文字能不能让一个 LLM 产出 FLY-679 五条铁律要求的行为"。为此派了第二个独立子 agent:完整读入 role .md 作为其唯一 system prompt/persona,扮演刚被 Tadashi dispatch 到一个 `pm`+`no-three-stage` 测试 issue 的 PM Runner,喂一句仿真 Annie 的模糊方向("我们该做 productization 了 —— 想让 Flywheel 装到别的项目上更简单点,一条 command 就能装"),要求产出其 Round-1 `gate question` 的原文。

产出逐项核对 role .md「Round 1」协议的 5 项要求:

1. **复述真实意图**(law 4)—— CONFIRMED:开篇复述"手工装 project config/bot/launchd"痛点 + "一条命令收敛"目标,以「这个理解对不对?」收尾。
2. **提 topic 树 + 点名先钻哪块**—— CONFIRMED:列出 5 个子块(目标与范围/安装体验/接入体验/更新与版本/自描述文档),明确"先从第 1 块开始"。
3. **探定见原句**—— CONFIRMED:结尾原句「这块你有定见,还是我来发挥?」逐字命中。
4. **不写 PRD 正文**—— CONFIRMED:全文没有 problem/users/goals/requirements 等 PRD 段落,只有复述+提纲+一问。
5. **单轮一问**—— CONFIRMED:5 个子块只是背景铺垫,实际只问了 1 个问题(子块 1 的探定见),未批量发问。

**结论**:role .md 的 Mode A 契约不只是"文字里含有对的关键词"(守卫测试已验),而是真的能诱导出符合五条铁律的具体行为。

## 5. 两仓时序(plan §5 风险 4 已知,非本 PR 缺陷)

前置检查(plan Step 5 §1):
```
ls ~/.claude/skills | grep -E "problem-definition|product-brainstorming|...(13个)"
```
→ **0/13** 命中 —— 配套的 `flywheel-skills` repo(vendored 13 个 PM skill)尚未合并/由 skills-sync 同步落地。

这是 plan.md §5 风险 4 明确预判且已给出缓解的已知状态,不是本 PR 的缺陷:role .md 的 skill 地图段已含「skill 缺失时不停摆、按地图描述的框架手动照做、报告缺失给 Tadashi」的兜底条款(经 §4 行为模拟侧面印证 role .md 的其余行为契约同样能被正确执行,兜底条款大概率同样有效,但未做针对性模拟)。

**因此本 PR 的静态/事实/行为验证可以完整跑完,但 plan Step 5 点 2-3⑤("真 dispatch + 至少 1 个 vendored skill 能被 invoke")无法在当前状态下验证** —— 需要 flyview-skills 侧 PR 落地、skills-sync 同步后才能补测。这条真 dispatch E2E 涉及创建真实 Linear 测试 issue、走 Tadashi/Bridge 生产调度链路、真实 Discord thread(且若 gate 挂起 ~10 分钟会通过 FLY-605 兜底 @founder),QA 判断这一步应等 companion skills 落地后再执行,而非在两仓时序缺口未补时勉强跑一半。

Step 5 点 4(Annie 亲自跑 productization 第一单)按 plan 本就明确划出 QA 范围之外。

## 6. 文档补漏

发现 plan.md Step 4 承诺的「CLAUDE.md 里程碑行 = PR 最后 commit」在 implement phase(4/4)未落地(diff 中 CLAUDE.md 无改动)。已在本次 QA 补上里程碑行(`⏳ Pending ship (PR #450)`,含本报告 §3/§4/§5 的关键发现摘要),随本 commit 一并提交。

## 7. 结论

**PASS**(有条件范围声明,非无保留通过)——

- 本仓交付物(role .md 扩写 + 守卫测试 + CI + doc-flow 文档)本身:静态验证(16/16 guard test + 全仓 lint 干净)、事实核查(5/5 runtime 声称 CONFIRMED)、行为模拟(5/5 Round-1 契约项 CONFIRMED)三层证据一致通过,可以合入。
- Plan Step 5 的完整真机 dispatch E2E(尤其 skill-invoke 断言)因两仓时序(flywheel-skills companion PR 未落地)**当前无法完整执行**,这是计划已知、有兜底的状态,不阻塞本仓合入,但**在 companion skills 同步落地前,不建议把 FLY-880 标记为"完全验收完成"** —— 建议 Tadashi 在 flyview-skills PR 落地后跟踪补一次真 dispatch 验证(可开轻量 follow-up 或在下一次真实 PM 使用时观察)。

建议按三段式 pipeline 进入 approve/ship 流程。
