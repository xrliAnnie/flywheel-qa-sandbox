# FLY-1182 额度自动切换点火 — 三段式 QA 阶段报告(独立验证)

Issue: FLY-1182
日期: 2026-07-16
基于: plan.md / qa-report.md(design 阶段自述)/ PR #615 @ `a5de114fc`
执行: QA 阶段 runner(独立于 implement 阶段)

---

## 0. 结论

> ## ✅ 终验(2026-07-16,head `dfe055e90`)—— **verdict 翻绿:PASS**
>
> 第一轮 FAIL 的**唯一**一条(交付③ 答卷文案)已由 implement 的 `cf3385b9d` 真修复,
> 我**逐条复验了 claim、不是看 commit 标题**(§4.8)。三块 §8 在此 head 重跑全绿:
> 红线回归 13/13 · 隔离 drill 10/10 · 核心 quota 套件 85/85 · notify 真送达(独立回读)。
>
> **仍未完成、不归我**:① 生产引擎仍被止血冻结(`order: []`)—— 解冻是 Tadashi 的动作;
> ② gate 升级前还差**一道 @head 的增量 Codex 审**(delta = 我的证据 docs,由 implement 注册);
> ③ **CI 在此 head 仍 pending**(不是绿,别当绿用)。
> **我不开 approve gate** —— 按 Tadashi 指令:终验 PASS → 报他 → park。

### 0.0 生产账号池重建增补(2026-07-16 PT / 2026-07-17 UTC)

在后续 reviewed head `573414320` 上,生产账号池已经按 Annie 确认的顺序完成
`business → personal1 → school → shopping → personal` **5/5 真登录、capture、pool verify
与 journal mark**。最后一槽刻意是 `personal`,commit 后独立 Keychain verify 仍是
`source=keychain verdict=match`;机器四个见证 `.active` / `~/.claude.json` / account store /
resolver 全部收敛到 `personal`,store/state generation 都是 4。

journal 现为 **`awaiting_1252`**,candidate quota daemon 以 reviewed runtime tree
`743e76d8…` 重启并持续 `local_scan`;生产 config 仍逐字冻结在
`trigger5hPct:100, order:[]`(sha256 `9ffa886d…`)。**没有运行 `promote-enabled`,所以这不是
“已经自动切换常开”的证据。** FLY-1252 precheck + Annie 监督 GO/解冻仍是独立硬门。

完整逐槽时间、身份、fail-closed PATH drift、commit 与 post-commit 证据见
`evidence/production-pool-rebuild-20260716.md`。

---

### 0.1 第一轮结论(留档,便于看清收敛过程)

**verdict: FAIL(kickback,仅第 ③ 项交付)。切换机制本身全绿,不是机制问题。**

- **机制**:5 项独立验证全过,并经**变异测试**证明测试非空过(§2)。
- **点火(措辞要准)**:两个开关 + daemon **确实在生产活着**(§1,实测活进程,非读 `.env` 文件);
  **但引擎当前被 Tadashi 的止血冻结按住 —— `quota-monitor.json` 的 `order: []`,候选池空
  ⇒ 一次也切不出去**(§1.1)。**「活着」≠「会切」**;真·常开还差**解冻**那一步(他的动作)。
- **红线**:529 不误切 / 不关活 runner / 登录回滚 —— 均验证通过(§2、§3)。
- **FAIL 的是交付 ③「机制答卷」**:`recovery-runbook.md` 的 Q1/Q2 描述的是**已被退役的旧架构**,
  与当前生产实际执行者**不一致**(§4)。这正是验收标准 3 要求 QA 独立核对的那一条。
  它是要端给 Annie 的答卷 —— 她问「谁执行切换」,现有答案会给她**错的那个组件**。

修 Q1/Q2 文案即可解;机制无需改动。

---

## 1. 交付 ①「配置」—— 开关 PASS,但**引擎当前被止血冻结、切不动**(自我更正)

| 项 | 实测 | 判据 |
|---|---|---|
| `FLYWHEEL_ACCOUNT_SELF_HEAL=1` | ✅ 活进程 env | Bridge worker **pid 44361** |
| `FLYWHEEL_CLAUDE_PROFILE_BIN` | ✅ 活进程 env | 指向主仓 bin |
| `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` | ✅ 活进程 env | = **daemon 模式已生效** |
| quota daemon 活着 | ✅ **pid 10747**,已跑 17h | `dist/account-heal/quota-monitor-cli.js`,launchd `com.flywheel.quota-monitor` |
| **`~/.flywheel/quota-monitor.json` 的 `order`** | 🔴 **`[]` 空** | **候选池为空 ⇒ 永远切不出去** |

