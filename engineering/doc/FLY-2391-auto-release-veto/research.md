# FLY-2391 默认发布与否决 — 调研
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-14
基于: exploration.md

## 结论

本次以工作树基线 `579c79ed6` 为事实来源。B0 已提供完整身份合同，B1 已有窗口前 prepare 与窗口后零构建 commit，B3 已有即时三态判断，B5 已有撤版与客户端止血。缺少的是将这些能力连接起来的耐久周期、真正可用的否决入口，以及执行时授权；不能把已有脚本加一个 cron 就称为 B4。

采用 Bridge 专属 release cycle 账本。窗口内的动作与健康故障写入和最终授权 claim 使用同一 SQLite 事务边界；GitHub 在真正准备提交时才通过 endpoint 的窄控制信箱请求授权。Bridge 不持有 customer-release 凭据。manifest 形状保持 B0 v1；控制信箱只是耐久传输，不能自行产生授权。

## 代码与消费者审计

| 代码位置 | 当前事实 | 对 B4 的约束 |
|---|---|---|
| `packages/release-contract/src/identity.mjs:18` | deriveBetaCandidate/deriveReleaseArtifact/deriveVetoBinding 严格派生双身份 | 复用导出，不镜像 semver/hash 语法 |
| `packages/release-contract/CONTRACT.md:198` | VetoBinding 六字段；决策由 Bridge 保存，不入 manifest | cycle 额外身份留 Bridge，manifest schemaVersion=1 不加字段 |
| `scripts/release/payload-promote.mjs:198` | prepare 从 beta entry 取 commit，检查 checkout；规范化版本戳后逐文件等价；上传回读后 prepared | 窗口必须等 prepared；重试 prepared 的 prepare 仍会构建，不能用于窗口后恢复 |
| 同文件 `:364`, `:435` | commit 零构建、流式验 hash、每次 CAS 重派生；已 committed 同 releaseId/hash 零写返回 | 不重建、不替换候选；ETag 变化每次重取授权 |
| 同文件 `:632` | abandon 不允许撤销 committed，abandoned 终态 | veto 后旧 releaseId 不可复活；手动 go 需要新 op 和新完整绑定 |
| `packages/payload-endpoint/src/handler.mjs:78`, `:283` | bearer capability 控制 diff；最终 R2 etag CAS；无 B4 检查 | 增加只准提交已授权 artifact 的执行能力；旧 customer 管理能力不得交给自动任务 |
| `packages/payload-endpoint/src/transitions.mjs:110` | tuple write-once，C-6b 要求 commit 时 beta active | founder go 不能绕过 |
| `.github/workflows/payload-promote-commit.yml:46`, `:51` | 全局 payload-release 排队、main-only、environment release | 自动入口独立；不能假设 COMMIT 文本或 environment 名本身是 founder 授权 |
| `packages/teamlead/src/bridge/plugin.ts:5224` | 启动主动删除 FW_CUSTOMER_RELEASE_TOKEN | 新能力不把这个 token 放回 Bridge |
| `packages/teamlead/src/bridge/beta-release-store.ts:21` | 使用 StateStore 原生 better-sqlite3 连接、唯一 occurrence 与状态条件更新 | release 单独建表，沿用同连接事务模式，不复用 beta cadence 游标 |
| `packages/teamlead/src/bridge/beta-release-runtime.ts:27` | 每次读取真实 localDeployedSha | B6 无关；B4 不将 main HEAD 当成已 soak 的 beta |
| `packages/teamlead/src/bridge/release-readiness/subject.ts:10` | B3 subject={baseVersion,sourceCommit} | 用 frozen beta 对应 subject，再以 B0 full binding 关联最终 artifact |
| `release-readiness/service.ts:24`, `routes.ts:119` | collect 即时读 DB、deployed SHA、outbox；evaluate 追加 verdict | 用显式 subject；不使用默认 GET、本机新 HEAD 或旧日报 green |
| `release-readiness/evaluate.ts:146` | 必须是当前已部署 source 与开放 episode；unknown 优先于 hold | 新 beta 只排队；实际部署切离 frozen source 会触发取消，不能默默沿用旧健康 |
| `StateStore.ts:4608`, `:4628`, `:4663` | verdict 耐久；down 粘住；成功 scan/bug health 可覆盖旧错误 | 需要在负面源写入事务内追加失效事件，防止轮询错过瞬时 unknown |
| `release-readiness/ingest-rider.ts:117`, `:161` | heartbeat 和 founder 双 emoji 全分页扫描，错误记账 | 复用 B3 健康；artifact veto 独立，不借 day/subject 的 thumbs-up |
| `release-readiness/report.ts:8`, `routes.ts:37` | HTML 转义、512 KiB 限制；报告当前 subject | 加只读 cycle 展示，不能让日报渲染触发开窗 |
| `scripts/release-readiness-report.sh:32` | day/subject publication intent→published 有 messageId | 该 receipt 缺最终 hash，不能复用为 B4 veto notice receipt |
| `approval-signal/canonical-founder-id.ts:24` | owner 与 consent id 冲突返回 null | 复用唯一 founder 解析；动作名称/模型判断不构成身份 |
| `founder-thread-notifier.ts:27`, `:73` | posted/posted_ambiguous/failed，存在成功但 messageId 缺失 | 专属 notice 接口必须区分投递尝试和可验证送达 |
| `approval-signal/founder-reaction-approval-handler.ts:135` | ship 反应依赖 durable card binding，写 ship gate | 仅借鉴绑定模式，不调用 ship write helper |
| `lead-backends/codex/CodexDiscordGateway.ts:62` | 现有 Codex inbound 是 message 接口，不接按钮交互 | B4 需要 vendor-neutral release interaction Gateway 接入，不能假装已有按钮支持 |

