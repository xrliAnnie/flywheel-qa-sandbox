# Research: 在飞 Codex runner 原进程换号续跑 — FLY-2951

**Issue**: FLY-2951（[Codex·研究] 在飞 Codex runner 能否不换体、原进程直接换号续跑）
**Date**: 2026-09-26
**Codex 版本**: `codex-cli 0.157.1`（源码：openai/codex tag `rust-v0.157.1`，commit `36650394c5b3`）
**性质**: 研究单，只出结论，未改生产代码、未动生产登录态

---

## 给 founder 的一段话结论

**部分能做。** 正在跑的 Codex 进程**可以不重启就换号**，但不是靠改 `auth.json`：
Codex 故意不读磁盘上换了号的凭据。能用的是 app-server 的一个接口，它可以把新号的 token
直接塞进正在跑的进程。本机实测：一个已经撞额度墙的号，在同一进程里热换到另一个号之后，
**同一个对话线程接着跑**，也还记得换号前的上下文。

和 Claude 比，还差三点：

1. 撞墙那一轮已经失败了，救不回来，需要 Flywheel 自动再发一句“继续”；
2. 这个接口被 Codex 自己标成“OpenAI 内部使用、不稳定”，以后升级可能失效；
3. Flywheel 要负责给这些进程续 token。

「Luna Reserve」是撞墙号**自己**附带的一小桶备用额度，不是别的号，也不花钱。
只有挂着 TUI 窗口的 runner 才会自动切过去。9-26 晚那一桶在 UTC 01:18 到 01:23 这 5 分钟里，
从 65% 用到了 100%，现在已经用完，**扛不住额度墙，不能依赖**。

**建议开实现单**：让 Bridge 给在飞的 Codex 进程热换号，然后自动续一轮。这是一条快路径；
FLY-2902 + FLY-2900 的“换体”方案保留，作为兜底。

---

## Q1 运行中的进程能否不重启换凭据？

### 源码结论

| 途径 | 能否热换到**另一个号** | 依据 |
|---|---|---|
| 改写 `$CODEX_HOME/auth.json`（`codex-profile use` 的做法） | ❌ **不能** | `AuthManager` 启动时把凭据读进内存，文档注释写明外部修改不会被观察到（`login/src/auth/manager.rs:2039`）。磁盘重读只发生在两处：proactive refresh（`refresh_token`，:2848）和 401 恢复（`UnauthorizedRecovery`，:1855），两处都走 `reload_if_account_id_matches`（:2487）：**磁盘上的 account_id 跟进程当前的号不一样，就直接跳过**，报 account mismatch。也就是说，读取磁盘上的新号这件事是被**故意禁止**的 |
| 额度墙（usageLimitExceeded） | ❌ 不触发任何重读 | 恢复状态机只在 HTTP 401 时进入；额度墙不是 401，turn 直接 `failed`，`willRetry:false` |
| 信号 / 文件监听 | ❌ 没有 | 源码里没有针对 auth 的信号处理或 file watcher |
| app-server `account/login/start {type:"chatgpt"}` / `chatgptDeviceCode` | ⚠️ 能，但要浏览器或设备码交互 | 登录完成后调用**无条件** `auth_manager.reload()`（`app-server/src/request_processors/account_processor.rs:945`）。无人值守的 runner 用不了 |
| app-server `account/login/start {type:"apiKey"}` | ⚠️ 能，但属于付费 API | :455，违反约束，不考虑 |
| **app-server `account/login/start {type:"chatgptAuthTokens"}`** | ✅ **能，无需交互** | 客户端直接传入 `accessToken` 和 `chatgptAccountId`，server 端调用 `set_external_auth` 立即替换进程内凭据（`account_processor.rs:811-883`）。需要在 initialize 时声明 `capabilities.experimentalApi: true`。协议上标着 **`[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE`**（`app-server-protocol/src/protocol/v2/account.rs:86`） |

换号之后，进行中的会话会自动跟上：`ModelClient` 检测到凭据 owner 变了，就会丢掉旧号的
WebSocket 连接和 `previous_response_id` 缓存，然后以新身份重新建连并发送完整历史
（`core/src/client.rs:603`、`:1538`）。