### 🔴 1.1 自我更正(我第一版把这条漏了 —— 这正是我最该避免的错)

我原先只验了 **env 开关 + daemon 活着**,就把交付①写成「PASS(点火完成)」。
**那是拿「开关」冒充「功能」。** 补验 daemon **自己的** config 后事实是:

```
~/.flywheel/quota-monitor.json → { "trigger5hPct": 100, "order": [], ... }
```

`order: []` ⇒ `selectNextAccount` 的候选集恒空 ⇒ **恒返回 null ⇒ needs_human,永不切换**。
⇒ **当前生产 = 检测得到、但绝对切不动。**

**这是 Tadashi 的止血冻结,不是缺陷**(2026-07-16 pool contamination 事故刚清完,见
`incident-20260716-pool-contamination.md`)。冻结**由他解**,**不是本单 QA 能碰的**
(红线:`quota-monitor.json` 的 trigger=100 + 空 order 不许改不许测切)。

**对交付 ④/⑤「常开」的影响(必须端给 Annie,别让她以为已经在保护她)**:
「常开」的最后一步 = **解冻(填回 `order`)**,那一步**在冻结解除之前不可能成立**。
所以本单 GO 卡只能是「机制已验 + 答卷修正」,**不能宣称「已经在自动救你了」** ——
真·常开 = 冻结解除 + FLY-696 §8(b) 首次自然封顶验真翻活。

**方法学坑(记下来,别再踩)**:`ps eww <pid>` 对 **npm wrapper 进程**(pid 41889)返回
**零** env,看起来像「开关没生效」。真正读 config 的是 worker(43988 / 44361)。
我第一发就误判成「knobs 不在活进程里」——是**我挑错了 pid**,不是产品缺陷。
**阳性对照救了这一条**:先对自己起的进程验 `ps eww` 能不能读出已知 marker(能,144 个 env
token),才证明尺子是好的、零结果是真的零。**先验尺子,再信读数。**

---

## 2. 交付 ②「机制」—— PASS,且经变异证明非空过

### 2.1 变异测试(证明测试真的在保护)

对 `model-cap.ts` 逐条注入缺陷,确认测试**真的变红**:

| 变异 | 会造成的真实伤害 | 结果 |
|---|---|---|
| 去掉 `active` 三态 | 正在干活的 runner 被判 capped → **销毁性关闭活 runner** | **3 个测试红** ✅ |
| 去掉 `switch models with /model` 判别标记 | 账号级封顶文案被误判成模型级 | **1 红** ✅ |
| 去掉「cap 后有成功 → clear」 | 健康 runner 被误判封顶 | **1 红** ✅ |

三次变异后源码均**逐字还原**(`diff -q` 校验)。

### 2.2 真实事故形状(2026-07-11 Fable 事故的逐字文本)

- 事故原文 → `{state:"capped", model:"Fable 5"}` ✅
- 通用性(非写死 Fable):`Claude Opus 4.8` 同样触发 ✅
- 活体 spinner(`✻ Cooking… esc to interrupt`)→ `unknown`(**不关活 runner**)✅

### 2.3 选号(真切换判定)

真 `selectNextAccount`,6/6 通过:

- **weekly 挑 reset 最近**(soonest reset 优先;`null` reset 排最后)✅
- **5h 跳过仍在封顶的号** ✅
- **per-(账号,模型) bench**:Fable 被 bench 的号,**Opus 仍可用** ✅
- **全废 → null**(needs_human,绝不瞎切、绝不 re-login)✅

> 注(如实):5h 档目前是「挑任一已回血的」,**不是**「挑 reset 最近的」。这与
> `qa-report §6(a)` 记录的 Annie 提议一致,属**已知 follow-up**,非本单缺陷。

---

## 3. 红线验证

### 3.1 「529 瞬时不误切」—— PASS(结果层),但**保护它的不是我以为的那道闸**

