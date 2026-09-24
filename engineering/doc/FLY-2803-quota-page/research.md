# FLY-2803 额度页页面改版 — 调研
Issue: FLY-2803 (https://linear.app/geoforge3d/issue/FLY-2803/额度页页面-页面一张单改完spec-e1-e19呈现改版分组排序在用号染绿进度条时间格式-订阅到期显示与手填记确认人时间-e19)
日期: 2026-09-23
基于: exploration.md

## 取证范围与限制

本次读当前代码、测试、已合并产品规格及 #1301 分支文件；GitHub 状态由 `gh pr view` 实查。没有读账号秘密、没有调用额度探测、没有改生产数据。历史 memory 搜索无匹配。本报告中的 2807 真机状态来自派工与其 plan，不冒称本节点实测。

## 入口与消费者

| 代码 | 已核查事实 | 设计约束 |
|---|---|---|
| `packages/teamlead/src/bridge/plugin.ts:1986` | token-auth GET `/api/accounts-page.html`；refresh=1 调既有 observer，随后 buildCapacitySnapshot→buildAccountQuotaView→renderAccountsPageHtml | 只在此读页面手填文件并传页面上下文；不新增远端写接口 |
| `bridge/hook-payload.ts:946` | buildAccountQuotaView 同时供 formatAccountQuotaTickLines 消费 | 页面分组/排序不可改变共享数组或文字摘要顺序 |
| `bridge/account-quota-view.ts:33` | row 有 active/exhausted/unusable/recovery/sortAt，QuotaCell 只有 display/source/observedAt/stale | 新增可选的原始数值/时刻，严禁解析中文 display 回推数值 |
| 同文件 `:198–224` | nextImprovementAt 取最早未来 reset 或恢复时刻 | 页面不能复用 sortAt；保留文字摘要旧逻辑 |
| 同文件 `:802–897` | 格子有来源小字，页尾差异/legend；红绿组合 CSS 明确覆盖绿底 | 页面删除指定说明、重写状态优先级 |
| `bridge/capacity-snapshot.ts:198` | Codex tokenState 把五小时/周任一100合成“打满” | 页面将此单一标签改为“正常”；保留吊销/过期等真实认证状态，底层不变 |
| `codex-quota/codex-account-quota-store.ts:46` | 非秘密 identityKey 可绑定账号身份 | 页面手填不能只凭显示名跨换号继承 |
| `account-heal/account-store.ts:90` | Claude identity 有 email、可选 uuid、setAt | 页面私有上下文可从现有 store 身份生成键；不读 OAuth 凭据 |

## 2807 的接口与冲突

- `account-quota-view.ts` 新 Claude prepaid 与 Codex resetCredits 展示，后者 availableCount 不能用 credits.length 替代，null/[]/截断必须保留。
- 新 `claude-quota/manual-prepaid.ts` 给了固定 stateDir 路径、64KB、同用户 owner、非 symlink/不可组写的 JSON 输入模式。本单复用约束思路，文件和 schema 独立，不能给充值卡文件偷偷加到期语义。
- 新 `account-detail-store.ts` subscription=`active|canceled|unknown`，observedAt；capacity 追加 subscriptionStatus/usageStatus/detailObservedAt。canceled 且 usageStatus 非 ok 时，2807 页面把额度/reset 标为“已取消”，避免展示 9/08 假活跃读数。
- #1301 从旧基线开发：其 account-quota-view 缺少当前 tokenStatus 列，又带 MANUAL_CODEX 固定三号与 fallback active=personal。整文件接受它会退回 2762。必须逐块保留目录枚举、未知 active、token 列与本单新分组。
- 本单不改 rate-limit-detail.ts、observer、store parser、凭据、余额替代卡、refresh 与降级策略。若实现时 #1301 未合入，先做不依赖新字段的页面/手填任务；它合入后把最终依赖验收补齐，禁止把缺失数据接入算完成。

## 页面契约决定

- 周百分比数值决定 upper/full/unavailable；有效时刻决定组内顺序，null 最后，同一时刻 name 作为稳定平局键。stale、active、tier、5h、Fable、cancel 均非排序权重。
- 唯一例外不是排序例外：2807 已判不可显示的旧周数不恢复；缺数组的排序键仍取原 weeklyResetAt（若有效），可显示格子继续保持“已取消”。
- 5h 与周 reset 改页面格式为 `MM/DD 周几 HH:mm`，时区固定 America/Los_Angeles；排序按 ISO 时间戳，不按格式化字符串。DST/跨年要测试。
- 手填日期是 YYYY-MM-DD 的日历日，不经过 UTC→PT 导致退一天；具体时刻没有来源就不造。
- 未取消：订阅到期空白（spec 明示的合法空格）；未知：“未知”；已取消但日期未确认：“已取消 · 日期待确认”；已取消有日期：“已取消 · MM/DD”。日期未确认是已取消的资料缺失，不制造第四种订阅状态。
- 确认记录保留在受控本地 JSON；公共报告不暴露 identityKey、确认人联系方式、原始证据内容。HTML 只展示必要状态与日期。

## 验证策略

设计阶段做文档覆盖、依赖审计、报告本地构建与托管验证。实现阶段先 RED→最小改动→GREEN，跑点名测试；QA 同输入旧/新页面截图、computed style 以及 #1301 实际明细回归。全文测试交 CI。不能用测试截图假装生产验收。

## 第一轮评审修正取证

- `account-heal/account-identity.ts:143` 的 identityKey 已规范uuid优先/email归一化，:166 identityDigest直接hash该key；页面沿用它，避免第四种序列化。
- `quota-guard-cli.ts:767` 已有identity-set；设计不执行该命令。只读生产Claude account store仅输出身份有无：business/personal/school/shopping/personal1均有identity、无uuid（2026-09-23），未输出邮箱、未更改账号。
- AccountEntry/实际selector没有档位输入；删除空洞的“给selector fixture塞tier”测试，以页面实际档位变换与import/type边界审计为证据。
- 页面不提升旧MANUAL_CLAUDE百分比为无出处机器读数：原共享值保留兼容，页面格显示无、无进度条、周未知进第三组。机器旧读数仍按E9保留原排序，不与硬编码manual混淆。
