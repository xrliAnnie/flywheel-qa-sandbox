# FLY-1307 模板派发 — 启用决策
Issue: FLY-1307
日期: 2026-07-16
基于: plan.md

## Decision

本 PR 交付启用能力，但**不在代码或生产配置里拉杆**。新增唯一入口杆：

`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`

实际 start-time 派发不是单杆，而是统一组合谓词：

- schema v1 engineering：`template_dispatch ∧ claims_write ∧ claims_read`
- schema v2 generalized：`template_dispatch ∧ claims_write ∧ claims_read ∧ generalized_templates`

任何已 `engine_owned` 的 run 在运行中缺任一必需 flag 都 hold，绝不退回 legacy belt。没有模板候选仍精确走 legacy；v1 候选在 dispatch OFF 时也精确走 legacy；v1 显式开启 dispatch 后若 claims 缺失、以及 v2 缺任一必需 flag，均 fail-closed 且零副作用。

## Recommendation

Annie 的产品偏好是能力成熟后 default-enable；本次建议仍保持 registry default-off，并在 ship gate 明示以下条件后由她决定 rollout：

1. PR-8 code review、独立 QA 与本页列出的真机/硬 gate 证据均绑定同一最终 head。
2. `FLYWHEEL_WORKFLOW_CLAIMS_READ` 的 production governance 前置被明确确认；isolated E2E 证明机制可行，不替代 production peer-credential/fresh-principal 准入裁定。
3. 先对受控 project/category 小流量拉齐四杆，再扩大；不得只开 dispatch 杆。

若第 2 条在 ship gate 时尚未闭合，正确决定是“合并能力、继续 default-off”，不是用 legacy projection 或缓存 head 冒充 claims-read 合规。

## Evidence

- eng 等价 hard gate：legacy belt 与 engine v1 的 handoff/loop/gate/max-limit 逐事件一致。
- 真机 E2E：13/13 checks PASS；8 次 fresh spawn；eng 一次 QA fail 回环后 PASS；source outbox/projector；product output → real Git materialized head → cross-family review → founder terminal；Bridge restart 无重复派发。
- flag matrix：v1/v2 在 selection、materialize、admission、successor consume 四 seam 对每根必需 flag 单独 OFF。
- R6 advisories 已收：review output-producer guard、caller-head 不得升级 authority、claims-read OFF 对 engine 真正 inert、dispatcher 不自锁 60m、materializer 永久错误不 1Hz 刷屏。

## Rollout

建议顺序：

1. 先确认 `claims_write=1`、`claims_read=1` 与（v2 时）`generalized_templates=1` 的同一 project 治理状态。
2. 再对该 project 设置 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`，观察 source outbox cursor/deadletter、engine held intents、claim USE-time 结果。
3. 验证 engineering default binding `* / light / trivial` 未覆盖 founder 既有 exact category binding。
4. 任一 hold/deadletter/head mismatch 即停止扩大，不做 legacy 降级伪成功。

## Rollback

紧急回退为两步，顺序保守：

1. `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`
2. `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0`

新 start 回到 legacy；已 engine-owned run 不跨引擎回落，而是保持 hold，待受控恢复或人工处置。回退不删除 snapshot、claims、source rows、receipt 或 deadletter，保留完整审计链。