真 fixture + **真生产组合**(`isTransient: isTransientThrottlePane`,与 `plugin.ts:8837`
逐字相同):`throttle-529-live` / `settled` / `stale-scrollback` **全部零切换** ✅
**阳性对照**:`throttle-529-then-usage-cap`(529 旁边有真封顶)→ **不被抑制**、照常切 ✅
—— 这条证明尺子不是「永远返回 null」。

**🔎 变异揭穿了我自己写的第一版测试(如实记录)**:把 `detectRunnerQuotaCap` 里的
529 短路**整条删掉**,我的 13 个测试**依然全绿**。说明那版测试是**空过的**。
追查真因:529 画面本来就**没有 100% 用量条**,gauge 解析本来就返回 null ——
**null 来自 gauge,不来自 529 闸**。

进一步实验:构造「live 529 + 真 100% gauge 行」的合成画面,gauge 路径**仍**返回 null;
而任何带**真封顶**的画面,`isTransientThrottlePane` 因 BLOCKED_KEYWORDS 否决而返回
false(真封顶永远压过抑制)。⇒ **`isTransient` 这道闸对账号级封顶是 defense-in-depth,
不是承重墙**;承重的是 gauge 解析。

**结论**:红线**成立**(结果层已验:没有任何 529 画面导致切换),但**机制归属要说准**。
已把这段**写进测试文件头注释**,防止后来人把这组绿测误读成「529 闸被证明有效」。

### 3.2 「绝不弄坏现有 claude 登录」—— PASS(代码路径 + 套件)

`flywheel-claude-profile` 的 verify-before-commit 是真的:写前 `kc_read` 快照 →
**先证明 preimage 可还原**再动第一次 mutation → 写后读回校验 → 不一致
`restore_keychain_preimage` **回滚并二次验证**;回滚失败则报「Keychain 可能不一致,
需人工」**绝不静默**。凭据全程走 `security -i` **不过 argv**。

**本次未重跑生产真 Keychain 演练**(如实交代 + 理由):当时 load **18.71**、**117 个 claude
进程**在飞。轨B 已做过一次真生产 Keychain 演练并**字节级还原**(evidence/track-b-*)。
在 117 个活进程上再切一次真 Keychain,收益(重复已验结论)远低于风险(红线②「不打断
在飞 runner」)。**这是我的判断,已显式标注,便于 Tadashi/Annie 复核或推翻。**

### 3.3 不打断在飞 runner —— 遵守

本轮 QA **全程只读 + 隔离**:未碰生产 Keychain、未碰生产 Bridge/daemon、未起真切换。

---

## 4. 🔴 交付 ③「机制答卷」—— FAIL(唯一的 FAIL)

验收标准 3 原文:**「机制答卷:三问人话版,事实与代码一致(QA 阶段独立核对)」**。
逐条核对结果:

### F-1(阻塞)Q2「谁执行切换」答错了**执行者**

`recovery-runbook.md` Q2 现文:
> 「**Bridge 自己切**」/「Codex Infra Bot 可以先认领」/「**20 秒没人认领,Bridge 兜底自己切**」

**但生产 `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` 已生效**,`resolveQuotaDaemonBridgeMode`
(`quota-daemon-cutover.ts:25-33`)在 cutover 下的真值表是:

| 字段 | cutover 值 | 含义 |
|---|---|---|
| `runAccountSwitchWatchdog` | **false** | **Bridge 兜底 watchdog 不跑** |
| `attachAccountSwitch` | **false** | Bridge 不装 switch 执行器 |
| `retireAccountSwitchRoute` | true | `/api/account-switch` 退役(bot 无法认领) |
| `quarantinePending` | true | 启动时**隔离**旧 pending store(`plugin.ts:4812`) |

实际执行者 = **外部 quota daemon(pid 10747)**,不是 Bridge;
「20s 认领窗 / Bridge 兜底」这套**整体已退役**。
⇒ Annie 问「谁执行切换、怎么切」,现答案会给她**错的组件和错的时序**。

### F-2(阻塞)Q1「怎么 detect」漏了**根因修复本身**

Q1 现文只说「用量条到 100% 才算」——那是**账号级**。全文 **0 处**提到**模型级**封顶
(grep 实测;**阳性对照**:同一条 grep 在 `qa-report.md` 命中 **27 次**,证明尺子有效)。

