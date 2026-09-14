# FLY-2490 空体收尾 — 实现与验证
Issue: FLY-2490 (https://linear.app/geoforge3d/issue/FLY-2490)
日期: 2026-09-11
基于: plan.md

c1–c5 已实施，保留 closeRunner crash-preserve 门。内部失败写 receipt，HTTP 拒绝 pre-adapter kind；closeout 只接受 failed/blocked + receipt + closed claim + 零 daemon 证据，再做通用缺席检查与终复核。旧调用者仍用 liveness-only 探针。

Lead 回复 1fa1ef0d-3289-4a74-bf28-3c632dc632f3 撤回交接里的 cancelled，固定计划 closed-only 为准。物理 DB 写边界归 FLY-2526。

定向 TDD（日志 /tmp/fly2490-*）：c1 缺模块 RED → 71 GREEN；c2 缺 API RED → daemon 95 GREEN（旧读取 oracle、损坏/非法字段、FIFO/symlink/大小上限）；c3 receipt API 与 quiescence 正例 RED → quiescence 29、receipt restart/idempotence 1、retention 30 GREEN；c4 HTTP 伪造及缺凭据 RED → HTTP 101、DirectEventSink 11、lifecycle 59 GREEN；c5 blocked 误标 RED → cause/post-ship 62 GREEN。每批包级 typecheck 通过。

完整 pnpm -r build 已通过（c5 后代码）。lint 首次失败为 event-route 格式，已修正，以最终记录为准。按 Lead a797d5b2-709a-498b-a240-3e324827de75 指示，宿主不跑全包测试，必须由精确 HEAD CI 证明。评审、CI 和 PR 尚待完成。

## 一次性历史补写

scripts/fly-2490-backfill-receipts.mjs 默认只读，所有路径显式传入，不创建缺失库。manifest 为一至两行，包含完整 executionId、sourceEventId、issueIdentifier，仅允许 FLY-2351 / FLY-2382。逐节点要求 failed、tmux NULL、无指定项目 CommDB 行、closed claim、零 daemon 证据，以及 2026-09-11 前的 direct-event-sink/session_failed 事件；payload.failureKind 必须为 worktree_takeover_failed，issue/project 必须匹配。历史事件只供人工审阅的运维修复使用，在线探针不读它。

清单继承 research §6 的历史快照，未刷新现网：FLY-2351 / #1133 / c070fce7-2b7e-44cb-9073-26b4e3200ede；FLY-2382 / #1107 / 9ab658df…（执行前从受管快照取得完整 id 与 sourceEventId，不能用前缀）。

操作人先按 snapshot-control 合同取快照、审阅 manifest，并确认部署了本修复。写入前停止相关 Bridge/dispatcher 写入，再追加 --apply --confirm-quiesced。本节点没有执行生产补写、resume 或重启。

    node scripts/fly-2490-backfill-receipts.mjs --state-db "$STATE_DB" --comm-db "$PROJECT_COMM_DB" --session-root "$CODEX_SESSION_ROOT" --socket-root "$CODEX_SOCKET_ROOT" --manifest "$REVIEWED_MANIFEST"

临时库测试 dry-run 结果（不是现网证明）：

    {"mode":"dry-run","nodes":[{"executionId":"c070fce7-2b7e-44cb-9073-26b4e3200ede","sourceEventId":"historical-failure","issueIdentifier":"FLY-2351","action":"would_insert"}]}

测试断言 dry-run 前后 DB 字节哈希不变；状态/窗口/claim/事件来源/daemon 反例拒绝；显式 apply、审计及重复执行幂等。实际执行先写幂等 pre_adapter_receipt_backfill_authorized 审计，再调用 StateStore receipt API；中断后可重放，不覆盖第一份凭据。批次预检任一拒绝则不打开写库。

回滚代码时 additive 表保留无害，旧探针恢复 unknown，不删除凭据或反改历史 session。部署与补写后由 Lead 各 resume 两个 held operation 一次；FLY-2351 历史 operation 路径见 plan §5，FLY-2382 以当时 operation_id 为准。生产验收需 closeout_report complete、land_operation 离开 held；临时测试不替代该验收。

## R1 / CI 返修

R1 question 5d07dd7f-0230-4a58-98d7-34443430448e 在 0c0c5d7af 返回 CHANGES_REQUESTED，唯一 HIGH 为 retention-consumer-gate-unregistered。补写脚本的 session_events/read consumer 已按 candidate_guarded 登记（缺历史事件会拒绝补写）；同时补齐实际 CI 发现的 liveGroup.kill() qa-only inventory 条目。两项共 13 行清单，无运行逻辑改变。consumer CLI、consumer 单测 5 条及 kill-path inventory 单测 5 条通过。

R1 MEDIUM/LOW 已报告 Lead，按只修 blocking 的指令保留范围：HTTP 残留死分支、receipt 写失败策略、跨部署 source replay、通用 source 治理、运维 quiescence 人工断言、receipt retention 和 ledger buffer 分配。完整原文保存在该 review gate 的结构化结果中。

首次精确 HEAD CI 34645126939 的三个 TeamLead 分片全部通过；Quick Gate 与 heavy 分片分别因上述两项清单遗漏失败，因此首次 CI 不是全绿。新 HEAD 必须重新通过 CI 和 R2。

## QA replacement 返工（attempt 2）

基线 528950ec4 的 QA 复刻脚本 `/tmp/fly2490qa/prove-backfill.mjs` 证明历史事件为平铺 `payload.failureKind`，补写脚本和原测试却用了嵌套字段。将夹具改成历史形状后，dry-run 断言以 `historical_evidence_missing` 失败；脚本改为读平铺字段后 green。运行时死亡证明逻辑无改动。

回归覆盖平铺事件 dry-run/apply/审计/幂等，以及嵌套、错误类别、空对象、null 的 dry-run 和 apply 拒绝。QA 原复刻脚本现输出生产形状 `would_insert`，嵌套形状拒绝。完整 `pnpm lint`（有既有 warnings）和 `pnpm -r build` exit 0。未执行生产数据补写。完整 QA 摘要及宿主全包测试限制已向 Lead 核对，question 9e50f8ee-fa3c-4e69-a405-e7f3c629c812；新代码评审与精确 HEAD CI 尚待完成。

## Engine conflict rework（attempt 3，2026-09-13）

返工请求 `rework:974d0ae42c28f6a31d73b32d0d60edb40069cafb31553cda18cc073404e4e8ad` 的原因是 merge conflict。基线 `8722a5be2`，合入 main `26ebc4931ba41e0a626ee14075f6de5359815ab5`，合并提交 `45ec2b92b`。仅手工解决三处文件冲突：StateStore 保留双方导入；retention consumer 清单保留双方条目；retention 断言按合并后的 registry/fixture 合并计数（protectedCurrentOrReference 148、总表 209、非退休表 206）。未扩展本单运行时行为，未改已批准计划。

本轮 lint exit 0（16 warnings）；六个定向测试文件共 251 tests 通过，backfill/consumer 脚本共 8 tests 通过，consumer gate ok。按 replacement prompt 启动的完整 `pnpm test:packages:run` exit 1：config 的 drift-scan 一个 5000ms timeout、fly1981-final-ledgers 两个 15000ms timeout（2 files failed、3 tests failed、815 passed）；未宣称全量通过，未重跑该宿主全包套件。恢复到历史宿主限制后已报告 Lead。首轮 build 因本地依赖尚未同步而找不到 main 新增的 yauzl；按 frozen lockfile 同步后另行记录构建结果。精确 HEAD CI、全新 code review 与 QA retest 仍是交付门。

## Engine conflict rework（attempt 4，2026-09-14 UTC）

基线 `c57b9387c742544f855e8848f6ae46fc1bc14d55`，合入 main `573159a15`，merge `6fe9c1eba`。唯一手工冲突为 StateStore 顶部 flywheel-core import，保留双方符号。脚本比对确认 run-quiescence.ts、receipt DDL（219 bytes）与两方法（1089 bytes）、retention registry/fixture/count 测试均与基线字节相同；StateStore 相对 main 仅增加原有 receipt import/DDL/方法，main 的独立函数保持原样。已批准计划未改。

本轮完整 lint（17 warnings）与 build exit 0；TeamLead 9 文件 364 tests、daemon 104 tests、backfill/consumer 8 tests 全过。全包测试已启动，终态回执由交接报告记录，不将定向结果代作全量通过。冻结新 milestone HEAD 后另取新 code review 和精确 HEAD CI；本节点仅 needs_review 交 QA，不执行生产补写、resume 或 ship。
