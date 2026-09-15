# FLY-2573 weekly lifecycle 时间夹具 — 验证
Issue: FLY-2573 (https://linear.app/geoforge3d/issue/FLY-2573/ci假红-db-maintenance-weekly-lifecycle-测试跨秒就假红假-stat-在读取时才取-date)
日期: 2026-09-14
基于: plan.md

## 基线与验证环境

生产及测试基线：f022a0a7e；本节命令执行时尚无测试或生产改动。

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| pnpm install --frozen-lockfile | exit 0 | /tmp/fly2573-install.log |
| pnpm lint | exit 0，18 warnings | /tmp/fly2573-lint.log |
| pnpm -r build | exit 0 | /tmp/fly2573-build.log |
| TMPDIR=/private/tmp bash scripts/__tests__/db-maintenance.test.sh | exit 0，11 passed / 0 failed | /tmp/fly2573-baseline-canonical.log |
| pnpm test:packages:run | 运行中；尚无最终 receipt | /tmp/fly2573-packages.log |

本机默认 TMPDIR 是 /var/folders/...，生产脚本将数据库路径 realpath 成 /private/var/...，维护 CLI 因 HOME 与数据库规范路径不一致报 maintenance_database_path_not_canonical。默认环境两次基线均为 7 passed / 4 failed；不是本单的跨秒 RED。后续验证显式使用 TMPDIR=/private/tmp，生产路径校验保持不变。

## 早期尚待验证（已由下方结果更新）

- 确定性 x.999 跨秒：原夹具 RED 与冻结 mtime 后 GREEN。
- 完整脚本连续 20 次，零失败。
- 未来 mtime 仍被完整生产入口拒绝。
- 最终包级 receipt、有效 code review 与 PR exact-head CI。

原始日志保留在本机 /tmp，后续收敛时将必要的结果摘要与对照证据存入本目录。未取得的验证不算通过。

## 确定性对照结果

- RED：保留旧动态 date 的 GNU stat 分支，加入同一跨秒时钟。exit 1，10 passed / 1 failed；唯一失败为 weekly lifecycle：rc=0 receipts=4。完整输出见 evidence/red.txt。
- GREEN：将动态 mtime 改为夹具建立时的 2000000000，并增加 future case。exit 0，12 passed / 0 failed；完整输出见 evidence/green.txt。
- 时钟从 2000000000999ms 开始，在第一次 BSD stat 探测时推进为 2000000001000ms；断言最终时钟值以及三个 skip。原版第一个 marker 被判未来，修后不再发生。
- future case：独立真实数据库、schema 合法 marker，now=2000000000，mtime=2000000001；完整维护入口生成一条 VACUUM receipt，且无 weekly skip。
- 复现 RED：将 GNU stat 分支输出 FIXTURE_MTIME 的 printf 临时换回 date +%s，执行同一完整脚本即可；不需要等待真实秒边界。
- bash -n exit 0。生产脚本 diff 为空。

## 最终实现验证（代码59f1f1d04）

- 加入Lead要求的weekly-expiry边界后，完整脚本14/14通过，见evidence/final-green.txt。
- 同一最终脚本连续20次，所有运行均14 passed / 0 failed；循环整体exit0，逐次摘要见evidence/repeat-20.txt。每轮使用全新临时数据库，没有重试、sleep或多数判定。
- 最终pnpm lint exit0（现有18条warnings）；全仓构建exit0。此后仅修改Shell测试和文档，无构建输入变化。
- 包级验证仍由原会话78784执行，目前进入teamlead，尚无最终PACKAGE_GATE_RECEIPT。不得将已通过的包外推为全仓通过。
- 代码审查7b31fa1e-959f-48fd-9e85-1cfa8dee4fb7待回复；7b318f2a-0538-4c3d-b407-35d43b697901针对较早代码。最终审查/CI收据在PR中汇总。

## Lead要求的夹具缺变量防护

- 删除future用例的FIXTURE_MTIME，旧测试仍14/14通过（evidence/missing-env-before.txt）：证实假绿。
- 两个假工具验证全部三个FIXTURE变量，缺失时写入各自bin目录的fixture-errors并exit2；整套测试独立断言没有fixture-errors，防止生产marker不可读回退吞掉错误。
- 相同删除变异在新版本exit1、14 passed / 1 failed，明确指向fixture环境错误（evidence/missing-env-after.txt）。
- 正常配置exit0、15/15（evidence/hardened-green.txt）。新版本20次重复验证运行中。
- 最终头上一轮审查报告独立验证：删除生产mtime<=now守卫会杀掉future断言；将weekly比较从lt变le会杀掉604800边界。此为reviewer提供的变异证据，非本地执行声明。
- Lead将时钟reset/env helper封装和BSD原生marker覆盖列为follow-ups，本轮不做。

## 交接收据位置
后续精确头CI、代码评审、package gate及缺变量防护版本20次逐次结果在PR #1205中更新，以保持milestone为最后一次提交。前面的14项版本20/20证据保留原版本标识，不能冒充15项版本结果。
