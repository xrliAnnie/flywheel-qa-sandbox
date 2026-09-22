# FLY-2692 shadow-declare 去主频道噪音 — 探索
Issue: FLY-2692 (https://linear.app/geoforge3d/issue/FLY-2692/窄口自动批噪音-shadow-declare-不该要求-lead-在-founder-的主频道里发一串哈希当凭证founder-2026)
日期: 2026-09-17
基于: 无

## 1. 问题与用户结果

FLY-2398 让 Lead 在 founder 的工作频道先发 `shadow-declare <questionId> <class>`，再把 Discord message ref 交给 Bridge。消息只是代理声明凭证，不是 founder 批准，却出现在 founder 主频道；founder 已明确要求“post it to yourself instead of to discord”。目标不是换一种可见文案，而是让声明完全留在 Lead 与 Bridge 的内部认证通路里。

完成后的外部体验：ship 卡照常出现，issue thread 的机器意见照常更新，但 founder 主频道和 issue thread 都不再产生声明凭证文本。Lead 只在自己的运行上下文执行 CLI。

## 2. 当前事实

当前链路由四层组成：

1. `hook-payload.ts` 要求 Lead 在自己的 Lead channel 发精确正文，再运行 CLI。
2. `flywheel-comm shadow-declare` 要求 `--message-ref`，用 fleet ingest token 请求 Bridge。
3. `auto-merge-shadow-route.ts` 回读 Discord，检查频道、bot 作者、精确正文、未编辑和消息时间不早于卡创建。
4. `StateStore.recordAutoMergeShadowDeclaration` 向不可更新、不可删除的 `auto_merge_shadow_declaration` 追加一行；FLY-2453 的窄口逻辑和 FLY-2398 报表都读取这张表。

因此，单纯删掉 Discord 回读会丢失“是这个 Lead 说的”这层证明；单纯改投另一个 Discord channel 仍保留无业务价值的外部消息和 Discord 可用性依赖。

## 3. 设计假设

- Lead 运行时已有统一的 `authorizeLeadWrite` 活体校验：Claude Lead 走当前 lease，Codex Lead 走 live carrier claim；Bridge 可用同一验证器重验。但 Claude lease DB 对同一 macOS UID 可读，lease 元组本身不是 Lead 专属秘密，不能单独替代旧 Discord bot 作者证明。
- Claude Lead 还持有 Runner 被明确剥离的 `DISCORD_BOT_TOKEN`。它只作为本地 HMAC key，不发 Discord 请求；Bridge 用名册中的同一 bot token 重算。新凭证必须是 `lease_validated + lead_hmac` 或 `carrier_passthrough`；`off`、`unprotected`、`audit_allowed` 不足以声明。
- `workflow_gate_holder.created_at` 是卡创建的服务端权威下界；Bridge 当前时间是声明发生时间，不接受客户端时间。
- 历史 Discord 声明是有效历史证据，迁移必须原样保留，不能改写成新凭证。
- FLY-2453 的开关控制、founder 原消息验证、自动批准 source/actor、三闸和 `decision_source` 均不在本单修改范围。

## 4. 候选方案

### A. 直接 CLI → Bridge 强认证声明（选择）

CLI 在本地先验证当前 Lead write authorization，再把声明 id、卡号、类别和最小 Lead proof 发给 loopback Bridge。Claude 路径还用 Lead-only bot token 对 versioned canonical payload 做 HMAC；Codex 路径用 live carrier claim。Bridge 根据当前卡反解预期 Lead，重验活体与 HMAC/carrier，把服务端时间与身份摘要写进同一不可变声明台账。

优点：零 Discord 消息；认证强度来自当前 Lead 活体与配置身份；卡号和类别由签入请求及不可变行绑定；时间由服务端产生；不增加频道或 bot 运维。

代价：声明表要同时表达历史 Discord proof 与新 Lead-auth proof，并安全迁移已有行。

### B. 发到审计频道 / 机器 thread（不选）

优点：最小代码变化，继续复用 Discord 作者、正文、时间证明。

缺点：仍制造无业务价值的 Discord 消息；需要新频道权限、留存与回读可靠性；与 founder “post it to yourself instead of to discord”的追加方向相反。

## 5. 锁定边界

- 不改 ship 卡、issue thread 的机器意见内容与 FLY-2453 founder 控制消息。
- 不改三闸资格、自动批准 writer、land、review hold 或 founder approval 归因。
- 不清理历史声明，不伪造 Discord snowflake 作为内部凭证。
- 不把 fleet ingest bearer本身当 Lead 身份；它只保护路由，Lead 身份必须另外重验。
- 不把 raw carrier claim、bot token 或其他凭证写入台账或日志。

## 6. 验收映射

| 验收 | 证明方式 |
| --- | --- |
| 主频道和 issue thread 无声明文本 | prompt/render 测试不再要求 Discord post；CLI/route 测试证明无 Discord ref/fetch |
| 谁说的 | route 将卡的预期 Lead 与 `lease + Lead-only HMAC` 或 live carrier 对齐；行冻结 `declared_by`、identity digest 和 auth method |
| 哪张卡、哪个类别 | 严格 body + 当前 ship holder + 不可变 `(question_id, declared_class)` |
| 发生在出卡后且未改过 | Bridge 服务端时间显式不早于 holder `created_at`；no-update/no-delete triggers |
| 四线与 decision_source 不变 | 继续写 `auto_merge_shadow_declaration`；FLY-2398 报表与 FLY-2453 focused regression 全绿 |
