# FLY-2399 QA 返工 — 实施记录
Issue: FLY-2399
日期: 2026-09-11
基于: plan.md

本轮基线 a4d8c0b051e019ec27660bb69712ec4a0959d2df，PR #1163，implement attempt 2。按 Lead 4a7d8614-ee1f-4e7d-877f-9a8616bc8576 只修 F1/F2/F3；不修改批准计划、规则或授权契约，不处理 advisory。

F1：modeTick 整体同步异常边界覆盖第一次 mode() 读取，失败记录 mode_read_failed，定时器继续；Bridge 两个 start 调用分别捕获，错误不阻断后续启动。`scripts/__tests__/ship-judgment-timer.test.mjs` 使用编译 dist、全新真实 StateStore 临时库，无 uncaughtException/unhandledRejection handler。修复前 mode 在 Timeout._onTimeout 退出码 1，startup 同样退出码 1；修复后各存活 6.5 秒且下一 tick 继续，startup 错误记 stderr、mode 错误进 onError。日志 /tmp/fly2399-rework-timer-red.log、/tmp/fly2399-rework-timer-final.log。测试已接入 CI Quick Gate。

F2：setting-sources 使用非空 user；最小环境增加 USER/LOGNAME 以允许系统订阅身份解析。继续使用 safe-mode、空 tools、严格空 MCP、禁 hooks、固定 system prompt、空临时 cwd、120 秒且不重试。CLI envelope/usage 接受额外元数据，真正读取字段仍校验类型；显式拒绝非空 tool_calls、permission_denials、非成功/错误 envelope、非零服务工具调用。模型语义 JSON 的 strict 校验不变。环境/envelope 测试先 RED，修复后连同 runtime 共 10 项通过。

真实生产脚本 `scripts/replay-ship-judgment.mjs`，二进制 /Users/xiaorongli/.local/bin/claude，bindings.opus=claude-opus-5 / high。共 4 次顺序调用，无重试/并发，全部 resultCode=evaluated。原始冻结输入与完整报告保存在 rework-fixtures，报告 inputSha256 与原输入字节逐一核对一致。C01/C02/C03 是 QA 冻结包原样复制，目标仍为其历史基线，不能当新头产品运行证据；positive 为明确标注的合成冻结冒烟包，期望在调用前写入 expectations.json。

| 样本 | alignment | coverage | 结论 |
|---|---|---|---|
| C01 | undetermined | undetermined | 模型指出 diff 只有 gate/注释、缺调用处，以及零观察/零投递用例缺失；不改 QA 原期望，不计正例通过 |
| C02 | pass | pass | 原 QA 正例通过 |
| C03 | fail | fail | off 写库偏离需求被拒 |
| positive | pass | pass | 有穷输入域 inc 示例的完整映射通过，仅为真实 evaluator 冒烟 |

F3：`scripts/__tests__/ship-judgment-mutations.test.mjs` 的同源 mutant 分别删除映射检查和覆盖引证核验；invented-R2 配对负例在原版 requirement_map_invalid、变异版 evaluated，coverage=pass 却没有 QA 引证的负例在原版 coverage_evidence_missing、变异版 evaluated。完整正例在原版和变异版均通过。四项进程/变异测试通过，变异测试接入 Quick Gate。合成输出非真模型变异证据，真模型变异由 QA 复测（Lead 裁定 55ae7905-1ea0-4d13-8159-44b3d53d2fa9）；本轮不修改生产 prompt。

全量检查：完整 Quick Gate 28 条命令 exit 0（/tmp/fly2399-rework-quick-gate.log，包含 pnpm build 即 pnpm -r build、typecheck、lint）。两项新增脚本独立运行通过。全包 pnpm test:packages:run 的最终结果另行补录；不能以 Quick Gate 替代全包结果。推送、R1 code review、精确头 CI、needs_review 回执仍是后续独立门。

## R1 code review 与容量返工

R1 f2838c49-5cbd-4159-b854-243e2fa70aaa 在 dfb394214 的 effective/reviewer verdict 为 CHANGES_REQUESTED。完整结构化结果见 rework-r1-review.json。唯一 HIGH `epic-page-judgment-evidence-unbounded`：每项内联最多 64KiB evaluation 和约 96KiB mechanical，使主 Epic JSON 超过 1,507,328 字节上限。四条 MEDIUM/LOW（off history transport race、legacy freeze queue、user settings、GEO identifiers）不改，交 Lead 留档。

R2 最小修复：pageEvidence 对 evaluation/mechanical 各保留至多 960 UTF-8 字节的原始 JSON，小证据仍照常可见；超限返回明确 truncated、原始字节数和稳定 audit_id。EpicJudgment schema 对 evidence 总体另设 2048 字节硬界。原始 StateStore 记录与现有 show --id 完整结果不改。新测试真实入库 100 条要求引用、100 条长路径重叠，60 项页面修复前 assertEpicPage 抛 `document exceeds 1507328 bytes`，修复后正常，且 audit ID 可读回完整原始数据，读取期间零 DB 写入。原压力夹具加入接近上限的真实证据，新增主 JSON 大小断言；不改 HTML 阈值、8 roots/60 children 规模、计数、attention/cap 断言。

RED /tmp/fly2399-rework-r2-budget-red.log；GREEN /tmp/fly2399-rework-r2-budget-green.log（7 项），完整 Epic 回归 /tmp/fly2399-rework-r2-epic.log（28 文件、393 项全部通过）。新完整 Quick Gate 运行结果在 R2 提交前核对。

本地 pnpm test:packages:run 的归因更正：**Lead 主动结束，未采信**。Lead a302a494-3425-40c2-bde2-f820c9bb15b3 确认 13:48Z SIGTERM pid50781，本体仅观测 session43505 exit143；不重跑。精确头 dfb394214 的 CI34606157483 attempt1 仅 payload 安装冒烟外部443网络失败（其余所有测试分片通过），保留失败日志 /tmp/fly2399-rework-ci-script2.log；同头失败项重跑一次为 attempt2。此旧头 CI 不能替代 R2 新头 CI。

R2 完整 Quick Gate 最终 28 条命令 exit 0，日志 /tmp/fly2399-rework-r2-quick-final.log；此前一轮只在新增测试格式处 lint 红，修正后全套重跑通过。未重跑 Lead 已主动结束的本地全包套件。R2 待新头 review/CI，旧头重跑的结果单独保留。
