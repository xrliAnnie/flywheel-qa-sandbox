# FLY-2597 审查返修 — 实施记录
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597)
日期: 2026-09-16
基于: plan.md, verification.md

## 权威与范围

原 head `4f1cd6eb7384fd4d78b0045b6e260a8e5e0205a9` 的 request `2f99516a-fb77-4c4e-8ebd-b32eadce2110` / gate `2d88ee47-5afd-4e1b-a0dd-3c8e69a0640d` 返回 effective CHANGES_REQUESTED。同源 HIGH 触发停工报告后，Lead 在 question `9b845ad7-0720-494a-bc41-85576711c44b` 授权一轮修复、一次 push、一次新 head review；不等 PR #1216，若 CI 唯一红是 observation-performance 则报告并等 Lead 通知同步 main。

## 本轮修复

- HIGH `stale-intermediate-holder-test-red`：先新增真实 StateStore 测试，证明中间 `code_review` holder 是 SQL 候选（rawCount=1），但被 pinned snapshot authority 排除（facts=[]），页面无该卡片；该测试在生产代码未改时通过。随后抽取同一真实 fixture 替换旧页面 mock；没有恢复硬编码 founder_gate，保留 custom approval node 测试。
- HIGH `founder-page-hides-unlinked-attention`：founder 列表仍只列可用 Discord 链接；有效项缺链接时摘要显示清单不完整和缺链接条数，不能声称无事。新增 guild/thread/thread_url 三种缺失的渲染回归。
- `reply-watermark-single-alias-key`：用项目内身份解析器验证出的别名集合匹配标题事实和既有回复水位；不改 gate 回答或 ship 授权。两种回复键（identifier / UUID）均有真实库测试，双别名端到端验证点亮、回复熄灭且 gate 仍 pending。页面选择 session 时优先来源绑定键，避免元数据 UUID 抢走同一来源的生命周期判定。
- visibility unavailable：读取 session 或 effective 状态失败时，相应源桶成为 `source_unavailable`，页面明确 incomplete，不再把未知当成已清空；不展示未经确认的 attention 行。

新增行为回归首轮 7 failed / 72 passed，失败分别复现缺链接误报、别名点亮/熄灭和可见性读取失败。后续实际结果写入 verification.md。

## 保留的非阻塞后续项

遵从 Lead 本轮范围：attention 读取失败冻结 Face B/C、每 issue 重复扫描、null-stage 清除范围、维护批次异常隔离、hold 同时压 answer 均未扩修。visibility 异常导致静默删行与本轮 unknown-state 是同一代码路径，本轮通过 incomplete 源单元修复其误报为空的后果；没有泛化其它异常处理。

quiet intake 的 Bridge receipt 是原 issue 第 4 项明确授权的选项 (a)，不是本轮新增范围；保留现有鉴权与 needs_founder 消息证据。null-stage 清除与设计 R3 的已接受提醒存在解释差异，本轮不按代码审查 advisory 擅改。

真机标题、真人 founder 回复、固定页实际发布/截图均未执行；仍由 QA 专属测试 thread 承接。本轮未合入 main 分支、部署、服务重启或 successor dispatch。

## Lead 后续同步指令

`[lead-instruction 616e3ee9-87ca-4358-bf5c-800e2be2f476]` 在原 ruling 后明确要求将已合入 PR #1216 的 origin/main 一并纳入本轮唯一 push/review。完整包测试退出后执行普通 union merge（无 rebase），main `b51fec42277425c0fb2c76edf8233beb85c8f4b8` → merge `0284a1fb791b8875f0683318bf858ce730f5cd34`，无冲突；保留双方语义。该同步不是 ship 或将 feature 合入 main。