而 `qa-report §9/§10` 自己的结论是:模型级检测**才是**「1182 从来没修好过」的答案 ——
Annie 撞的一直是 `You've reached your Fable 5 limit`。当前代码里模型级**确实**会触发切换
(`quota-monitor.ts:795` `scope:"model"` → `802` `switchAccount`)。
⇒ 答卷把**最该讲的那扇门**整个漏了。

### F-3(非阻塞,建议同批修)`qa-report.md` 自身已过期

`qa-report.md` §10/§12/§13 大量引用 `classifyRunnerCap`。该符号在本分支
**全仓零命中**(含测试;阳性对照:`detectRunnerQuotaCap` 同尺命中)。
该报告写于 PR #562 架构,已被 Rev 2「delivery redirect 到 FLY-1256 daemon」取代。
它是 GO 卡素材 → 建议加**时效抬头**或按现架构订正,别让 Annie 读到已不存在的组件。

> 修法建议(供 implement 阶段参考,**不是我改**):Q1 补「账号级 gauge 100% **+ 模型级
> 封顶文案**两条口径」;Q2 把执行者改成「外部 quota daemon 常驻进程」,删掉/改写
> 「bot 20s 认领 → Bridge 兜底」那段(cutover 下已退役)。

---

## 4.5 §8 三块覆盖(Tadashi 划的范围 —— 逐块认领)

| §8 范围(Tadashi 原话) | 状态 | 说明 |
|---|---|---|
| **529 房无误切验证** | ✅ **已做** | §3.1(真 fixture + 真生产组合 + 阳性对照) |
| **隔离环境真切换 drill(verify / commit / rollback 三段)** | ✅ **已做 10/10** | §4.6(Tadashi 裁定「现在就补」后完成) |
| **#flywheel-notify 通道真实送达** | ✅ **已做**(Tadashi 拍板 (b)) | §4.7 —— 真 token + 真 channel + **独立回读**确认 |

**如实说清 §3.2 的边界**:我原文写的是「未重跑**生产**真 Keychain 演练」——
那个判断**是对的**,且与 Tadashi 红线②③**完全一致**(真账号池 / keychain /
`claude-accounts.json` 不许写)。**但那不等于「隔离 drill 也不用做」。**
隔离 drill **既安全又在范围内**,第一轮我漏了 —— 那是**真缺口,不是豁免**;
Tadashi 裁定「不等 implement,现在就补」,已补完(§4.6)。

> 注:`order: []` 的冻结**不影响**隔离 drill —— drill 用的是隔离 pool/config,
> 与生产那份被冻结的 `quota-monitor.json` **无关**,红线不冲突(已由 S4 哨兵实证)。

### 4.6 ✅ 隔离 drill —— 10/10(`scripts/qa-fly-1182-isolated-switch-drill.sh`)

驱动**真** `flywheel-claude-profile` 二进制,全隔离(假 `security` + scratch 池 + 隔离
`claude.json` + 非生产 service 名),**fail-closed 隔离闸**:任何旋钮指向生产就拒跑。
证据:`evidence/qa-phase3-isolated-drill.log`。

| 段 | 结论 |
|---|---|
| S1 verify+commit | ✅ rc=0、keychain=目标凭据、`.active` 翻到 bravo |
| **S2 rollback(红线)** | ✅ 脏 verify → **非零退出** + **keychain 逐字还原回原值** + `.active` 不动。binary 原话:「rolled back and verified the previous Keychain state; .active unchanged」 |
| S3 argv 无泄密 | ✅ 8 行 security argv 里零凭据(**带阳性对照**:log 确实可 grep) |
| S4 生产零污染 | ✅ 3 哨兵(quota-monitor.json / claude-accounts.json / 池 .active)前后逐字一致 |
| S5 claude.json 隔离 | ✅ 身份写落在 **scratch**,证明 redirect 真生效 |

**变异验证(证明 drill 非空过)**:把 `restore_keychain_preimage` 改成 no-op →
**S2 立刻变红**(keychain 停在 `CORRUPTED-BY-DRILL`)。源码逐字还原。
⇒ 「绝不弄坏现有 claude 登录」这条红线,现在是**驱动出来的**,不是读代码读出来的。

**两个被阳性对照抓住的 harness 缺陷(留档,别再踩)**:
1. **假 security 若「每次写都损坏」,连回滚那次写也会被损坏** → 把 harness 自己的破坏
   栽赃成产品红线违规(我第一版就是)。改成 **corrupt-once**。
