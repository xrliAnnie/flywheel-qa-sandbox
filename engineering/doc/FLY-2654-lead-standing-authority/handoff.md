# FLY-2654 Part A 设计交接 — 交付记录
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-20
基于: plan.md

## 当前交接（2026-09-20）

以当前 plan.md、design-correction.md 为准：Raya 正常 main 更新下一班车自动带上；收尾类紧急重启授权来自已激活 standing carve-out，a/b/c 满足由 Lead 自决，不把条件消息当授权，也不改成每次问 founder。只有前提不满足才回原路径。旧 Part B 继续关闭，代码和 b554c478e 血缘保留。

Lead 在问题 5ac555cf-0161-4373-a403-2d7a35238017 与指令 cd826c6b-b695-44cf-82fb-4fd5a9c2f706 作上述纠正，第一稿 39143d02d 及 review da775f5b-44ce-4004-88a3-8fdb32b88f32 已失效。问题 f116e8d1-9a7a-44f4-923a-44c4825297c7 确认执行包固定与自动独立确认，confirmer 定 Aunt Cass。

本单后续实施阶段必须完成 plan 的 I1–I6 和正反验收，包括 activation/verifier 集成、两种载体的规则加载与无逐次授权的实际结果；这些是本单 Done 前置。原实现 44/46 不能代表新范围已完成。先核验现有实现与 WIP、原 QA 冲突返工，再增量对齐；由自身 TURN/身份取得代码复审、CI 和 QA。设计体不实现、不派发后继。

本轮新设计门已通过：question d8b48727-1ca1-4cdf-9478-eb5e1a4336f6 / request 99bc9f51-729e-4dd5-8a74-2d5eda7772e9，round 3，effective APPROVED，语义提交 6ed0e655d。发布、托管核验和完成收据在本节续记；旧 URL/旧门不作本轮证据。

## 本轮复审 Follow-ups

- MEDIUM reboot-computer-branch-lacks-closeout-binding：确认 bare“重启电脑”能否按合同作为收尾意图；不由实现者悄悄扩写或更改文法。已报 Lead 决定。
- MEDIUM intent-grammar-hit-rate-unvalidated：实施/QA 应回放真实历史 founder 消息，报告命中率和拒绝分布，不能只凭四条人为正例声称不再逐次授权；实际正向可用结果仍属本单 Done 门。
- R2 四条 MEDIUM 的原文与有界验收备注保留在 review-standing-round2.json / plan.md，未声称代码已处理。
- Lead 对问题 15930bb5-7319-45ee-85c8-38c1fb8fc007 明确：前提 a 检测 fail-closed，无法证明则问 founder 一句，不推断；文法维持上述几种日常表达，不做通用解析器。满足 active+a/b/c 后不得再问逐实例确认。

## 当前验证边界

源码差异只在本 issue 文档目录；无产品代码改动。页面 8 个区块均有留言，单一 nonce 脚本，零外部依赖；VM harness 覆盖 localStorage 抛错、pathname 隔离、长意见分段、clipboard 成功/不可用/拒绝回退，均通过。未声称真实浏览器 QA。新版流程图两次本地渲染失败，源文件与明确占位保留。

## 本轮交付收据

- HTML 提交 b53990d97；后续文档收据提交不改变页面字节。
- 静默 URL：https://fw-reports-356a6d.vercel.app/r/00bff3645292c1619a076df607f90fae/ 。publishOnly=true、messageId=null、delivered=false。
- verify-report PASS：HTTP 200、placeholder 0、单脚本 nonce 与 CSP 匹配。独立回取再次证实线上/源脚本一致、8 个留言框、零外部依赖；见 hosted-standing-verification.json。
- DESIGN-HTML ready 报告 id d3aae32b-2883-4066-b52c-faae563f0954。
- Lead 对 06e3801f-923c-43c1-8f0b-e2df9c047755 已处置两条 MEDIUM：裸重启电脑只满足 a，仍需 b/c；#engineer 近 30 天真实“重启”原话回放成为 QA 验收项，不达标不宣称目标完成。已写入 plan.md，不另做语义分支。
- Closeout 复用判断按本会话指定 native memory 扩展位置保存到 2026-09-20T2206Z-fly2654-standing-scope-restored.md；未直接改写共享 runner-memory 索引。
- 最终提交后调用本 execution 的 complete --route phase_design_complete，由控制器交接。该命令的运行时收据才是阶段完成证据；本文不提前声称成功。

## 历史交接（以下无现行规范效力）

