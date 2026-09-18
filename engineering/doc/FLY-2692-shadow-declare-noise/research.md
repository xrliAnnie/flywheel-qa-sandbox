# FLY-2692 shadow-declare 去主频道噪音 — 调研
Issue: FLY-2692 (https://linear.app/geoforge3d/issue/FLY-2692/窄口自动批噪音-shadow-declare-不该要求-lead-在-founder-的主频道里发一串哈希当凭证founder-2026)
日期: 2026-09-17
基于: exploration.md

行号与行为以本分支基线 `f01754584` 为准。

## 1. 现有凭证强度从哪里来

`packages/teamlead/src/bridge/auto-merge-shadow-route.ts` 当前依次验证：

- 请求来自 loopback，且 body 只有声明 id、question、class、message ref；
- question 指向 `founder_gate + land + git_head` holder；
- holder 对应的 issue labels 精确解析到一个 Lead；
- Discord message 位于该 Lead 的 `chatChannel`，作者是该 Lead bot，正文逐字等于卡号与类别，未编辑；
- message timestamp 不早于 holder `created_at`；写前重读 holder，防止校验期间换卡。

这五步里，fleet ingest bearer 只保护 Bridge 路由，不证明调用者是某个 Lead。作者证明由 Discord bot message 提供。因此替换通路必须增加 Lead 身份证明，而不是仅移除 fetch。

## 2. 可复用的 Lead 强认证

`packages/flywheel-comm/src/lead-lease.ts` 已提供双端同构的活体机制：

- CLI `authorizeLeadWrite` 先由当前 `projects.json` 行计算 canonical identity digest。
- Claude Lead 成功结果为 `lease_validated`，携带当前 lease key + generation；但该 SQLite 文件与元组对同 UID Runner 可读，`LeadLeaseStore.validate` 不验证发起请求的进程身份，所以它只证明“当前 Lead lease 存在”，不能单独证明“请求由 Lead 发出”。
- Codex Lead 成功结果为 `carrier_passthrough`，携带当前 live carrier instance claim。
- Bridge 用 `forwardedLeadAuthorizationEnv` 从当前 registry 重建环境，再调用同一个 `authorizeLeadWrite` 重验。
- `postCarrierClaim` 限定 raw carrier claim 只能发到精确 loopback URL；raw claim 不应持久化或打印。
- `off`、`audit_allowed` 是兼容/审计模式，不等于当前活体已被证明，本声明入口应 fail closed。

Claude launcher 注入 `DISCORD_BOT_TOKEN`，Runner launcher 为了避免身份冒用明确删除该变量。因而新通路可在不触达 Discord 的前提下复用它作为 Lead-only HMAC key：

```text
HMAC-SHA256(botToken,
  JSON.stringify(["flywheel-shadow-declare-v1", declarationId,
                  questionId, declaredClass, leadId, projectName]))
```

CLI 计算 HMAC；Bridge 从该卡精确解析的 Lead 配置取得 bot token，用 `timingSafeEqual` 本地重算。HMAC 值和 token 都不入台账、不入日志。最终强 proof 是 Claude 的 `lease_validated + lead_hmac`，或 Codex 的 `carrier_passthrough`。只凭 ingest token 加可读 lease 元组的伪造请求必须失败。

`ship-judgment-reference-route.ts` 和 `auto-narrow-control-route.ts` 已采用“CLI 先验 + Bridge 重验 + strict body”的形状，可以直接复用，不需新认证系统。

## 3. 卡、类别和时间的绑定

- 卡：`question_id` 定位 `workflow_gate_holder`；route 只接受 land ship gate，并在写前用 `sameHolder` 重读。
- 类别：四值枚举已经在 CLI、route、StateStore 与 SQLite CHECK 四层固定。
- 时间：旧通路信任 Discord 返回的 server timestamp；新通路应只用 Bridge `now()` 生成 `declared_at`，并显式检查 `declared_at >= holder.created_at`。客户端不得提交 timestamp。
- 不可修改：`auto_merge_shadow_declaration_no_update` / `_no_delete` 已存在；新的 proof 字段应进入同一行、同一触发器保护范围。

这能逐项替代旧 proof：Lead-only HMAC/live carrier 替代 bot author；versioned canonical request 替代 message body；Bridge time 替代 Discord time；immutable row 替代“message 未编辑”。

## 4. 台账迁移约束

现表把 Discord proof 编成五个 `NOT NULL` 字段：channel id、message id、author id、message timestamp，以及 message id UNIQUE。新通路不能塞伪 snowflake；正确做法是把声明行升级为带类型的 proof union：

- `evidence_kind='discord_message'`：保留历史五字段，Lead identity digest/auth method 为空；
- `evidence_kind='lead_authenticated'`：Discord 字段全空，冻结 64 位 identity digest 与 `lead_hmac|carrier_passthrough`；
- `declared_by / question_id / declared_class / declared_at / declaration_seq` 对两种 proof 共用。

SQLite 不能原位放松 `NOT NULL`，需一次性 rebuild。仓库已有 `ship-judgment/evidence-migration.ts` 的安全模式：

1. 检查 receipt 与实际列严格一致，partial state fail closed；
2. 保存 foreign key/legacy alter pragma；关闭 FK enforcement，开启 legacy alter；
3. 在 IMMEDIATE transaction 中核对旧 schema 与两个 immutable trigger；
4. 建 next table、把历史行标为 `discord_message`、drop/rename、重建 trigger；
5. 只对 parent 与两个 child（`auto_narrow_opinion_snapshot`、`auto_narrow_decision_audit`）对比迁移前后的 foreign-key baseline，写 v2 receipt；禁止在约 2.2GB 的生产库启动路径跑全库检查；
6. finally 恢复 pragma。

新库直接创建 v2 schema；`evidence_kind` 默认 `discord_message`，使现有显式列 fixture 与历史导入保持兼容。历史值不改写，新的 nullable Discord 字段不允许形成半行。

## 5. 消费者与 FLY-2453 隔离

生产 reader 集被 `fly2398-narrow-boundary.test.ts` 冻结。声明消费者只关心 `declaration_id / question_id / declared_class / sequence`：

- FLY-2398 `shadow-table.sql` 仍从同表取每卡最新声明；四线定义不变。
- FLY-2453 opinion/eligibility/audit 仍引用同一 `declaration_id`；`decision_source='auto_narrow_gate'`、source envelope、founder gate 与 land path 不变。
- retention 分类仍是 `protectedCurrentOrReference`；不新增可删除的平行台账。

因此 proof transport 的升级不需要改任何授权 consumer。focused 回归必须包含 FLY-2398 boundary/report 与 FLY-2453 schema/approval tests，防止无意放宽。

## 6. 提示与 CLI 兼容

唯一生产提示位于 `hook-payload.ts`，当前明确要求 “post ... in your Lead channel”。改为直接运行 CLI，并写清 “do not post or relay”。`gate-question-render.test.ts` 固定该文本。

CLI 对外行为改为 `--question + --class` 即可。`--message-ref` 选项暂不净删除，但只要出现就 exit 1，并明确输出“已退役；不要把 shadow-declare 发到 Discord”。这样旧配方不会静默成功，生产提示也不再生成它；因为没有删除或改名子命令/选项，不触发 FLY-1914 消费者迁移。

## 7. 失败语义

- 缺少 Lead/project identity、CLI 本地强认证失败：usage/auth failure，零请求。
- Bridge 身份不匹配、Claude HMAC 缺失/错误、proof 不是强组合：403，零写入。
- 未知 question / 非 ship gate / holder 变化 / server time 异常：原有 fail-closed 语义延续。
- 同 declaration id + 同卡/类/Lead identity proof：replayed；任一绑定不同：409 conflict。若首次提交后响应丢失、随后 Lead registry 变化导致 identity digest 漂移，同 id 保守返回 conflict，调用者核实后使用新 declaration id。
- Bridge/network 返回未知：CLI 保留 declaration id，调用者用同 id 重试。

## 8. 精确修改面

- `packages/flywheel-comm/src/commands/shadow-declare.ts` 与单测：生成/提交 Lead auth proof，无 message ref 依赖。
- `packages/teamlead/src/bridge/auto-merge-shadow-route.ts` 与单测：lease + HMAC / carrier 强认证、server time、无 Discord fetch/post。
- `packages/teamlead/src/StateStore.ts` 与 shadow ledger tests：typed proof schema、legacy migration、direct append/replay。
- `packages/teamlead/src/bridge/hook-payload.ts` 与 render test：禁止 Discord post/relay。
- 不改 FLY-2453 control/approval/land implementation；只跑回归。
