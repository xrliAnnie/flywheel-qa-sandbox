# FLY-2399 自动审批学习闭环 — QA 交接
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399/2309b5-自动合并放手前要改的三条规矩提案交-founder-拍p2-文档单-依赖-b4-结果)
日期: 2026-09-11
基于: plan.md

本文件是实现侧的验收入口说明。首轮独立 QA 已在 a4d8c0b05 判 FAIL；本轮实现返工已完成四次真实 CLI 冒烟，结果见 rework.md；仍不声称新头 QA 或完整语义质量通过。批准计划第 9 节仍为验收依据。本文件不修改计划或授权 QA dispatch。

## 冻结语义输入与独立期望

QA 在看模型输出前，独立准备至少 12 个 frozenPacketSchema JSON，六组各至少两例：完整代码正例、需求偏离、遗漏用例、冲突、缺资料、原文诱导。每例保存已批准范围、精确源码 diff、QA 原报告及可核对引用。使用全长目标 head/base 和当前 judgmentModelSnapshot/JUDGMENT_PROMPT；不要将期望字段放入 packet。

先提交独立 expectations 文件，记录每例期望三点判定、overall、引用和理由；记录该文件及所有输入 SHA256、被测源码 HEAD、构建 identity。期望文件与输入文件分开，传给模型的参数只有原始 packet。模型或 prompt 变动会被生产 evaluator 拒绝，必须重新冻结并标明新一轮，不改旧报告。

构建当前 HEAD 后，一例一次执行：

```sh
pnpm -r build
node scripts/replay-ship-judgment.mjs --input /absolute/qa/frozen-case.json --output /absolute/qa/new-report.json --bin /absolute/authorized/model-binary
```

脚本读取最多 96 KiB，只调用现有 evaluateSubscription/runSubscriptionProcess 一次。沿用固定模型、无 tools/MCP/plugins/hooks、私有临时工作目录、120 秒、64 KiB 输出限制；顺序运行每例，不并发、不自动重试。脚本不连接数据库/Discord、不写审批、不修改 flag；SIGINT/SIGTERM 传递到子进程取消。输出以 wx/0600 创建，不覆盖输入或旧报告；输入错误可能留下空的已预留报告，视为失败保留，不作为有效结果。独立 QA 自行遵守获授权测试槽位的调用预算。

报告保存 inputSha256、model、targets、questionId、原始成功进程 stdout envelope、生产验证映射、耗时/usage/cost（模型有提供时）。失败保留固定 reason；进程失败或输出被拒时 CLI 非零。`acceptance=not_assessed` 永远不是 PASS。注入测试传输明确标记 injected_test_transport；该标记的结果不能作为真实模型验收。

QA 将原输出逐例与预先冻结的期望核对。至少完整代码正例可建议通过，高风险负例不得「可」，不能以全 unknown 通过。冲突是独立确定性检查：用相同冻结 head/file-set/main/target base 运行 checkGitMerge/checkFileConflicts，再按 aggregateJudgment 组合三点，不能让模型自己宣布无冲突。保留实际输入及这两项结果引用。

## 变异验收

从同一被测 HEAD 建三个独立临时副本，分别移除需求映射核验、用例覆盖核验、冲突检查。独立 QA 记录精确补丁/hash，在各副本重跑对应已冻结负例并断言原期待不满足；每个变异必须有对应负例将它杀死。不能改期望来迎合变异结果，也不能将手造模型输出的单元测试算成真实模型变异证据。生产分支和固定计划不应用这些补丁。

## 隔离真实链路

由 DAG 指派的 QA 使用全新测试 slot 与获授权测试 bot/founder actor；不操作生产卡/生产 flag。保留同一 question/card/head/targets 的以下证据：真实卡 → 可见机器意见 → 真实身份原卡决定 → B2 审计/可见前配对 → 分歧澄清 → 对自己澄清的 founder 回复及“已记录，未改变批准” → show/stats → Epic 主页面/审计 sidecar/30 天历史页。浏览器 click/截图证明链接和解释入口可用；API/HTML 测试不替代它。

另核对澄清内“批准”不能写批准，原卡正常 approve/rework 不被 pending 澄清吞掉；off/其它项目无新消息/模型，auto 仍走旧机械三闸；重启/丢响应不重复 POST，原卡 sender 与意见 sender 各改自己的 message。已完成单仍可在历史找到且保留原卡链接。

## 已有本地证据与边界

implementation.md 记录每批代码/测试；progress.md 是动态游标。历史 21 卡两页、发布失败/重启/复用/到期、主页面全 notes/history 的测试使用真实私有 StateStore/registry 与模拟外部 HTTP，不能当 hosted/浏览器证据。实际 attention 容量测试 cap=69 children、hardened 521503 bytes；200 个候选输入在该压力页保留 attention=0 并明确 source_truncated，不能说显示了 200 项。零 attention 仍保留完整 69 个 child、8 roots 和 20 preview。

retro-import.json 的六条样本全部 quarantined，不进入前瞻质量集或 precision 分母。执行时全仓 gate、review、exact-head CI 与此后的 QA 结果分别记录；任何一项未做或失败均不得归为通过。


## QA 返工复测入口

见 rework.md 与 rework-fixtures/：F1 两个真实进程 RED→GREEN；F2 四次真实 argv 调用均 evaluated，C02 与补充 positive 为 pass/pass。C01 按实际模型结论为 unknown，不能冒充原 QA 正例已过。F3 新脚本提供映射/覆盖两对负例及同源验证器 mutant。**合成输出非真模型变异证据，真模型变异由 QA 复测**（Lead 裁定 55ae7905-1ea0-4d13-8159-44b3d53d2fa9）。原 QA 输入/报告不改写，既有 12 例和三个模型变异的独立验收仍按派单执行。
