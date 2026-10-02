# FLY-3138 安装包发布流水线 wrangler→cf — 设计评审记录
Issue: FLY-3138 (https://linear.app/geoforge3d/issue/FLY-3138/cloudflaref5挂起-安装包分发的发布流水线从-wrangler-改用-cf-触发条件cf-正式版发布)
日期: 2026-10-02
基于: plan.md

Codex 设计评审（gpt-6-astra / xhigh，thread `01a0fbfa-a8cc-7271-a25a-9837adf705b5`）**3 轮 APPROVED**，批准的 plan blob = `7d8e51ad83fe6862fbafa8f7252a0eff8463b594`（request `2b410631-…`）。批准范围限于「GA 闸门式设计」，单子继续挂起。

| 轮次 | 结论 | 发现 | 处理 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 2 HIGH + 3 MED | 全部采纳 |
| R2 | CHANGES REQUESTED | 1 MED | 采纳 |
| R3 | APPROVED | 0 | — |

## R1 发现与处理
1. **HIGH 假成功**：密钥已存在时，`Aborted.`/exit 0 + 「名单里有这个名字」仍会通过；批次末才检查破坏 B4「首个失败即停」。→ 新闸门 G2：每次写入必须有可靠成功回执，helper 逐个解析、失败即停；名单读回降为补充。部署 E 也要回执 version/deployment ID + 活动部署读回。
2. **HIGH 部署抹密钥**：普通 `cf deploy` 是否保留未声明的 `FW_OPS_ADMIN_TOKEN_SHA256` / B4 没有成为前置闸门；声明 `bindings.secret()` 可能与「F/G 部署后才写 hash」形成循环。→ 新闸门 G4（文档/钉定源码证据）+ 分支 D；默认不声明任何密钥；E 内部署前后名单比对（F/G 之前）。
3. **MED 身份校验**：比较常量不能证明实际配置正确。→ 改为校验求值后配置 / Build Output + 远端设置读回（含 signer 文本绑定），加变异测试。
4. **MED dry-run 判别**：配置里「是不是 dry-run」无可靠判断。→ 取消判断：配置永远严格；CI 只传全零哨兵；activation 拒绝哨兵。新闸门 G5。
5. **MED 打包证据**：降级方案漏了 aws4fetch。→ 两条路径都覆盖三项 + 无 bare import 断言 + 变异测试。

## R2 发现与处理
1. **MED**：`FW_R2_ACCOUNT_ID` 只注入 E，更早的 B2 求值配置会缺参。→ 放到 activation job 级 env；守卫前移到首个 Guards 步骤；加 workflow 接线合同测试（「只在 E 注入」变异必须失败）。

## 非阻塞提醒（来自 R3，实施时照做，不改 plan）
- 实施时按计划执行接线合同测试与 GA 核对（§2 V1–V11），它们是已接受的验证要求。
