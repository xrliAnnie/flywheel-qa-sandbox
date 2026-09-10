# FLY-2465 Codex 舰队自动切号 — 探索
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465/2371-根治-codex-舰队级自动切号限额信号-按最早重置挑号-切-codex-重起被收的体全池打满才发-founder)
日期: 2026-09-09
基于: 无

## 目标与授权

把 Codex 额度耗尽从「反复换一个仍不能工作的进程」改为「自动找可用账号、验证、恢复受影响任务」。从 Bridge 首次观察到业务号限额起，正常网络、至少一号可用的台架必须在 10 分钟内恢复全部受影响 run，无 founder 介入。账号全部确认耗尽才发一次 founder 告警；不能把网络/身份故障说成额度耗尽。

本节点只交付设计、跨家族设计评审和可评论 HTML，不执行真实切号、重起或部署。Founder 2026-09-09 17:16Z 的自动化直令为功能授权；动态设计节点合同不要求再次申请 brainstorm/research/founder 确认。按完整 DOC-FLOW 产出，其他通用技能的旧目录和额外人审步骤不适用。

## 已审计的事实与题面漂移

- 基线 `227058c73`；Bridge 健康接口 2026-09-09 18:42Z 返回 ok，但运行版本 `7aec15367`，因此源码和部署必须分开验证。
- `runner-quota-scan.ts` 仍为 Claude 文案和检测，默认间隔 60 分钟；不能作为本功能主要触发器。
- `classifyGoalOutcome` 将 `usageLimited` 归为普通失败字符串，缺少可持久化的配额分类和账号代数。
- 当前 `codex-home.ts` 对新建 home 使用规范凭据链接，但已有普通auth文件仍进入覆盖复制兼容分支；生产清点878个旧execution家都是副本，implement keyed家也仍是副本。FLY-2404迁移与目标home验证必须作为生产启用前置，不能把新建源码当作已部署事实。
- 当前 `codex-account-core.mjs` 的 registry 明确只接受 school/personal/business，`personal1/personal2` 为未登记目录；`codex-profile next` 明确退役。新自动化须由 Bridge 协调，不能暗中恢复旧 shell 轮换器。
- 现有账号账本是身份观察，不保存额度 reset；`last_refresh` 是凭据刷新时间，不能据此推算周额度重置。

## 方案比较

| 方案 | 收益 | 否决原因或代价 |
| --- | --- | --- |
| 加强 CLI wrapper，遇到 429 就 next | 改动小 | resident daemon 与 review job 不一定经过 wrapper；每个进程抢写凭据；普通限流误触发 |
| 把 Codex 塞进 Claude 账号切换状态机 | 表面共用 | Claude 独立 reset/凭据/复活语义已复杂，违反不改 Claude 的验收 |
| Bridge 内专用 Codex 协调器，复用身份库与 run 管理 API（选定） | 统一限额事件、探针、原子切换、恢复和审计 | 需要持久化事故/恢复进度与多个真实消费点守卫 |

## 必须解决的边界

1. 信号的账号与生成号取自启动时快照，不能在旧进程迟到报错时读取当前新账号进行归罪。
2. 六具进程同秒耗尽只产生一次 vendor=codex 的 usage_limit；每个 run 都进入同一恢复集合。
3. 先在隔离临时 home 跑一次真实 `codex exec`，成功且身份匹配才原子安装规范凭据。任何失败都不能生效或重起。
4. 暂停配额相关的所有换体/重试入口；暂停状态须跨 Bridge 重启生效。
5. 成功探针后，逐个调用 terminate → start，持久化每一步，网络响应丢失不能重复创建 run。
6. 普通 429、网络故障、刷新令牌失效、用户主动 hold/cancel、Claude 的失败都不是 Codex 额度恢复对象。
7. 自动切号审计与 STEP 2 快照有稳定可读字段，凭据和未经清洗的 provider 输出不出日志。

## 非阻塞问题

Engineering Lead 已在问题 `7bac2cb7-e969-486e-86a4-094c62088a71` 明确确认：仅 school/personal/business，personal1/personal2 保持退役。可用账号按 observed reset 最早排序，相同 reset 以剩余额度更多优先；last_refresh 仅作凭据新鲜度。隔离探针不可扰动在飞进程；探针失败不切、不重起、只告警一次。报告回执 `f2823d09-9b5c-4752-b380-53d3d7ebc189` 已确认采纳。

## 设计验收入口

研究列出真实 consumer 与持久化合同；计划逐条覆盖功能 1–5、验收和 QA 1–4，包含失败/重放/崩溃矩阵。HTML 用本地 Mermaid SVG，每卡评论、跨页隔离保存、意见分段复制与 CSP nonce。最终需设计评审 APPROVED、提交推送、发布并报告 URL，然后 phase_design_complete 和 park。
