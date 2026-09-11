# FLY-2483 现在要你看 — 调研
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-09
基于: plan.md

## 设计需求逐项对应

1. 三路且脱离 Epic：plan §3、§4、§7、C1–C3。证据来源已读；实现验收需要三源 exactly-3 fixture、空 Epic、久未答问题和跨项目排除。
2. attention.v1 kind/action：plan §4、§5、C2。四种精确词表与未知原 kind + 不确定动作已定义；实现需要输出/校验的正反用例。
3. 固定四段：plan §4、§8、C4。时间对应主动作，label 起点未知；实现需要逐个缺字段仍四段的 DOM 证据。
4. discord.guild_id 持久化与真实 thread 来源：plan §5、§6、C1–C4。单例表、配置变更/移除、UUID/identifier 与频道绑定、冲突灰掉、derived 双源已定义；实现需要重启与缺失负例证据。
5. 真点开截图：plan §10。当前未验证，QA 必须亲自从生成页点击正确 thread 并留图；schema 测试或设计页截图不替代。
6. declared_blocked 默认排除：plan §3.2、§10。Lead 已确认；实现需要第四个干扰 fixture 不进入 attention 的证明。
7. F13 及报告：plan §8、§10。角色固定文案、真实标题转义的范围经 Lead 确认；本设计 HTML 与文档无具体人名、无表格，QA 报告仍需逐项验证。
8. 不改 Epic/子单、不依赖 E1：plan §1、§7、C3/C4。此设计不引入 parent/scope.v2/排序调整。实现需要成功路径现有卡 DOM 与 scoped 调度事实不变的回归；无 scope 的调度结果必须 unavailable。

## 设计交付证据游标

- 三文档、Mermaid 源、逐节留言 HTML：提交 c13cbed1f，已推送。
- 11 节评论/单 nonce/CSP 模板/安全复制与分段：本地检查通过，详见 design-verification.md。
- 两图本地正常与标准重试均受 Chromium 权限限制；按明确 fallback 保留待渲染标识，不能宣称 SVG/视觉验证成功。
- 有效设计 review：登记问题 4b10142c-f64a-44b5-bbd2-4e4d82543554、request f40d1d08-c88d-4e53-891b-7afdb2b061d7；R1要求修改，R2/R3均有效APPROVED；最终request 8b2d8942-505b-427f-9d16-5078bc3bf48b、question 8e271f35-aefc-4aeb-8424-cb6e3688eb9c，详见review-response.md。
- 最终托管与阶段交接：R3有效APPROVED后已publish-only并向Lead报告最终URL；托管HTTP/nonce/CSP检查通过，详见design-verification.md。阶段交接以随后complete/park命令回执为准。

## 后继执行规则

产品行为验收尚未执行。implement/QA 由 DAG 编排器推进，设计节点不派发。若收到后续意见，当前 TURN 持有者写 design-correction.md 并增量修正；parked design 不写共享工作区。
