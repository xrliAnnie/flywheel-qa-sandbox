# FLY-1945 巡检证据与机制缺陷 — 评审建议
Issue: FLY-1945 (https://linear.app/geoforge3d/issue/FLY-1945/巡检体系-仪器假报修复-机制缺陷完成门并-1952)
日期: 2026-09-14
基于: plan.md

首轮有效 verdict 为 CHANGES_REQUESTED，仅 HIGH 阻塞项在本轮修订。以下为服务端标记的非阻塞 advisories，未冒称已解决；完整原文在 review-round-1.json。有效批准后通过指定报告回传 Lead，由 Lead 决定后续工作；本节点不立后继任务、不派工。

| findingKey | 等级 | 后续建议 |
|---|---|---|
| shared-branch-veto-attribution | MEDIUM | 将区间内合法 writer 谓词直接写入唯一 reducer，并增加非 holder 的 head 变化测试 |
| mechanism-dedup-unbounded-candidate-set | MEDIUM | 明确非 Bridge 机制单的专用 label 或 parent 候选集，避免整个项目逐单扫描 |
| coverage-gap-vs-head-veto-precedence | MEDIUM | 明确跨 90 分钟缺口时正向 head 证据与 coverage 重建的优先级 |
| git-ref-path-encoding-slashes | LOW | 明确 ref 中 slash 保留、按段编码，并验证含 slash 分支 |
| unknown-row-legacy-gate-field-shape | LOW | 定义 UNKNOWN 行仍满足旧 last_change_epoch 数字形状的兼容输出 |
| mechanism-id-ordinal-stability | LOW | 将首次 ordinal 显式冻结并校验 finding id 与身份计算的一致性 |

## 第二轮有效批准后的新增建议

有效 reviewVerdict=APPROVED、reviewerVerdict=APPROVED；以下三项为非阻塞建议，保留原设计，不重新设计或重审。首轮六项仍为未处理建议，不因批准而自动消失。

| findingKey | 等级 | 后续建议 |
|---|---|---|
| repo-source-type-in-key-resets-timer | MEDIUM | 同仓同分支的来源类型升级是否应保持原计时窗口 |
| unknown-escalates-whole-step2-under-probe-budget | MEDIUM | 明确探测超时/预算耗尽为 transient，并按真实 pane 数标定预算 |
| registry-root-branch-vs-pr-branch-mismatch | LOW | 后续 PR 分支与 immutable branch 不同名时增加诊断和反证 |

## 代码评审 LOW（Lead 明确留后续）

依据 `[lead-instruction b8a77904-1bc7-4a1b-87b5-475d812a943c]`，本轮不扩大修复范围：

- `missing-observation-fallback-key-mismatch`：collector 缺行兜底的 key 与旧 entry identity 可能不一致；当前真实 collector 为每个 id 返回观测，后续统一 fallback identity。
- `dead-continuity-shell-vars`：旧 TSV shell 变量已不参与写入，后续清理；本轮保持回滚文件字节不变。

## 第三轮代码评审（有效 APPROVED）

Gate `caab0840-f3c2-495e-bf0b-c58f9e6c28e2`，request `123d984f-4380-4da3-b9d2-f47bb79f46ef`，round 3，reviewed head `2fccdc6cd5d2440de374f17647c7a9b24f58157e`；有效 reviewVerdict 与 reviewerVerdict 均为 APPROVED，2026-09-15 重新读取服务端回执确认。

依据 [lead-instruction 27f0dea8-6198-4126-a68e-f6d032464fd6]，以下五项仅记录后续，不修改产品或再次开审；文档更新后等待 PR 新头 CI 绿色再执行 needs_review。

| findingKey | 等级 | 后续建议与当前限制 |
|---|---|---|
| stalled-record-not-required-to-surface-on-a-pane | MEDIUM | 增加 ACTIVITY_RECORD 到 pane 的反向完整性检查；当前修改 pane 的 activity/findings 可隐藏机器 STALLED 声明，机器记录仍可审计。 |
| sidecar-schema-tightened-without-version-bump | MEDIUM | 后续收紧 v2 必填字段需版本迁移或获授权的留证重建；当前坏 sidecar 保留且不自愈。审查时尚无已部署 v2 文件。 |
| collector-tests-use-handrolled-schema | MEDIUM | 增加真实 StateStore/CommDB schema 初始化测试，捕获未来列名和单位漂移；当前测试使用手写 DDL。 |
| helper-failures-collapse-to-one-opaque-token | LOW | 用安全原因 token 区分 CLI 顶层异常，并保留 snapshot 可见诊断；当前归并 helper_unavailable。 |
| lastveto-oldhead-picks-first-duplicate-ref | LOW | 对同 repo/ref 去重或绑定确实变化的旧 SHA；重复 ref 时 oldHead 可能取错，影响证据记录。 |
