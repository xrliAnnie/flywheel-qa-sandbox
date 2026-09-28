# FLY-2957 Codex 在飞热换号 — 探索
Issue: FLY-2957 (https://linear.app/geoforge3d/issue/FLY-2957/codex热换号-在飞-codex-runner-撞额度墙时原进程热换到有额度的号并自动续一轮不换体不丢上下文换体保留为兜底)
日期: 2026-09-28
基于: 无

## 一句话

Codex runner 撞额度墙后，优先把另一个可用账号的短期 access token 注入同一个 app-server 进程，并在同一 thread 自动发一轮“继续”；只有热换不可用或失败时，才进入现有待命／换体流程。

## 为什么要做

切换磁盘上的默认账号不会改变已启动进程内的凭据。9 月 26 日多个在飞 runner 因同一 business 账号周额度耗尽而同时停住，运营只能逐一保存 WIP、终止和重开；这保住了代码，却丢了进程内上下文并消耗数小时。

本单的成功标准不是“更快地换体”，而是以下身份全程不变：

- execution id 不变；
- thread id 不变；
- daemon PID/PGID 不变；
- 换号前只有线程知道的事实，换号后仍能回答。

## 已确认事实

1. Codex 的 `AuthManager` 启动时把凭据读入内存；额度墙不是 401，改 `auth.json` 不会触发重读。
2. app-server 的实验接口 `account/login/start` 接受 `chatgptAuthTokens`，可立即替换同一进程的内存凭据。
3. 外部 token 模式不自行 OAuth refresh；server 会在 401 时向客户端发 `account/chatgptAuthTokens/refresh`，要求 10 秒内响应。
4. 撞墙的那一轮已经失败，换号后必须在同一 thread 再发一次 `turn/start`。
5. 现有 FLY-2900/2925 已提供额度待命、换体和接管恢复；热换应位于它们之前，失败时不改变原终态与派单语义。

## 方案比较

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 改磁盘 `auth.json` | 简单 | 在飞进程不重读 | 拒绝 |
| 杀进程后 `thread/resume` | 已有兜底 | 换体、丢进程内上下文 | 保留为兜底 |
| 新建第二条 app-server 连接 | 隔离 | 双连接争用状态，重复协议实现 | 拒绝 |
| 同一 daemon client 调 `account/login/start` | 不换进程、不换 thread，研究已实测 | 依赖实验接口，Flywheel 要接管 token 回调 | 采用 |

## 建议边界

### 做

- `usageLimitExceeded` 被确认后，从只读号池挑选健康且支持目标模型的账号。
- 先安装 refresh 应答器，再注入 token、核对账号、钉回配置模型、发送带幂等 id 的“继续”。
- 每个 execution 串行热换；同一时刻最多一张未结算 grant，并排除本轮已失败账号。
- 成功写审计和 issue thread 一句话；失败才通知 Lead/founder。
- 升级时用协议 schema 冒烟，接口消失则自动关闭热换并走兜底。

### 不做

- 不写任何账号的登录态，不轮换 refresh token，不兑重置卡。
- 不把热换扩展到 review executor。
- 不依赖 Luna Reserve。
- 不试图挽救已经进行中的失败回合；只在明确额度墙终态后处理。
- 不把全局默认号切到候选账号；本单只改变目标 daemon 的内存凭据。

## 核心不变式

- token 只从只读凭据槽进入 Bridge 内存和 daemon socket；日志、数据库、outbox、异常文本都不得出现 token。
- 热换失败必须保留原 `usageLimited`/`unauthorized` 事实，不能伪造成功或吞掉 FLY-2900/2925 的兜底信号。
- 只有首个模型产出才证明续跑成功；`turn/start` 已发送但结果不确定时不得再创建第二个并发回合。
- 换后再次撞墙只归因到当前生效账号，不能错误冻结原账号下的其他 execution。
- 模型与 reasoning effort 属于节点配置，不属于账号；热换或换体后都必须保留。

## 推荐方向

采用“Bridge 授予一次性 grant，runner client 在同 daemon 中完成注入和续跑”的两层设计。Bridge 负责选号、持久化状态机、审计和兜底归因；client 负责协议时序和进程内安全边界。这样选号与凭据读取只有一个来源，daemon client 也不需要知道全局号池结构。

