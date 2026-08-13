# FLY-1687 Bridge 派发式 Lead 巡检(patrol_tick) — 独立 QA 验收报告

Issue: FLY-1687 (https://linear.app/geoforge3d/issue/FLY-1687/机制-bridge-派发式-lead-巡检patrol-tick-纯闹钟名册声明清单与判断全在-lead-侧独立核founder)
日期: 2026-08-13
基于: plan.md

被验 head: `55c9e2258c9c20001fcc0bf1e72a5ce4a32b2dcf`(PR #827;开跑前 `git fetch` 核过,收工前再核一次)

---

## 0. 判决

**PASS**(详见 §2 逐条、§4 诚实边界)。

---

## 1. 验收环境(FLY-529 隔离房,生产零触碰)

| 项 | 值 |
|---|---|
| 房间 | `scripts/test-deploy.sh 1 --lead-label Flywheel --extra-lead 4:Finance-Test --alerts` |
| 拓扑 | **单 Bridge × 2 个真 Lead = N-to-N**(`flywheel-test-1` 标签 `Flywheel`,role=cos;`flywheel-test-4` 标签 `Finance-Test`,role=dept lead) |
| Bridge | PID 60131,port 19871,`buildSha == artifactBuildSha == 55c9e225`(与被验 head 逐字一致) |
| Bridge 启动 | 2026-08-13T12:16:26Z,**全程一次都没重启**(PID + lstart 收工前复核不变) |
| 告警隔离 | `#test-flywheel-alerts` + slot 本地 `alert-queue` / `alert-deadletter` / `claims.db` |
| 真 runner | `scripts/inject-linear-issue.sh 1 FLY-1687` → `/api/runs/start` HTTP 200,exec `7c7c8acf`,真 tmux 窗 `runner-test-slot-1:1` |
| 生产影响 | 生产 Bridge 跑 `dbb5877`(main);`git grep patrol.json origin/main` **零命中** ⇒ 本次写入的 `~/.flywheel/patrol.json` 对生产是死文件。生产 `teamlead.db` 只做只读查询 |
| 收工核对 | 13:05:08 `test-teardown.sh 1` 拆房完成(Bridge + 2 Lead + worktree + slot CommDB 全清);13:05:09 删除 `~/.flywheel/patrol.json`(已确认不存在);生产 Bridge `uptime=24671s` 连续未重启、`buildSha` 仍是 `dbb5877`、5 条 session 未动、生产 `lead_events` 里 `patrol_tick` 行数 **0** |

**房间自身的两处环境坑(非产品缺陷,已记录)**:① Runner 环境的长 `TMPDIR` 让 `tsx` 的 IPC unix socket 超过 macOS `sun_path` 104 字节上限 → Bridge 起不来(`EINVAL … .pipe`),需 `TMPDIR=/tmp`;② Runner 环境继承的 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 没有配套 `*_BOT_TOKEN_ENV` → slot Bridge fail-loud 退出,需在部署子 shell 里 unset。

---

## 2. 逐条验收(issue §验收 5 条 + 评论追加的热调)

### AC1 — 有 runner 的 Lead 收到 tick;零 runner 的 Lead 零 tick ✅

**差分对照(同一个 Bridge、同一轮 pass,一个响一个不响)**:

| 时刻(UTC) | 事件 |
|---|---|
| 12:16:33–12:21:17 | 双 Lead roster=0(≈5 轮 pass):`lead_events` 0 行、mailbox 0 行、两个 pane 0 处 `[patrol_tick]` |
| 12:21:30 | 注入真 runner FLY-1687 |
| **12:21:36** | **genesis tick → `flywheel-test-1`**(注入后 **6 秒**);`flywheel-test-4` 仍然 0 |
| 12:25:44 | 给 `flywheel-test-4` 造 roster(见 AC5) |
| **12:26:36** | **genesis tick → `flywheel-test-4`**(roster 非空后 **52 秒**,即下一轮 60s pass) |

`flywheel-test-4` 从 Bridge 启动到自己 roster 非空,**9 分 11 秒零 tick**,期间同一 Bridge 已给另一个 Lead 发过 tick —— 这是差分证据,比单纯"没动静"强。

### AC2 — tick 内容严格「闹钟 + 名册声明」(阴性对照)✅

从 comm.db mailbox 行取**投递原文**(`delivery_content` 为 NULL ⇒ `content` 即投递正文),与固定模板 `diff` **逐字节相同**:

```
[patrol_tick] 巡检时间到。
按 Bridge 的账,你名下有 1 个未终结 runner(此名册是待核声明,不是结论):
- FLY-1687 [7c7c8acf] (main, running)
```

- `diff` 退出 0(3 行 / 164 字节);
- 扩展禁用词表扫描(`check|verify|suggest|inspect|建议|怀疑|该查|应该|请你|需要你|可疑|排查`)**零命中**;
- 名册 2 条时同样只是多一行(见 AC5 正文)。

**已知并已向 founder 明示的边界**:生产信箱主路会给**所有** Lead 向消息统一加 FLY-1573 批次信封(`[mailbox-batch …]` + 签收指令)。本次两个 Lead 都自述"收到 patrol_tick batch",与设计声明一致。判定对象是**批次里拆出的 tick 本体**,这条取舍已写进 founder design HTML §⑦ 并明写"你可否决"。

### AC3 + 评论追加的热调 — 一处配置全舰生效、动态可调、零重启 ✅

锚点:tick#1 于 12:23:45.267Z 被 Lead 签收(cadence 锚 = 签收时刻)。

| 阶段 | 动作 | 预期 | 实测 |
|---|---|---|---|
| A | 12:23:43 写 `~/.flywheel/patrol.json = {"interval_minutes": 10}`(Bridge 已启动 7 分钟,不重启) | 下一条 tick 在锚 +10min ≈ 12:33:45 之后的第一轮 pass | **12:34:36 到达**(锚 +10m51s;pass 网格在 :36 秒)。若配置没被热读,默认 60min 应等到 **13:23:45** —— 差 49 分钟,不可能误判 |
| B | 12:34:44 改成 `{"interval_minutes": 1440}` | 观察必须**越过** 10min 的到点时刻(12:45:51)才有鉴别力 | (见下方 §2-B 实测) |
| C | 全舰档保持 1440,给**项目档** `.flywheel/config.yaml` 加 `patrol.interval_minutes: 10` | 项目 > 全局,且到点已过 ⇒ 立即补发 | (见下方 §2-C 实测) |

Bridge PID 60131 在 A/B/C 全程不变 ⇒ **零重启热生效**成立。

> 方法学说明:第一版 B 阶段只观察到 12:45:44,而 10 分钟档的到点是 12:45:51 —— 那个窗口对"1440 生效"和"10 分钟还没到"给出同样的沉默,**不具鉴别力**。发现后中止并重跑,把观察窗推到到点之后 8 分钟。

**§2-B 实测**:12:34:44 把全舰档改成 `{"interval_minutes": 1440}`。静默一直持续到 **12:53:45**(19 分钟),其中**越过 10 分钟档的到点时刻 12:45:51 约 8 分钟**仍然零 tick(`lead_events` 计数纹丝不动 = 2)。⇒ 调大同样是热生效的。

**§2-C 实测**:12:53:45 全舰档保持 1440,只给项目档 `<projectRoot>/.flywheel/config.yaml` 加 `patrol.interval_minutes: 10`。**12:54:37(52 秒后,即下一轮 pass)tick 到达** —— 而且**两个 Lead 同一轮各来一条**(`…:after-7` / `…:after-6`),因为两边的锚点在项目档口径下都已过期。⇒ 项目档压过全舰档、项目档同样现读、且一处配置对房里所有 Lead 同时生效。

### AC4 — 新建 Lead(QA 槽)零配置自动获得 ✅

两个 Lead 都是本次现开的全新 QA 槽 Lead,**没有任何 patrol 相关配置**,都自动进入名册并收到 tick。
Lead 侧清单也自动到位:dept Lead(`flywheel-test-4`)物化出来的 rules bundle 里 `patrol_tick` 锚点 2 处、`TMUX= tmux list-windows -a` 锚点 1 处。

### AC5 — 故意把名册写错,Lead 按清单独立核出来(阳性对照)✅✅

造脏(隔离房 DB,issue 原文授权的做法):插入两条"账上 running、地面无窗"的 session —— `FLY-9999`(路由到 Lead-1)、`FLY-8888`(路由到 Lead-4)。

**两个 Lead 各自独立抓到,互不知情:**

- `flywheel-test-4`(dept Lead,带新 §0 清单)—— 先跑 `TMUX= tmux list-windows -a`(§0 第 1 条,地面真相),再 `runner_terminal_list`,再 Bridge DB 交叉,结论原文:
  > 判定: FLY-8888 [deadbeef-…0002] 为幽灵会话(ledger 有、地面无)。
  并**在真 Discord 落地**(隔离频道 `#finance-lead-test`,msg `1537437823878303857`,12:29:01Z)。该消息用 slot bot token 在**目的地**独立读回验证过,不是采信 Lead 自述。
- `flywheel-test-1`(cos Lead,只有旧 §1 纪律)—— 也自己做了逐条核查并给出表格:`FLY-1687 ✅ 活着` / `FLY-9999 👻 幽灵条目,声明≠实况`。

**"多了"方向同样被抓到**:Lead-4 主动备案"名册外还有一个活着的 FLY-1687 窗口,不在我 scope";Lead-1 也备案"全局还有第三条 FLY-8888,不在我名册 —— Bridge 按 Lead 分名册是对的"。⇒ per-Lead 名册作用域在 Lead 侧可观察且正确。

**结论**:Bridge 把错的名册原样声明出去(它本来就不该判断),Lead 用独立信源把错找出来 —— founder 要的"兜底者不受被兜底者指挥"在真机上成立。

### 附加(非 issue 明列,但属机制正确性)

- **在途封顶**:tick#1 从 12:21:36 投出到 12:23:45 签收前一直是 `LEASED`,期间 4 轮 pass **没有**铸出第二条;签收后才按周期铸下一条。
- **链式 id 确定性**:`patrol_tick:test-slot-1:flywheel-test-1:after-genesis` → `…:after-2`(prevSeq 递增),同 Lead 不重号。
- **告警面(plugin.ts 装配,单测覆盖不到)**:真机诱发验证(隔离房):删掉某条 tick 的 live mailbox 行、保留 permanent identity,让 `inspectDeliveryState` 每轮抛 `active mailbox identity has no row`。

  - 12:56:35 诱发 → Bridge 日志出现 **5 次**连续失败(每轮 pass 一次),**只影响被诱发的那个 Lead**,同轮 `flywheel-test-4` 正常;
  - **隔离告警频道只收到 1 条** severe:`🚨 Lead patrol tick delivery is stalled (flywheel-test-1 / inbox_loop_stalled)`,时间 **12:58:37.975Z = 第 3 次失败**。第 4、5 次没有再发 ⇒ 三连击阈值 + 30 分钟冷却都成立,**不刷屏**;
  - 13:01:37 恢复行 → 失败停止;到 13:04:45(≈3 轮干净 pass)warn 计数仍是 5 ⇒ 自愈成立、告警面 re-arm。
  - **频道阳性对照**:同一 slot 的 Bridge 在 12:12:33Z 曾成功往这个隔离频道投过一条 `bridge_abnormal_exit`,所以"只有一条"不是频道坏了。
  - ⚠️ 第一版诱发脚本有 bug(`grep -c` 零命中退出码非 0,`|| echo 0` 让计数变成 `"0\n0"` → 算术错 → 等待循环秒退),那一轮**什么都没证明**,已修正重跑;上面的结论来自修正后的运行。

---

## 3. 自动化门(在被验 head 上跑)

| 面 | 结果 |
|---|---|
| `packages/config` patrol-config | 5/5 通过 |
| `packages/teamlead` patrol-tick / render / StateStore / gate-poller / fly369 rules | 30/30 通过 |
| `packages/flywheel-comm` mailbox-settlement | 2/2 通过 |
| `packages/teamlead` lead-inbox-runtime(被改文件) | 12/12 通过 |
| PR #827 CI on `55c9e225` | **9/9 全绿**(Quick Gate / Unit ×5 / Script Tests / NPM payload / CI OK) |

抽查了渲染测试是否"空过绿":恶意 fixture(`identifier` 带换行 + 指令词、`sessionRole="verify"`)断言输出仍是 3 行且被替换成 `unsafe-<8位hash>` —— 断言是真的。

**未在本机跑全仓 `pnpm test:packages:run`**:该主机同时跑着生产 Bridge 与多个 runner(load ≈10–13),全量套件会压垮它(既有教训)。全仓门以 PR CI 的 9/9 为准。

---

## 4. 诚实边界(没测到的,风险与去处)

1. **"全天零 tick"没测满一天** —— 实测是 9 分 11 秒的差分窗口(同 Bridge 一个 Lead 响、一个不响)。代码路径 `roster.length === 0 → continue` 不含任何时间分量,单测覆盖;真正的"全天"留 ship 后自然观察。
2. **Bridge 重启后的节奏连续性未在真机复现** —— 设计说锚点存在 `lead_events` + mailbox 结算态里,重启不丢节奏也不 boot 风暴。本轮 Bridge 一次没重启(那正是热调验收要求的),所以这条只有单测和结构论证,没有真机证据。**建议 ship 后第一次全舰重启时顺手看一眼:重启后 5 分钟内不应出现 tick 风暴。**
3. **`canSpawnRunners:false` 的 Lead 零 tick 没在真机验** —— QA 槽的 test-deploy 不设这个字段,两个 Lead 都是"可派 runner"。生产 `projects.json` 里 5 个 `false` 的 Lead(flywheel-cos / belle / mufasa / 两个 infra-bot)只有单测覆盖。
4. **`archived_terminal`(>72h 归档后恢复 cadence)只有单测** —— 真机跑不出 72 小时。
5. **Codex Lead 侧渲染未真机验** —— 渲染是 Mailbox/CommDB 两个 runtime 共享同一个 `formatPatrolTick`(有 parity 单测),与 Lead 后端无关;但生产的 Codex Lead(Mufasa)`canSpawnRunners:false`,本来就收不到 tick。
6. **本报告没有截图/GIF** —— 本机 Claude-in-Chrome 扩展当前 0 连接(需前台交互),证据形态是 tmux pane 原文抓取 + Discord API 在目的地读回 + SQLite 原文,均可复核。

---

## 5. 观察项(不阻塞 ship,建议 Lead 知悉)

1. **`unowned_roster` severe 告警是"有条件休眠"的,不是不可能触发。**
   `resolveLeadForIssue` 在标签都不匹配时回落到 `project.leads[0]`;若那个 `leads[0]` 恰好 `canSpawnRunners:false`,该 session 会进 `unowned` → **founder 可见的 severe 告警,每 30 分钟一次,只要那条 session 还没终结**。
   生产现状:`flywheel` / `growth` / `tidal-echo` 的 `leads[0]` 都是 `canSpawnRunners:false`;`personal-assistant` 唯一的 Lead 也是 false(该项目一旦出现非终结 session,会走 fleet 级 severe)。
   **当前是安全的**:今天 5 条生产非终结 session 全带 `["Flywheel"]` → 命中 `flywheel-eng-lead`;历史全量 session 的标签分布也没有落到不可派 Lead 上的。且 `/api/runs/start` 的 DEPT_SCOPE 闸本来就要求恰好一个部门标签。所以这是**设计上的 fail-loud(宁可吵也不静默丢),不是缺陷**,只是值得知道它存在。
2. **"够资格收 tick"和"加载了 §0 清单"是两个独立条件,今天恰好重合。** 收 tick 的条件是 `canSpawnRunners !== false`;加载 `runner-patrol-rules.md` 的条件是"非 cos 的 dept lead 分支"。本次 QA 槽里就出现了错位:role=cos 的 `flywheel-test-1` 收到了 tick,但它的 rules bundle 里没有 §0(它靠旧 §1 纪律照样做了核查)。生产今天所有 `canSpawnRunners:true` 的 Lead 都是 dept Lead,所以不重合的情况不存在。将来若新增一个"可派 runner 但不是 dept 分支"的 Lead 角色,它会收到闹钟却没有清单。
3. **存量在跑的 Lead 要到下次重启才带上 §0 清单**(rules bundle 在 Lead 启动时物化)。plan §5.1 已如实标注;期间收到 tick 也能理解执行(模板自含名册,且旧 §1 巡检纪律已在 bundle 里)——本轮 cos Lead 就是这个形态的实证。

---

## 6. 证据落点

- pane 原文抓取、mailbox 原文、`lead_events` 台账:本次运行的 scratchpad `evidence/`(会话内可复核);关键原文已逐字引用在上文。
- 隔离 Discord 消息:`#finance-lead-test` msg `1537437823878303857`(用 slot bot token 在目的地读回验证)。
- PR CI:https://github.com/xrliAnnie/flywheel/actions/runs/31696586018(head `55c9e225`,9/9)。