2. **`~/.claude.json` 不能当哨兵** —— 活着的 claude 舰队在持续改写它(实测:**没跑 drill
   时它自己 25 秒内就漂**,`bc0b138f→08853a94`)。拿它做 byte-identical 断言 =
   **假红线违规**。已剔除,改用 S5 **正面证明** redirect 真生效。

### 4.7 ✅ #flywheel-notify 真实送达 —— Tadashi 拍板 (b),已执行

**我先停下来问,没自己拍**:#flywheel-notify 是「真换号了」对 Annie 的播报口;引擎此刻
被冻结切不动,一条 QA 帖在她眼里就是「刚刚切号了」= **假信号**。我给了三个选项。

**Tadashi 裁定 (b)**(理由:(b) 一次性证明**真 token + 真 channel + 真送达的完整生产链**,
隔离频道证明不了生产口;且 Annie 在线、他已在 thread 铺过冻结的上下文,标注清楚不会误导)。
**执行如下**(证据:`evidence/qa-phase3-notify-delivery.log`):

| 项 | 实测 |
|---|---|
| P-identity | ✅ 走生产同一判据 `resolveInfraNotifyIdentity(env)`(真 `CLAUDE_INFRA_BOT_TOKEN`) |
| channel | ✅ `1521630422918758472` = 生产 `FLYWHEEL_NOTIFY_CHANNEL` |
| 代码路径 | ✅ 生产同款 `postDiscordMessageToChannel`(**非裸 curl**) |
| send | `{"ok":true,"messageIds":["1527461745709551616"]}` |
| **独立回读** | ✅ **不信 send 的 ok** —— 按 id `GET /channels/.../messages/...` → **HTTP 200**,author=`claw-infra-bot`,channel_id 与预期一致,timestamp `2026-07-16T23:47:39Z` |

**与指令的一处偏差(如实报,不是漏标)**:Tadashi 要求首行**必须是**
`🧪 [QA 演练 · 非真实切换]…`。实际首行是
`🤖[自动] 🧪 [QA 演练 · 非真实切换] FLY-1182 通道验证帖,引擎仍处冻结,未发生任何真实切号`
—— 前面多了 `🤖[自动] `,因为生产 sender 的 `origin:"automation"` 会经
`markAutomatedDiscordText` **自动前置**该标记。标注文案逐字在首行内、防误导的意图成立;
**这正是生产路径的真实行为,而验证生产路径就是本次演练的目的**,所以我**没有**去改代码
迎合措辞。

---

## 5. 低危 finding(不阻塞,建议建 follow-up)

- **L-1 `retireAccountSwitchRoute` 是死字段**:真值表里声明了,但**零消费者**。
  路由退役实际靠**另一条路**(`plugin.ts:4941` `quotaDaemonCutover: quotaDaemonCutoverEnabled`
  → `3541` `cutoverEnabled`)。**行为正确**(路由确实退役,18/18 测试绿),但该文件自称
  「One explicit truth table for every Bridge execution face」而其中一列并不承重 ⇒
  **两个真相源**,后来人改真值表会以为改得动行为。`cutover` 字段同样零消费者。
- **L-2 `aggregateQuotaTrigger` 是死代码但有测试**:`quota-trigger.ts:32` 定义 + 4 个测试,
  **生产零调用**;daemon 真实走的是 `quota-monitor.ts:592` `createModelDetectionIntent`。
  ⇒ 「quota-trigger 测试绿」会被误读成「触发聚合已验证」,实际那条路不跑。

---

## 6. 其它核对(全部与代码一致 ✅)

| 答卷claim | 代码 | 判定 |
|---|---|---|
| 「每 30 秒扫一遍」 | `plugin.ts:9017` `pollIntervalMs: 30_000` | ✅ |
| 「20 秒认领窗」 | `account-switch-repair.ts:96` `20_000` | ✅ 数字对(但 cutover 下该路径已退役,见 F-1) |
| 「用量条 100% 才算」 | `usage-gauge.ts:239-243` | ✅ |
| 「weekly 挑最快回血」 | `account-store.ts:212-225` | ✅ |
| 「全都用尽 → 需要人处理,绝不重新登录」 | `account-store.ts:199` → null | ✅ |

---

## 7. 测试与 CI

