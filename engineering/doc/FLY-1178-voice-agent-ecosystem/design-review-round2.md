# Design Review — FLY-1178 plan.md (Round 2)
Date: 2026-07-11
Author: Codex
Status: APPROVED

## Summary

Round 1 的六项问题均已在当前 checkout 中闭环，且修复不只是补充说明，而是进入了执行步骤、验收条件和失败路线。计划现在能在 DR 开始前证明工具链可用，在导出后建立 finding→exact source 的 claim 级证据链，在写 digest 前按 coverage matrix 发现缺口，并对无法核验的论断 fail closed。Q1/Q3/Q4 的 prompt 边界也已收紧到本 issue 真正需要的 agent-layer 取舍深度。

本轮结论为 **APPROVED**。未发现影响可行性、正确性、引用红线、scope 或 sequencing 的阻塞项。

## What's Good (Keep)

- **Claim-level evidence contract 已真正闭环。** `plan.md:70-83` 保存原始 `.docx` 并收紧 M1 验收；`plan.md:85-106` 将附录 A 设为 finding 主键的 exact-source 内容核验台账，将平面 URL 健康检查拆到附录 B，并把定位不到来源/打不开/不支持统一判为 `UNVERIFIED`；`plan.md:132-134` 又要求每条正文 finding 必须在附录 A 有 exact verified source。`research.md:122-149` 的 findings 模板与该合同一致。
- **`.docx` 路径在现有 skill 产物上可行且保持 fail-closed。** 我用 FLY-883 的真实 Word 导出检查了 OOXML：同时存在 `word/document.xml` 与 `word/_rels/document.xml.rels`，正文中有 137 个外部 hyperlink occurrence、19 个唯一外部 URL，可按报告位置恢复 Word 导出的 source references。更重要的是，新 M2 不假设恢复必然成功：任何不能定位到 exact source 的 finding 都降级为 `UNVERIFIED`，因此不会静默误配。
- **命令合同已从“裸命令假设”改成 Runner 注入路径。** `plan.md:34-37` 明确不假设 bare `flywheel-comm` 在 PATH；M0 的 inbox、GitHub、Chrome 仲裁和 browser checks 在 `plan.md:39-61` 全部前置；M5 在 `plan.md:141-147` 写出了 questionId 绑定和 wake 后 `verify-approval` 的完整链；`plan.md:175-177` 的 progress 命令具备必填 `--exec-id` 与 `--file`。源码核对仍显示 `ask/gate` 要求 `--lead`、progress 要求 `--exec-id/--file`，当前计划已覆盖这些要求。
- **当前真实 GitHub 阻塞被诚实建模。** fresh `gh auth status` 仍显示默认账号 token invalid；`plan.md:44-47,60-61,160` 会在 M1 前协调修复，修不好即 blocked，不会先烧 DR 再卡在 PR。这让“端到端可执行”成为显式 gate，而不是乐观假设。
- **Q1 fence 冲突已消除。** `dr-prompt.md:60-82` 只允许一个短段落把 s2s/chained 当术语背景，后续强制聚焦 handoff、delegation、async tool work 和用户等待体验；`dr-prompt.md:135-148` 又把 Q4 latency 限定为平台自身公开预算，并要求 vendor claims 明示，不会重跑 FLY-883 的 backend benchmark。
- **Q3 已拆清 logical vs compute/session residency。** `dr-prompt.md:103-131` 定义两轴、要求每案例标 durable state/warm process/idle cost/recovery/lifetime，并收敛成三桶比较；`research.md:45-59` 的搜索锚点同步。Letta 只被用作 persistent-state-not-warm-process 的例子，没有再被错误当作常驻计算证明。
- **Coverage gate 已从字数代理升级为交付覆盖。** `research.md:151-166` 分别列出 Q1-Q5b 必答格，明确单独判断 Q5a/Q5b；`plan.md:108-117` 将最大缺口组合进唯一一次 targeted rerun，剩余缺口进入未验证清单。该设计既守住 1+1 预算，又不会让“150 词/2 引用”掩盖漏答。
- **恢复与时间证据要求准确。** `plan.md:76-80` 优先在同一 conversation 恢复 export，只有研究会话丢失才重跑，且技术恢复不占内容补跑预算；`dr-prompt.md:184-194` 要求 source 有日期才使用 source date，否则标 undated + access date，明确禁止猜日期。
- **Q5b 和 scope 保持一致。** `plan.md:124-134,148-151`、`research.md:133-134` 都把下游标为 FLY-1179，明确 FLY-1168 只是 consumer。当前 `git status --porcelain` 仍只有 `engineering/doc/FLY-1178-voice-agent-ecosystem/` 下的四个新增设计文档，未发现 production-code 改动。

## Issues & Recommendations

没有阻塞项。以下仅为实施时的非阻塞卫生建议，不影响批准：

1. `plan.md:34-37` 的总括句可在以后顺手改成“所有调用都以 `node <commCliPath>` 开头，flags 按子命令合同传递”，因为 `stage`/`complete` 并不接受 `--lead`；当前各具体示例和括号说明已经足以避免误执行，所以无需为此再开一轮。
2. `research.md:94` 仍简写为“每个论断带日期+链接”，而最终 prompt 已采用更准确的“source 有日期则用，否则 undated + access date”。建议实现时按 `dr-prompt.md:184-194` 执行，后续可把 research 摘要句同步，避免读者误以为无日期页面必须猜日期。
3. 提交 `evidence/*.docx` 前做一次 `unzip -t`、文件大小和 `docProps/core.xml` 元数据检查，确认文件未损坏且无账号/个人元数据。FLY-883 样本的 creator 字段为空，但新导出仍应逐次检查。

## Verdict

**APPROVED**

该设计已达到实现阶段入口条件：工具与外部依赖在烧 DR 前 fail closed；研究、导出、claim 级验证、coverage 补跑、双栏 digest、PR/approval 和 Lead-only handoff 的责任边界完整且顺序正确。可以按当前 `plan.md` 进入 Implement。
