# FLY-2913 评审接线冲突 — 返工记录
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-26
基于: design-correction.md、qa-rework.md

本轮执行 `aed7b5ac-5791-4326-af12-5a154d942a5c`，implement attempt 3 / TURN epoch 27。QA `948e8299-adc2-4035-9339-c4865d2e7e96` 对基线 `4173903b4cbb527ebcdfee811d9a936962320ac4` 判 FAIL：PR #1361 与 main 冲突导致 `ci-full ensure` 返回 `ship_ci_not_green`。设计门 `53e1859b-f323-4509-abca-a44e6661b3d3` 当前 effective/raw APPROVED，设计与 role-v1 内容不重做。

同步 main `b0da16c38b75beb8634dac7d24c52914c9f1e19f`，实际重现四处冲突，均取语义并集：

- `claude-review-runner.test.ts` 保留两侧 fs imports，包括前缀权限/hash测试和取消测试使用的符号。
- `ClaudeReviewInvocation` 同时保留 prefixProfile/prefixAudit/prefixStamp 与主线 AbortSignal。
- `plugin.ts` 同时注入 reviewPrefixProfile 和主线 earlyStopEnabled。
- `review-request-coordinator.ts` 每次 round 解析作者 pinned profile 后，把 prefix 审计与 run.controller.signal 一起传给启动器；保留主线 freshness 检查、过期/取消结果丢弃、新 session fallback 及后续回执逻辑。

这是冲突合并，不引入新产品行为。失败证据为 GitHub `DIRTY/CONFLICTING` 与本地 merge 的四条 content conflict；已有两侧功能测试用于验证合并。main 自带的其他改动原样保留；不修改 Lead 配置、不起拆房、不触发全 CI。

验证证据保存在 `~/.flywheel/qa-evidence/FLY-2913-implement-aed7b5ac/`。消费者检索按冲突文件的完整路径、文件名、父目录、关键接线字面量及 `.js` import 拼写执行；每个命中测试的保留/排除理由在 consumer-discovery.json。保留直接 reviewer consumer 及 FLY-1560 词法、FLY-2211 kill inventory、稀疏迁移、FLY-2567 compatibility manifest 和 flag registry/drift 守卫。

related 使用外部临时配置列出 8 个具体 teamlead 测试文件，继承 owning package setup/sequence 并关闭 projects 覆盖，避免 plugin.ts 枢纽扩为整包；仍由实际依赖图筛选。首次只读 discovery 尝试 `vitest list --related` 被该 CLI 拒绝，未执行任何测试，也不算通过证据。没有全包或全仓本地测试。

验证通过：11 个具体 Vitest 文件共 358 tests；related 实际命中 4 文件 237 tests；teamlead 及依赖 build、teamlead/voice-codex typecheck、根 lint 均 exit 0（25 既有 warning）。源码合并提交为 `103e93c259f75f30f339aa26596aa864b79fbdf0`。日志/源文件哈希、完整命令、related 配置及消费者证据索引见 `evidence/qa-conflict-rework-checks.json`。合并范围内四文件 whitespace 检查通过；整次 merge 的 diff --check 指出 main 既有 FLY-2882/2883 文档尾空白，未越界清理。

QA 边界：最新 QA 返工摘要已确认五角色必要工具证据（design/implement/review-design 为未改 profile 的历史房内数据，QA/review-code 为本轮真实 role-v1），及两模板隔离发布/回退/replay、legacy 字节和不可变 revision 行集。新 generalized driver 在 candidate 执行前遭宿主 Claude JSON lock timeout，负载 100.60 超过 Lead recorder 安全限，未执行 strength-two 记录；publish-only HTML 有 HTTP/CSP 证据但未送达。这些是 QA 提供的既有边界，不冒称本次重跑或新合并头 QA PASS。新头有效 code review、QA retest 和 frozen-head full CI 仍须各自取得。
