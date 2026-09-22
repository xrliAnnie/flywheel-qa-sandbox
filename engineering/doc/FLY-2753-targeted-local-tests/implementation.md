# FLY-2753 本机定向测试守则 — 实施记录
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-18
基于: plan.md

## 交付范围

- `.flywheel/agents/nodes/{implement,qa,engineer}.md` 的既有验证行改为：全仓 lint、受影响包 build/typecheck、直接相关定向测试；本机不跑全量 package suite。
- 三份守则以相同规则选择测试：changed file owning package + direct test consumers；对完整相对路径、文件名、父目录路径运行 `git grep -lF`，逐条解释排除项；TypeScript 用所属包的 `vitest related`；新增 shell test 全跑。
- 全量证据唯一来自 frozen-head full-mode exact-head CI 的 `CI OK`；`CI Scope OK` 不是全量证据。implement/engineer 修当前 HEAD 实际运行的红 job，QA 判 FAIL 并交回作者。
- 删除三份活守则里的 `pnpm test:packages:run`、`PACKAGE_GATE_RECEIPT`、`onTaskUpdate` 本机全量路径。未改 canonical phase protocol、同步脚本、CI workflow、package-gate implementation 或其他守则条款。

## TDD 证据

1. RED commit `1e8d8a85ab35aa35dcaf06ef3e974bb822f31112`：
   - `scripts/__tests__/package-gate.test.mjs` 为 21 pass / 1 fail；唯一失败是旧 implement 守则仍含本机全量合同。
   - `scripts/__tests__/fly2121-node-contract-and-setup.test.sh` 为 10 pass / 2 fail；唯一失败是缺 affected-package selector 与 no-local-full-suite 文本。
2. 最小守则实现 commit `180bdaa3e` 后，两项合同分别 22/22 与 12/12 通过。
3. 旧 prompt fixture 先产生 4 个预期失败（implement/qa × Claude/Codex）；其余 14 通过、12 跳过，证明 fixture 是直接消费者。
4. fixture commit `810c02fff` 用 RED commit 的改动前实际 composed prompt 重建 implement/qa anchor；随后 FLY-2533 为 18 通过、12 跳过。

## Prompt budget

| Node/backend | UTF-16 before → after | UTF-8 before → after |
| --- | ---: | ---: |
| implement / Claude | 6910 → 7517 | 6924 → 7533 |
| implement / Codex | 7011 → 7618 | 7027 → 7636 |
| qa / Claude | 14521 → 14897 | 14622 → 15000 |
| qa / Codex | 14622 → 14998 | 14725 → 15103 |

所有测量都以改动前 composed prompt 为 before，增长低于既有 10% gate。

## Direct-consumer discovery

对每个变更 node 文件分别以完整相对路径、文件名、父目录 `.flywheel/agents/nodes` 执行 `git grep -lF`，再读命中内容判定是否直接覆盖本次验证行。

保留并运行：

- `scripts/__tests__/package-gate.test.mjs`：遍历三份 node 并断言完整新验证合同。
- `scripts/__tests__/fly2121-node-contract-and-setup.test.sh`：断言 implement affected-package build 与 no-local-full-suite。
- `packages/edge-worker/src/__tests__/Blueprint.generalized-workflow.test.ts` + `fixtures/fly2533-phase-baseline.json`：加载 implement/qa domain 并校验 composed prompt 与预算。
- `scripts/sync-phase-protocols.mjs --check`：直接校验九个 managed canonical projection；它不是 package test。

排除判定覆盖 discovery 的每个其他命中：

