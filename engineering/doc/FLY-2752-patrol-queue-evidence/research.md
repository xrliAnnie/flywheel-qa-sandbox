# FLY-2752 巡检队列证据完成门 — 调研
Issue: FLY-2752 (https://linear.app/geoforge3d/issue/FLY-2752/巡检完成门-fly-27021257给巡检快照的-activity-evidencepane-evidence-加了-queue)
日期: 2026-09-18
基于: exploration.md

## 生产者合同

### `scripts/lead-patrol-snapshot.sh`

当前每个 owned pane 都输出以下字段：

`pane target owner exec capture_sha256 lines bytes state_sha256 last_change_epoch findings action result schema activity semantic_sha256 last_change_basis last_checked_epoch activity_evidence queue_request queue_position queue_wait_seconds`

queue 证据不存在时，脚本仍输出 `queue_request=unavailable queue_position=0
queue_wait_seconds=0`。存在时，值来自 collector 已核验的 queue evidence。

### `packages/teamlead/src/patrol-continuity-cli.ts`

`activityEvidence()` 为每个 execution 输出一条 `ACTIVITY_EVIDENCE`，既有字段后总是追加同样
三项 queue 字段。queue 不存在时也使用 `unavailable/0/0`。因此 validator 不能把三项是否
出现当成“是否正在排队”；它只校验机器行格式，排队语义仍由 continuity entry 决定。

## 完成门合同

`packages/teamlead/src/patrol-report.ts` 的 `fields()` 已具备四项基础防线：拒绝无 `=`、空值、
重复键、白名单外键。当前 activity 调用传入旧白名单，所以新版每行固定累积三条
`invalid_or_duplicate_field`。pane 调用没有传白名单，任意未知键会被保留且不报错。

其余 stalled 证据完整性检查依赖 activity/pane 的既有字段，不需要也不应因本 issue 改变。
`packages/teamlead/src/patrol-continuity.ts` 的外层完整性校验继续校验 ACTIVITY_RECORD 与
sidecar digest；queue 字段只是机器摘要，不替代 record 权威来源。

## 实测复现

在干净 `origin/main` 头完成 `pnpm install --frozen-lockfile` 与 `pnpm -r build` 后，直接调用
当前 `validatePatrolReport()`：

| 输入 | 当前结果 |
|---|---|
| 旧 activity 行，无 queue 三项 | valid |
| 同一行追加 `queue_request=req-1 queue_position=0 queue_wait_seconds=65` | invalid，三条 `invalid_or_duplicate_field` |
| 同一行追加 `surprise=yes` | invalid，一条 `invalid_or_duplicate_field` |

这把故障限定为 validator/producer schema 漂移，不是 queue collector、snapshot 取值或外层
record integrity 故障。

## 校验细节

- token：复用现有 `TOKEN`，接受生产 UUID、`unavailable` 以及现有 token 字符集；空值仍由
  `fields()` 拒绝。
- 整数：使用 `^(?:0|[1-9][0-9]*)$`，接受生产实际写出的规范非负整数，拒绝负数、小数、
  指数、空串和带前导零的非规范值。
- 兼容：每项仅在出现时校验；三项都缺的旧报告保持 valid。
- 白名单：activity 追加三项；pane 引入与当前 snapshot 输出一致的完整白名单。两类机器行
  的未知字段都继续/开始 fail closed。

## 回归测试位置

1. `packages/teamlead/src/__tests__/patrol-report.test.ts`
   - 新版 queue 字段 valid；
   - 旧版既有 `complete` fixture 继续 valid；
   - 两类机器行的未知字段 invalid；
   - token、position、wait seconds 的非法值 invalid。
2. `scripts/__tests__/lead-patrol-snapshot.test.sh`
   - 从测试内真实 `lead-patrol-snapshot.sh` 输出抽取 schema、PANE/ACTIVITY/RECORD 机器行，
     补唯一合法的零 finding review 行，调用真实 `flywheel-patrol-continuity.mjs
     validate-report`；修复前必须因 queue 白名单失败，修复后通过。

不新增 fixture 文件，不修改生产 snapshot、continuity 或规则文档。
