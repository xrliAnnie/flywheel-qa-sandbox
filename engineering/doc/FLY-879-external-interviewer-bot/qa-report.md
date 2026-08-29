# FLY-879 对外 PM 卫星 bot(Anna)基建 — QA 报告

Issue: FLY-879 (https://linear.app/geoforge3d/issue/FLY-879)
日期: 2026-07-05
基于: plan.md, design-review.md

---

## 结论:PASS

本 PR(#453)是**纯 scaffold**(W1 主仓代码 + W5 隔离验证脚本 + 部署 runbook),不指向真客户、不 go-live——按 plan.md §4 的 PR 边界,验证范围就是"主仓代码变更是否严格符合 external 角色类设计 + 是否零回归"。

## 验证方法

### 1. 设计 vs 实现比对
逐条核对 plan.md W1/W5 的交付项与 `git diff main...flywheel-FLY-879` 的实际 diff(ProjectConfig.ts / claude-lead.sh / external-agent-contract.md / post-compact-bootstrap.sh / lead-alert.sh / verify-anna-isolation.sh):

- `LeadConfig.external?: boolean` 新字段 + `parseAndValidateProjects()` 交叉校验:`external:true` ⇒ 显式 `canSpawnRunners:false`、`external`⊕`companion` 互斥、MVP 仅 claude-code backend——三条校验逐条读码确认落点正确,且**校验顺序正确**(canSpawnRunners 归一化在前,故校验读到的是归一化后的真实布尔值,absent/true 都会被正确拒绝)。
- `claude-lead.sh` 角色态三值化(standard|companion|external):external 分支跳过的每一项(shared-rule 同步、founder-only-authority、founder-ux-rules、founder-html-delivery、cross-dept-channel-rules、discord-reply-contract、common-rules、screencapture skill、Agent Team 接线、PostCompact hook 安装、engineering bootstrap)逐处读码确认与设计一致;`FLYWHEEL_LEAD_EXTERNAL=1` pane 标记、`_external_query()` 三态检测 + fail-STOP(`external_config_error` 新告警 kind)均落地。
- `external-agent-contract.md`:五条边界(指令源边界/单向阀/写权限边界/系统边界/live-gate)内容完整,措辞与 design-review.md round1#10 的"诚实表述"要求一致。
- `post-compact-bootstrap.sh`:`FLYWHEEL_LEAD_EXTERNAL=1` early-exit,位置在 companion 分支之后、bootstrap_curl 定义之前——不会有一次 bootstrap curl 漏网。
- `lead-alert.sh`:`external_config_error` 加入 kind allowlist(usage 注释 + case 分支同步更新)。

**PM/Triage 标签碰撞检查**:Anna 用的 `external-interviews` 标签不在 `PM_LABELS=["pm","triage"]` 内(独立读码验证,非只信 commit message),按设计"刻意避开 PM/Triage 路由词"生效。

### 2. 自动化测试(全部真跑,非假设通过)

| 测试 | 结果 |
|---|---|
| `ProjectConfig.test.ts`(含 external 校验矩阵 + reverse-compat sentinel) | ✅ 130/130 |
| `external-agent-contract.test.ts`(合同内容回归) | ✅ 15/15 |
| `fly879-external-launch-plan.test.sh`(含脏 fixture 注入、fail-STOP、rollback) | ✅ 40/40 |
| `fly879-postcompact-external.test.sh` | ✅ 4/4 |
| `lead-alert-external-kind.test.sh` | ✅ 6/6 |
| `fly231-companion-launch-plan.test.sh`(含 T8 5 个 golden byte-compat) | ✅ 44/44 |
| `scripts/verify-anna-isolation.sh`(独立执行,Anna 尚未 provision) | ✅ 4 项全部 graceful skip(设计如此——见下) |
| `pnpm -r build`(全仓 17 个包) | ✅ 全绿 |
| `pnpm lint`(全仓 biome) | ✅ 0 error(14 条 pre-existing warning,均在本分支未触碰的文件内,已用 `git diff main...HEAD --stat` 核实) |
| `packages/teamlead` 全量 vitest(4868 tests) | ✅ 4867 passed / 1 pre-existing 环境问题(见下)/ 0 因本 diff 导致的失败 |

`verify-anna-isolation.sh` 的 4 项 skip 是**设计内行为**:Anna 尚未 provision(无 `ANNA_GITHUB_TOKEN`、projects.json 无该 lead entry、workspace 未创建),脚本按 W5 设计"降级为 skip 而非 fail",真正的 go-live gate 验证要等 W2/W3 仓外物料落地后再跑——不在本 PR 范围内。

### 3. 全量测试中的失败排查(逐一 root-cause,非无脑略过)

全量 vitest 第一轮(4868 tests)出现 32 个失败,集中在 `codex-lead-runtime.test.ts`。Root cause:**QA 跑测环境本身的 TMPDIR 落在 `~/.flywheel/runner-state/.../browser-tmp` 下**,撞上该文件的"workspace 不得与 `~/.flywheel` 重叠"防护断言——这是已知环境问题([[reference_qa_codex_lead_runtime_tmpdir_overlap]] memory 记录过),**与本 PR diff 完全无关**(`git diff main...flywheel-FLY-879 --stat -- packages/teamlead/src/lead-backends/` 为空)。改用干净 `TMPDIR=/tmp/...` 重跑,32 个全部转绿。

第二轮(干净 TMPDIR)剩 3 个失败(`LeadAlertNotifier.test.ts` 1 个 + `createLeadRuntime-preflight.test.ts` 1 个 + `post-ship-finalization.test.ts` 1 个),逐一独立复现排查:

- **`createLeadRuntime-preflight.test.ts` + `post-ship-finalization.test.ts` 的失败**:单独重跑这两个文件(不与全量套件并发)**全部通过**——确认是全仓 4868 测试并发跑在这台负载较高的机器上的纯计时抖动(test timeout / 并发资源竞争),非真实回归。
- **`LeadAlertNotifier.test.ts`**(唯一稳定复现的失败):`POSTs to alertChannel with resolved bot token` 断言 `Authorization` header 应为 mock 值 `"Bot resolved-bot-token"`,实际读到一个真实 Discord bot token 格式的值(`Bot MTQ4Nz...`)。Root cause:**这台机器的 shell 环境本身 source 了生产 `~/.flywheel/.env`,`SIMBA_BOT_TOKEN` 等真实 bot token 已在 `env` 中**(该测试文件在这一处 `beforeEach` 没有像其下另一个 describe block 那样显式清空这几个 env var)——纯环境污染,与本 PR 代码无关。**独立验证**:在完全独立的 `~/Dev/flywheel`(main 分支 checkout,未涉及此分支任何改动)跑同一测试,**同样失败、报错信息逐字节相同**,证明是这台机器长期存在的预先污染,不是 FLY-879 引入的回归。

**结论**:本 PR 的代码 diff 没有引入任何测试回归。

## 未做的事(明确不在本 PR 范围内)

- 未实际 provision Anna(无真实 Discord bot、无 flywheel-interviews 仓)——按 plan.md §4 这些是"仓外物料",走 runbook,不进这个 PR。
- 未跑 W6 彩排 + 注入对抗测试——同样需要 W2/W3/W4 先落地,是 go-live gate 的一部分,由 Annie/Tadashi 在部署阶段执行。
- `LeadAlertNotifier.test.ts` 的环境污染问题超出本 issue 范围(pre-existing,main 上同样复现),未在本 PR 修复;已记录以便后续单开 follow-up(测试应在 `beforeEach` 里显式清空 `SIMBA_BOT_TOKEN` 等 env var,不依赖机器干净)。

## 未新增测试

未发现设计要求之外的测试缺口——W1 校验矩阵(ProjectConfig)、隔离证明(launch-plan)、fail-STOP 路径、byte-compat golden 全部覆盖,且都是本人独立读码验证后确认与实现逐条对应,而非仅信任 commit message 描述。故本次 QA 未新增测试文件。
