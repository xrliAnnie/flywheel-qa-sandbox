# FLY-145 S6 retry Product-Test — 调研
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-26
基于: exploration.md

## 调研结论

系统机制具备 S6 所需的双层保护，但当前 sandbox 拓扑尚不具备可执行前提：部门 Lead 只有在“单一 @mention + 一个 issue id + 明确执行语义”同时出现时才允许启动，Bridge 又必须以部门范围闸门 on 运行。当前 repo harness 没有四 Lead 同读 `cos-test` 的模式，本 design DAG 的 slot 4 闸门还是 off。因此 FLY-145 不需要产品代码实现，但 QA 必须先取得独立 campaign 的 fan-out 与 gate-on receipts，缺一即 INCONCLUSIVE。

## 权威来源

### 1. FLY-127 原始实现与 PR

主仓 [`xrliAnnie/flywheel#170`](https://github.com/xrliAnnie/flywheel/pull/170) 是 FLY-127 的 Bridge 部门范围实现，核心决定是：

- `LeadConfig` 提供是否能启动 Runner 的授权位；
- `DepartmentRegistry` 根据项目、Lead 与 issue 标签进行分类；
- `/api/runs/start` 在 chat thread 注册和 dispatcher start（派发器启动，即真正创建 Runner 的动作）之前拒绝越界请求；
- 拒绝返回机器可读的 `DEPT_SCOPE_REJECT`，不依赖 Lead 自己遵守提示词。

当前 sandbox 仓库自己的 PR #170 是无关的 FLY-2248 generalized-DAG fixture。设计与 QA 引用必须带完整仓库名，避免编号碰撞。

### 2. 当前部门注册表

`packages/teamlead/src/department-registry.ts` 的判定顺序是：

1. `project_unknown`
2. `lead_unknown`
3. `lead_cannot_spawn`
4. `issue_no_department_label`
5. `issue_multiple_department_labels`
6. `label_mismatch`
7. `ok`

标签比较不区分大小写；非部门标签不会影响唯一部门标签的匹配。`canonicalLeadId`（规范 Lead 身份，即服务端根据标签确定的唯一所属 Lead）只在能够唯一解析时给出。

### 3. 当前 `/api/runs/start` 路径

`packages/teamlead/src/bridge/runs-route.ts` 当前行为：

- 先从 Linear 获取 issue 及 labels；
- label 读取失败会留下空标签，部门闸门随后按无部门标签拒绝；
- 明确提供或自动解析出 `leadId` 后，默认开启的 `BRIDGE_DEPT_SCOPE_REJECT` 会调用 `isLeadInScope()`；
- 拒绝返回 HTTP 403：`{ success:false, code:"DEPT_SCOPE_REJECT", reason, canonicalLeadId, silent:false }`；
- 只有通过后才继续 resume/admission/dispatcher 路径。

这证明 Bridge 能拦截“越界 Lead 已经错误地发起 start”的情形，但 `silent:false` 也说明：Bridge 拒绝不是 S6 的理想路径。S6 对被动跨部门噪声的预期仍是 prompt 层直接保持沉默、根本不调用 Bridge。

### 4. Lead 行为规则

`packages/teamlead/lead-rules-base/department-lead-rules.md` 明确区分：

- 直接启动必须同时具备：唯一 @ 到自己、正好一个 issue id、明确执行/归属转移语义；
- 被动看到别人的跨部门 spawn 指令：保持沉默，不调用 Bridge；
- 明确 @ 到自己或确认后的请求：允许调用 Bridge，再按 `DEPT_SCOPE_REJECT` 给一次诊断；
- 多 Lead 同时被 @ 的 spawn 指令：不启动，要求拆成 one Lead per spawn message。

`cos-lead-rules.md` 同时规定：无人点名时 cos Lead 是 default replier；点名某个 dept Lead 时 cos Lead abstain。因此裸 `FLY-145` 会产生与 issue 预期相反的正常行为。合法 S6 根消息必须只点名 test-2 并带执行语义：`<@1493072948683341976> 起 Runner FLY-145`。不能 @ 非所属 Lead，否则会把“被动噪声保持沉默”变成显式拒绝场景。

### 5. 自动化覆盖

`packages/teamlead/src/__tests__/department-registry.test.ts` 已覆盖：

- `Product`/`Operations` 等单标签归属；
- 多部门标签；
- 大小写不敏感；
- 错误 Lead 对单一部门标签产生 `label_mismatch`；
- 正确 Lead 通过。

`packages/teamlead/src/__tests__/start-e2e.test.ts` 已覆盖：

- `label_mismatch`、无部门标签、多部门标签与 `lead_cannot_spawn` 的 403；
- 403 时 dispatcher 未被调用；
- 正确标签 happy path 能启动；
- 回滚开关关闭时跳过检查。

这些测试证明机制存在，但不提供本轮真实 bot 行为证据。本设计阶段不改 TypeScript，因此本地不运行测试；下游也不得用全包测试代替现场 S6。

### 6. QA slot 与 FLY-145 锚点

当前 `/Users/xiaorongli/.flywheel/test-slots.json` 的非敏感投影确认：

| slot | bot | role | deptLabel | channel |
|---|---|---|---|---|
| 1 | `flywheel-test-1` | cos | `PM-Test` | `cos-test` |
| 2 | `flywheel-test-2` | lead | `Product-Test` | `product-lead-test` |
| 3 | `flywheel-test-3` | lead | `Ops-Test` | `ops-lead-test` |
| 4 | `flywheel-test-4` | lead | `Finance-Test` | `finance-lead-test` |

配置还存在 slot 5/6，但 issue 的 S6 验收范围明确是 1–4。QA 启动前必须确认本轮 production-mirror 注入把同一测试输入送到指定四个参与者；不能仅凭各 slot 的默认频道名推断它们都收到了消息。

当前 repo harness 的拓扑审计表明：slot mode 只订阅本 slot 的 channel；mirror mode 使用 `test-core-mirror` 且只支持 slot 1–3；roundtable mode 使用 `test-leads-roundtable`。没有一个现成模式能证明 slot 1–4 同时收到 `cos-test`。此外当前 design DAG 的 `/private/tmp/flywheel-test-slot-4/bridge-launch.json` 明确包含 `BRIDGE_DEPT_SCOPE_REJECT=off`，staged cos identity 未证明 test-2/3/4 bot id 在 abstain roster 内，而 Bridge 没有覆盖所有早期 4xx 的通用 access log。这些事实都是 QA execution blocker，不是可以用“零响应”绕过的细节。

现有 `scripts/qa-fly-1189-preflight.sh` 还提供了 FLY-145 的精确锚点示例：

```text
--expect-label Product-Test --expect-lead flywheel-test-2 --issue FLY-145
```

它能验证已生成 session 的标签、owner routing（owner routing，即已启动 Runner 归属到哪个 Lead）和 chat thread 绑定，但它发生在 spawn 之后，只能作为 test-2 正向链路的补充证据，不能证明 1/3/4 的沉默。

`scripts/qa-fly-1189-room-smoke.sh` 同样把 `FLY-145` 固定为 `Product-Test` 主 issue，说明该 sandbox issue 是既有 QA 夹具而非待实现功能。

## 数据与证据模型

每次 S6 attempt（尝试，即一次唯一测试消息及其完整观察窗口）需要以下字段：

```text
Attempt
  attempt_id        唯一值
  issue             FLY-145
  source_message    cos-test 消息 id / 时间戳
  started_at        观察起点
  ended_at          观察终点
  slots[4]
    slot_id         1 | 2 | 3 | 4
    bot_id          flywheel-test-N
    reacted         boolean
    start_count     integer
    spawn_count     integer
    evidence_refs   消息/事件/session 引用列表
  verdict           PASS | FAIL | INCONCLUSIVE
  cleanup           archived | retained
```

`INCONCLUSIVE` 与 `FAIL` 必须分开：若无法证明某个 slot 确实收到了广播或观察窗口未闭合，不能把缺证据写成“沉默”，应判 INCONCLUSIVE 并保留 issue。

## 迁移、回滚与清理边界

本任务没有 schema、配置或代码迁移。唯一状态变化是 QA 操作本身：发送一条测试消息、让正确 Lead 启动 Runner、最后在 PASS 后归档 fixture issue。

- 回滚不是关闭 `BRIDGE_DEPT_SCOPE_REJECT`；该开关会削弱受测机制，禁止为让测试通过而切换。
- 失败恢复是停止追加刺激、保存 attempt 证据、清理本轮测试 Runner（按 QA harness 的正常 teardown 流程）并保留 FLY-145 供复查。
- 只有 PASS 可以触发 archive；INCONCLUSIVE/FAIL 均不 archive。

## 风险与控制

| 风险 | 后果 | 控制 |
|---|---|---|
| 只观察频道、不查 start/spawn | 漏掉静默越界副作用 | 每 slot 同时核对消息与后台事件 |
| 四个 slot 未都收到同一输入 | 把“没收到”误判为“保持沉默” | 记录 fan-out/订阅证明；缺失则 INCONCLUSIVE |
| 根消息没有点名 test-2 | cos 正常回复、test-2 正常沉默却被误判 FAIL | 使用唯一合法指令 `<@1493072948683341976> 起 Runner FLY-145` |
| 任一 Bridge 闸门 off | 只测 prompt 层却宣称双层 PASS | 四个 launch receipt 都必须证明显式 enabled，或在完整清洗环境下证明 key 缺失从而使用 default-on |
| cos roster 不认识测试 bot id | cos 正常 default reply 被误报为规则失败 | 实际 staged identity 必须列出 test-2/3/4 bot id |
| 没有四路 HTTP ingress capture | 无法证明非 owner 没有发起早退 4xx start | capture 缺口一律 INCONCLUSIVE |
| DB 时间文本格式不同 | 字符串比较漏掉新 session 或纳入旧 route | 所有比较统一用 SQLite `julianday()` |
| 重发测试消息 | 重复 start/spawn，无法归因 | 每 attempt 只发一次并记录 message id |
| 用昵称判断身份 | 显示名变化导致归属错误 | 用 slot id、bot id、lead id 与标签绑定 |
| PR #170 仓库混淆 | 引用错误实现 | 始终写 `xrliAnnie/flywheel#170` |
| PASS 前归档 | 失去复查入口 | 清理作为 PASS 后最后一步 |
| 记录 token/credential | 证据泄密 | 只记录 id、时间、状态与脱敏引用 |

## 调研自检

- 结论同时由当前代码、当前规则、当前测试与主仓 PR 支撑。
- 明确区分了机制证据、现场行为证据与负向沉默证据。
- 记录了当前六 slot 配置与本 issue 四 slot 范围的差异，没有把额外 slot 悄悄纳入或忽略。
- 没有建议修改代码、关闭保护开关或扩大 issue 范围。
