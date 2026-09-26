# FLY-2913 主线 registry 合并漂移 — 返工记录
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-26
基于: design-correction.md、implementation.md

QA execution `c445eb0d-1c95-433d-8916-4240776c36fb` 对旧头 `49f239b0d66f4e7893bce988d56bb88012e9d99f` 判 FAIL。唯一已报告的代码/CI 阻断为 full CI `36269635458` 的 Unit (light)：`feature-flags-registry.test.ts:97` 固定数量断言期望 36，PR merge checkout 实际注册 38。逐 flag 名称/文案映射不是该次失败点；分支本地通过不能覆盖此集成失败。

返工在 implement TURN epoch 21 / attempt 2 下进行。同步 `origin/main` 至 `fdd1b404d40129f9e5345d325f1c687e52a682e9`，无冲突。该主线头已通过 FLY-2934 删除重复的数量断言，完整 `EXPECTED_WHEN_ON` 映射与逐条合法性校验保留；FLY-2913 的 `runner_prefix_profile` 退役断言也保留。没有另写一份数量修复、修改角色前缀清单、改变 Lead 配置或重做设计。

本次验证聚焦原失败合同、FLY-2913 与主线交叉文件的接线和词法守卫。同步引入的其他主线改动不扩展为本地全仓/全包测试。按完整路径、文件名、父目录和相关字面量完成 35 次查询，370 条测试匹配逐项保留/排除理由及 15 个具体保留文件（含 StateStore 稀疏迁移与 FLY-2567 清单成员变化守卫）见本执行证据目录的 `rework/consumer-discovery.json`。每个保留文件单独执行；registry 测试另用 owning-package `vitest related`，只命中同一具体文件。

验证已收齐：13 个 TypeScript 测试文件共 313 tests 通过，另 2 个 shell 守卫通过；registry related 仅 1 文件 58 tests 通过。受影响 teamlead/edge-worker 及依赖构建、edge-worker/teamlead/voice-codex typecheck、根 lint 均 exit 0（lint 25 条既有 warning）。命令、日志哈希、源文件哈希和测试结果见 `evidence/qa-rework-checks.json`。merge 提交为 `41390bed7`，后续只更新文档与进度。本地日志位于 `~/.flywheel/qa-evidence/FLY-2913-implement-f44b83c5/rework/`。旧 CI 红日志来自 GitHub 原始 run；没有请求新 full CI，冻结新头的完整 CI 与 QA retest 由 QA 阶段负责。

历史房内证据继续按 SHA 限定：旧头 role-v1 design、implement、review-design 有真实工具证据；Claude review-code、Claude QA 两格仍 `not-proven-room`。QA 的 slot 1 已验证两模板受管发布及指针回退，但因本次 CI 红项停止，不能把这两格计为通过。新头交接须重新取得有效代码评审，并由 QA 重测缺项。上轮 slot 2 已受管收房，未为返工自行起/拆房。
