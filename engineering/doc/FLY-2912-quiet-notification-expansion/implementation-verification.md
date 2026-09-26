# FLY-2912 纯通知只记账 — 实现验证
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912)
日期: 2026-09-25
基于: plan.md, implementation.md

## 恢复与范围

本执行 `d5f75d56-6938-40b2-a56b-e5aa8e92240e` 从 WIP `8b29f69cd` 接续 implement 4/6，取得 implement TURN epoch 4。已批准设计字节不变，不重做设计。前执行红绿证据见 implementation.md；本次重新验证实际代码及保留消费者。

消费者发现对每个改动源文件执行 `git grep -lF` 的完整路径、文件名、父目录，另补 `.js` 导入名和 stem；[完整清单](evidence/consumer-audit.json) 列出全部匹配路径的保留/排除理由。保留 51 个 Teamlead、8 个 CommDB 测试文件，没有新增 shell 测试，不跑本地全包套件。复现配置为 [Teamlead](evidence/teamlead-related.config.mjs) 与 [CommDB](evidence/flywheel-comm-related.config.mjs)，保留原 setup/env/fork 限制；传改动 TypeScript 文件给 `vitest related ... --run --config <绝对配置路径>`。related 未收集到的保留文件另用显式 `vitest run` 补测。

首轮临时配置的父 include 与 project include 被 Vitest 合并，导致重复执行；该轮停止，不作为整轮通过证据。修正后 `vitest list --filesOnly` 确认 51 个唯一文件。测试使用临时 StateStore、CommDB、Codex home/lease；没有 startBridge、生产载体或真实频道调用。

## 本地验证

| 检查 | 结果 |
|---|---|
| `pnpm lint` | PASS，25 个既有 warning；没有自动修改 |
| `pnpm --filter "flywheel-teamlead..." build` | PASS，构建 13 个受影响包及依赖 |
| `pnpm --filter "...flywheel-teamlead" --filter "...flywheel-comm" typecheck` | PASS，7 个包；首次缺 voice-bridge dist，定向构建 `flywheel-voice-bridge...` 后原命令通过，未改 voice 源码 |
| CommDB `vitest related` | PASS，8 文件 / 142 用例 |
| Teamlead `vitest related` + 显式补集 | PASS：51 个唯一文件，850 passed / 1 既有 skipped；46 related 文件首次出现 1 条 fixture 失败，修复后该文件 13/13 通过；另 5 个保留文件 29/29 通过 |

唯一修复是 `lead-events.test.ts` 构造旧 schema 时先删除新增的 `idx_lead_events_notification_range`，再删除它引用的列；失败发生于 fixture 构造，修复后真实升级/重启断言通过。没有改动生产行为。既有 skip 为 #705 的 operator quiescence 禁用场景，本单保留原指令。合计 59 个唯一测试文件，992 passed / 1 skipped。

本机日志：`/tmp/fly2912-lint.log`、`/tmp/fly2912-build.log`、`/tmp/fly2912-dependent-typecheck-r2.log`、`/tmp/fly2912-comm-related.log`、`/tmp/fly2912-teamlead-related-r2.log`、`/tmp/fly2912-journal-migration-green.log`、`/tmp/fly2912-retained-extra.log`；最终 lint 重跑 `/tmp/fly2912-lint-final.log` 通过。这些是定向本地验证，不是 CI/QA/生产证明。

## 257 条历史回放及验收缺口

固定窗口 `[2026-09-26T01:30:00Z, 04:00:00Z)`，包含 03:58Z 恢复批；保留全部 257 个原 ID 和顺序。[结果](evidence/replay-result.json) 与 [原始载体派生观察](evidence/carrier-observation.json) 分开记录。

| 世界 | 输入 | model 候选 | 接受批次 / adapter 调用 | 实际模型回合 |
|---|---:|---:|---:|---|
| A 原账 disposition 基线 | 257 | 169 | 99 | 未由台架测量 |
| B 新策略 ON、历史缺证保守保留 | 257 | 257 | 121 | 未由台架测量 |
| C 新策略 OFF | 257 | 257 | 121 | 未由台架测量 |

这是同台架假设的提交计数，**不是生产精确唤醒次数，也不证明节省或行为回归**。141 条目标输入仍有缺证项；21 条 startup 均经过真实 DirectEventSink.emitStarted/flush，80 条 stage 经真实 HTTP producer，另外 156 条缺原 ingress 的输入保留 canonical journal 路径。A 复用原账 disposition，不冒充执行历史二进制。B 不凭今天的运行状态补造历史证明。所有 A 的 actionable 在 B 保持 model，同输入 tick 入队延迟均为 0；业务副作用摘要 ON/OFF 一致。合成正例/反例留在 producer 单测，未混入真实分母。

Lead question `aa046fc1-d883-44ff-8510-8eb27eedb337` 已明确：无法恢复的样本保守建模、如实标注、不缩分母，先推送再 complete，不等回信。本实现按此交卷；真实历史收益验收仍未完成。Claude/Codex 双载体的真实模型消费转录也未取得，payload/adapter 收据测试只证明接线和提交。隔离认证需要正式保留的 QA slot，本节点没有冒用、派发 QA 或向生产频道发测试消息。

## 交卷边界

PR、有效代码评审及当前 HEAD CI 状态在控制器交卷报告中绑定。普通实现头不请求 full CI；冻结头 full CI 与真实载体验证由后续授权流程执行。`CI Scope OK` 只代表 scope 检查。没有 merge、ship、deploy 或服务重启。
