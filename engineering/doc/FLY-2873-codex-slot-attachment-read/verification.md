# FLY-2873 Codex 测试房附件读取 — 验证
Issue: FLY-2873 (https://linear.app/geoforge3d/issue/FLY-2873/病根529-房-codex-载体-lead-在测试房读不了附件默认-direct-出站没有读取身份transport-unavailable)
日期: 2026-09-25
基于: plan.md

## TDD 反馈环

- `qa-codex-lead-layers.test.sh` 红：12 passed / 3 failed，缺 effective mode、bridge canonical env 和三条 carrier redirect；实现后 15/15 绿。
- `test-deploy-fly1389.test.sh` 红：真实 `test-deploy → launchd wrapper → runtime` 在 `missing canonical env FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE` fail-close；实现后 25/25 绿，覆盖默认 full-access/bridge、显式 full-access/direct、混合 companion/direct、Bridge/Lead 路径同字节和 restart/teardown。
- 最小实现只改测试房部署、环境 contract 和纯 shell helper；没有改附件 route、carrier validator 或生产 launcher。

## 定向验证

| 命令/范围 | 结果 |
|---|---|
| `bash scripts/__tests__/qa-codex-lead-layers.test.sh` | 15 passed |
| `bash scripts/__tests__/test-deploy-fly1389.test.sh` | 25 passed |
| 4 个 attachment scope/router/MCP/TUI Vitest 文件 | 4 files / 69 tests passed |
| `bash scripts/__tests__/qa-slot-env-contract.test.sh` | passed |
| `bash scripts/__tests__/qa-lead-artifact-fixtures.test.sh` | 7 passed |
| `bash scripts/__tests__/test-deploy-launch-boundary.test.sh` | passed |
| `bash scripts/__tests__/run-bridge-isolation-boot.test.sh` | passed |
| `bash scripts/__tests__/test-cycle-bridge.test.sh` | 31 passed |
| `bash scripts/__tests__/test-deploy-generalized.test.sh` | all passed |
| `bash scripts/__tests__/test-deploy-multilead.test.sh` | 29 passed |
| `bash scripts/__tests__/fly1663-qa-launchd-mutants.test.sh` | 11 passed |
| `bash scripts/__tests__/codex-home-reconcile-cadence.test.sh` | passed |
| `node --test scripts/__tests__/fly2655-voice-room.test.mjs` | 15 passed |
| `bash scripts/__tests__/test-deploy-qa-room.test.sh` | 19 passed |
| `pnpm lint` | exit 0；26 个 warning（诊断不在本单改动文件），无 error |
| `pnpm --filter "flywheel-teamlead..." --filter "flywheel-claude-runner..." build` | 13 个 workspace package build 通过 |
| `git diff --check` | passed |

最终没有 TypeScript diff，因此 owning-package `vitest related <changed-ts-files> --run` 不适用。本机没有跑 full package suite，也没有请求 ordinary-head full CI。

## 消费者枚举

对五个实现文件分别以 repo-relative 完整路径、basename、parent directory 执行了 `git grep -lF`。保留并运行了上表中所有直接读取 deploy、artifact helper、slot contract 或受 full-access 默认切换影响的测试。

以下 test match 逐项排除：

- `fly1679-dev-channels-v2.test.sh`：只验证 Claude dev-channel dialog/poller，不消费 Codex outbound 或 carrier 坐标。
- `qa-fly-2456-dry-run.test.mjs`：只验证 dry-run 命令扫描器，`test-deploy.sh` 仅作为静态输入来源。
- `qa-lead-coordinates.test.sh`：只调用未改动的 coordinate serializer；artifact helper 新增函数由 `qa-codex-lead-layers` 覆盖。
- `qa-room-env.test.sh`：只测试未改动的 `qa-room.sh` 纯 helper。
- `test-auto-approve-identity.test.sh`：只核对 approval/identity 字节哨兵，与 outbound/carrier 无关。
- `test-deploy-discord-pointer.test.sh`：只核对 mirror Discord plugin pointer guard。
- `test-deploy-preflight-github.test.sh`：只核对 GitHub REST preflight。
- `test-qa-executor-529-nton-contract.sh`：只核对 QA role prompt 的 N-to-N 文本契约。

其余 parent-directory 命中是生产源码、文档、fixture 或非测试脚本，不是可执行测试消费者；完整路径/basename 命中的直接部署测试已在上表保留。

## 生产不变与 secret 边界

以下 `origin/main` 与实现头 blob SHA 完全相同：

| 文件 | blob SHA |
|---|---|
| `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh` | `c4bb144420f300e5c1a4ad9e8f0c6d1fcb6c547f` |
| `scripts/flywheel-lead.sh` | `c13b6566f2a455f8d92b546b89ee6333bcef9e0a` |
| `packages/teamlead/scripts/run-codex-infra-bot-tui.sh` | `2c9c0404f78b9ffe36c2c514aa6c768c9d6a4e65` |
| `packages/teamlead/src/bridge/lead-inbound-attachment.ts` | `1de573ced90af0413208d7dab3be962058d06e43` |
| `packages/flywheel-comm/src/lead-lease.ts` | `1c3b65556d9baa6258ab65472847f7023a5229b6` |
| `packages/teamlead/src/bridge/plugin.ts` | `c68e148cf3fb2c81ccaa213fc8634b828932903e` |
| `packages/teamlead/src/bridge/fleet-data.ts` | `b8c8176c364745a9b33c30d84dd5c0bc0f1e9be5` |
| `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts` | `c22311fcc821bf458d0a373f4a0393e7776113bc` |

新增日志只报告 token presence/length；runtime 证据把 token 写成 `[present]`。diff secret 扫描唯一的 literal token 是单测固定值 `fixture-api-token`，没有真实 credential、raw carrier claim 或 token value 进入 argv、日志、JSON 证据或文档。