**两种载体**：Flywheel 的 Codex runner 是每个 runner 一个 `codex app-server --remote-control`
daemon，TUI 窗口通过 `codex resume --remote unix://…` 接进来，只是个客户端，凭据只存在于 daemon
进程里。所以 app-server 和 TUI 两种载体，**热换点是同一个**：对 daemon 调用
`account/login/start`。独立启动的 TUI（进程内 app-server）没有等价的无交互入口，只有
`/logout` + `/login` 走浏览器。

### 本机实测

用临时 `CODEX_HOME`、单个 `codex app-server` 进程；token 来自 `~/.codex/profiles/*` 的只读副本，
access token 距过期还有约 91 小时，因此**不会触发 refresh，也不会轮换任何 refresh token**。
脚本是 `hotswap-probe.py`（与本文同目录），输出里只打 account_id 前 8 位。

**Run 1**：A = personal1（`559d5b2f`，prolite，**当时已撞墙**），B = personal2（`b0c510e4`）。

```
P0 account routing_acct=559d5b2f  ratelimits ordinaryAllowed=False used%=100
P0 turn1 (A): status=failed  usageLimitExceeded            ← 真实撞墙场景
P1 把 B 写进 auth.json（模拟 codex-profile use）
P1 account routing_acct=559d5b2f                            ← 进程没有理会
P1 turn2: status=failed usageLimitExceeded                  ← 还在用 A
P2 account/login/start chatgptAuthTokens(B): ok
P2 account routing_acct=b0c510e4  ratelimits ordinaryAllowed=True used%=0
P2 turn3 (同线程): status=completed reply='PELICAN'         ← 记得 turn1 用户消息里的暗号
P2 turn4 (同线程): status=completed reply='OK-4'
disk auth.json 仍是 A，last_refresh 未变                     ← 外部模式不写盘、不 refresh
```

**Run 3**（验证推理内容能否跨号使用）：A = personal2，B = personal（`1c06bcad`，pro）。
A 号先完成一轮带推理的 turn，rollout 里有 1 个带 `encrypted_content` 的 reasoning item；
热换到 B 后，同一线程的 turn3 回答 `PELICAN`，turn4 也完成了，**没有任何解密或校验错误**。
（Run 2 的 B 选了 school，但 school 当时也已撞墙，只证明了“热换后撞到的是 B 号自己的墙”，
这反过来说明换号确实生效了。）

## Q2 换号后原线程能否继续？

**能。** 线程状态保存在本地 rollout 文件和进程内存里，不绑定账号。请求用 `store:false`，每次都带
完整历史，其中包括上一号产生的 `reasoning.encrypted_content`。Run 1 和 Run 3 都是同一个
thread id 跨号继续，上下文也保留了。

注意两点：

- **撞墙那一轮本身已经失败**。热换只保证下一轮能跑，需要调用方在同一线程上再发一次 `turn/start`（例如一句“继续”）。
- 本次只测了**两轮之间**换号。在一轮进行中（工具调用间隙）换号，源码上会在下一次请求时切到新号，但没有实测。

## Q3 「Luna Reserve / gpt-reserve」是什么

- **机制（源码）**：TUI 读取 `account/rateLimits/read` 时，后端会随响应下发一个 `rate_limit_upsell` banner。只有在“普通额度用完、且这个号有 Reserve 可用”时，后端才会下发 `banner_type:"luna_reserve"`（`tui/src/chatwidget/backend_banners.rs:144`）。TUI 收到后，调用 `thread/settings/update` 把线程模型改成 `gpt-reserve`，并提示 “Automatically switched to Luna Reserve … due to usage limits.”（`tui/src/app/backend_banner_fallback.rs:101-104`，`tui/src/model_catalog.rs:7`）。**这段逻辑只在 TUI 客户端里**，没挂 TUI 的 headless daemon 不会自动切。
- **谁付费**：还是**原来那个号**。9-26 两波切换（UTC 16:39、UTC 00:00，一次覆盖该号下所有挂着 TUI 的线程，包括空闲线程）都发生在 prolite 号上：rollout 中普通额度的 `resets_at=1791048442`，与 personal1 完全一致。`credits.balance` 始终为 `"0"`、`has_credits:false`，说明**没有花买来的 credits**，是套餐自带的额度。
- **额度是否独立**：独立，但很小。切到 Reserve 之后，`token_count` 显示的是另一个桶（`limit_id` 仍然是 `codex`，但 `resets_at=1791045923`，是一个 7 天窗口）。9-26 晚第二波中实际跑了 Reserve 的两个线程（implement `01a0dfc0…`、qa `01a0dfc3…`；未与 issue 中的 87bae3f4 / 9823414f 一一对应核实）在 **UTC 01:18 → 01:23，5 分钟内从 65% 用到 100%**。现在 personal1 / school 的 banner 已经变成 `prolite_rate_limit_reached` / `pro_rate_limit_reached`，CTA 只剩 “Add Credits”，不再提供 Reserve。
- **能否依赖**：**不能。** 它按号、按周计，额度小，几个并发 runner 几分钟就能用完。另外它会把线程模型静默换成 `gpt-reserve`（原本是 gpt-5.6-sol / gpt-6-astra），回切依赖 TUI 本地记录的 return model，而这份记录**换号时会被清掉**（`backend_banners.rs:120`）。所以将来热换号后，线程可能一直停在 `gpt-reserve` 上。

