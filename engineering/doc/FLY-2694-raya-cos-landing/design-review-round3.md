# Design Review — plan.md (Round 3)

Date: 2026-09-17
Author: Codex
Status: APPROVED

## Summary

Round 2 的四项问题均已完整关闭，且本轮没有发现新的可行性、正确性、边界或时序阻断。计划现在是一份可按顺序执行、能以非 vacuous 守卫证明 S1 边界、并与现有 workspace/CI/package-gate 机制一致的 construction book。

## What's Good (Keep)

- QA ⑤ 现在由互补的两层证据闭合：§2.2 精确约束 M 集合、包根集合与 121 个 `src/*.ts` 路径（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:44-70`），C1 再对 120 个上游文件做 blob/set 等值并只排除新增 guard（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:103-130`）。本轮执行的合法集合通过；额外包根文件、额外或非 `.ts` 源文件、缺 guard、删除既有脚本及第三个 M 文件均被拒绝。
- README 目标文案不再包含禁用字面量，且仍明确 S1 无运行时消费者、S2 才提供稳定 shim；因此目标段落与收尾 grep 已一致（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:178-204`）。上游 README 全文中该 grep 的唯一命中正是被替换的旧调用路径。
- 远端证据时序现在明确要求只推 commit ②、等待并记录两个绑定该 SHA 的 checks，再创建和推送 docs-only commit ③；提前推送时的恢复路径也重新绑定 CI 与 package-gate receipt HEAD（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:284-291,321-343`）。这与 workflow 的 PR 触发和同 ref `cancel-in-progress` 行为一致（`.github/workflows/ci.yml:3-7,19-21`）。
- CI 接线继续复用 Build 后的 root Node contract suites step（`.github/workflows/ci.yml:125-155`; `engineering/doc/FLY-2694-raya-cos-landing/plan.md:220-238`）。枚举守卫要求根级 Node suite 被字面注册（`scripts/__tests__/ci-shell-suite-enumeration.test.sh:26-40`），而 shard 精确清单只约束五个 script shard（`scripts/__tests__/ci-structure.test.sh:877-885,910-940`）；本轮重新执行两条守卫均通过。
- `noUncheckedIndexedAccess` 仍是唯一放松的严格开关，并由精确 compilerOptions/base-value 断言锁定（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:161-175,206-218`; `tsconfig.base.json:2-20`）。AST 依赖守卫含违规正向对照，避免了仅凭空扫描得绿。
- C5 的结构比较只允许新增一个 importer，保持旧 importers 及所有其他顶层 lockfile 数据不变（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:240-267`）。整个变更面仍明确排除 shim、updater、persona、部署和宿主状态操作，保持在 S1 范围内（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:81-84,346-363`）。

## Issues & Recommendations

1. 未发现阻断项或必须修改项。Round 2 的 README 自冲突、包内白名单绕过、commit ② CI 证据时序和两处精确性问题，已分别在 `engineering/doc/FLY-2694-raya-cos-landing/plan.md:58-79,92,119-124,190-204,330-339` 得到可执行且相互一致的修复。

## Verdict

APPROVED — ready to implement
