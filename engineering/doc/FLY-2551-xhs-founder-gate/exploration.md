# FLY-2551 小红书逐次批准门 — 探索
Issue: FLY-2551 (https://linear.app/geoforge3d/issue/FLY-2551/2441follow-up-小红书-publishcommentlikefavorite-的机器可验-founder-门今天)
日期: 2026-09-14
基于: 无

## 任务与阶段

目标：founder 在 Discord 审阅本次完整内容并明确批准后，可信服务写下绑定内容、账号和时限的一次性回执；Claude/Codex Lead 均只能经 broker（执行前检查权限的中间服务）使用它。
本次授权仅设计，输出探索、调研、可执行计划、有效设计评审、创始人 HTML 和阶段回执。**不实现、不派工，实施等待 founder 排期**。设计完成不是生产门已存在。

## 已核实的起点

- 当前分支 `flywheel-FLY-2551`，起点 `579c79ed662e49e7799b5d61ccd6d11a00fce3f2`，首次检查干净；不存在既有 FLY-2551 文档目录。
- 取得 design TURN，epoch=1；execution=`ddec1a1e-08f6-4bbf-bc0d-71a7cd36d234`，run=`c3d6e76c-306c-463d-9c51-a24e55de0113`；activation=`activation:ddec1a1e-08f6-4bbf-bc0d-71a7cd36d234:c3d6e76c-306c-463d-9c51-a24e55de0113:eng_design:1`。
- 2519 参考对象 `8e182b224316c2ae1ba3ac19f370db474677d08f` 只读审计；不合入、不移动其分支、不恢复它的 stash。实施排期后继承实际通过审查的 2519 基线。
- 六个对外写工具：`publish_content`、`publish_with_video`、`post_comment_to_feed`、`reply_comment_in_feed`、`like_feed`、`favorite_feed`。取消赞/收藏也是写。`delete_cookies` 是额外账号控制写，继续 `unclassified_write`。
- 2519 `upstream-inputs.ts` 的六项 `founder_write_gate_absent` 和 `handlers/upstream-write-denials.ts` 引用 Lead 裁定 `3a78eb55`；目前不存在可复用的 XHS founder receipt。
- 2519 `XiaohongshuTokenHandles` 将 xsec_token 留在父进程，用不透明 handle 提供给模型；`LeadArtifactStore` 校验媒体字节、路径和文件身份，但当前仅 activation 内有效，且无 video MIME。

## 三种方案

| 方案 | 优点 | 缺陷 / 结论 |
|---|---|---|
| 模型读聊天后自行判断、或复用 ship 批准 | 改动少 | 内容无绑定、无法证明 founder 身份、可重放；拒绝 |
| 客户端各自校验一张签名票据 | 可以离线验签 | 签名不能解决两端并发消费；Claude 原始 MCP/REST 旁路仍存在；拒绝 |
| 可信 Bridge 保存冻结请求与批准，统一写出口原子消费 | 一个权威、可审计、跨模型互斥 | 必须封闭 provider 旁路、补账号身份和媒体持久化；推荐 |

## 选定体验

1. Lead 准备请求，系统冻结完整文字、目标、账号、图片/视频和选项；给每次修改新版本。
2. Discord 的可信审核卡展示所有会影响外部结果的字段。长文/媒体以同版本完整预览承载；未成功完整交付不能批准。
3. founder 明确回复所绑定卡片的批准指令。Bridge 重新获取 Discord 原始消息，校验真实作者、频道、回复关系、版本和有效期；普通“好”、模型转述和页面意见均无效。
4. broker 验证账号与字节未变，在同一数据库事务内将批准置为已消费并登记唯一尝试，然后最多发送一次。
5. 网络超时或崩溃后显示“结果未知，可能已发出”；自动重试只能查询状态。再次发送必须新卡、新批准。

## 不可弱化的约束

- 内容 digest（固定内容计算出的指纹）覆盖账号、工具、目标、媒体字节与顺序、完整文本及所有选项；不使用仅标题、handle 或文件名的摘要。
- 账号用平台稳定 user ID，不用昵称、配置标签或“已登录”布尔值；验证和执行必须持有同一账号会话的独占租约。
- 回执只由可信 founder 入站处理器写入。Lead/API 请求不能自填批准人、批准时间、有效期或 accepted=true。
- 无回执、内容不符、账号改变、过期、重复消费均不得触达外部写；撤回也要明确时序边界。
- 两个 Lead 共同走同一出口；直接 MCP、REST、终端、已登录浏览器、cookies 及私有端口旁路均进入启用前证据。
- 媒体仅受控 artifact；冻结为不可变字节后预览与上传同源。禁止模型提供 URL/任意路径。
- 单次最多一次发送不等于外部平台恰好成功一次；不捏造幂等键或成功证据。

## 研究问题

确认现有 founder 消息绑定/身份源、Bridge 持久化事务、2519 运行时所有接入点；确定无原始 provider 旁路的部署形态；确认 2.0.0 的账号输出和动态商品/评论选择能否冻结；把这些必要改造纳入计划，不把缺口隐藏为未来可选项。

## R1修订收敛

最终采用独立OS账号运行XHS authority，它自己从Discord核验founder；Bridge和所有登录UID模型只作不可信请求者。批准账本离开teamlead.db，provider使用专用UID的headless会话。具体机制、路径属主和可执行探针见plan §2.2。