## 数据流与失败边界

1. 配置到期 → 唯一 cycle → 从 active beta entry 冻结身份 → B3 对同 subject 判定。
2. B1 prepare → clean 包等价、不可变 staging、回读 hash → deriveVetoBinding。
3. 单次 notice 意图 → Discord 实际消息 + 配置 founder 可访问频道确认 → receipt → 开一次窗口。
4. Gateway 按钮事件 → 校验 app/guild/channel/message/founder/customId → 同事务写 action 与周期取消 → 才回「已拦下」。Bridge/Gateway/scheduler 失联使尚未授权周期取消。
5. 到截止后，零构建执行器先验 artifact，生成绑定当前 manifest ETag 的提交尝试；Bridge 即时判断并 claim；窄执行器消费短时许可，完成 B1 CAS。
6. 超时不是未发布证明；重查 releaseOps/entry/full tuple。只有 manifest committed 才投影发布成功。三本账的网络投影可重试，不能反向驱动再次发布。

### 为什么需要显式的两个时点

SQLite 的授权 claim 是「本次动作已不可再当作窗口否决」的时点；R2 CAS 才是「客户可见发布」的时点。不同系统不能假装有共同事务。claim 必须晚于窗口截止，并与所有已耐久接收的 veto/失效事件串行。许可一旦暴露，后来消息不能靠删除另一份控制文件保证撤销；此时报告「提交中，结果待核对」，不能回「已拦下」。未 claim 的窗口取消不可逆；claim 后未知结果只恢复同一尝试，不再发放新许可，必要时走 B5 withdraw。

## 外部资料核对（2026-09-14）

- [Discord interactions 接收与响应](https://docs.discord.com/developers/interactions/receiving-and-responding)：按钮可经 Gateway 接收；初始响应需在 3 秒内。B4 先同步 durable action，再答复，处理超预算则取消周期并报告失败，不能先答成功再写 DB。
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)：安全 WebSocket 提供事件与心跳。v1 新建专用 release app 的最小 Gateway 接收器，不借某一 vendor Lead 的生命期。
- [Discord Message](https://docs.discord.com/developers/resources/message)：发送可带 nonce/enforce_nonce，但不能用服务端有限时去重替代本地一次性 notice 意图。模糊 POST 只查回原消息，不发第二张窗口卡。

上述资料只支撑传输选择；未做真实 Discord 按钮、R2 或客户机验证。所有 URL/消息正文/标签都视为外部输入，校验边界并在 HTML 转义；运行时仅 textContent/value。

## 现有证据的实际层级

- `engineering/doc/FLY-2541-b3-reader-activation/implementation.md:58` 明确需后续真实 beta + Actions URL + occurrence source + publishedSourceCommit + B3/localDeployedSha 对齐。当前合入 reader 不能替代生产证据。
- `engineering/doc/FLY-2392-customer-auto-updater/implementation.md:77` 有 handler/npm-packed shell E2E 与 SIGKILL 恢复；使用 fixture supervisor，不等于真实客户服务验收。
- B5 合同 `CONTRACT.md:292` 说明旧 presigned URL 最多仍有效 60 秒；quarantine 不召回已下载字节。B4 的窗口前否决不能以事后 withdraw 冒充。
- 本次只做静态审计，未执行实现测试或任何生产发布。激活清单必须逐条收真收据。

## 测试落点

沿用 StateStore/Bridge 的 vitest、endpoint 的 node:test 和 shell pipeline 的确定性故障注入。`packages/payload-endpoint/__tests__/memory-bucket.mjs:113` 的 beforePut 可验证 CAS 交错；不要用 sleep 凑时序。新增窗口全转移表、source fault 事务、Gateway replay、授权信箱、过期/变 ETag、丢回包、恢复、迁移与 rollback 负例。

已有回归：release-readiness-{evaluate,service,rider,routes,report}.test.ts，StateStore.release-readiness.test.ts，payload-promote-controls.test.mjs，payload-promote-argv.test.sh，release-workflows-structure.test.sh，payload-release-pipeline.test.sh。

## 非阻塞问题

Lead question `b476568a-56e9-492d-890c-f669a1ce814e`：窗口具体钟点/发布日。未收到决定前不填写生产值；配置缺失拒绝激活。本次 mandate 已授权研究与实施计划，使用注入的 design-review gate，不另开通用 skill 的 brainstorm/research 人工 gate。
