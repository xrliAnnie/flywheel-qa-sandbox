# FLY-2533 快照阶段协议 — 探索
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: 无

## 任务与授权

本节点只设计。依据当前注入 issue 描述与 Tadashi 2026-09-13 22:40Z 的 B‴ 裁定，完成可实施计划、设计评审、创始人 HTML 和 design 交接。标题的 409 文案修复只是其中一项；不能将任务缩回标题的小修复。

设计方向已由本轮任务锁定，不重开 brainstorm / founder 选型。正式 design gate 仍必须有效 APPROVED。issue 全生命周期的代码、PR、529 实测由后续 implement / QA 持 TURN 执行，本节点不伪称已完成。

审计基线：`26ebc4931`；当前分支 `flywheel-FLY-2533`；TURN design epoch=1，执行 `50a6cf26-a76f-47c7-8864-519a16871c53`。项目说明中的旧文档生命周期让位于注入 DOC-FLOW。本文件夹原先不存在。

## 用户问题

跨项目的领域执行器知道业务，却可能不知道 Flywheel 的完成协议。QA 会话即使一直 running，也不代表它提交了可推进工作流的 qa_verdict claim（机器可验证的验收记录）。另一个入口问题是省略 taskCategory 后实际查询 `*` 绑定，409 却只说没有 binding，诱导排查错误方向。

成功行为：Bridge 在创建运行快照时，把节点应遵守的阶段协议放在领域手册前，二者一起固化并参与摘要；缺协议就在启动前报错。入口错误明确指出分类缺省和认证种类；QA 与实现不能指向同一文件。

## 固定选择与代价

| 路径 | 判断 | 代价与边界 |
| --- | --- | --- |
| B‴：快照物化注入仓内协议 | 采用；协议与领域内容共同进入现有摘要链 | 必须覆盖显式 agent_file 与角色解析两条路径，随 Bridge 打包，旧快照不可重注入 |
| 给每个项目手工复制协议 | 不采用 | 多副本会漂移；领域作者继续承担平台协议维护 |
| 在 Blueprint 派发文本中拼协议 | 不采用 | 越过已批准注入点，协议不自然绑定原始快照 |
| 自动补 `* → tpl_simple_code` | 不采用 | 改变默认路由与产品语义；裁定明确保持显式绑定 |
| 建 registry / 改 config 结构 | 不采用 | 非 Flywheel 项目继续现有 roster 通道 |

本轮没有取得 A/B/B′/B″ 的原始评论全文，故不编造这些代号各自的定义；这里只记录裁定已排除的选择与代码层可确认的替代路径。Linear MCP 不可用；依据用户完整描述与仓内 issue-context 副本，二者裁定和 QA A–F 一致。

## 技术约束与研究问题

1. 正式节点类型为 `design/implement/qa/generic/review/gate/land`。`eng_design`、`general` 是角色名；不能拿节点 id 或文件名作权限来源。核查 review 及 generic 的条件化协议。
2. `readAgent` 先校验 realpath 在项目根内，再裁切 40,000 字符并算 agent digest。新协议必须在所有截断之前放到开头，完整保留。
3. `snapshot_digest` 覆盖 resolved agent 内容及其 digest；不加 protocolDigest、数据库列或 config 字段。
4. 旧快照恢复只读取已固定内容，不能重新读取新协议。新启动缺文件、空协议、无映射均拒绝；引擎自身 gate/land 无模型会话，不需要协议。
5. roster 加载器已有项目内 realpath 校验，需按文件身份拒绝 qa/implement 同文件，不能只比较 YAML 字符串。
6. 抽取协议后 Flywheel 原节点领域手册保留；不能保留重复协议再靠自然语言去重。打包、旧快照和直接角色消费者都需要审计。
7. 409 回显只能来自已验证 taskCategory 和服务器确定的 authKind；不能回显 token，也不能暗示 scoped token 因带分类便有 master 权限。

## 验收范围

A：前置协议改变 agent / snapshot 摘要。B：529 隔离房固定 Claude QA，纯领域执行器实际提交 qa_verdict claim，有注入前对照。C：缺协议拒绝，不产生 running 会话。D：QA 与实现同文件拒绝。E：非 work-kind 分类缺省 409 的提示与回显。F：Flywheel 各节点语义保留，完整 prompt 增幅不超过 10%，协议不重复。

这些均需明确测试和证据形状。设计阶段不启动 529、派发假活或接触生产数据库。

## Lead 收敛补充

问题 13da1f44-f11f-4f06-b9fc-029d8506b4ca 与报告 d7ec1b82-6f6d-4637-af6f-7ad52735b2cc 均已回复：接受正式 type 映射、review 协议、生成兼容节点、Codex 既有首轮通道；总长边界收紧为协议+完整手册 >40,000 时拒绝新派发，不能截尾。以 plan.md 的最终算法为准。
