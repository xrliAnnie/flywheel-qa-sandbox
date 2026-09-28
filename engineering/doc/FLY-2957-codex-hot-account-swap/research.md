# FLY-2957 Codex 在飞热换号 — 调研
Issue: FLY-2957 (https://linear.app/geoforge3d/issue/FLY-2957/codex热换号-在飞-codex-runner-撞额度墙时原进程热换到有额度的号并自动续一轮不换体不丢上下文换体保留为兜底)
日期: 2026-09-28
基于: exploration.md

## 证据范围

本设计以三类证据交叉核对：题面给出的 FLY-2951 结论；当前 QA sandbox 的 Flywheel 架构；同机只读生产工作树 `/Users/xiaorongli/Dev/flywheel-FLY-2957` 中已经过多轮实现与测试的目标接口。生产树只作为研究证据，本节点不修改它。

## 协议能力

| 能力 | 结论 | 设计约束 |
|---|---|---|
| `InitializeCapabilities.experimentalApi` | 必须为 `true` | initialize 明确声明；缺失则热换直接 decline |
| `account/login/start` + `chatgptAuthTokens` | 可立即替换内存凭据 | access token/account id 只走进程内 RPC |
| `account/read` | 可核对实际账号 | login 响应成功后仍要做身份一致性检查 |
| `model/list` | 可判断目标模型是否可用 | 候选号不支持配置模型时排除并试下一号 |
| `thread/settings/update` | 实验接口 | 等 `thread/settings/updated` 确认，避免 TUI 留在 reserve 模型 |
| `account/chatgptAuthTokens/refresh` | server→client 请求，10 秒超时 | handler 必须在 login 前绑定，9 秒内确认写回 |

接口标为内部实验能力，因此不能只靠运行期失败发现兼容性。升级冒烟应离线生成 schema，检查 initialize 能力、login 变体、refresh 请求和 thread settings 四项，并按 Codex 版本保存能力锁。

## 现有执行时序

`runGoalToTerminal` 观察到 `usageLimited` 时，daemon 仍活着；进程只在 adapter 外层清理阶段停止。因此正确插入点是 goal 终态结算之前，而不是 Bridge 收到最终 failure signal 之后。

FLY-2900 已有带标记的额度恢复回合：先 `turn/start`，再 `thread/goal/set active`，并以该回合首个模型产出作为成功证据。热换应复用这条时序和文案，不另造“继续”协议。重复派发的幂等键使用 grant id。

## 组件边界

### Runner client

`packages/claude-runner/src/codex-daemon-client.ts` 负责 JSON-RPC 请求、server-request 应答、goal/turn 事件和终态结算。它不应读取号池。

新增的 runner 会话对象放在 `packages/claude-runner/src/codex-quota-hotswap.ts`，职责是：

- 串行所有 login（首次换号、daemon 重装、同号 token 续期）；
- 在 login 前绑定 refresh handler；
- 保存当前 installed/running grant 与失败排除集；
- 在 daemon 重启时重装已实际运行过的账号；
- 在 token `exp - 30min` 只读请求更新 token，并在同进程重注入；
- 结束时清理 timer 与 handler。

### Bridge service

`packages/teamlead/src/codex-quota/hotswap-service.ts` 负责：

- 从 `codex-accounts.json` 读取新鲜额度读数；
- 读取并核验候选槽中的 access token/account id；
- 以 CAS 状态机发放和结算 grant；
- 保存当前有效身份，让换后墙正确归因；
- 提供 refresh/续期的只读 token 解析；
- 写审计、outbox 和能力锁。

runner 与 Bridge 之间只交换一次性 grant 和机器码，不让 client 理解账号注册表、SQLite 或告警策略。

## 选号规则

候选必须同时满足：

- `authHealth === "valid"`，identity 非空且不在本 execution 排除集；
- 至少一个额度窗口已知，所有已知窗口 `<100%`，没有未分类窗口；
- 读数不超过 5 分钟且未来时钟偏差不超过 60 秒；
- 槽文件可读，账号 id 与注册表一致；
- access token 距过期至少 1 小时；
- `model/list` 包含配置模型。

排序为：最早重置时间 → pro/plus/business/team/enterprise 档优先 → profile 名称。排序只决定候选顺序，不承诺独占容量；同一账号仍可服务多个 runner。

## 状态与持久化

一个 execution 同时最多有一张未结算 grant。建议状态为：

`granted → installed → swapped → continued`，失败可从任一未完成状态进入 `failed`；Bridge 接管同一存活 daemon 时可以转移 owner，但不能把半截 continue 猜成成功。

另有一条“当前 daemon 实际安装身份”记录。它不能在 grant 被替换时提前删除，因为 A→B 已运行、随后申请 C 但 C login 失败时，最终墙仍应归因 B。身份只在终态信号与入库事务一起退役，或确认 daemon 已死亡时清理。

## 不确定窗口与失败语义

| 场景 | 处理 |
|---|---|
| login/mode pin 明确失败 | 排除候选，最多再试；之后原样进入额度兜底 |
| `turn/start` 明确未到 daemon | 可用同 grant id 重发一次 |
| `turn/start` 可能已到 daemon | 不创建第二回合；停止当前 daemon，交 FLY-2900/2925 恢复 |
| continue 首个模型产出 | 标记 `continued`，回主循环 |
| continue 再次 `usageLimitExceeded` | 排除当前号，回到选号入口 |
| 热换后 401 | 尝试槽内更新 token；仍失败则换下一号；无号时进入换体 |
| 无可用号 | 保持排队/待命，不重复派单 |
| 协议不支持 | 按版本锁死热换、告警一次、自动兜底 |

## FLY-2902 / FLY-2925 关系

- 本单不依赖 FLY-2902 的每体凭据副本：主行为只改 daemon 内存。若其已合入，热换后的槽绑定必须走它唯一的 `commitCredentialChange` 入口，不能旁路写链接。
- FLY-2925 允许 Bridge 接管存活 daemon：接管时按 PGID/实例身份恢复 running grant、重新绑定 refresh handler，并从号槽只读载入当前 token；半截 grant 标记失败，不做无证据的 live adoption。

## 审计与可见性

审计至少包含 execution id、thread id、daemon instance/PGID、旧/新 profile 或脱敏 identity、phase、detail code、duration。绝不存 access token；token 只可保存不可逆短指纹。

成功只写 issue thread 一句话，避免打扰 founder；失败、协议消失、token 续期不可用才走 MetaAlert。所有 user/issue/profile 派生文本在 HTML 或消息模板里转义/白名单化。

## 验证边界

本地只跑相关测试文件，并遵守以下选择：

- `packages/claude-runner/test/codex-quota-hotswap.test.ts`
- `packages/claude-runner/test/codex-daemon-client.test.ts`
- `packages/claude-runner/test/codex-quota-resume-preflight.test.ts`
- `packages/teamlead/src/codex-quota/__tests__/hotswap-candidate.test.ts`
- `packages/teamlead/src/codex-quota/__tests__/hotswap-service.test.ts`
- 受接线影响的精确 Bridge 测试文件
- 每个 changed TypeScript 集合额外执行 owning package 的 `vitest related <changed-files> --run`

不得用 bare `vitest`、package 全量 test 或目录/glob 代替精确文件。真房验收还必须证明 execution/thread/PID/PGID 不变和上下文暗号保留；单测无法替代这项证据。

