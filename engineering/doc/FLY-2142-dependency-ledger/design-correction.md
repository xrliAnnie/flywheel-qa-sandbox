# FLY-2142 依赖账本 — 设计修正
Issue: FLY-2142 (https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢)
日期: 2026-09-04
基于: plan.md

## Abolished concepts

1. 废止依赖 mutation 的“两端 issue 都必须通过 `issueMatchesBinding`”约束，也废止“blocked 端必须通过 `issueMatchesBinding`”的第一次修正。`add` / `remove` 的 blocked 端必须复用 Epic 页面范围谓词：它是 project binding 当前 active root 的非 backlog 后代；blocker 端可为工作区任意 issue。blocked 不在该范围时返回 403，且 `which: "blocked"`。
2. 废止 `create-issue` 在带 `parentId` 时允许缺少 `projectName` 的设计。带 `parentId` 时 `projectName` 必填，父单必须通过 `issueMatchesBinding`。
3. dependency mutation 路由与 `create-issue` 带 `parentId` 的分支统一使用独立 master-only 守卫，只接受 `config.apiToken`；scoped / Gemini token 返回 403，`apiToken` 未配置时返回 503 并 fail-closed。不得依赖或修改 `tokenAuthMiddleware` 的凭据档位。

## Retained organs

`plan.md` Git blob `56628e13059a6022b26c34140cb74a0faa94879b` 保持 pinned，不回退、不改写。除下列被治理裁定明确推翻的验收、负向守卫和测试条目外，其余目标、合同、分块、失败路径、负向守卫、测试矩阵和运维边界全部保留：

1. plan A3 的“两端任一张不在绑定 ⇒ 403 零写入”改为“blocked 不属于当前 active root 的非 backlog 后代 ⇒ 403、`which: "blocked"`、零写入”；blocker 越过 team / project / label 边界不再是 403 条件。
2. plan §5 的“两端 issue 都 `issueMatchesBinding`”以及“同 team 不同 project、缺 scope label”两例，仅对 blocker 端被推翻；blocked 端改测页面范围谓词，不测 `issueMatchesBinding`。
3. research §2.1 step 7 的 `which: "blocker" | "blocked"` 收窄为仅 `which: "blocked"`；blocker 不做 binding 拒绝。
4. research §7 权限表的“两端 issue 都 `issueMatchesBinding`”改为“blocked 属于当前 active root 的非 backlog 后代，blocker 不限”。
5. research §8 T5 的 outside 用例改为：blocked 不属于页面范围 ⇒ 403 `which: "blocked"`；blocked 属于页面范围但没有 scope label且 blocker 跨 team / project / label ⇒ mutation 可执行。
6. plan M4 / T8 关于 `parentId` 的合同补充：`projectName` 必填；父单必须过 `issueMatchesBinding`；master-only 守卫对 scoped / Gemini token 返回 403、master token 缺失返回 503。

实现测试必须覆盖：

1. dependency mutation 的 blocked 端是当前 active root 的非 backlog 后代且没有 scope label、blocker 端跨 team / project / label 时可执行；blocked 端不在页面范围时返回 403 `which: "blocked"`。fixture 中页面能读到的每一条边都必须能删除。
2. scoped / Gemini token + `parentId` 返回 403。
3. master token + `parentId` 但无 `projectName` 返回 400。
4. master token + `parentId` 且父单不在 binding 返回 403。
5. `config.apiToken` 未配置时，dependency mutation 与 `create-issue + parentId` 返回 503。

账本理由仍只评论在 blocked issue；blocker 可属于外部项目，其 identifier 必须写进 blocked 侧评论。`dependency log --issue` 的理由读取合同仅保证 blocked 侧，不扩展 blocker 侧查询。

实现还必须处理并在 implementation report 逐条对账：审阅格上界、add fresh-read 分页越界、`walkBlockers` 扩域后的上界说明、`ready_items` 守卫可信度、schema error 422、A5 grep 文件全集、以及首行损坏但仍有 `dl1:` 机器行的 log 过滤。

## Lead 治理裁定（逐字引用）

> 治理裁定(Lead,FLY-1404 §6 增量修正机制;plan blob 56628e13 保持 pinned,不回退不改写):
> 【裁定 1 · out-of-binding-edges-unremovable】采纳你的建议:依赖 mutation(add/remove)只要求 **blocked 端 ∈ binding**(team 前缀+project+scope label 全过);blocker 端不受 binding 约束(可以是工作区任意单,和 blocked_by 的来源一致)。mutation 路由为 master token only(scoped/gemini token 一律 403)。「减法不许丢」是本单核心目的,能读到的边必须能删。
> 【裁定 2 · parentid-widens-scoped-token】取最严档:create-issue 带 parentId 时 **projectName 必填**,且父单必须过 issueMatchesBinding;scoped(gemini)token + parentId 直接 403(不是静默丢 parentId)。两条都要有测试:①scoped token 带 parentId → 403;②master token、parentId 无 projectName → 400;③父单不在 binding → 403。
> 【执行】不改 plan.md。在本单 doc 目录追加 design-correction.md:abolished concepts(两端都要过 binding 的删边约束;parentId 无 projectName 也允许)/ retained organs(其余 plan 全保留)/ 本条裁定逐字引用。然后对同一 blob 开一次新的 exact-blob review,请求里附 design-correction.md 路径。若复审只重提这两个 findingKey ⇒ 视为已裁(Lead acceptance),直接继续实现;若有**新的**阻塞级发现才停下报我。M0/A7 探针授权照旧。

## Lead 增量裁定 #2（逐字引用）

> 增量裁定 #2(Lead,追加进同一份 design-correction.md,plan 仍 pinned):
> 【HIGH blocked-end-in-scope-but-out-of-binding】采纳你的建议:依赖 add/remove 的 blocked 端判据改为**「是 project binding 当前 active root 的非 backlog 后代」= 页面可见范围谓词**(与 Epic 页读边用同一个谓词/同一段代码,不允许两套),不再用 issueMatchesBinding,也不搞 label 放宽;blocked 不在该范围 → 403 which=blocked;blocker 端仍不受限。不变量写进测试:页面上读得到的每一条边都删得掉(用 fixture children labels:[] 做阳性用例)。
> 【MEDIUM scoped token 403 无机制】改为:mutation 路由与 create-issue 带 parentId 的分支统一挂一个 master-only 守卫中间件(只认 config.apiToken;apiToken 未配置 → 503 fail-closed,不许 no-op 放行);不要求 tokenAuthMiddleware 暴露档位。
> 【MEDIUM retained organs 与 abolished 对撞】design-correction.md 的 Retained 段改成「除下列被裁定推翻的验收/负向守卫/测试条目外全部保留」并逐条列出被推翻的测试条目;别再写全保留。
> 【MEDIUM 账本评论只写 blocked 一侧】维持:blocker 可能是外项目单,理由只落 blocked 侧;在 blocked 侧评论里写明 blocker identifier 即可。
> 其余 MEDIUM/LOW(canceled_blocker/dependency_cycle 上界、fresh read 分页越界、walkBlockers 上界论证、ready_items 可信度、错误类型 422、A5 grep、log 过滤)= 普通实现质量项,你在实现里处理并在 implementation report 逐条对账,不需要再开设计复审。本轮起按 Lead acceptance 直接进实现;只有新的阻塞级发现才停下报我。