`````text

## 有效交付
仅 plan.md Part A：R4 对 AUTH-CANON(A) 已有、精确、一次条件式 founder 指令的识别指引；真实 Lead 发票归因、24h/自然时间框、单次票、触发证据、版本绑定与失败审计。无 standing carve-out，无 activation manifest，无新授权来源。

Part B 已由 Lead 指令 ec106d4d-6c4b-4507-a164-73bcef60a2e3 关闭，FLY-2679 取代；依据为 founder 在 #flywheel-engineer `1516209714097291335` 的消息 `1550240284800188529`（2026-09-17 20:21:25Z）与 `1550242249705660427`（20:29:14Z，“搬 … this should be in part of a epic”）。其历史全文用四反引号 text fence 包裹，不作为实施任务。原归档内的 I1–I7 不是活动实施清单；只执行 Part A A6 的 I1–I5。

设计门：question 7ea95d75-3f48-4efc-b148-927e0ef5ebdc / request 23cc8d5f-1552-448d-abfd-d13a8d0ba77b / effective APPROVED / round 4。评审计划正文提交 0f2ed1f4d。本节点不实现、不派发、不请求 ship、不部署或重启。

## Follow-ups（实施阶段处置）

设计评审的七条非阻塞建议完整保留于 `review-final.json`；实施阶段按 Lead
指令全部处置，没有借此扩大 Part A：

| finding | 处置 |
|---|---|
| `time-frame-omission-silently-falls-back-to-24h` | verifier 对回读原文先做独立固定词表预扫；命中任何时间语言却声称 `elapsed-24h` 即拒绝，并有 “今晚” 与显式时钟反例 |
| `sweep-roots-omit-doc-tree` | 消费者 sweep 覆盖 `scripts packages engineering doc .lead .claude`；现行 `doc/` runbook 与 Lead identity 区分 bare founder-direct 和条件 `--request` |
| `no-arg-emergency-path-removed-without-degraded-fallback` | QA rework 恢复 bare founder-direct v1 producer/consumer；当前直接指令无需 verdict，条件式 Discord/message ref 不可回读仍 fail closed且不得降级 |
| `merge-not-pinned-to-targetsha` | producer 固定 fresh `origin/main`；updater 要求 ticket target 与 remote 完全相等，并以该 SHA 执行 `--ff-only`，不再 merge 漂移头 |
| `no-reconciliation-with-fly1894-r4-ruling` | R4 逐字声明保留 FLY-1894：只识别既有 founder 指令，绝不授予 Lead 发起权 |
| `part-b-sections-lack-paused-markers` | Part B 总标题、B1/B2/B3 与冻结原文各层均标为“已关闭归档”；活动实现清单只引用 Part A A6 |
| `partb-closure-provenance-has-no-original-message-ref` | 记录 #flywheel-engineer 频道 `1516209714097291335`、消息 `1550240284800188529` 与 `1550242249705660427`，并绑定替代 Epic FLY-2679 |

实现与验证收据见 `implementation.md`。原始 Discord 内容没有在本节点冒充重新
认证；上述 Part B 引用用于解释关闭决定，不是 Part A 的运行时授权证据。

## QA rework 交接

QA 指出的 squash merge 不可用问题已改为以 GitHub 核验的 merged PR 为桥：target
绑定 merge commit，verdict 绑定该 PR 的精确 head。QA 同时指出的直接 founder 紧急
重启回归已通过恢复 bare v1 producer/consumer 修复；显式 `--request` 仍严格走 v2，
不能借失败降级。相关测试、非绿 aggregate 与隔离复跑的诚实收据见
`implementation.md` 和 `validation.md`。最终精确头仍须重新 code review 与 CI；本
节点不 dispatch QA。

## 诚实验证边界
设计期 HTML 脚本经 Node VM DOM harness 验证；浏览器工具受 approval policy=never 限制不可用，不声称浏览器 QA。最终 Part A Mermaid 本地渲染两次失败，保留 flow.mmd 与 DIAGRAM PENDING LOCAL RENDER。实施节点随后完成代码与脚本验证，详见 `implementation.md`；仍未运行生产票、部署或重启。

## 记忆收尾
按本会话允许的写入位置，复用判断已记入 native memory extensions/ad_hoc/notes/2026-09-17T2000Z-fly2654-authority-consumers.md，并追记范围已被最新决定替代；共享 runner-memory 目录未改写。

## Founder 页面
已静默发布并核验：https://fw-reports-42fba7.vercel.app/r/c018a2dc6a267a2b761a5f0c9c532575/ 。HTTP 200、nonce/CSP/源脚本一致、零外部依赖。DESIGN-HTML ready 报告 4706d03a-0d1c-46ac-98b8-94852745d0c7。图仍明确标记本地渲染待完成；无实际浏览器 QA。
`````
