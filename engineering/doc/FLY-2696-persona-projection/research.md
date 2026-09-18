# FLY-2696 人设投影 — 调研
Issue: FLY-2696 (https://linear.app/geoforge3d/issue/FLY-2696/raya-并仓s4-persona-投影p1人设留-raya-仓显式-opt-in-contract-启动屏障fail-open)
日期: 2026-09-17
基于: exploration.md

## 代码事实（基线 f0175458414f20f6f82ca7ea12cd6a6f64899eb3）

| 消费者 | 当前行为 | 设计后果 |
|---|---|---|
| `packages/flywheel-comm/src/commands/lead-registry.ts:1148` runSelector | projects.json → compileLeadIdentityRows → 选唯一 project/lead；输出 projectsDigest/projectRoot，未输出 projectRepo | 扩展 selector 必须走 schema 和端到端测试；repo 不是开关 |
| `scripts/flywheel-lead.sh:214` run_manifest | selector/manifest 校验后 compose env，exec Codex launcher | 投影只挂实际 run 路径，不挂 install/register/verify/read-only preflight；缺省不写 |
| `scripts/flywheel-lead.sh:188` | systemPromptFiles 固定 workspace identity | 保持此路径，不迁移 persona 所属仓 |
| `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1196` | stripFrontmatter + trim + join 后得到 baseInstructions，读失败跳过 | 文件 sha256 与提示词 sha256 分开；opt-in 分支必须严格一次读、不能默默跳过 |
| `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:904` | 每代 start 在 connectDaemon 前 requirePersona；目前仅非空 | 在这个消费点验证 raw blob，再由同一 Buffer 派生 baseInstructions |
| 同文件 `:1072`、`:1110` | buildThreadParams 闭包用于 start/resume；后续建立 inbound | 保证同一已验证字符串用于两条线程路径；不能只看环境变量 |
| 同文件 `:1693` | publishCarrierRuntimeAssertion 的 identityDigest 是 registry 身份摘要 | 另命名 personaBlobDigest/baseInstructionsDigest，不改既有身份语义 |
| `packages/teamlead/src/lead-capabilities/default-runtime.ts:173` | v2 从 projectRoot 发现 rules，并由 parent 提供 baseInstructions | S4 首轮显式拒绝 opt-in + capability v2，非 opt-in v2 保持原行为；避免未验证的分叉绕过 |
| `packages/teamlead/src/bridge/summary-presentation-migration.ts:247` | complete 分支早退，不能证明全量 source/disposition 复验 | 不把调用迁移 CLI 成功当 activation 证明；S4 不执行迁移 |
| `scripts/lib/updater-raya-deploy.sh:222` | 旧 FLY-2496 legacy-stop 的授权合同 | 不能把旧 stop manifest 或布尔 granted_by 当新 exact-pin 授权 |

## 负例名册

`fleet-inventory.json` 留 exact project/agentId、repo、文件存在及 tracked 状态。fixture 要模拟这些合法-looking 条件，不能用空项目。生产只读观察不等于已经执行投影器测试。

## 安全与部署边界

网络取源只能读 Git 对象，无 checkout/filter/hooks/submodule。对源 tree mode、目标路径每级目录、普通文件、大小及内容 digest 做验证；fetch 与原子替换失败不能污染旧文件。未知 migration 状态只可停机，不能借回退逃过授权校验。

后继以仓库当前 test scripts 为准执行 flywheel-comm / flywheel-teamlead Vitest，shell launcher 与 packaging/CI enumeration 套件。设计文档验证不替代这些代码测试，也不替代 B5 的真实 summary 证据。

## 双解析路径与分发核验

只读并行审计补充：ProjectConfig.ts 与 flywheel-comm lead-identity.ts 是两个入口；共享 schema 位于实际包 `packages/config/`（包名 flywheel-config）。selector exact-output 测试 `lead-registry-cli.test.ts:343`。`scripts/materialize-lead-manifests.sh:79` 仅物化稳定启动指针，不应复制新合同。`scripts/lib/lead-restart-lifecycle.sh:564` 仅取 selector 子集，additive 字段兼容。QA `scripts/test-deploy.sh:738` 的 identitySource 是另一含义，因此本合同命名 personaProjection。Lead 已指定本 plan §4.3 为 M0-code 的权威接口。
