# FLY-2654 Lead 有条件自决 — 调研
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-20
基于: exploration.md

## 2026-09-20 当前有效结论

最新 Lead 回复（问题 5ac555cf-0161-4373-a403-2d7a35238017）要求保留 founder“不再逐次授权”目标：禁用条件消息授权解析，但以两项带 a/b/c、审计和独立 activation 的 standing carve-out 替代，只有前提缺失才回原授权路径。Raya 正常合入后下一班车自动带上，不解析任何消息。当前精确方案见 plan.md；旧 Part B 关闭和现有代码保留。

本轮源码确认 R1 仍保留逐 SHA canonical_line，R4 当前仅接受当下指令，updater 已有成功 urgent 后 Raya pass；这些是待增量对齐的实际消费者。Codex lead-turn-evidence 仅 model/effort 证据，不能冒称已证明规则加载。新 activation verifier/独立确认/不可变执行包尚未存在，本计划明确列为实施任务，不能以静态设计替代上线证据。

下方探索/调研已被后续裁定替代，整体保留为历史，不是当前设计规范。

`````text

最新状态：Lead 指令 ec106d4d-6c4b-4507-a164-73bcef60a2e3 确认 founder 20:29Z 拍板 FLY-2679 迁仓；Part B 已关闭并由该 Epic 取代，历史原文保留。

## 当前范围更正（优先于下方历史探索/研究）
Lead 于问题 3262d907-45d1-446c-9fcf-7edc13d3073b、4c50f935-1aec-489b-868f-ee050a68ceab 连续裁定：本次 Part A 仅做 R4 条件式 founder per-instance 指令的 reading guide + 真实 Lead 归因与审计，不新增 standing 权限或 activation。原 Raya 与三条件收尾 standing 方案完整保留在 plan.md Part B，暂停等待 founder 架构决定。下方技术审计为历史证据，不是当前启用范围。


## 结论
现有两条执行链都需最小适配。规则是唯一授权语义来源；代码负责拒绝不匹配的证据、保留归因。当前没有发现可复用的 AUTH-CANON activation manifest 执行器，不应声称该机制已上线。

## 已读的一手仓库证据
| 文件 / 位置 | 事实 | 设计后果 |
|---|---|---|
| `packages/teamlead/lead-rules-base/founder-only-authority.md:96` | Raya deploy 需 v2 receipt、同 activation、多项业务证据 | 放权不能降低上线验收 |
| 同文件 `:110` | 首次切换硬要求逐 SHA 授权行 | 替换该段，普通 merge 主体保持 |
| 同文件 `:427` | R3 仅 auth-expired 的原位自愈 | 不把新例外伪装成 R3 |
| 同文件 `:475` / `:510` | updater 两种触发来源；每个紧急票 fresh founder | 更新发票主体，不新增运输通道 |
| 同文件 `:615` | 新 entry 必须 landed commit、部署、live bundle、独立 confirmer 单一 manifest | 生效证据不能靠设计作者签字 |
| `packages/teamlead/src/bin/raya-migration-manifest.ts:14,50` | authorization 类型固定 granted_by=founder；校验完整 canonical 行 | 保留 v1 兼容，增加区分 Lead standing 的分支 |
| `packages/teamlead/src/bin/raya-migration-init.ts:258,332` | 读取 Discord 原消息验证 founder 后写 manifest | 新分支不能继续把原消息当逐 SHA 许可 |
| `scripts/lib/updater-raya-deploy.sh:221` | shell 再验 founder 行与 target 相等 | 所有 stop consumer 必须支持相同权威验证结果 |
| 同文件 `:707` | P7 后 standard-update 已 fetch origin/main 并要求祖先关系 | 复用已有后续事务，不另造班车 |
| 同文件 `:839` | P2 先授权、旧 owner、fetch、scratch build、quiet-check，之后才停旧体 | 自动更新只能在未产生 stop intent 前；变化使准备证据失效 |
| 同文件 `:188` | manifest transform 使用 digest compare-and-swap + atomic replace | 沿用锁与原子更新，不能手改目标 |
| `scripts/request-restart.sh:76` | schemaVersion=1，kind 固定 founder-urgent-restart，四字段票 | 新 Lead 模式需要真实 provenance；默认旧路径保留 |
| `scripts/update-flywheel.sh:397` | consumer 严格校验四个 keys；目标只要求是 main 祖先 | producer/consumer 必须同版本；Lead 波次需明确目标漂移策略 |
| 同文件 `:442,493,614,724` | 先 claim，失败告警且不自动重试；urgent 不运行 Raya shuttle | Raya standing 不隐含 urgent 权限；故障不能盲目重发 |
| `packages/teamlead/src/lead-capabilities/rule-sources.ts:278` | engineering rule bundle 包含 authority 文件 | 必须核对运行 Lead 实际加载，而非磁盘上存在 |

## 消费者清单
- 规则加载：`lead-capabilities/rule-sources.ts`；`lead-rules-bundle.test.ts`、`rules-bundle-truth.test.ts`、`fly2567-rule-budget.test.ts`。不改普通 R1/R2/R5 行为。
- Raya：migration manifest/init/shuttle/resolve，updater-raya-deploy.sh 的授权、prestop、P7 后续事务；v2 receipt 和 proof 消费者必须保留同 activation 与冻结目标约束。
- 紧急票：request-restart.sh 写票、update-flywheel.sh strict parser/claim/deploy/alerts；`scripts/r4/r4-window.sh` 只查队列为空与调度配置，本次不增加新队列。
- 测试：`raya-migration-manifest.test.ts`、`raya-migration-init.test.ts`、`raya-migration-shuttle.test.ts`、`raya-prestop.test.sh`、`updater-raya-deploy.test.sh`、`request-restart.test.sh`、`update-flywheel-sources.test.sh`、`updater-trigger-policy.test.sh`。

## 持久化与外部边界
Raya manifest 已使用 deploy.lock.d 和 digest CAS；quiet/stop 窗口数据与迁移游标不得因 main 更新重置。紧急目录是 updater 队列，受理不等于重启完成。原始 Discord message id + channel id + authenticated author + content digest 是引用基础；文本中的 founder 字样不是身份。数据库读取若需要生产副本只能使用受管 snapshot 工具；本设计没有读取或复制生产 DB。

代码采用参数化 execFile argv、严格 parseArgs 和局部文件形状检查；新验证不得拼接 shell 或 SQL，不信任环境变量声明的 actor。相同 Unix UID 的模型可写文件，owner/mode/digest 只证明字节未变，不证明签发人有权。因此 activation/decision 必须链接独立可复核的原始记录，不能以本地 JSON 自我认证。

## 验证边界
本研究是静态代码审计，未部署、未发票、未重启、未认定任何新 carve-out 已激活。不需要外部网页研究；事实来自当前检出的源码与用户给出的任务。历史说明仅作为查找线索，当前源码优先。

## 当前裁定补充
Lead 已确认最小消费者适配，并明确 urgent 成功波次也必须执行 Raya pass（问题 4e5d3043-2ab5-4cbc-9723-8e292eb98a93）；现有 urgent skipped 是本单必须修正的差距。`restart-services.sh:345` 的 admission pause 有 owner lease，但仅阻止新 admission，不能作为现有 Runner 静止证据；计划明确这项限制。

## 首轮评审复核后的补充
已读 `founder-local-time.md` 与 `packages/config/src/founder-timezone.ts:88`：LA 只是 fallback，不是固定 founder 时区。已读 migration-init 的重建写入路径：authorization mode 迁移不能复用 init/resume-from-failed；必须原地 transform 保留 unresolved/cursor。已读 shuttle 的 prestop intent 退役分支：目标刷新必须设置 prestop_retry=true，未知发送结果仍保留对账。
`````
