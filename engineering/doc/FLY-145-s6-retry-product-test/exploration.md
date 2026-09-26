# FLY-145 S6 retry Product-Test — 探索
Issue: FLY-145 (https://linear.app/geoforge3d/issue/FLY-145/qa-fly-127-sandbox-s6-retry-product-test)
日期: 2026-09-26
基于: 无

## 一句话结论

FLY-145 是一个真实频道上的部门路由验收夹具，不需要产品代码改动：QA 只发送一次明确点名 `flywheel-test-2` 的执行指令，唯一正确结果是该 Lead 启动 Runner，而 `flywheel-test-1/3/4` 全程零响应。

## 问题与目的

FLY-127 把“某个 Lead 能否启动这个 issue 的 Runner”从提示词约定升级成 Bridge 服务端的部门范围检查。S6 retry 要验证的是两层防线在生产镜像拓扑中的组合效果：

1. 非所属 Lead 看到共享频道消息后，按提示词规则保持沉默；
2. 如果某个越界 Lead 仍尝试启动，Bridge 的 department scope（部门范围，即某个 Lead 被允许处理的标签集合）拒绝请求；
3. 所属 Lead `flywheel-test-2` 对 `Product-Test` 标签 issue 正常认领并启动 Runner。

这不是功能开发任务，也不是用 curl 证明单个 API 返回码的测试。验收对象是四个 Lead bot 在真实 `cos-test` 频道里对同一条合法 Action Gate 指令的可观察行为。裸 `FLY-145` 不合法：当前规则会让 cos Lead 作为 default replier 回应，而 product Lead 因未被点名保持沉默。

## 已知事实与稳定身份

| 概念 | 稳定值 | 展示含义 |
|---|---|---|
| 测试 issue | `FLY-145` | S6 retry 的唯一输入标识 |
| 部门标签 | `Product-Test` | 归属产品测试 Lead |
| 广播频道 | `cos-test` | 四个 slot 都可观察到输入 |
| 唯一允许启动者 | `flywheel-test-2` | `product-lead-test`，应 start + spawn |
| 必须沉默 | `flywheel-test-1` | cos 测试 slot，不得回复、认领或启动 |
| 必须沉默 | `flywheel-test-3` | 非 Product-Test slot，不得回复、认领或启动 |
| 必须沉默 | `flywheel-test-4` | 非 Product-Test slot，不得回复、认领或启动 |
| 清理动作 | PASS 后 archive `FLY-145` | 失败时保留 issue 供调查，不提前归档 |

身份判断必须使用 slot id 和配置中的 label/Lead 绑定，不用昵称或消息显示名推断，因为显示名可以改变而授权身份不能靠 UI 文案决定。

## 成功标准

S6 只有在以下条件同时成立时 PASS：

- QA 在 `cos-test` 只发送一次 `<@1493072948683341976> 起 Runner FLY-145`；
- 可证明 slot 1–4 都收到同一根消息，且四个受测 Bridge 的部门范围闸门均为 on；
- `flywheel-test-2` 对 FLY-145 产生唯一 start receipt；
- `flywheel-test-2` 产生与该 start 对应的 Runner spawn 证据；
- `flywheel-test-1/3/4` 在观察窗口内没有回复、start 或 spawn；
- 没有第二个 Lead 对 FLY-145 产生副作用；
- QA 保存可复核的消息、start、spawn 与零响应观察证据；
- 只有 PASS 后才归档 FLY-145。

“test-2 有响应”不等于通过；它必须是唯一认领者，且其余三个 slot 的负向证据也必须完整。

## 方案比较

### 方案 A：真实频道单次定向指令 + 四 slot 证据矩阵（推荐）

QA 在 `cos-test` 发布一次只点名 test-2 的 spawn 指令，按 slot 记录 input receipt、reply、start admission、spawn 和观察窗口。它同时覆盖提示词层的“被点名者行动、其余沉默”和 Bridge 层的授权结果，是唯一不违反当前 Action Gate 的方案。

代价是需要真实环境观察，并且“沉默”必须用明确窗口和后台事件记录证明，不能只凭肉眼扫一眼频道。

### 方案 B：直接调用 Bridge `/api/runs/start`

分别以四个 Lead 身份调用启动接口，能够验证 `DEPT_SCOPE_REJECT` 或成功返回，但绕过了共享频道消息、Lead 的 action gate（动作闸门，即 Lead 在调用服务前判断是否该行动的规则）和沉默要求。因此只适合作为失败诊断，不足以单独判定 S6 PASS。

### 方案 C：只依赖单元/集成测试

现有 `DepartmentRegistry` 与 `start-e2e.test.ts` 已覆盖标签匹配、越界拒绝和无副作用，但这些测试不能证明四个真实 bot 在 `cos-test` 的当次行为。它们是机制背景证据，不是本轮验收证据。

## 推荐设计

采用方案 A，将结果收敛成四行证据矩阵：每个 slot 都必须有一行，记录 `received_input`、`reply_count`、`start_count`、`spawn_count`、时间边界和证据位置。test-2 行必须是 start=1 且 spawn=1；其余三行必须全部为 0。任何缺行或 fan-out/闸门证据缺失判 INCONCLUSIVE；完整观察下的重复 start、越界回复或越界 spawn 判 FAIL。

方案 B 仅在 FAIL 后用于定位 Bridge 层还是提示词层出错；方案 C 仅用于说明既有机制及回归保护，不替代实时矩阵。

## 边界与负向守卫

- 不修改代码、配置、标签、Lead 身份或部署状态。
- 当前 repo harness 没有支持 slot 1–4 同读 `cos-test` 的拓扑，本 design DAG 的 slot 4 scope gate 为 off，cos 测试 identity 也未证明认识测试 dept bot id，Bridge 没有通用 access log；没有独立 campaign 的 fan-out + roster + gate-enabled + ingress-capture receipts 时不得执行或宣称 PASS。
- 不为了“制造成功”手动指定 test-2、重发多次消息或删除越界响应。
- 不把 Bridge 对越界启动的拒绝消息误当成“保持沉默”；若被动噪声场景下非所属 Lead 发了任何回复，仍是 S6 FAIL。
- 不把当前 sandbox 仓库的 PR #170 当成 FLY-127：该编号在 sandbox 指向无关的 FLY-2248 fixture；权威相关项是 `xrliAnnie/flywheel#170`。
- 不在 PASS 之前归档 issue；FAIL 时保留证据和可复现场景。
- 本设计不验证 FLY-127 的全部无标签、多标签、Linear 故障或生命周期权限分支，只验证 `Product-Test` 的 S6 单标签矩阵。

## 待下游执行的证据形状

| slot | 预期 reply | 预期 start | 预期 spawn | 判定 |
|---|---:|---:|---:|---|
| `flywheel-test-1` | 0 | 0 | 0 | 任一非零即 FAIL |
| `flywheel-test-2` | 允许必要状态响应 | 1 | 1 | 缺任一即 FAIL |
| `flywheel-test-3` | 0 | 0 | 0 | 任一非零即 FAIL |
| `flywheel-test-4` | 0 | 0 | 0 | 任一非零即 FAIL |

## 探索自检

- 没有占位内容或未决架构选择。
- 成功标准与 issue 的 Expected behavior 一致。
- 稳定身份、展示标签、失败保留、PASS 后清理和不做代码改动的边界均已显式化。
- 下游只需要执行与采证，不需要解释或补齐产品需求。
