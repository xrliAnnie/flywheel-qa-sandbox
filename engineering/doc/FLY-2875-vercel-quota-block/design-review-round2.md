# Design Review — plan.md (Round 2)
Date: 2026-09-25
Author: Codex
Status: APPROVED

## Summary

APPROVED。上一轮两个 BLOCKER 已在设计合同中关闭；剩余两项为实现时可顺手处理的验证细节，不阻塞进入实现。

已完整重读 `7d723322ff301c643627872f62d0e61b8ccf68e6` 的 plan.md，并逐项比较 Round 1 反馈。相对上一轮审查头，提交仅修改计划；另复核了 refresh、GET、startBridge 注入位置、原子 writer 和 route harness 的相邻源码。

本轮未运行测试套件、构建或 lint，未调用 Vercel API、读取凭据或修改仓库文件。执行的两条 Vitest CLI 帮助命令均退出 0；本结论是设计批准，不代表尚未实现的功能已通过测试。

## What's Good (Keep)

| Round 1 项目 | Round 2 核验结果 |
|---|---|
| BLOCKER 1：失败后误用旧成功文件 | **关闭。** `plan.md:81,144-146` 明确共享同一个 latest holder，先 publish 再 write；observer 抛错也发布非 null 的失败记录。GET 的 `??` 仅在尚无本进程尝试时读文件，失败记录不会触发旧文件回退。后续成功刷新可直接替换失败记录。 |
| BLOCKER 2：扣费日缺 Pro 门槛 | **关闭。** `plan.md:126,155` 将 `plan!=="pro"` 放在日期分支之前，并列出 Enterprise/未知套餐的负测及等于生成时刻的过期边界。 |
| NIT 3：HTML 断言及测试隔离 | **关闭。** `plan.md:137,145,157,161` 移除逐字节承诺，按实际 Vercel 行检查高亮，校验具体邮箱；可选接线使旧调用方不读取默认 Vercel 文件。相对时间 fixture 避免固定日期自然过期。 |
| NIT 4：测试范围 | **范围问题关闭。** `plan.md:168-180` 保留明确的本地清单，宽范围回归交 CI；列举命令还有下述小修正。 |
| NIT 5：异常日志泄漏 | **关闭。** `plan.md:40,144,159` 只记录固定文案，覆盖含 token 的 message/name 和非 Error 抛值。 |

`accountPageVercel` 的生产注入位置成立：现有 startBridge 在 `plugin.ts:9316-9383` 构造同一个 app，并已传入刷新函数及托管依赖。复用现有 single-flight 足以约束这个内存 holder，无需新增后台刷新机制。

计划已明确记录“写入和删除均失败，再重启后可能读到旧文件”的残余边界（`plan.md:81`）。本轮认可同进程最新尝试优先的修复；不将其描述为失败状态已跨重启持久化，也不要求为该辅助页面增加新的持久化协议。

## Issues & Recommendations

1. **NIT — 修正 `vitest related --list` 的工具写法。**

   **位置：** `plan.md:180`。

   **问题与影响：** 本机安装的是 Vitest 3.2.4；`vitest related --help` 没有 `--list`，列举能力是独立的 `vitest list` 子命令，提供 `--filesOnly`。本地 CLI 注册源码也分别注册 `related` 与 `list`（`packages/teamlead/node_modules/vitest/dist/chunks/cac.Cb-PYCCB.js:1335-1340`）。当前文字不能直接当作可执行命令使用。

   **建议：** 最简单是删除可选 related 步骤，直接使用已列明的定向测试。如果保留依赖范围预览，先给出并验证该版本支持的具体调用；不要将普通 `list` 的测试路径过滤误当作 related 的源文件依赖分析。现有明确清单足以使此问题保持非阻塞。

2. **NIT — 将 T6④ 从预置 latest 的模拟扩充为共享 holder 的刷新与恢复用例。**

   **位置：** `plan.md:159-161`。

   **问题与影响：** T5 验证 publish/write 顺序，T6④验证 latest 胜过文件，两者已覆盖核心设计。但只让 `latest()` 固定返回失败对象，仍不能证明 route 的刷新回调与读取回调使用同一个 holder，也没有直接验证下一轮成功可恢复显示。现有 route harness 已支持注入 refresh 回调（`capacity-route.test.ts:78-90,869-908`），补这一链路成本很小。

   **建议：** 用同一个 holder 连接真实 `createAccountQuotaRefresh` 与 app：旧成功文件 → reader 返回 unauthorized、writer 抛错 → `refresh=1` 和普通 GET 均显示读不到 → 下一轮成功恢复在用行。顺带令 `discardStale` 抛错，确认 best-effort 清理不会破坏内存失败结果或整页响应。这是补强实现证据，不重开已关闭的 BLOCKER 1。

## Verdict

APPROVED

可按修订后的计划进入实现；以上 NIT 在实现与定向验证时处理即可。
