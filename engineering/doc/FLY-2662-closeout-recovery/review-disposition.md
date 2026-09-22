# FLY-2662 首轮审阅处置 — 调研
Issue: FLY-2662 (https://linear.app/geoforge3d/issue/FLY-2662)
日期: 2026-09-17
基于: plan.md

首轮gate a2993708-bbd4-4036-bffc-9e90138c7ad2，request e059a71b-65c7-461a-9249-d3f8958dddea，effective=CHANGES_REQUESTED。原始结构化结果见evidence/review-round1.json。以下是设计修订，不是实现验收；必须新gate。

| findingKey | 处置 |
|---|---|
| reclose-auth-carrier-only-locks-out-claude-lead | 接受HIGH；核对lead-lease.ts:1455存在窄Claude lease guard，:1590 carrier确为codex-only。§3.1明确两后端proof，Claude不要求codex activation/profile，不迁Lead；双方正向/负向真实guard测试。只读project配置确认flywheel-eng-lead backend未设置（默认Claude）。 |
| legacy-issue-key-makes-park-guard-inert | 接受HIGH；核对root-key no_uuid_mapping与isUuid短路。§3.2新增verified lifecycle identity mapping，不改旧持久key；park/reclose/cancel共享alias锁、canonical guard，无映射不能跳过。fixture明确保留FLY字符串与无UUID初态。 |
| absent-worktree-needs-parent-identity-that-does-not-exist | 接受HIGH；revision2已并入§3.3，revision3保留非破坏性legacy_absence_observation与ENONENT/Git无登记实证，remove/prune/branchDelete为0。 |
| records-closed-after-worktree-circular-gate | 接受；§3.5列physicalReady/worktreesSettled/recordsClosed/archiveReady，目录不再等Comm finalize；非land分支保持原触发。 |
| attribution-revision-owner-row-unspecified | 接受；§3.3指定closeout_attribution_epoch表，run级/legacy issue级共享源epoch、op独立target版本；同事务源变更+epoch，先epoch比较再digest比较。 |
| epoch-trigger-identity-columns-unspecified | 接受；§5枚举sessions五列与declared五列，NULL-safe WHEN，非身份列不递增；execution主键转移双侧增量。 |
| operator-instruction-strings-not-in-rollout | 接受；§10覆盖两处提示、历史outbox文案与CLI自动proof；要求三root消费者sweep和未检查显式披露。 |
| vitest-positional-filter-batch-size | 无需依赖该历史问题是否普遍复现；拆为<=5过滤器的批次且必须记Tests条数，规避零匹配误报。没有宣称已跑源码tests。 |
| owner-deadline-supersede-consequence-unstated | 接受；§6说明活进程无heartbeat可占lane5min/reclose busy；实施新增2616 design-correction附录，不改其已批准原文。 |

同时保留Lead对主死结优先、可拆PR、只读形状重建、不合入2658的裁定。

## 第二轮审阅与revision 4
Gate `cdfc5262-1e62-446e-958f-8e9b2c5deb59`，request `6ebe355f-5633-4162-8e41-75b6e0db25a9`，effective=CHANGES_REQUESTED。原始结果见evidence/review-round2.json。第一轮记录保留为历史；下列合同取代首轮对Claude public lease proof及全局映射的不足。

| findingKey | 处置 |
|---|---|
| claude-lease-proof-forgeable-by-local-runner | 接受HIGH；Lead question 36ccc8fc-46c5-4044-9a0d-92758b15094b选择A：窄Unix socket+OS peer，不新增secret。§3.1绑定kernel peer token/pid incarnation+start、实际Lead祖先链及Runner排除；HTTP拒绝Claude public tuple。明确native模块/打包/失败原因/真机QA，保留主PR。 |
| mandatory-canonical-mapping-blocks-fleet-wide-closeout | 接受HIGH；§3.2强制映射只给reclose，普通ship保持identifierShip/no-key行为；零全库网络backfill，8卡逐个lazy灰度；离线legacy park本地veto、429可重试、不制造不可恢复hold。 |
| rootkey-switch-orphans-legacy-keyed-guard-tables | 接受MEDIUM；§3.2逐表规定disposition receipts、Linear observations、intents、apply claims与legacy veto的alias双读及原始receipt/snapshot不重写，不全局切root；专门旧receipt与canonical canceled/legacy op回归。 |
| claude-lease-claim-extraction-depends-on-lease-mode | 接受LOW；CLI不再从authorizeLeadWrite disposition提取身份，server用kernel peer+当前真实bound lease；mode off不放行无lease，也不排除有效peer。 |

Lead要求：peer/start/chain不明即拒绝；排除Runner树与PID复用；socket0600、父目录属主/无symlink；Darwin真机证据；HTTP不收Claude tuple、Codex carrier不变。全部写入§3.1/8D，未宣称已实现。若主PR因此拖过今天，后继必须带进度回Lead再裁，不能擅自拆掉权限依赖。

## 第三轮批准与实现期裁定

Gate `b508e40d-7241-45e3-8daf-a337b16a89cb` 的 revision 4 effective verdict 为 APPROVED；三项 MEDIUM advisory 是实现期必须显式核对的发布风险，不改变设计批准。实现期 question `c59f76f9-40b6-4d57-a9d6-438c135cda91` 由 Lead 选择 Darwin 源码构建路径 B，处置如下。

| advisory / 风险 | 实现期处置 |
|---|---|
| native peer adapter 无既有 build/pack 先例 | 生产 Mac 只走 main checkout + updater 的本地 Darwin `pnpm build`；native 单元必须可选，缺工具链或故意编译失败时整体 `pnpm -r build`、Bridge 启动及其它路径保持正常，只有 Claude `land reclose` 返回可见的 `peer_adapter_unavailable`。禁止 postinstall 与联网下载预编译物。 |
| CI/发布载荷均为 Ubuntu | Ubuntu 跳过原生编译，但覆盖 TypeScript 协议、拒绝路径、可注入进程链校验。packaged install 缺少 Darwin addon 时一律 fail-closed；Darwin native payload 分发由 Lead 建 follow-up，不在本单偷偷扩发布矩阵。 |
| peer connection timeout 可能包含外部查询 | native 连接只持有有限帧、kernel peer snapshot/revalidation；mapping/lease/scope等外部读取在上层受界限并在提交前重验。任何超时/断链均零恢复提交。 |
| env-only pane discovery 机制未验证 | pending/gone 主线必须以受界限全窗与进程环境清单证明；不能把缺命令行 marker 当 gone。枚举失败或身份不稳定仍 unknown/fail-closed，Darwin真机证据留给 QA。 |

主死结（`:pending`、NULL targets、`closeout_only_run_not_active`）与 native adapter 可用性解耦：Codex carrier 和自动收敛必须照常工作，只有 Claude Lead 手动 reclose 入口受 adapter fail-closed 影响。
