# FLY-2692 shadow-declare 去主频道噪音 — 实施计划
Issue: FLY-2692 (https://linear.app/geoforge3d/issue/FLY-2692/窄口自动批噪音-shadow-declare-不该要求-lead-在-founder-的主频道里发一串哈希当凭证founder-2026)
日期: 2026-09-17
基于: research.md

## 1. 目标与不做

把每张 ship 卡的 Lead 类别声明从“Discord 消息作为凭证”改成“当前 Lead 强认证 + Bridge 服务端时间作为凭证”，同时继续写入既有不可变声明台账。

本单不改：FLY-2453 mode 开关、founder 控制消息校验、机器三闸、`decision_source`、auto source/actor、review hold、land、ship 卡或 issue thread 的机器意见。

## 2. 新声明合同

### 2.1 CLI

生产命令：

```text
flywheel-comm shadow-declare --question <questionId> --class <class>
```

CLI 必须：

1. 校验 question、四值 class、declaration UUID、Bridge URL/token、当前 `FLYWHEEL_LEAD_ID` 与 project。
2. 调 `authorizeLeadWrite`。Claude 路径只接受 `lease_validated`，并要求 Lead 进程专有的 `DISCORD_BOT_TOKEN`；对 versioned canonical payload 计算 HMAC-SHA256。Codex 路径只接受 `carrier_passthrough`。
3. 对 carrier proof 使用 `postCarrierClaim`，从而强制精确 loopback；lease + HMAC proof 也把 Bridge URL 限定为精确 loopback。任何 token、raw carrier claim 或 HMAC 都不打印。
4. request 不包含 message ref、client timestamp、`declared_by` 或 run id。
5. 网络/Bridge 未知时打印同一 declaration id，允许幂等重试。

`--message-ref` 保留一轮作为明确退役护栏：只要传入就 exit 1，并输出“该选项已退役；不要把 shadow-declare 发到 Discord”。旧配方不能静默成功。

### 2.2 Bridge body

严格 body：

```ts
{
  declaration_id: UUIDv4;
  question_id: string;
  declared_class: "pure_docs" | "config_only" | "single_point_change" | "other_code";
  lead_auth: {
    lead_id: string;
    project_name: string;
    identity_digest: lowerHex64;
    proof_method: "lead_hmac" | "carrier_passthrough";
    lease_claim?: { lease_key: string; generation: positiveInt };
    hmac_sha256?: lowerHex64;
  };
  carrierClaim?: string; // 只用于内存重验，绝不持久化/打印
}
```

Bridge 顺序：

1. loopback + strict parse；定位 current land ship holder。
2. 从 run/project/labels 反解该卡预期 Lead；body lead/project 必须完全相等。Claude HMAC 路径只从这个服务端解析结果取得 bot token，不信 body 提供任何 key；不要求 Discord channel/user id，也不发 Discord 请求。
3. 用 `forwardedLeadAuthorizationEnv + authorizeLeadWrite` 重验。`lead_hmac` 必须得到 `lease_validated`，并以 `timingSafeEqual` 验证 versioned canonical HMAC；`carrier_passthrough` 必须得到同名 disposition 和 live raw carrier claim。返回的 digest 必须等于 body digest。
4. `declaredAt = now()`；timestamp 必须 canonical/finite 且不早于 holder `created_at`。
5. 对已有 declaration id 做 proof-aware replay/conflict 判断。
6. 写前重读 `sameHolder`，再向 StateStore 追加。

任何一步失败均零 Discord 调用、零台账写入。

## 3. 台账 v2

`auto_merge_shadow_declaration` 保持表名、主键、question/run/class/Lead/sequence/time 与两个 immutable triggers，增加：

- `evidence_kind`: `discord_message | lead_authenticated`，默认历史类型；
- `lead_identity_digest`: 新类型必填 lower-hex SHA256，历史类型必须 NULL；
- `lead_auth_method`: 新类型只允许 `lead_hmac | carrier_passthrough`，历史类型必须 NULL；
- 旧 Discord 四字段与 `message_ts` 改 nullable；历史类型必须全部合法且非空，新类型必须全部 NULL。

历史 row 原值逐字复制，只补 `evidence_kind='discord_message'`。新 row 不产生伪 channel/message/author id，也不持久化 HMAC、token、lease 或 carrier claim。canonical replay 比较 question、class、Lead、evidence kind、digest/auth method；Discord 历史分支继续比较 channel/message。旧的 StateStore Discord input 不要求 `evidenceKind`，缺省为 `discord_message`，保证 FLY-2453 现有调用与 fixture 不改。

迁移新增 receipt `fly-2692-shadow-lead-auth-v2`。receipt/schema 不一致、未知旧 schema/trigger、迁移新增 FK violation 均 fail closed。迁移临时关闭 FK enforcement 并用 `legacy_alter_table=ON`，IMMEDIATE transaction 完成 copy/drop/rename/trigger/receipt 后恢复 pragma；重开幂等。FK baseline 只检查 parent 与 `auto_narrow_opinion_snapshot` / `auto_narrow_decision_audit` 两个 child，不在启动路径跑全库检查。

## 4. TDD 批次

### C1 — prompt 与 CLI RED → GREEN

先改/加测试：

- gate question 不再含 “post in your Lead channel” 或 `--message-ref`，明确 `do not post or relay`；
- CLI 在没有 message ref 时发送；request 只有声明、question/class、Lead proof；
- lease + HMAC 与 carrier 两条正向；缺 Lead/project/token、弱 disposition、auth failure、非 loopback均零请求；
- 传 `--message-ref` 明确 exit 1 并提示不得向 Discord 发声明；CLI usage 同步更新；
- retry id、created/replayed 与 Bridge rejection exit code 保持。

最小实现后跑这两份 focused tests。

### C2 — route RED → GREEN

先把 route fixture 改为 Lead-auth request，并新增：

- 当前卡预期 Lead + `lease_validated + lead_hmac` / `carrier_passthrough` 创建成功；record input 冻结 identity digest/auth method/server time，Discord 字段为空；
- strict body、未知/非 ship gate、无 label 精确 Lead、Lead/project/digest 不匹配、HMAC 缺失/错误、弱 auth、auth failure、非 loopback均拒绝；
- 只凭 ingest token 与可读 lease 元组拼出的请求必须被拒绝；HMAC/token 不进入 row 或 response；
- server time 早于卡、非法 server time、holder race 均拒绝；
- proof-aware replay/conflict；所有失败零 write；确认 fetch Discord 永远不在依赖面。

最小实现只替换声明 proof，不改 router mount 或其他 workflow route。

### C3 — StateStore schema/migration RED → GREEN

测试覆盖：

- 新库 v2 列/constraints/triggers/receipt，重开 schema 完全不变；
- legacy DB 含一条 Discord 声明及 FLY-2453 child reference，重开后历史值不变、child FK 仍有效、proof 类型正确；
- direct Lead-auth row 两种强 method 的 append/replay/sequence；半 Discord row、半 Lead-auth row、弱 method、坏 digest 由 SQL 与 API 双层拒绝；row 的 Discord 字段类型改成 `string|null`，replay 必须按 evidence kind 分支；
- immutability 仍阻止 proof 字段 update/delete；历史 message uniqueness 仍有效，direct rows不依赖 message id。

实现 typed input/row mapping、v2 DDL 和一次性 rebuild。

### C4 — 回归与边界

Focused：

- `shadow-declare.test.ts`
- `auto-merge-shadow-route.test.ts`
- `gate-question-render.test.ts`
- `founder-gate-bot-token.test.ts`（精确 Lead/bot token 解析边界）
- `StateStore.auto-merge-shadow.test.ts`
- `StateStore.auto-narrow-schema.test.ts`
- `StateStore.auto-narrow-approval.test.ts`
- `fly2398-narrow-boundary.test.ts`
- `scripts/__tests__/fly-2398-shadow-table.test.mjs`

静态断言：生产 prompt/source 不再要求 post `shadow-declare` 到 Discord；route 不 import/fetch Discord；FLY-2453 approval/land readers没有新增读取路径。

## 5. 全仓验证

按实现节点合同运行：

```text
pnpm lint
pnpm -r build
pnpm test:packages:run
```

再运行本改动涉及的 `scripts/__tests__/*.test.mjs|sh`。若聚合只剩已知 onTaskUpdate RPC 错误，保留完整 PACKAGE_GATE_RECEIPT；否则修复本单造成的失败。任何测试命令都避开会打开真实 GUI 的 `tmux-viewer.macos.test.ts`。

## 6. 评审、提交与 PR

1. 设计评审 APPROVED 后进入 implement。
2. 每个行为批次按 RED 证据 → 最小 GREEN → refactor；更新 progress cursor。
3. 完成 focused/aggregate verification 后写 `engineering/doc/milestones/FLY-2692.md`，它是 PR 前 literal last commit。
4. push feature branch，开 PR；在 exact PR head 请求 code review。CHANGES 只修阻塞 finding，产生新 head 后重新评审。
5. 核 exact-head CI，不合并、不部署、不 dispatch QA。
6. `ask --report` 后用 `complete --route needs_review --pr <number>`。

## 7. 回滚与部署边界

运行代码回滚后，v2 表仍兼容历史 reader，但旧 route 不会生成 lead-auth rows；因此发布回滚必须保留 v2 schema/receipt，不尝试倒迁数据。`lead-lease mode=off` 或 audit-only 下的 lease fault 会安全停止新 shadow 声明，使 gate2 缺线；CLI 必须区分本地 disposition 不足与 Bridge 拒绝，方便运维诊断。新代码部署前 Lead 已暂停声明是业务上可接受的临时缺线；本 implement 节点不重启 Bridge、不恢复生产发声明、不验证真实 founder 频道。

## 8. 完成判据

- 自动提示与 CLI 均不要求 Discord post/message ref。
- Bridge 创建 direct row 前用 Claude lease + Lead-only HMAC 或 Codex live carrier 双端证明当前、正确的 Lead；server time 在卡后；row 不可修改。
- 历史 Discord rows 原样可读；FLY-2398 四线 report 和 FLY-2453 auto decision tests 不变。
- focused、build/lint/package aggregate、code review、exact-head CI、PR 和结构化 handoff 各自有独立证据。
