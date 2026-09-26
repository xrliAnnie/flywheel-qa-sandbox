# FLY-2910 告警叫醒去重 — 实现验证
Issue: FLY-2910 (https://linear.app/geoforge3d/issue/FLY-2910)
日期: 2026-09-26
基于: plan.md、evidence/replay-reconciliation.md

## 实现与恢复范围

按已批准的 v2.2 执行，plan blob 为 `b31ba94ad1d98ae7deed84598f9664078638c5c1`。本次从 rescue commit `0e26db8a64e7e85d523e19557cbcd840eb388f7f` 恢复；设计 R5 复核记录在 `47006755d`。核对源码后确认步骤 1–8 的实现与已采集回放均在 WIP 中，初次恢复没有修改生产代码；下方 R1 修订记录覆盖后续评审修复。

验证时 HEAD 为 `577c4fb35b0e33c5389f99052f108f73ec5a6203`；相对 rescue commit，生产源码和测试字节没有变化，新增的是设计复核、进度与本验证证据。最终 PR 的 gate/CI 绑定最终提交，由 controller 和 GitHub 记录。

## 本机验证

只运行下面的 19 个相关测试文件，没有运行整包或全仓测试。`evidence/test-consumers.json` 保存每个 changed TypeScript 文件的全路径、文件名、父目录三次 `git grep -lF` 查询（共 63 次）、所有排除理由、19 个保留文件及精确 `vitest related ... --run` 命令。临时配置保留原始 setup/env/pool，明确限定 include，移除会扩大范围的 projects，并排除 `**/tmux-viewer.macos.test.ts`。

| 检查 | 结果 | 日志 |
|---|---|---|
| `pnpm lint` | exit 0；25 个既有 warning，无修复 | `/tmp/fly2910-lint.log` |
| `pnpm --filter "flywheel-teamlead..." build` | exit 0；13 个包，包含本次 config/comm/teamlead 及依赖 | `/tmp/fly2910-resume-build.log` |
| config related | 5 文件，145/145 通过 | `/tmp/fly2910-resume-flywheel-config-related.log` |
| flywheel-comm related | 2 文件，53/53 通过 | `/tmp/fly2910-resume-flywheel-comm-related.log` |
| teamlead related | 12 文件，336/336 通过 | `/tmp/fly2910-resume-flywheel-teamlead-related.log` |
| API 下游 typecheck | 12 包均已通过，见下方预检说明 | `/tmp/fly2910-resume-typecheck.log`、`/tmp/fly2910-resume-typecheck-final.log` |
| `git diff --check` | exit 0 | 当前工作区 |
| 与 `origin/main` 的合并探测 | `git merge-tree --write-tree --name-only HEAD origin/main` exit 0；main=`dcc7142e2` | `/tmp/fly2910-mergeability.txt` |

依赖预检：恢复后的工作区没有安装包内依赖，第一次 build 在 `node:*` 类型/依赖解析处失败；`pnpm install --frozen-lockfile` 后上表 build 通过，锁文件未改。下游命令为 `pnpm --filter "...flywheel-config" --filter "...flywheel-comm" --filter "...flywheel-teamlead" typecheck`，11 包通过后 voice-codex 因缺少 voice-bridge 的 dist 声明失败；`pnpm --filter flywheel-voice-bridge build` exit 0 后，只重跑失败包 `pnpm --filter flywheel-voice-codex typecheck`，exit 0。没有通过修改产品代码或放宽类型检查解决预检。

本次没有新增 `scripts/__tests__/*.test.sh`。新表的两个 retention fragments 由 `fly-2413-retention-registry.test.ts` 验证；`protectedCurrentOrReference` 的分类原因是自身在送达记录事务中按 48h、每次最多 200 行清理，pending 摘要不删除。请代码评审同时确认此分类。

## 需求与失败边界

| 要求 | 可执行证据 |
|---|---|
| 同 Lead、6h、已送达等价、同代才合并 | alert-wake-dedup + lead-inbox-runtime：真实 enqueue/upsert → adapter receipt → 第二次 fire，ACKED/audit_only，adapter 只调用一次 |
| 升级、新对象、新要求、数量变化叫醒并标累计 | policy 测试覆盖 severe、session、issue、requestId、action、12→13/24；同批次累计、固定 6h 与 6h+1ms |
| 不同 Lead / kind 隔离 | policy 与 StateStore 测试 |
| info 摘要及带待办例外 | info 不调用 adapter；下一告警附摘要；flag_scan_handoff 保留叫醒；10 行上限和取后清零 |
| 项目 flag 默认开、关即恢复 | registry/store/drift/route guards；项目优先级与非法值/读取失败返回 false；policy off 不读去重证据并回到原有投递 |
| 新 schema、重启、回放幂等和事务回滚 | StateStore 测试：旧库迁移、重启、两载体 A→B→A→B 只记两次、证据写失败同时回滚 delivery marker、摘要事务回滚 |
| 不吞待办及未知形状 | 不同 requestId 不合并；未知/plain/非 dispatcher/无代次照投；截断仅信任 zombie 完整集合签名 |
| 投递失败、owner fence、冻结重投 | runtime/loop/queue 测试：receipt 前失败不立证据；丢 fence 不结算；重验证失败后原冻结批次照投；审计日志失败回滚；ACKED 按原归档路径清理 |
| 固定页与既有告警链路 | alert-duty-router 测试验证 wakeDedup；alert-threads-tickets / infra-alert-wiring 保留原账本、工单、路由行为 |

红绿证据继承原实现：`evidence/storage-evidence.txt` 保存 storage 的 13 red → 13 green；恢复时还核对了原临时日志中的 policy 8 red、integration 13 red，以及 Discord 信封和自动前缀各 1 red。上表 534 green 是本次新执行结果。此次恢复没有新行为修改，未重复原开发步骤。

本变更为 backend / JSON board 字段，没有新增渲染界面，视觉截图不适用。

## 真实序列回放交接

按 Lead 重派说明保留已采集的明确时间窗，`coverageComplete=false`。采集时刻 `2026-09-26T05:40:11.899Z`，最后观察行 `2026-09-26T05:40:04.716Z`；请求的完整窗口是 PT 9-25 整天（UTC 07:00–次日 07:00）。完整整天回放留给 QA。

| 口径 | 改前叫醒批次 | 改后 |
|---|---:|---:|
| 已采集窗口，真实可用代次证据 | 202 | 178 |
| 已采集窗口，假设同关联键同代（未验证上限） | 202 | 148 |
| 设计冻结窗口，真实证据 | 152 | 134 |
| 设计冻结窗口，假设同代 | 152 | 107 |

工程 Lead 在已采集窗口为 **15→15**；不同 review 请求继续叫醒。不能把上限估算当成真实去重收益。

R1 修复前 `StateStore.ts` 和 `alert-wake-dedup.ts` 的 SHA-256 与 `evidence/replay-real.json.productionCodeSha256` 完全一致。本次重新检查了各 Lead 的 before/after 批次合计，以及全部 59 组已送达等价证明（已采集 32 组，冻结对照 27 组）：同 Lead/指纹/代次、等价信的回执早于合并判定，固定窗口不超过 6h。完整决策与证明在该 JSON；相对设计估算 102 多出的 5 次叫醒来自当时尚无 adapter 回执，逐条解释见 `evidence/replay-reconciliation.md`。

初次复核没有重新打开或复制生产数据库；R1 重跑见下方。回放脚本原先只读打开来源 DB 并关闭 handles，counterfactual 写入仅在内存 StateStore。

## 剩余流水线边界

本地相关验证与回放核对已完成。推送、PR、有效代码评审、当前 HEAD 的 scoped CI、`complete --route needs_review` 依次由注册流水线记录。普通实现 head 不请求 full CI；完整 frozen-head `CI OK`、全天回放和 QA 验收由 QA 负责。此记录不表示已合并、上线或交卷成功。

## R1 评审修复（2026-09-26）

代码评审 request `57475e9a-4eb2-4a7d-85a6-00b49498ea0f` 在 `dff5eb79e4d1224287e31979e4aff2c2166c9fb0` 返回 CHANGES_REQUESTED。结构化结果见 `review/code-review-round1.json`。

HIGH `lease-requeue-self-suppression` 已复现：ACK lease 过期清空 batch_id 并递增 lease_retry_count，但 retry_count 仍是 0；新批次会把尚未 ACK 的原信与自己的送达证据合并。最小修复是在 AlertWakeDedup.revalidate 的入口对 lease_retry_count>0 返回 null，保留原投递及 ACK 义务和已物化的正文，不再累加合并/摘要计数。

新增两载体 A/B 的真实 MailboxQueue+LeadInboxLoop 测试，先在原代码上 2 failed，再修复为 2 passed。测试经过每次默认 30 分钟 ACK lease 及全部 3 次重投，证明原 delivery_content（含摘要）不变、acked_at 仍为空、计数只记录一次，最终保留 lease_expired_unacked 的 DEAD 路径。红绿与相关测试原始输出已保存 `evidence/review-r1-tdd.txt`。

本次修改生产 TS 与测试 TS 的 owning-package `vitest related`：alert-wake-dedup、lead-inbox-runtime、infra-alert-wiring 共 3 文件 / 96 测试通过（`/tmp/fly2910-r1-related.log`）。原始 19 文件 / 534 测试基线继续适用，新测试增加 2 项；并未把未重跑的初次结果冒称为修订后全量重跑。`evidence/test-consumers-review-r1.json` 保存这次变更的全路径/文件名/父目录 9 次查询及每个匹配的排除理由；回放 TS 为文档证据脚本，直接执行而非 package 测试。没有导出或类型变化。

R1 重跑回放使用当前源码、只读来源查询，在 `2026-09-26T07:27:38.723Z` 采集，将 created_at 明确限定在 UTC `[2026-09-25T07:00:00Z, 2026-09-26T05:40:11.899Z)`，`coverageComplete=false`。结果保存 `evidence/replay-review-r1.json`：真实可用代次证据仍 **202→178**，假设同代口径 **202→149**；冻结对照仍 **152→134**，假设口径 **152→108**。当前生产 SHA-256、各 Lead 合计与每个证明对的送达先后/6h 边界已验证。工程 Lead 仍 **15→15**。原 `replay-real.json` 保留为历史采集，不能宣称旧 hash 是当前源码。

假设口径增加 1 次叫醒来自 `infra_alert:claude-infra-bot-lead:zombie_session_backlog:zombie-backlog:b44bbf80d3229cc7:1790362951115`：它是 ACK lease 重投，因此由 suppress 改为 frozen_retry。旧采集与新采集之间当前线程映射可能已变化，6 条 Discord 消息的理由由 no_delivered_equivalent 变为 unprovable，仍全部叫醒；本次只对相同 created_at 窗口比较，不声称两次 DB 快照完全相同。新的 verified 口径没有可证明的重复合并，24 批减少均为 info 摘要；hypothetical 的 31 组等价证明仍是未验证代次的估算。

两个 LOW advisory 留给 Lead：`suppress-counter-before-settle`（跨库结算失败时摘要/计数可能先增加）、`unrecognized-counter-unexposed`（未识别计数未对外暴露且混有非告警）。它们不阻塞评审，本次未扩大修复范围。

R1 最终验证：`pnpm lint` exit 0（25 个既有 warning，`/tmp/fly2910-r1-lint.log`）；`pnpm --filter "flywheel-teamlead..." build` exit 0（`/tmp/fly2910-r1-build.log`）。检索保留的 config read-site/registry/store-policy 3 文件 / 92 测试也通过（`/tmp/fly2910-r1-flag-contracts.log`）；加上 teamlead 3 文件 / 96 测试，本修订共重跑 6 文件 / 188 测试，全部通过。初次验证中的 API 下游 typecheck 无新类型/API 变化，不重复扩大验证。`git diff --check` exit 0。
