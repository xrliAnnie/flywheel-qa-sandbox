# FLY-1182 事故证据档案 — 2026-07-16 keychain 静默漂移(shopping 现身)根因

Issue: FLY-1182 (https://linear.app/geoforge3d/issue/FLY-1182/enable-claude-账号-quota-自动切换点火-开关配置-fly-696-8-真机-qa-go-卡-常开)
日期: 2026-07-16
基于: 无(live 事故取证,Lead 指令 8694375d)
作者: runner-b48d9d5a(design phase,被改派事故诊断)
状态: 已以 ask --report 提交 Tadashi(question 3457da60)

## 一句话结论

不存在"某个组件在 10:00–10:17 把账号切到 shopping"这样的单一动作;真相是
**账号池凭据文件已交叉污染 + 整条切换链路(capture_back / switch / monitor 标签)
零 token→身份核验**。shopping 是 08:43 PDT 一次 `use personal` 把被污染的
pool:personal 文件(内容实为 shopping 的 token)写进 keychain 时现身的;
10:14:52 与 10:53:10 两次 claude 侧写回反而把 personal 修了回来(误打误撞自愈)。

## 决定性实锤(全部只读取证)

用每个 token 调 `GET https://api.anthropic.com/api/oauth/profile`(daemon 同款
oauth-2025-04-20 beta 头,只读、不耗模型额度)直接问身份:

| token 来源 | 身份返回 | 判定 |
|---|---|---|
| keychain(现在) | xrliannie@gmail.com,uuid f2caedf8 | = **personal** ✅(Annie 切回有效) |
| pool school/.credentials.json | xrliannie@gmail.com,uuid f2caedf8 | ❌ **是 personal 不是 school** |
| pool personal1/.credentials.json | xrliannie@gmail.com,uuid f2caedf8 | ❌ **是 personal 不是 personal1** |
| pool personal/.credentials.json | HTTP 401 | 死快照(family 已轮转;内容曾是 shopping 系,见时间线) |
| pool business/.credentials.json | HTTP 401 | 死快照 |
| pool shopping/.credentials.json | HTTP 401 | 死快照(Jul 4 捕获) |

**⇒ 池子 5 个槽位:2 个错身份 + 3 个死。自愈引擎当前实际切换能力 = 0**
(下次触发只会把 personal 自己再写一遍,或全灭 no_target)。

## 污染机制(设计缺陷,非单次误操作)

`packages/claude-runner/bin/flywheel-claude-profile`:

- `capture_back()`(脚本 :333–358):每次 `use <target>` 前把**当前 keychain 凭据**
  按 **.active 标签**写回旧账号的 pool 槽位——"当前 keychain 是谁"全凭标签,无核验。
- 脚本 :373 注释自认 "The opaque token cannot be decoded to an identity" —— 前提错误:
  `/api/oauth/profile` 一行 GET 就能解码(本档案的实锤方法)。
- 脚本头注释(:24–26)自己点名已知外部写入者:"a claude re-login recreating the item"。
- ⇒ 任何 out-of-band keychain 写入(claude re-login / 陈旧 session token-refresh 写回 /
  人手 login)都让 标签 ≠ 实际;下一次切换 capture_back 就把错误账号凭据捕进错误槽位,
  并随后每次切换继续扩散。**一次静默漂移 = 全池级联污染。**

## 精确时间线(PDT;证据在括号)

| 时刻 | 事件 | 证据 |
|---|---|---|
| Jul 14 ~14:30 | 真 weekly 封顶事故,Annie 老公手切 keychain → shopping | FLY-1252 issue 描述 |
| Jul 15 01:24–01:34 | 全舰 14 个 Claude Lead 启动(出生时 keychain 是什么就永远揣着什么) | ps lstart |
| Jul 15 23:06:35 | FLY-1256 外部 quota daemon 上线(pid 10747)+ `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` 写入 | wrapper log 第 1 行;.env mtime 23:06:37 |
| 01:16:43 | gen2:daemon 正常切换 "personal1→business"(capture_back 把当时 keychain 凭据捕进 personal1/ 槽) | claims.db account_switched 08:16:43Z;store personal1.quotaExhaustedUntil=09:30Z |
| 04:56:49 | gen3:daemon 正常切换 "business→school" | claims.db account_switched 11:56:55Z;state.lastSwitchAt=1784203009910;store mtime 04:56:53 |
| 05:16:58 | "school" 标签(实测疑为 personal,7d 轨迹吻合)5h=100%,候选全灭 → `quota_no_target` severe 发出**一次**,此后同日同签名去重静默 | claims.db 12:16:58Z;monitor log 100% 持续 12:37–14:27Z |
| 07:27 | 封顶期间 verifyCandidate probe-refresh personal1 槽 → 写回的是 **personal family** token(污染在此之前已存在) | personal1/.credentials.json mtime;今日身份实锤 |
| 07:30 | 该账号 5h 窗口重置,100% 解除(引擎全程没切出去 = "engine 没干活"第 4 例) | monitor log 14:37Z 骤降 4% |
| **08:43** | **某人/某物跑 `use personal`**:capture_back 把当时 keychain 凭据(personal family)捕进 school/ 槽;再把 pool:personal 内容(**实为 shopping family**)写进 keychain。.active→personal | school+personal 槽 mtime 15:43Z;.active 标签变化;monitor 15:57–16:57Z 7d=3→8%(全池唯一吻合 shopping);**执行者身份无法确定——脚本无 audit log,zsh history 无记录,非 daemon(state 无记录)** |
| 09:57–10:17 | Lead/Annie 观察到三方不一致:store=school / monitor 标签=personal / 实际=shopping | Lead 指令原文;上行为其机制解释 |
| **10:14:52** | keychain item 被**删除+重建**(cdat 重置)= claude 侧写入(profile 脚本用 add-generic-password -U 原地更新,不会重置 cdat)→ 某 personal-era 活进程 token refresh 写回,**把 personal 写回**(11/22 → 现在 35/26 一条连续轨迹,与现 keychain 身份吻合) | security cdat=20260716171452Z;monitor 17:17Z 起数字突变 |
| 10:32:02 | Annie `use personal` 切回:再次把 pool:personal 的**死 shopping 快照**写进 keychain | .active mtime;~/.claude.json oauthAccount=personal |
| 10:37:30 | daemon 读 keychain → 401/过期 → `quota_read_blind` 告警(死快照的直接后果) | claims.db 17:37:30Z;monitor log 该 tick 无 quota 行 |
| **10:53:10** | 又一次 claude 侧写回(mdat),把活的 personal token 写回 → 此后 keychain 稳定为 personal | security mdat=20260716175310Z;monitor 17:57Z 起恢复读数 26/25 |
| 11:01+ | 取证时点:keychain=personal(profile 实锤),mdat 18:01:44Z = personal-era 进程正常续 token | 本档案 |

## 四个候选裁决

- **(a) FLY-1256 daemon 静默路径 — 排除**(窗口内零切换:state.lastSwitchAt 停在 04:56:49;
  它的两次切换都有 claims 记录。但它的测量与切换建立在被污染池 + 零身份核验之上,是共犯非元凶)。
- **(b) FLY-1182 CUTOVER=1 B 段 — 排除**(quota-daemon-cutover.ts truth table:cutover 下
  attachAccountSwitch=false / watchdog=false / route 退役 / pending 隔离,唯一活面
  runner-quota-scan 只发告警,无任何 keychain 写入面)。
- **(c) flywheel-claude-profile 调用 — 部分坐实**(08:43 的 use personal 是 shopping 现身的
  直接机制;执行者不明 = **脚本无 audit log 的结构性缺口**)。
- **(d) runner 级 fallback — claude 侧无此机制**;但其变体【陈旧 claude session OAuth
  refresh 写回】是 10:14:52 / 10:53:10 两次写入的最佳解释,也是池污染初始来源的头号候选
  (全舰 Lead Jul 15 01:2x 出生,keychain 当时是什么账号它们就永远持有什么 family)。

## 为什么零通知

1. 引擎自己的事件**全都发了**(claims.db 今日 6 条:monitor_down×2、account_switched×2、
   quota_no_target×1、quota_read_blind×1)。反证投递成功:sendQuotaMonitorAlert 对非
   sent/duplicate/queued 结果直接 throw 且会打死 daemon 主循环——daemon 从 23:06 活到
   现在、日志零 error ⇒ 每条都被 lead-alert.sh 接收。
2. 但 `account_switched` 在 lead-alert.sh 里是 INFORMATIONAL_KINDS(发 root 消息、
   **无 ticket 头、不 @ 任何人**)→ 淹没在 #flywheel-alerts 流量里。
3. `quota_no_target`(severe)同日同签名(quota-no-target-5h-2026-07-16)只发第一条,
   之后 2 小时封顶期全部去重静默。
4. **#flywheel-notify 的 FLY-929 digest 位点挂在 Bridge 切换面上,CUTOVER=1 后整条死路**
   (PR #615 的 honest boundary 也写了这一条)——Annie 订阅期望的频道永远安静。
5. 窗口内 shopping 现身本就不是引擎动作,引擎侧唯一间接反应 = 10:37 那条 quota_read_blind。

## 对 FLY-1182 GO 卡的影响(建议,급→缓)

1. **立即冻结 daemon 切换面**(monitorOnly / 停 launchd job)——池子重建前它切必错。
2. **Annie 在场逐账号重新登录 + capture 重建池子**(= 原 runbook 步 1),同时把 store
   的 activeAccount/generation 与 .active/实际身份对齐。
3. **结构修复(设计项,进 FLY-1182 或 FLY-1252)**:
   - capture / capture_back / switch-verify / monitor 标签全部加 `/api/oauth/profile`
     身份核验(email↔profile 名映射,不符 = fail-closed + 告警);
   - profile 脚本加 audit log(who/when/what,append-only);
   - keychain 身份漂移侦测:daemon 每 tick 顺手比对 token 实测身份 vs .active,漂移即告警
     (它已经在调 usage API,加一个 profile GET 成本≈0);
   - 通知可见性:account_switched 至少进 Annie 真正看的频道/或带 ticket 头。
4. **fleet Lead 重启纳入下个批量窗**(陈旧会话写回是持续污染源;或接受写回、靠③的漂移
   侦测兜底)。
5. GO 卡前提更新:①池子身份核验后重建 ②漂移侦测在线 ③一次受控真机切换演练(带身份断言)
   通过——否则「首个自然封顶观察项」还会以今天的方式失败。

## 取证纪律声明

全程只读:keychain 只 find(-w 读取)、从未写入;usage/profile 只 GET;claims.db/state/
store/log 只 SELECT/读文件。PR #615 未动(R4-approved held @4bac905a7)。
