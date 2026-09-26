# FLY-2802 Runner 测试纪律 — 调研
Issue: FLY-2802 (https://linear.app/geoforge3d/issue/FLY-2802/runner测试纪律-本机只跑相关测试写进-promptfly-2753后-runner-仍跑整包全量把-prompt-写到不留口子-在)
日期: 2026-09-23
基于: exploration.md

## 当前证据与数据流

基线 `c5f2becd0`。本节点已获 TURN `phase=design epoch=1`；execution `49da92c8-f888-4efc-a8da-b82f20e11fd7`。以当前 checkout 和注入 issue 为依据，不从旧任务推定上线结果。

1. `.flywheel/agents/nodes/implement.md:29`、`qa.md:50`、`engineer.md:27` 有 FLY-2753 共同文本和各自报告/修复职责。
2. `packages/teamlead/phase-protocols/{implement,qa}.md` 是共享阶段规则；目前没有本机测试范围条款。
3. `scripts/sync-phase-protocols.mjs:8` 维护九个节点投影。`packages/teamlead/src/workflow-phase-protocol.ts:73` 从 role 剥离完全相同的投影再组合 canonical protocol，拒绝陈旧块，限制最终长度 40,000。不能只改 role managed block。
4. `packages/edge-worker/src/Blueprint.ts:1679` 调用 SkillInjector；`SkillInjector.ts:23` 生成 `.claude/skills/*/SKILL.md`，默认 testCommand 是 `pnpm test`。这些生成文件不应手改。
5. `packages/claude-runner/src/TmuxAdapter.ts:1240` 保存追加 system prompt，`:1337` 保存任务 prompt；`CodexTmuxAdapter.ts:1134` 组装 goal kick，独立 home 的 AGENTS 来自 `packages/claude-runner/agents/codex-runner-contract.md`。
6. Codex `codex-transcript-sink.ts:105` 展示 commandExecution 时压平并截断命令，仅 item/completed；该可读 transcript 不能证明全部工具调用，必须读取原始结构化 session JSONL 或完整事件源。

## 既有验收与缺口

FLY-2753 implementation.md 记录 package-gate 22 tests、FLY-2121 12 checks、FLY-2533 18 prompt tests；均为当时静态/控制器证据，未覆盖真实模型的选择。直接消费者仍需保留：

- `scripts/__tests__/package-gate.test.mjs`
- `scripts/__tests__/fly2121-node-contract-and-setup.test.sh`
- `packages/edge-worker/src/__tests__/Blueprint.generalized-workflow.test.ts`
- `packages/edge-worker/src/__tests__/fixtures/fly2533-phase-baseline.json`
- `packages/teamlead/src/__tests__/workflow-phase-protocol.test.ts`
- `packages/edge-worker/src/__tests__/SkillInjector.test.ts`

先确认 composed prompt 的实际增量，再调整预算 fixture；不得简单重置旧基线隐藏增长。

## 技能冲突初查

| 当前文件 | 指令/触发 | 处置 |
| --- | --- | --- |
| `packages/edge-worker/src/skill-templates/flywheel-tdd.ts:49` | REFACTOR 无选择 `testCommand`；写实现前可加载 | 修改 Flywheel 模板；保留 TDD，测试选择服从注入规则 |
| `packages/edge-worker/src/skill-templates/flywheel-git-workflow.ts:51,62` | PR test plan/pre-commit 无选择 testCommand | 修改模板，不修改生成 SKILL |
| `packages/edge-worker/src/skill-templates/linear-issue-context.ts:28` | Done 要求裸 testCommand | 修改模板的测试证据措辞 |
| `~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0/skills/dispatching-parallel-agents/SKILL.md:81,172` | 多领域并行修复后要求 full suite | 注入层明确覆盖；不改第三方 |
| 同版本 `finishing-a-development-branch/SKILL.md:23` | finishing 时示例 broad npm test/go test | 同上，保留相关验证与分支收尾 |
| `.flywheel/agents/nodes/general.md:19` | 进入 engineer 的摘要仍为全仓 build/tests | 定向修此一句以免导流语义矛盾；不重写 generic 协议 |

可发现或可能触发不等于历史确已调用；完整 sweep 与生效配置证据见后续 `skill-audit.md`。覆盖优先级以运行时注入为准，而不是声称第三方已修复。

## 529 的真实入口与不能复用的部分

- `scripts/test-deploy.sh` 支持 `--generalized --expect-head <sha>` 和真实 Claude/Codex。脚本所在 checkout 才是 Bridge/编译产物来源；`--from-branch` 只选择 sandbox 分支，不能用后者证明运行候选代码。
- `scripts/lib/qa-generalized-e2e-lib.mjs:140` 校验 room-info 身份与 real/stub；`:657` 的 start request 是 `/api/runs/start` + issueId/projectName/leadId/taskCategory/sessionRole/idempotencyKey。
- `scripts/inject-linear-issue.sh:114` 明确拒绝 generalized room；新 driver 应走上述正式 start boundary。
- `scripts/qa-529-generalized-e2e.mjs` 同时处理旧 run 回收、QA 重试、批准与 ship 收尾。不能整段调用来测“不跑整包”；只复用纯身份校验与参数构造，并删除其中固定的 fable/codex model override，使用每个测试 cell 的实际模型。
- `packages/qa-framework/README.md` 规定 sandbox fork、隔离 slot 的 config/数据库/交付密钥与生命周期归属。重用这些设施，不新增生产命令拦截器。

## 外部语义核对

[Vitest CLI 官方说明](https://vitest.dev/guide/cli)：文件参数是路径包含匹配；related 依赖静态 import，需 `--run` 避免 watch。因此字面量断言搜索必须独立保留，不能只用 related；指定文件也必须核对实际匹配集合。

[Vitest filtering 官方说明](https://vitest.dev/guide/filtering)：测试名筛选不等同于文件筛选。`--exclude` 只做排除，不能使“无正向文件选择的运行”变成合法定向验收。

## 研究结论

最小闭环是：共同规则来源 → 三节点/阶段协议/自有 skill 注入一致 → 合成任务真实运行 → 原始工具事件离线判定 → QA 将 exact-head 证据列为 prompt 改动必过项。观察器的错误应使验收无法通过，而不是改变 runner 的工具权限。

## R1 后的入口核验更正

已有 buildGeneralizedStartRequest 的 code 默认值不是本场景正确选项。当前 registry 的 code 图不允许 Codex QA，且包含真实 eng_design；simple_code 图允许 opus implement + codex QA 及 codex implement + opus QA，没有设计节点。workflow-menu.ts:872-906 拒绝同 vendor producer/QA。计划因此采用两次交叉 vendor 的 simple_code run，不改变生产 issue 分类或模型许可。

standalone engineer 还必须在项目 config 声明 agents.engineer.node，并经 agentName 显式选择。仅复制 registry role 不会创建 ConfigLoader 的 agents 映射；inject-linear-issue.sh 的请求体也不支持 agentName。修订 driver 直接使用已有正式 start API，部署前解析映射，部署后验证真实 carrier。普通 Codex 的 QA-only 扩展同时要求前置 expect-head 栅栏。

仓内完整可达的 full suite 链已补查并写入 skill-audit.md：QA node → qa-framework README → qa-parallel-executor → pre-ship-check → test:packages:run。初稿的技能审计不完整；这条链的指令源均加入处置。
