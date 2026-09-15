# FLY-2559 Raya 首装修复 — 验证
Issue: FLY-2559 (https://linear.app/geoforge3d/issue/FLY-2559)
日期: 2026-09-14
基于: plan.md

## 范围与裁定
Lead question573b411f-0594-492a-bb47-4142c0853321 supersedes C1：退役 Raya wrapper 保持拒绝；支持标准 carrier 的 pre-install/installed credential authority，不扩大 probe/recover。R2 design gate1657535e-29f7-4138-bc9b-75b633d411f6 APPROVED。

## 本地证据
| 验证 | 结果 |
|---|---|
| pnpm install --frozen-lockfile | exit 0 |
| 新回归 red2（修正 fixture 后、修复前） | 46 pass / 5 fail；authority、真实 link、双 symlink preflight、install、relink 均失败 |
| 精确 raya/raya：bash scripts/__tests__/flywheel-lead.test.sh | 70 pass / 0 fail |
| bash scripts/__tests__/resident-codex-lead-recover.test.sh | 22 pass / 0 fail；含 infra-bot mapping、missing plist、retired/unknown 拒绝 |
| bash scripts/__tests__/lead-restart-lifecycle-generic-carrier.test.sh | 15 pass / 0 fail |
| bash scripts/__tests__/codex-home-link-truth.test.sh | 14 pass / 0 fail |
| 相关 shell 套件 | 15 个全部 exit 0，清单见 related-results.tsv |
| pnpm lint | exit 0，18 warnings |
| pnpm -r build | exit 0 |
| bash -n（两实现脚本、两变更测试）/ git diff --check | exit 0 |
| pnpm test:packages:run | PR 创建时仍运行；必须在交接前收齐最终 receipt，并写入 PR description |
| code review / exact-head CI | PR 创建时待完成；最终回执在 PR 与结构化 handoff 中记录 |

附 focused-test-results.txt 保留各套件原始 PASS/FAIL 输出。修改前 red2 输出位于 /tmp/fly2559-lead-red2.log；最终精确身份输出 /tmp/fly2559-lead-raya-exact.log。

包级聚合活跃 run 的 receipt 目录：/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-7cOq6F。启动时记录 head522e635248708ddf9fdedeb7aeab22c72520654e；之后仅测试 tuple 与文档更新，生产脚本未再修改。此处不预判 aggregate 通过；仅完整 PACKAGE_GATE_RECEIPT 且零 assertion failure、RPC-only 错误时可按注入合同接受，否则需继续处理。

## 验收映射与边界
- 修订 C1：标准 installed Raya authority 返回 .codex-raya，三个 JSON 键不变；mufasa/infra-bot 和 retired/unknown 保护均保留。
- C2：current 与 current/codex 双 symlink PASS；external、prefix、dangling、directory、no-exec、world-file、world-dir、standalone root escape 均 FAIL。
- C2b：真实 register 输出明确无 residency opt-in；无 plist 时真实 helper 链接 auth，inspect already，verify registered 0；标准 install 后 --authority 和再次 link 都成功；manifest/registry/carrier/plist 漂移拒绝；标准 probe/recover 有无 opt-in 均拒绝。
- C3：本地相关 suite 证据如上；最终 exact-head CI 必须通过。变更回归均位于既有 CI 注册套件，无新增 suite 漏注册。
- 所有新增执行使用临时 HOME、fixture credentials、fake launchctl。无生产 install/restart/deploy；生产 registered verify 由 Lead 部署后执行，QA publish-report 属 QA 后续责任。
- 标准 carrier 的 residency patrol 仍不受本单支持；人工 opt-in 可能产生 uncertain，已报告 Lead。
