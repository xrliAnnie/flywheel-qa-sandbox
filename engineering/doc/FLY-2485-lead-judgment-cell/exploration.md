# FLY-2485 Lead 判断格 — 探索
Issue: FLY-2485 (https://linear.app/geoforge3d/issue/FLY-2485/进度页e4-lead-判断格lead-note-新表-flywheel-comm-lead-note)
日期: 2026-09-09
基于: 无

## 目标与边界

给任意项目的 Epic 或子单补一句 Lead 判断，和机器句并列，注明角色、写入时间；没人写就不出现这一格。默认超过 3 天淡化，阈值可配置。判断不改 Linear 状态、运行状态、排序、依赖或任何审批权限。

本单为 eng_design：交付探索、调研、可实施计划、有效 APPROVED 评审、已提交并托管的可留言 HTML。实现、产品验收、部署由后续节点负责；本节点不派发它们。

## 已核依据

- 用户注入的 FLY-2485 全文是本轮 issue 范围依据；仓库 `product/doc/FLY-2457-founder-progress-page/prd.md` v2.1 的 F12/F13、§4/§10/§11/§15 Q4 一致。
- 当前 `dependency` 是 CLI → master-token Bridge → Linear 评论账本，并无同名本地表。“同构”采用输入校验、受保护入口和写后通知刷新形状，不照搬评论历史与关系写入。
- 当前根列表唯一位置为 `header.roots.value[]`；PRD 的 `roots[]` 在本分支映射到这里。不新增镜像根列表，不等 E1/E3。
- live issue GET 返回 HTTP 401；没有读取额外凭据或修改上游。不能把这次请求称为 live issue 核验成功。

## 取舍

选择：StateStore 新增一张当前值表，一项目一单每个角色最多一句，不同角色共存；`set` 替换同角色、`show` 只读、`clear --role` 只删除指定角色。写入用稳定 issue UUID，显示时使用当前 identifier。角色来自项目已配置部门，显示词由统一标签层负责。

不选：Linear 评论作为新判断源（不满足新表且携带作者身份）；从机器字段自动生成 Lead 句（伪造判断）；一单只有一个总句（Lead 已裁定不同角色需共存）；复制根数组、另造刷新服务、历史版本与操作 UUID 账本（当前需求不需要）。

## 异常和真实限制

- 无记录与读取失败分开：无记录省略；读取失败使本轮生成明确失败，保留旧页和旧时间，不伪造角色、时间或“暂无判断”。
- 写入成功不等于托管页已经刷新，现有队列合并更新，扫描兜底；CLI 只声明刷新函数已调用或不可用；不将调用正常返回冒充已排队/已发布。
- shared master token 证明调用方有内部写权限，不能证明具体哪一个 Lead 写的。role 是受约束的角色声明，不是人类签名。
- F13/S3 保障零人名硬编码、零作者身份字段；一句自由文本由 Lead 负责用角色表述。此单不新增通用人名识别器，不声称可识别任意语言中的人名。
- 隐藏/暂停的 Epic 与 backlog 子单可存判断，但不因此进入页面；投影范围仍由现有页面查询决定。

## 非阻塞问题

- `2cb86bbf-53b8-4f1d-b281-3d8ffc6abc1b`：向工程 Lead 说明同构的真实实现、单句替换与角色方案。
- `913a8ccb-7321-43d1-8953-034c00ecb876`：说明 canonical roots 路径、项目绑定范围、角色声明与 S3 边界。
- 两问均已收到同一裁定：新表、按 project+issue+role 存最新一句、canonical roots、issueMatchesBinding、配置角色、3 天及 S3 边界确认。全文已修正为角色共存；不另等 founder 决定。

## R1 范围修正

评审发现页面对子单不要求继承根的 team/project/label，原先仅 issueMatchesBinding 的设想会漏掉已显示子单。Lead 在 `99e28443-02c3-4f76-bbcf-6fd19029f8c7` 同意：直接项目绑定或当前绑定根子树成员均可写，其他跨项目单拒绝；新增缺标签与跨 team 的页面子单反例。最终合同以 plan.md 的该修订为准。
