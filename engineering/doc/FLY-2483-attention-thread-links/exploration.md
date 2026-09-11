# FLY-2483 现在要你看 — 探索
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-09
基于: 无

## 问题与授权范围

首屏必须看见本项目正在等你行动的事，包括没有挂进大任务的散活。每件事都要读得出是什么、做什么、等多久、去哪里。实现后由 QA 真点开生成的 Discord thread 链接并截图，拼出字符串不是使用成功的证据。

本节点只做设计，依据用户提供的完整 FLY-2483 issue 说明与仓库 `product/doc/FLY-2457-founder-progress-page/prd.md` §6.3、§6.4、§7、§11。不依赖 E1，不改 Epic 或子单渲染，不写产品实现、不派发后继、不合并、不部署。当前未读取在线 Linear issue；本机没有可用 Linear MCP，issue 说明以任务注入为准。

## 已核查的结构

- `packages/teamlead/src/epic-page/generate.ts` 负责项目页面生成；`items` 由现有 Epic 范围决定。
- `epic-page/model.ts` 的 Cell 同时存值、出处、观察时间和缺失原因；严格校验不允许任意新增字段。derived 表示按有编号的规则从已有事实计算出的值。
- `stuck_items` 来自范围内 signals；直接筛旧数组不能满足 Epic 外散活。
- 现有 kind/action 词表不存在；本单新增唯一 `attention.v1` 规则，不复用已有 signal 标签冒充 founder 动作。
- `config.discordGuildId` 来自 `DISCORD_GUILD_ID`；`chat_threads` 存 issue 与 thread 绑定。guild 是 Discord 服务器的编号，thread 是该单专属的讨论串。
- 页面链路还包括严格 schema、内容摘要、数据库存储、HTML/Markdown 渲染和出处回执，必须一起审计。

## 方案选择

A：在 renderer 从现有 items/stuck_items 临时拼首屏。改动少，但继续漏 Epic 外的单，且没有可审计新事实。拒绝。

B：生成阶段独立收集项目范围的三路事实，合并成 attention[]；持久化一个 guild 配置记录，thread_url 从真实绑定计算，渲染仅消费文档。选择此方案：可脱离 Epic 验证，数据与页面一致。

C：让页面运行时请求 Discord/Linear 或由 Lead 手写等待清单。增加凭据、出站与人工维护，也违背自动投影和零外部依赖。拒绝。

## 待核语义与研究方向

- 现有 question_pending 是等 Lead 回答，未必已经升级给 founder。按本单列入，但不把来源说成独立 founder 请求；已向 Lead 发非阻塞问题。
- 同 issue 多源合并如何保留全部依据与多个真实等待时间，而不隐藏独立问题。
- founder 门的真实状态并非统一叫 open；需按实际 gate 类型/状态与项目归属过滤，排除自动评审门。
- 未配置 guild 与绑定不存在要分别解释；移除配置不能继续生成旧 guild 的可点击链接。
- 旧 schema 文档、固定 hosted token 与发布失败回退必须有明确兼容/回滚设计。
- F13 按无硬编码人名、角色化产品文案，外部标题保留且转义；已向 Lead 核对字面“全文零人名”是否包含外部输入。

## 流程选择

本轮为已批准产品方向下的 bounded design；按动态任务直接推进 exploration → research → plan → request-review，不追加技能通用的 brainstorm/founder 批准流程。用户明确禁止本节点请求 brainstorm/ship 批准。最终有效 APPROVED 后才发布最终 HTML；HTML 发布不等待 founder 再评。

## Lead 语义裁定（本轮已收到）

问题 `11a90990-9057-4c15-837b-6ca536579e1e` 与 `57f47ca0-07de-446c-ba0b-3c9002ed840e` 已答复：同意项目级全未答 question_pending、排除 declared_blocked、逐单合并保留所有来源与既定主动作顺序；明确 no_active_roots/missing_daily_root 时独立显示 attention，Epic 提示不可用且 residual unavailable；F13 为无硬编码人名、角色文案与外部标题保留并转义；真实 Discord 点击+截图是 QA 硬门，设计保持未验证。前文提问已经解决，以上为当前实施口径。