## Q4 结论与最小实现方案

**结论：部分能做。** 同进程、同线程换号，已经在源码和实测两方面都得到证实；但做不到“像 Claude 一样零感知”：撞墙那一轮要重发一次，依赖的是实验性接口，续 token 也要 Flywheel 自己负责。

**建议开实现单**，把它作为 2902+2900 前面的一条快路径：

1. **runner daemon 客户端**（`packages/claude-runner/src/codex-daemon-client.ts`）
   - initialize 时声明 `capabilities: { experimentalApi: true }`（现在是 `{}`，:447-453）；
   - 新增 `loginWithChatgptTokens({accessToken, accountId, planType})`，封装 `account/login/start`；
   - 处理 server→client 请求 `account/chatgptAuthTokens/refresh`（server 端超时 10 秒，`app-server/src/external_auth.rs:18`），用号池里该号当前的 access token 回复。TUI 客户端对这个请求既不应答也不拒绝，所以必须由 Flywheel 自己的连接来回复。
2. **触发点**（接在 FLY-2900 检测额度墙的位置，`packages/core/src/codex-quota.ts` 的 `usageLimitExceeded` 证据）：检测到撞墙 → 从 FLY-2902 号池选一个没撞墙的号 → 热换 → `thread/settings/update` 把模型改回配置值（防止停在 gpt-reserve）→ 在同一线程上 `turn/start` 一句“继续”。热换失败（接口被拒或 initialize 不支持）时，回落到现有的换体流程。
3. **founder 手动切号**：可选。监听宿主 `auth.json` 变化，把新号推给所有在飞的 daemon。

**风险**：

| 风险 | 缓解 |
|---|---|
| 接口是 `[UNSTABLE] … INTERNAL USE ONLY`，Codex 升级可能改名或移除 | 把 `hotswap-probe.py` 改成升级冒烟测试；失败时自动回落到换体 |
| 外部凭据模式下 Codex **不再自行 refresh**，token 过期时靠 refresh 回调（10 秒超时），没人应答就 401 | 常驻应答方 + 在宿主或号池刷新 token 后主动重推。access token 有效期约 10 天，远长于单个 runner 的寿命 |
| 401 回调路径、一轮进行中换号：**只有源码依据，未实测** | 在实现单的 QA 里补测 |
| 新号所属套餐不支持线程当前模型 | 换号前用 `model/list` 或配置校验 |
| 换号后第一轮 prompt cache 失效 | 可接受（只是一次成本或延迟） |

**附带收益**：外部凭据模式下 daemon 既不写 `auth.json`，也不用 refresh token。刷新集中在号池或宿主一处，
可以消除多个 daemon 共享同一个 refresh token 时的 `refresh_token_reused` 竞态。

---

## 约束遵守记录

- 没动生产 Codex 登录态：宿主 `~/.codex/auth.json` 和 `~/.codex/profiles/*` 只读取、没写入；实测全部在 scratchpad 的临时 `CODEX_HOME` 中进行，进程已退出。
- 没有触发 token refresh：access token 余量约 91 小时，refresh window 是 5 分钟；实验结束后临时 home 的 `last_refresh` 没变。
- 没用付费 API：只用了 ChatGPT 订阅号，少量消耗了 personal2、personal 的普通额度（各 2～3 轮短对话）。
- 用到的号：personal1、personal2、school、personal（business 只做了 `account/rateLimits/read` 只读探测，没有发模型请求）。
