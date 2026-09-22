# FLY-2669 班车失败可见 — 评审后续项
Issue: FLY-2669 (https://linear.app/geoforge3d/issue/FLY-2669/班车告警-班车里任何一个-lead项目的部署步骤失败或被跳过必须当场在频道告警并挂到固定页不许静默raya-仓-10-天每班-prestop)
日期: 2026-09-18
基于: plan.md

R2 effective reviewVerdict=APPROVED，request `f21ab753-cde4-41c0-8f5e-dbe5223892ea`，question `cef0cde6-ca8a-473a-8fd5-fabbf4aff6f2`。以下是非阻塞建议，交 Lead 选择处置；不重开设计，不声称已实现。

| findingKey | 级别 | 后续建议及证据边界 |
|---|---|---|
| shuttle-primary-route-send-capability-unproven | MEDIUM | 上线前用 channel-permissions.ts 的 computeChannelPermissions 只读核实际 sender 对工程频道的 VIEW_CHANNEL/SEND_MESSAGES。route-audit.json 仅证明配置可解析；未证明可发、未发真实消息。 |
| no-fanout-cap-for-correlated-mass-failure | MEDIUM | 评估群体故障时的每班汇总/扇出上限；不能静默丢单元告警或跳过去重预算。当前方案逐单元告警可能产生一批频道消息。 |
| kind-contract-and-hub-ticket-posture-undecided | MEDIUM | 实施时补齐 kind-contract.ts 的 owner/arc/informational 选择及 kind-contract.test.ts，必须满足已批准的不创建自动修复工单、不重启的边界。 |
| primary-route-identity-hardcoded-in-code | LOW | 将当前明确的基础设施 Lead 身份迁成配置的后续选项；本版依 Lead 当前裁定解析 flywheel/flywheel-eng-lead。 |
| route-resolution-two-faces-no-drift-guard | LOW | 同一 production-shaped fixture 同时跑 shell 和 TS resolver，断言返回相同 project/lead/channel，防两侧漂移。 |

图形边界：两张 Mermaid 各尝试两次均因本地 Chromium MachPortRendezvousServer 权限失败，按任务合同保留源码和 DIAGRAM PENDING LOCAL RENDER 占位。HTML/controller 验证不等于浏览器视觉 QA。

## 2026-09-18 exact-head review transfer

Review transfer 要求的 4 个阻塞项已在本单修正：`page-shows-healthy-when-shuttle-stale`、`observation-error-suppresses-all-unit-alerts`、`undispatched-intents-silenced-for-utc-day`、`observation-failure-pages-founder-as-deploy-failed`。以下 4 个 MEDIUM 与 8 个 LOW 按 Lead 明确边界不在本单扩展，作为已知缺口/后续保留。

| findingKey | 级别 | 已知缺口/后续边界 |
|---|---|---|
| upstream-skip-fanout-opens-sticky-incidents | MEDIUM | 上游失败的扇出与 sticky incident 收敛策略另行设计；本单不改变已批准的逐单元事实与告警语义。 |
| permission-preflight-transient-failure-not-retried | MEDIUM | 权限预检瞬时失败的有界重试另单处理；本单维持 fail-closed 路由判定。 |
| no-retention-unbounded-ledger-and-export-wedge | MEDIUM | observation ledger 的保留/压缩与导出阻塞治理另单处理；本单不新增清理调度器。 |
| restart-side-producer-untested | MEDIUM | restart 侧 producer 的端到端覆盖另单补齐；本单只覆盖 updater 班车主路径。 |
| inventory-producer-roster-mismatch | LOW | inventory producer 与 roster 的边界漂移另行校准。 |
| bridge-sync-python-delivery-recorder | LOW | Bridge 同步与 Python delivery recorder 的契约一致性另行收紧。 |
| queued-drain-skips-route-recheck | LOW | queue drain 前的路由重检另单处理，避免扩大本单 alert transport 范围。 |
| lead-alert-python3-required-for-all-kinds | LOW | lead-alert 对 Python 3 的通用依赖治理不属于本单。 |
| permission-fixture-env-in-production-path | LOW | production path 中 permission fixture 环境入口的进一步隔离另单处理。 |
| stale-unfinished-cycles-not-reconciled | LOW | 旧未完成 cycle 的自动 reconcile 另单处理；本单只保证新鲜度不再显示健康。 |
| projector-noise-on-hosts-without-updater | LOW | 无 updater 主机的 projector 噪声抑制另单处理。 |
| exact-head-ci-red-preexisting-flake | LOW | `lead-capability-read` 的已知主干 timeout 由 FLY-2714 跟踪；新头若复现，仅按 Lead 指令重跑失败 shard 一次。 |

## 2026-09-18 code review round 1

精确头 `fadbfebd15018310b4429afd1d03ef3e09a8c5b6` 的 code review 唯一 HIGH `raya-workspace-project-repo-permanent-false-failure` 已修：Raya canonical manifest 的 Lead workspace 不再被登记或执行为 `project_repo`，独立 `external_repo` 部署单元保持不变。以下 2 个 MEDIUM 与 4 个 LOW 为该轮非阻塞 advisories，留待后续。

| findingKey | 级别 | 已知缺口/后续边界 |
|---|---|---|
| removed-unit-open-episode-never-retired | MEDIUM | 为删除/改名 unit 增加显式 retire 语义，避免旧 open episode 永久投影；需要单独的数据生命周期设计。 |
| bridge-export-not-readonly-tight-deadline | MEDIUM | 将 Bridge export 改为只读事务并评估 500ms deadline / unavailable 抖动策略；不在本轮阻塞修复中扩大 projector 变更。 |
| bundle-dir-env-sourced-without-prefix-check | LOW | 在 source immutable observer bundle 前增加 state-root/bundles 前缀校验。 |
| legacy-raya-alert-not-delegated-double-notify | LOW | 有 observation cycle 时统一 Raya 旧告警与 shuttle intent，避免部分失败分支双通知。 |
| stale-window-no-tolerance | LOW | 在 12 小时 scheduled slot 上增加明确容忍窗口，避免班次刚开始时短暂显示过期。 |
| drift-since-set-for-non-drift-failures | LOW | 仅在有实际落后证据时设置 driftSince；其他异常单独显示持续时间。 |
| no-manifest-branch-records-excluded-raya-unit | LOW | manifests 全缺失的兜底分支仍会尝试记录已从名册排除的 Raya project_repo；需与名册规则共用同一职责判断。 |
| external-workspace-exclusion-hardcoded-to-raya | LOW | 当前外仓 workspace 排除按 Raya 固定登记实现；未来新增外仓 Lead 前应将 project_repo 职责做成 descriptor 属性。 |