- `doc/**`、`engineering/doc/**`、`product/doc/**`：全部命中均为历史记录、计划、评审证据、图表或本单过程文档，不读取或断言当前验证行，不作为可执行测试。当前 `plan.md` / `research.md` 也属于本类。
- `.flywheel/agents/registry.yaml`、`.flywheel/menus/ic-roster.yaml`、`scripts/package-onboard-files.allow`：只登记 role、路径或打包资产，不断言验证语义。
- `packages/claude-runner/test/{CodexTmuxAdapter,TmuxAdapter}.test.ts`：只验证 adapter 装载/注入 node 文本，不断言本次验证行。
- `packages/config/src/__tests__/{agent-registry,ConfigLoader.agent-registry}.test.ts`：只验证 registry/path 与 config loading。
- `packages/edge-worker/src/__tests__/{AgentDispatcher.registry,AgentDispatcher,Blueprint.fly208-report-back}.test.ts`：只验证 dispatch/registry/report-back；不覆盖验证行。FLY-2533 generalized test 已单独保留。
- `packages/flywheel-cli/src/__tests__/{doctor,migrate-agent-registry}.test.ts` 与 `packages/flywheel-cli/src/commands/{init,migrate-agent-registry}.ts`：只验证/实现初始化与 registry migration。
- `packages/teamlead/src/__tests__/{feature-flag-config-source,fly1262-ssot-acceptance,management-console-handbook-links,management-topology-source,workflow-menu-registry,workflow-menu,workflow-template,workflow-phase-protocol,workkind-cutover-routes}.test.ts`、`packages/teamlead/src/bridge/__tests__/{runs-route.dag-entry,question-admission}.test.ts`：只验证文件来源、导航、拓扑、路由、phase protocol 或 gate admission，不断言本次 domain 验证行。
- `packages/teamlead/src/__tests__/fixtures/{legacy-workflow-manifests,legacy-workflow-seed-definitions}.ts`、`packages/teamlead/src/bridge/__tests__/fixtures/fly2269-r1-reviewer-raw.txt`、`packages/teamlead/src/workflow-phase-protocol.ts`：历史 fixture 或生产装配源码，不是本次行为测试。
- `scripts/__tests__/{fly2015-diagram-design-roles,fly2045-milestone-layout-mutations,fly2045-milestone-layout,package-onboard-smoke,package-onboard-version-injection,package-onboard,runtime-role-auto-qa-retirement,skill-framework-variants,test-pm-executor-contract,test-qa-executor-529-nton-contract,test-qa-executor-ship-report-contract,test-setup-new-project,v2-retirement-cleanup}.test.sh`：各自只断言图、milestone、打包、退役、skill/PM/QA/setup 合同；虽含 role 文件路径或目录字样，但不读取本次验证行。
- `scripts/__tests__/fly2533-phase-protocol-assets.test.sh`：只断言 canonical 资产与 managed block；本次未改 managed block，直接 projection 证据由 `sync-phase-protocols.mjs --check` 提供。
- `scripts/{fly2121-legacy-name-guard.mjs,package-onboard.sh,qa-fly-2533-phase-protocol.mjs,setup-new-project.sh,test-deploy.sh}`：生产/手工工具或历史 QA driver，不是验证行消费者。FLY-2121 的直接合同 test 已单独保留。

动态模板字符串导致 package-gate test 不一定被精确路径 needle 命中；旧合同字符串审计和源码阅读确认它是直接消费者，因此 fail-closed 保留。没有新增 `scripts/__tests__/*.test.sh`；修改的既有 FLY-2121 shell test 已运行。

## 最终本机验收

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | exit 0；既有 diagnostics 仅提示，未改无关文件 |
| `pnpm --filter "flywheel-edge-worker..." build` | exit 0；10 个相关 workspace package |
| `pnpm --filter flywheel-edge-worker typecheck` | exit 0 |
| `node scripts/sync-phase-protocols.mjs --check` | exit 0；9 projections checked |
| 三份守则旧词负 grep + 新合同正 grep | exit 0；旧本机全量/receipt 词零命中，三份均命中新规则 |
| `node --test scripts/__tests__/package-gate.test.mjs` | 22 passed / 0 failed |
| `bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh` | 12 passed / 0 failed |
| `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533` | 18 passed / 12 skipped；1 file passed |

本机没有运行 `pnpm test:packages:run` 或 `pnpm -r build`。普通 implement PR 的实际 scoped jobs 若红，仍由本阶段处理；全量 suite 只由 QA 对 frozen HEAD 运行 `ci-full ensure` 并取得 `CI OK` 后成立。

## 已知边界

`.flywheel/agents/nodes/general.md` 仍有旧 full-repo 摘要。任务和 QA 判据锁定 implement / qa / engineer，且要求不要顺手改其他条款；因此保留并在此披露。此单没有 UI、Discord、数据库、服务重启、部署或 production mutation。
