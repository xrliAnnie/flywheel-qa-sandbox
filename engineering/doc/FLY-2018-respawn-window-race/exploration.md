# FLY-2018 writer_replacement 重生体连环夭折与静默停摆 — 探索

Issue: FLY-2018 (https://linear.app/geoforge3d/issue/FLY-2018/enginebug-writer-replacement-重生体-spawn-与同名窗清理竞速ensure-heldstatusnull)
日期: 2026-08-23
基于: 无

## 1. Issue 陈述的问题

FLY-2000 run `8bfa33b2` 在 2026-08-24 00:13–00:20Z 出现:引擎判旧实现体死亡(goal ended non-complete)→ `writer_replacement` 铸新体 → 新体 4 秒内 teardown(signal=failed, status=blocked),连续两具(d952fa7a / 0b813c92)同一签名,之后引擎「不再重试」,node 挂 running + 死 exec 静默停摆(死角⑮形)。

Issue 给出三个修点方向(实现方定):

1. **修点①** `codex-runner-tui-window` 的 ensure 包装:helper stdout 已报成功动作(`{"action":"verified"}`)时,不应仅因退出态非 0/null 判 held——至少记录 signal 与凶手线索再裁;
2. **修点②** 同名窗 kill 与新 spawn 的时序:kill 非 ok 时 ensure 被 guard 扣住,重生必然撞死,需要收敛路径(等待/重验/换窗名);
3. **修点③** 重试停止后无任何告警,node running + 死 exec 静默(与 FLY-2016 同族的「无出口」病)。

## 2. 探索前提:先审计,不把 issue 的因果链当成 greenfield 事实

Issue 的因果链是从 `/tmp/flywheel-bridge.log` 539287–539311 的四行日志推出来的:

> 旧窗 killed → 'kill returned non-ok (non-fatal)' → 'guarded session ensure attempt 1 held (status=null)' → 'guarded tmux session ensure held — skipping' → tuiFailure(retryable-hold) → 秒死

这条链有一个可证伪的关键假设:**ensure held 发生在死亡之前、并导致死亡**。本次探索的第一件事就是回到原始日志与 append-only 事件账本,核对时序方向。审计结论(细节见 research.md)推翻了这条因果链:

- `d952fa7a failed: goal ended non-complete: blocked` 在日志中出现于 ensure-held 两行**之前**;
- ensure-held 的 `status=null` 是 teardown 的 AbortSignal 自己 SIGTERM 了尚在飞行的 `tmux-server-rescue` helper(内部信号,非外部凶手);
- 真正让每具体秒死的是 **codex 账号 refresh token 被撤销**:每个 fresh thread 的第一个 turn 立即以 `unauthorized` 失败,goal 转 blocked,adapter 判 `goal ended non-complete: blocked`;
- 「重试停止后无任何告警」不成立:引擎在 00:44:28 触发 `retry_limit_escalated` + 【需人工】告警 + run 置 held。观察者在 00:20 看到的「静默」是 1/5/15 分钟盲换退避窗 + liveness probe unknown 打磨期,这段等待**没有任何可见状态**,外观与死机相同。

## 3. 重新定义的问题域

审计后,真实的问题分成四层,危害从高到低:

### 3a. 诊断信号全链丢失(本次事故的最大成本来源)

daemon 的 turn error(`"Your access token could not be refreshed because your refresh token was revoked"`, `codex_error_info: "unauthorized"`)只存在于 runner CODEX_HOME 的 rollout jsonl 里。adapter、CommDB session、engine 事件、告警,每一层都只看得到 `blocked`。后果:

- 引擎盲换 7 次都在治「blocked」这个标签,不是治 auth;
- 运维(operator rework 200)也在治标签,attempt 2 的替换体照样秒死;
- 连 FLY-2018 这张 issue 本身都被误导去追 tmux ensure 的鬼影。

### 3b. 环境类失败无断路器

unauthorized/config 类死因是**换体治不了的**:每个新体从同一份源凭据快照 provision,必然继承死凭据。引擎现有机制:

- `repeated_dead_execution_pattern`(deathNumber≥2)只写事件账,无告警、无行为变化;
- account rotation 只在 daemon **进程死亡**(transport_closed)时触发;goal 以 terminal blocked 结束是正常 resolve,不触发 rotation;
- 盲换配额(`MAX_BLIND_REPLACEMENTS=3` + 原始 dispatch)要全部烧完(约 21+ 分钟的退避)才 `retry_limit_escalated` → held。

### 3c. ensure 包装的误报与 provenance 缺失(修点①,定位为诊断性缺陷)

`ensureSessionWithRetryAsync`(codex-runner-tui-window.ts)只看退出码,丢弃 helper stdout 的成功动作;`spawnCommandAsync` 把内部 timeout、内部 abort、外部信号杀统一折叠成 `status: null`,不记录 close 事件的 signal 名与终止来源。产生了本次把整条诊断链带偏的日志:「held (status=null): {"action":"verified"...}」——一条实际是「被自家 teardown 取消」的记录被打成了「持锁不可用」。同文件的姊妹路径 `TmuxAdapter.ensureRunnerSession` 是解析 stdout action 的,两个包装行为不一致。

### 3d. 退避窗与 kill 结果的可见性(修点②③的残余部分)

- 盲换退避(1/5/15 分钟)期间,node 保持 running + 死 exec,无任何「引擎在等待,下次重试在 T」的可见状态 → 人在 00:20 看必然读成停摆;
- `killRunnerTuiWindow` 把「窗不存在」(常态、良性)与「kill 真失败」打成同一条 non-ok 日志。

### 3e. 修点②的竞速:证据不支持

本事故中不存在同名窗 kill 与新 spawn 的竞速:`kill returned non-ok` 是因为窗从未建成(TUI attempt 1 尚在 ensure 阶段就被 run-ended abort),按名 kill 落空;FLY-1239 的 provable purge(按 immutable id kill + re-verify 零同名窗)已提供 ≤1 窗不变量,且 TUI 窗全程 fail-open(只损可见性,不碰 run)。**不建议为不存在的竞速建收敛机制**(scope discipline);只保留诊断性小修 + 一条回归测试证明 kill-非-ok 情形下 purge 不死锁。

## 4. 方案方向(供 research/plan 展开)

| 方向 | 内容 | 治哪层 |
|------|------|--------|
| A. turn error 上抛 | daemon 通知流中的 turn 终态 error(message + `codex_error_info`)→ `GoalRunResult` → adapter `failureReason` → session/事件/告警全链 | 3a |
| B. 环境类失败早停 | teardown fact 带失败分类;同签名环境类秒死 deathNumber≥2 → 提前走 retry_limit 同款收口(held + 【需人工】带真实原因),不烧完全部盲换配额;分类不确定时维持现行为(fail-safe) | 3b |
| C. ensure 包装 provenance | `spawnCommandAsync` 捕获 close(code, signal) + terminationRequested + abort reason;包装层解析 stdout 成功动作;自家 abort 打「cancelled」不打「held」;外部信号杀 + 完整成功 JSON → 轻量 re-verify 后按成功处理 | 3c |
| D. 退避可见性 | `workflow_dead_execution_watch` 物化 `next_retry_at`,并入 FLY-1925 patrol 名册正文;killWindow 区分「窗不存在」与真失败 | 3d |

**不做**:同名窗竞速收敛机制(证据裁定不存在,见 3e);auth 轴自愈(凭据快照时效预检、unauthorized 触发 rotation)属账号族 issue(FLY-513 相邻),本单点名上报、不越界实现。

## 5. 关键不确定点(research 要回答)

1. daemon 通知流(JSON-RPC)里 turn 终态的 error 字段的确切形状——rollout jsonl 里有,通知流里叫什么、挂在哪个方法的 params 上;
2. 失败分类的签名怎么定义才 fail-safe(誤把偶发网络错标成环境类 → 早停会伤到可自愈场景);
3. `next_retry_at` 物化的落点(watch 行 UPDATE vs 新事件 kind)与 patrol 的消费方式;
4. 修点①里「信任成功 stdout」的边界:helper 被信号杀时 stdout JSON 完整性如何判定,是否必须 re-verify。