- **新增守卫**:`packages/teamlead/src/__tests__/quota-ignition-red-lines.test.ts`(13 测,绿)。
  补的是**真实缺口**:现有 runner-quota 测试全部注入**stub** `isTransient`,**没有一个**跑
  真生产组合。文件头**如实写明**这组测试证明什么、**不**证明什么(见 §3.1)。
- **既有套件**:core quota/account 8 文件 **85/85 绿**;cutover + account-switch-route **18/18 绿**。
- **本机 2 个红 = 环境性假失败,非缺陷**:`claude-profile.test.ts` 的 identity 用例在
  load≈18 下 5s 超时(实测 6866ms);**放宽 timeout 后 22 通过**,且 **PR #615 CI 全绿**
  (Build & Test pass)。与已知 flake(task #149)一致。
- **PR #615**:`MERGEABLE`,CI green,head `a5de114fc`。

---

## 8. 交付验收对照

| # | 交付 | verdict |
|---|---|---|
| ① | 配置(两个开关 + profile bin + 生产池) | ⚠️ **接线与池重建 PASS(5/5,gen=4),但引擎仍冻结在 `order:[]`**;journal=`awaiting_1252`,尚未常开 |
| ② | 真机 QA:真切换判定 / 回滚路径 / 529 不误切 | ✅ **PASS(§8 三块全齐)** — 529 ✅ · 判定逻辑 ✅ · 隔离 drill 三段 10/10 ✅ · #flywheel-notify 真送达 ✅(独立回读);另有生产池 5/5 + final Keychain match 增补证据(§0.0) |
| ③ | **机制答卷(三问)** | ✅ **PASS** — F-1/F-2/F-3 已在 §4.8 按 claim 复验,当前 daemon / v1 恢复边界一致 |
| ④ | GO 卡 | ⏸ 账号池 precheck 已绿;仍等 FLY-1252 precheck + Annie 监督 GO/解冻,**不得宣称「已在自动救你」** |
| ⑤ | 收尾(merge/Done/archive) | ⏸ 待本增补 fresh review/CI 与后续受权 ship;禁止 FLY-1182 自行 `promote-enabled` |

**一句话给 Annie(别被「点火」二字骗了)**:门修对了(模型级封顶 = 你真撞的那扇)、
机制验过了;但**引擎现在被止血冻结着,一次也切不出去** —— 因为 pool 事故刚清完,
候选池是空的。**「常开」还差解冻那一步**,那是 Tadashi 的动作。

**当前下一步**:本增补进 fresh cross-family review/CI;生产保持 `awaiting_1252` +
`100/[]`。只有 FLY-1252 precheck 通过并取得 Annie 监督 GO 后,冻结 owner 才能走独立的
enable/unfreeze 事务。机制侧与答卷侧均已验绿,这里不偷跑 promotion。

---

## 4.8 ✅ 终验:交付③ 复验(按 claim 扫,不看 commit 标题)

implement 的 `cf3385b9d`(「docs: correct quota ignition runbook」)已在 head 历史里
(`git merge-base --is-ancestor` 确认)。**但「有个 commit 叫修复」不是修复** —— 我把第一轮
找出缺陷用的**同一把尺子**重跑,并带阳性对照:

| finding | 第一轮 | 复验(head `dfe055e90`) | 判定 |
|---|---|---|---|
| **F-2** Q1 漏模型级 | 全文 **0 处**提模型级 | **4 处**;明确写出识别形状 `reached your <model> limit … switch models with /model`、三态 `capped/clear/unknown`、`unknown` 绝不关 runner/切号、per-(账号,模型) 有界 bench | ✅ **已修** |
| **F-1** Q2 执行者写错 | 「Bridge 自己切」+「20s 认领 → Bridge 兜底」 | 旧说法**已消失**;现写「执行者 = launchd 常驻外部 `quota-monitor` daemon(`com.flywheel.quota-monitor`)」+ 明确 `CUTOVER=1` 下旧链**已退役**、`/api/account-switch` 不是入口 | ✅ **已修** |
| **F-3** qa-report 陈旧 | 引用全仓零命中的 `classifyRunnerCap` | 加了 **SUPERSEDED 抬头**:标明本文是 PR #562 旧架构、其 Bridge watchdog / Bot 20s 认领 / 自动 rescue 说法**不得用于当前 GO 卡** | ✅ **已修** |
| **§1.1 冻结**(我的自我更正) | —— | 他们**主动折进** Q2:「当前生产还没有常开」+ `trigger5hPct:100`/`order:[]` + monitor-only + 「在那之前不能说『自动切换已生效』」 | ✅ **超出要求** |

**阳性对照**:同一把 grep 在同文件命中 `Annie` 5 次 ⇒ 尺子在跑,「旧说法为空」是真的空。

**新引入的 claim 我也核了**(修复会带进新的不准确 —— 这是我该查的):

| 新 claim | 代码 | 判定 |
|---|---|---|
| 「代码默认 5h 在 90% 触发」 | `quota-monitor-config.ts:19` `trigger5hPct: 90` | ✅ |
| 「daemon 默认每 60 秒扫一次 pane」 | `quota-monitor-config.ts:27` `paneScanSeconds: 60` | ✅ |
| 「weekly 在 100% 触发」 | `quota-monitor.ts:165` `usage.sevenD.pct >= 100` | ✅ |
| 「20 分钟轮询 / 70% 加速到 10 分钟」 | 生产 `quota-monitor.json` 逐字一致 | ✅ |

### 4.9 终验重跑(head `dfe055e90`)

| 块 | 结果 |
|---|---|
| 红线回归(529 无误切 + 模型级 + 选号) | ✅ **13/13** |
| 隔离 drill(verify / commit / rollback) | ✅ **10/10** |
| 核心 quota 套件(8 文件) | ✅ **85/85** |
| #flywheel-notify 真送达 | ✅ 独立回读 HTTP 200(msg `1527461745709551616`) |

**head 说明**:`1c33406f9 → dfe055e90` 之间**只有** progress ledger 的 chore commit
(`git diff --stat` 证实只动 `progress.md`),被验内容与 Tadashi 指定的 `1c33406f9` 等价。

**CI:此 head 仍 `pending`**(`gh run list` 实测 status=pending)—— **我不把它当绿**;
gate 升级前需 CI 绿 + implement 注册的增量 Codex 审 @head。

---

## 5. 🔁 RE-TEST 轮(2026-07-16,head `c3b94eb5`)—— verdict **PASS 保持**

implement 又推了一版,worktree 已在 `c3b94eb5`。**这一版不是文案改 —— 是切换路径的实质代码变更**
(`#618 harden Claude quota account switching` + origin/main 合并):我 §8 覆盖的 5 个文件全大改
(`flywheel-claude-profile` +688 / `account-store` +250 / `quota-monitor` +662 / `switch-executor` +144)。
**所以上一轮的 PASS 对这版无效,我按「代码变了就重验、不假设」把三块在新 head 全重跑。**

### 5.1 🆕 #618 新增了一道 fail-closed quota 闸 —— 我的 drill 第一发就红了(阳性对照抓的)

新 `use` 在切换前先跑**活额度 guard**:目标账号没有活额度证据就**拒切**
(`quota_check`:rc 0 健康 / 32 已封顶 / 33 证据不可用;非 delegated 手动模式对 33 **fail-closed 拒**,
带 `FLYWHEEL_CLAUDE_QUOTA_BYPASS=1` 紧急旁路)。我原 drill 没喂这个 guard →
**S3 阳性对照立刻报「0 argv 行 = security 从没被调用」**,S1 直接 `FLYWHEEL_QUOTA_UNAVAILABLE`。
—— 这正是 RE-TEST 该抓的:**切换路径被加固了,我的尺子得跟着更新**。

**顺带堵了一个 drill 自身的隔离漏洞**:新 gate 的 store + guard bin **默认指向生产**
(`~/.flywheel/claude-accounts.json` + 真 dist guard)。已把两者注入 scratch,并把
**fail-closed 隔离闸也扩到断言这两条**(指向生产就拒跑)。

### 5.2 隔离 drill 扩到 16/16(`scripts/qa-fly-1182-isolated-switch-drill.sh`)

| 段 | 结论 |
|---|---|
| S1 verify+commit(guard=健康) | ✅ |
| S2 rollback(脏 verify) | ✅ keychain 逐字还原 + .active 不动 |
| S3 argv 无泄密 | ✅（阳性对照:security 真跑了 8 行） |
| S4 生产哨兵零污染 | ✅ 3 哨兵逐字一致 |
| S5 claude.json 隔离 | ✅ 身份写落 scratch |
| **S6 🆕 目标已封顶(rc=32)** | ✅ **拒切 + keychain/.active 不动 + 理由含 exhausted** |
| **S7 🆕 证据不可用(rc=33)** | ✅ **fail-closed 拒 + 状态不动**;**阳性对照**:健康 guard(rc=0)同一切换**放行**(证明不是一刀切) |

**变异验证(证明 S6/S7 非空过)**:把 `quota_check` 短路成永远放行 →
**S6/S7 立刻变红**(「switched to an EXHAUSTED account」「fail-OPEN」),源码逐字还原。

### 5.3 其余两块 + 全套件 @新 head

- 红线回归 **13/13** + 核心 quota/account **11 文件 209/209**(含新 `quota-guard-cli` 套件、
  改了 +250 的 `account-store` 选号)。
- notify 真送达:上一轮的独立回读证据仍成立(sender 逻辑 `infra-notify.ts` 本轮未改)。

### 5.4 答卷对新代码仍准(+ 一条非阻塞完整性观察)

runbook 本轮又 +36 行,已与 daemon 架构一致(Q2 明写「选**已恢复且验证可用**的账号」,
呼应新 gate;#flywheel-notify 落点变化 + FLY-1252 跟踪已写明)。
**非阻塞观察**:Q2 步骤 4 列了 profile 侧的 fail-closed 检查(freshness/身份/写回/verify),
但**没点名新 #618 的活额度闸**这一层。文档不算错(步骤 2 已说「验证可用」),只是比新代码**略欠完整**;
建议 implement 在步骤 4 补一句「+ 目标活额度 guard」。已报 Tadashi,不阻塞。

**RE-TEST verdict:PASS**(§8 三块在新 head 全绿 + 新 #618 gate 的两条红线经变异验过)。
红线全程守住,零真切换。仍不开 approve gate(Tadashi 持;增量 Codex 审 + CI 绿为 gate 前置)。

---

## 6. 增量 Codex code review(Tadashi 步骤 ③)—— 3 轮 APPROVED

Tadashi 裁定「CI 绿后由你驱动一次增量 Codex review(delta = 你的证据 commits)」。已做完,
**结果不是走过场**:Codex 在我的 QA harness 里连抓 7 个真缺陷,全是「假绿 / 碰生产」两类,
逐条对 binary 核实后修掉,3 轮收敛到 APPROVED。PR review 帖:pullrequestreview-4719930950。

**R1(4 findings)**:① transition journal 默认写生产(切换时 write-then-delete,hash 检查抓不到)
→ 注入 scratch + guard 断言 + residue 检查;② 继承的 QUOTA_BYPASS/PREVERIFIED/FRESHNESS_BYPASS
→ 防御性 unset;③ S2 回滚前置只数「有没有 security 调用」(写前的 read 就满足)→ 改成必须有真
`-i` 写 + corrupt-once 被消费;④ 529 正向对照只调 recognizer → 加断言「完整 composition 出非空
switch 决策」。

**R2(3 findings)**:① 继承的 IDENTITY_BYPASS(跳过身份校验)+ TEST_PAUSE_AFTER_JOURNAL(写
`.ready` 挂起)→ 补进 unset;② **正向对照读生产 `claude-accounts.json`,无它则 12/13 —— 会红 CI**
→ 注入 scratch store;③ S4 存在检查抓不到干净的 write-then-delete → 措辞订正为「只抓 residue」,
真防护是注入。

**R3:APPROVED** —— 全部修复正确完整,无新增假绿/碰生产。Codex 独立复验:敌意继承旋钮 → 17/17
不挂起不跳过;外部空 store → 回归 13/13;所有可达生产默认路径已重定向 scratch。

**🔴 铁证:CI 亲自替 Codex R2 的判断背书。** 我 R1 的修复(commit `4e4118fa`)**CI 真的红了** ——
正是 Codex R2 预言的「正向对照读生产 → CI 红」。R2 修复(`f75795240`)后我**等到 CI 落定确认
success**(不是 in_progress 就当绿)。⇒ 增量审 + CI 两道都真过,不是我自报。

**收尾状态**:head `f75795240` = PR head(已核)· CI green(已等到)· Codex 3 轮 APPROVED(已贴 PR)
· thread 已 archive · drill 17/17 · 回归 13/13(CI-safe)· 红线全程零违背。
**剩下 = Tadashi 步骤 ④**:把 gate 对齐到 `f75795240` 再呈 Annie。我不开 gate。
