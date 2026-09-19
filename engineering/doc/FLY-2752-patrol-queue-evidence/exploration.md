# FLY-2752 巡检队列证据完成门 — 探索
Issue: FLY-2752 (https://linear.app/geoforge3d/issue/FLY-2752/巡检完成门-fly-27021257给巡检快照的-activity-evidencepane-evidence-加了-queue)
日期: 2026-09-18
基于: 无

## 问题边界

FLY-2702 的巡检生产链已在每条 `ACTIVITY_EVIDENCE` 与 `PANE_EVIDENCE` 后追加
`queue_request`、`queue_position`、`queue_wait_seconds`。当前
`packages/teamlead/src/patrol-report.ts` 仍用旧的 `ACTIVITY_EVIDENCE` 字段白名单；真实
新版行因此稳定产生三条 `invalid_or_duplicate_field`。同一文件对 `PANE_EVIDENCE`
完全没有字段白名单，也没有对三项 queue 值做格式校验。

本 issue 只修完成门与已经上线的生产者合同之间的漂移，不改快照采集、queue 判定、
WAITING 语义、报告 schema 或巡检处置流程。

## 当前证据

- `73edeb188` 在 `scripts/lead-patrol-snapshot.sh` 的 pane 行和
  `packages/teamlead/src/patrol-continuity-cli.ts` 的 activity 行写入三项 queue 字段。
- 当前构建产物对旧 activity 行返回 valid；在同一行追加三项后返回三条
  `invalid_or_duplicate_field`；追加任意 `surprise=yes` 返回一条同类错误。
- `runner-patrol-rules.md` 已要求保留 package-gate queue 证据，因此生产者不能回退或删字段。

## 假设与成功条件

- 新三项是可选扩展：旧版骨架三项全缺仍须 valid。
- 字段存在时，`queue_request` 必须是非空 token；`queue_position` 与
  `queue_wait_seconds` 必须是规范的非负十进制整数。
- `ACTIVITY_EVIDENCE` 和 `PANE_EVIDENCE` 都只接受明确列出的字段；任意未知字段继续
  fail closed。
- 回归测试必须覆盖新版、旧版、非法 queue 值和未知字段；实现只落在 validator 与其测试。

## 方案比较

### A. 只扩 `ACTIVITY_EVIDENCE` 旧白名单

改动最小，能直接消除线上每 pane 三条错误；但 `PANE_EVIDENCE` 仍可接受未知字段，三项
queue 值也没有被验证，不能完整满足 QA 的 fail-closed 判据。

### B. 两类机器行都用显式白名单，并共享 queue 值校验（采用）

给 activity 白名单追加三项，为 pane 建立与当前快照格式一致的完整白名单；复用一个小型
校验函数检查可选 queue 字段。这样同时保持旧格式兼容、拒绝未知字段，并让生产者与完成门
使用同一份明确合同。范围仍局限在一个 validator 文件和一个测试文件。

### C. 允许 `queue_*` 前缀或取消白名单

可以避免未来字段再次导致完成门失败，但会把拼写错误和未审计字段也当成合法输入，破坏
完成门的 fail-closed 属性，因此不采用。

## 推荐设计

在 `patrol-report.ts` 定义两份字段常量和一个 queue 值校验器。`fields()` 继续负责空值、重复
键和未知键；解析 activity/pane 后再对存在的三项做类型约束。缺省值不由 validator 补写，
以便旧报告保持原样。测试以真实生产者字段顺序构造新版骨架，同时保留旧骨架对照，并对
未知字段和负数、非整数、空 token 做反例。
