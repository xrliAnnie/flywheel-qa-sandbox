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
3. 明确 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH` 是 **Bridge-global** flag，不存在按 project 单独拉杆；只能用 project/category binding authority 收窄候选面。若当前 registry 不能形成安全 canary 面，就继续 default-off。

若第 2 条在 ship gate 时尚未闭合，正确决定是“合并能力、继续 default-off”，不是用 legacy projection 或缓存 head 冒充 claims-read 合规。

## Evidence

- eng 等价 hard gate：legacy trace 来自真实 start calls、PASS intent 与 escalation alert，再与 engine v1 的 handoff/loop/gate/max-limit 逐事件比对；`maxFixRounds 3→1` 与 `onPhaseComplete return` 两次负向突变均会打红。
- 真机 E2E：13/13 checks PASS；8 次 fresh spawn；eng 一次 QA fail 回环后 PASS；source outbox/projector；product output → real Git materialized head → cross-family review → founder terminal；Bridge restart 无重复派发。
- flag matrix：v1/v2 在 selection、materialize、admission、successor consume 四 seam 对每根必需 flag 单独 OFF。
- R6 advisories 已收：review output-producer guard、caller-head 不得升级 authority、claims-read OFF 对 engine 真正 inert、dispatcher 不自锁 60m、materializer 永久错误不 1Hz 刷屏。

## Rollout

建议顺序：

1. 先确认 Bridge-global 的 `claims_write=1`、`claims_read=1` 与（v2 时）`generalized_templates=1` 治理状态，并审计每个 project 的有效 binding 候选面。
2. 只有 binding authority 已把候选面收窄到可控范围时，才设置 Bridge-global `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`，观察 source outbox cursor/deadletter、engine held intents、claim USE-time 结果；否则保持 default-off。
3. 验证 engineering default binding `* / light / trivial` 只进入原本完全无 binding 的 project；任一已有 founder/category binding 的 project 必须整组保持不变。
4. 任一 hold/deadletter/head mismatch 即停止扩大，不做 legacy 降级伪成功。

## Rollback

紧急回退只使用真实接线的统一入口杆：

1. `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0`

新 start 回到 legacy；已 engine-owned run 不跨引擎回落，而是保持 hold，待受控恢复或人工处置。回退不删除 snapshot、claims、source rows、receipt 或 deadletter，保留完整审计链。
