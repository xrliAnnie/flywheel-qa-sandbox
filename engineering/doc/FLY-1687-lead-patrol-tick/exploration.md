# FLY-1687 Bridge 派发式 Lead 巡检(patrol_tick) — 探索

Issue: FLY-1687 (https://linear.app/geoforge3d/issue/FLY-1687/机制-bridge-派发式-lead-巡检patrol-tick-纯闹钟名册声明清单与判断全在-lead-侧独立核founder)
日期: 2026-08-13
基于: 无(本单首文档;上游为 Linear issue 正文 + 4 条评论)

---

## 1. 问题与裁定(输入约束,全部不可协商)

### 1.1 Founder 需求原话(2026-08-10)

> 有的时候你不能 expect 每个 runner 都知道他一定要去做什么…对于 Lead 来说,可能起码要做每半个小时一次的巡检…**重点在于,我们怎么样能做到让以后每一个 Lead 都知道要做这件事情,并且能够正确地去执行?**…巡检的频率应该是一个比较好调节的东西…我也不想给 Lead 增加太多的负担…在没有任何 runner 在跑的情况下,他们理论上不需要巡检;只有在有 runner 在跑的情况下才需要。

### 1.2 Founder 设计裁定(2026-08-10 23:19,推翻初稿「Bridge 预检」层)

> 本来我们做巡检就是为了兜底 Bridge 没有做好的工作,如果 Bridge 自己都不知道哪里没做好,那绝对不能让它去告诉 Lead 该干什么。如果只让他发一个通知,说"时间到了,你该巡检了",可能还行,但更多的就不太应该了。

⇒ **兜底者不受被兜底者指挥。Bridge = 纯闹钟;清单与判断全在 Lead 侧,核对以独立信源为准。**

佐证:2026-08-10 当晚 Lead 抓到的 5 个问题,全部来自独立信源交叉(pane 实况 vs 账本 / GitHub 真态 vs 账本 / 两本账互对),无一能由 Bridge 单方账本自报。

### 1.3 Founder 需求追加(2026-08-12 11:55 PT,Linear 评论,design 必须吸收)

> 1. 巡检频率要设成可调节的,而且不要是那种重启才可以调节的,必须是**动态可调节**
> 2. 它的 **default 频率设成每小时一次**就可以(目前看每小时巡检一次好像就蛮够了,不需要更快)

⇒ ① 频率热生效零重启(参照 models.json 热读模式或等价机制);② 默认 60min(**覆盖 issue 正文的 30min**);③ 验收含「改频率→下一个 tick 即按新频率,全程零重启」。

### 1.4 同族子项(founder 明确「不用马上修」,本单不做)

关键节点自动在 issue thread 留痕(段切换/verdict 落账/门铸出/ship 结果的事实播报)。与「Bridge 只当闹钟」不冲突(留痕=事实播报,非判断),但排在本单主体之后。本设计只需**不堵死**它。

---

## 2. 机制的三角分工(issue 定稿,照录)

| 角色 | 视角 | 机制 |
|---|---|---|
| FLY-1614 | 当事人 | 等棒 runner 超阈值自动喊 Lead(已 merge,`flywheel-comm turn` 内嵌检测) |
| **本单 FLY-1687** | Lead | 定期独立兜底,不信任何单一组件 |
| Bridge | 闹钟 | 只送「该巡了」这个事实 + 名册待核声明 |

三角色互不依赖对方完美。FLY-1614 的设计文档三处明确把「Lead 独立巡检兜底」划给本单(`engineering/doc/FLY-1614-turn-handoff-deadline/exploration.md:76`、`plan.md:64`、`plan.md:96`)。

---

## 3. 现状审计摘要(细节见 research.md)

1. **Lead 侧巡检纪律已有一份**:`packages/teamlead/lead-rules-base/runner-patrol-rules.md`(FLY-369)——「自然节奏巡检」(处理完一批 inbox 后 + 任务边界),明确「no new timer」。它解决「记得巡」靠的是事件节奏,**没有定时器,零 runner 活动的静默期恰好是它的盲区**(parked/done-lingering runner 不产生新事件 → 没有 inbox 批次 → 没有巡检触发)。本单补的就是这个洞。
2. 该文件有内容契约守卫 `fly369-patrol-rule.test.ts`,锚点必须保留。
3. Bridge 侧「巡逻类」工作全部骑 GatePoller 共享 tick(`tickCount % N`,FLY-725/FLY-208/FLY-1614 三个先例),FLY-1570 刚拆完「追人型 watchdog」,**新增独立 timer 是方向性禁忌**。
4. 配置:「不加新 flag」铁律区分 flag(on/off 门,禁)与 tuning knob(数值参数,允许)。现存 config-source 模式是 **Bridge boot 时预加载**——不满足「动态热调」;models.json(`packages/config/src/model-config.ts`)的 mtime/size cache-key 热读是 founder 点名的参照实现。
5. eng-lead 现行「会话 cron」过渡原型不在仓库里(运行时人肉约定),仓库内零成文——本单落地即首个成文机制。

---

## 4. 设计空间与选型

### 4.1 闹钟的触发载体

| 选项 | 说明 | 判 |
|---|---|---|
| A. 新建独立 setInterval | 每 Lead 一个或全局一个 timer | ✗ FLY-1570 刚拆完 watchdog 家族,「零新 timer」是既定纪律(FLY-1169/1172/1614 均遵守) |
| B. 骑 GatePoller 共享 tick + per-Lead due 账 | 每 ~60s(现有 patrol cadence)检查各 Lead 的 `now - lastTickAt >= interval(project)`,到点即注入 | ✓ 三个现存先例同构;间隔判断每次现读配置 → 动态热调自然成立 |
| C. 外部 cron 打 HTTP 端点 | 仿 `POST /api/patrol/scan-stale` | ✗ 多一个外部依赖(launchd/cron),「新 Lead 零配置自动获得」要再接线;Bridge 进程内已有现成 cadence |

**选 B**。动态热调的实现被 B 顺带解决:间隔不是 timer 的属性,而是每次 due 判断时现读的值——改配置后下一次判断(≤60s 后)即用新值,天然零重启。

### 4.2 频率配置的层级与热读

需求:默认 60min;可调;项目级覆盖;**动态热生效**;一处配置全舰生效;新 Lead 零配置。

| 层 | 载体 | 热? |
|---|---|---|
| 代码默认 | `DEFAULT_PATROL_INTERVAL_MS = 60min` 常量 | — |
| 全舰覆盖 | 全局热读文件(models.json 同款 mtime 热读) | ✓ |
| 项目覆盖 | `<projectRoot>/.flywheel/config.yaml` 的 `patrol:` 块,**每次 due 判断时热读**(mtime cache) | ✓ |

排除的形态:
- **env 旋钮作为调节面**(FLYWHEEL_PATROL_*):env 在进程启动时定格,改它必须重启 → 直接违反 1.3-①。env 只允许留给测试注入路径(如指定全局文件位置),不承载生产调节。
- **boot 预加载 config-source**(founder-milestone 同款):FLY-205 ship 窗教训「补装项目 config 落地后必须再重启一次 Bridge」——正是 founder 点名要避免的形态。

全局热读文件的落点是唯一真正开放的问题(候选:`~/.flywheel/patrol.json` 新文件,或挂进某个既有热读文件),进 research 核实后在 plan 定稿。

### 4.3 「active runner sessions > 0」的口径

Founder 语义:「没有任何 runner 在跑」= 不用巡。但 2026-08-10 的事故恰恰多为 **parked / awaiting / 卡住**的 runner 被遗忘——这些不是「在跑」但正是巡检对象。

**口径:非终态 session 数 > 0**(running + awaiting/parked 类,精确状态集在 research 里按 StateStore 现状锁定)。终态(completed/failed/canceled)不算。零非终态 = 零 tick,满足「零 runner 零 tick」验收;parked-only 的 Lead 照样收 tick,堵住事故主形态。

### 4.4 tick 内容(负面约束是硬验收)

严格两句,固定模板,零动态判断:

1. 「patrol_tick:巡检时间到。」
2. 「按 Bridge 的账,你名下有 N 个未终结 runner:<identifier/状态列表>。此名册是**待核声明**,不是结论。」

不含:该查什么、哪个可疑、任何预检结果、任何指令。验收阴性对照即 grep 这条消息不含预判/指令词。「收到 tick 该做什么」写在 **Lead 侧 rules 文件**里(Lead 自己的清单指挥 Lead 自己)——这是 founder 裁定下唯一合规的知识放置点。

### 4.5 Lead 侧清单的落点

| 选项 | 判 |
|---|---|
| 新建 `patrol-tick-rules.md` | ✗ 需双路径接线(claude-lead.sh + lead-rules-bundle.sh)+ README + pinned array 四处;审计发现 resolver parity 是单向的,漏接一边测试照绿(现存漂移先例:default-enable-policy) |
| **扩展 `runner-patrol-rules.md`** | ✓ 已在 dept 分支双路径接线、已有 guard test、主题同族(它管「怎么巡+怎么报」,本单加「何时巡(tick)+独立信源清单」);保留既有锚点,新增 FLY-1687 节 + 新锚点 |

**选扩展**。既有「natural cadence」巡检保留为事件驱动补充层,tick 成为定时主触发。

### 4.6 tick 的送达与防堆积

- 送达通道:Lead mailbox(现行 Bridge→Lead 事件通道,精确入口在 research 锁定)。
- 防堆积:Lead 忙/卡时每小时一条 tick 会在信箱堆积。规则:**每 Lead 至多一条未消费 patrol_tick**——注入前查未消费同类消息,存在则跳过本轮(仍推进 lastTickAt,不补发积欠)。巡检是幂等的(每次都是全量核对),漏一轮无损,补发旧 tick 无意义。
- Bridge 重启:lastTickAt 是否持久化 → research 权衡(内存版重启后延后一个周期 vs 持久版重启不丢节奏);倾向持久(一张小表/复用现有 ledger 模式),因为部署夜 Bridge 重启频繁,内存版会让重灾时段恰好没有巡检。

### 4.7 谁收 tick(Lead 面)

只有**能开 Runner 的 dept Lead**(dept 分支)可能有名下 runner session;cos(canSpawnRunners:false)、companion、external 天然零 session → 零 tick,无需显式排除逻辑——gating 条件(非终态 session>0)自动覆盖。新建 Lead(QA 槽)一旦有 session 即自动获得,零配置。

---

## 5. 开放问题(带进 research)

1. Bridge→Lead mailbox 注入的精确现存入口(函数/表),tick 消息的 kind 标识怎么定;
2. StateStore sessions 的精确状态词表 → 「非终态」集合定义;session→Lead 归属的现存查询;
3. 全局热读文件落点(`~/.flywheel/patrol.json` 新建 vs 挂既有文件);
4. lastTickAt 持久化的最小形态(新小表 vs 复用 turn_wait_ledger 式模式);
5. 「未消费 patrol_tick 存在则跳过」在 mailbox 表上怎么查(有无现成 status 列可判);
6. tick 消息里 runner 列表的字段(Linear identifier + status + tmux window name?)——给 Lead 核名册用,信息要够对但不越界成预检。

## 6. 明确不做(honest boundary)

- Bridge 侧任何预检/健康判断/「该查什么」提示(founder 裁定);
- 关键节点自动 thread 留痕(同族子项,不堵死即可);
- Lead 巡检结果的自动落账/自动处置(处置仍是 Lead 人工按应急程序);
- runner 侧任何改动(FLY-1614 已覆盖当事人视角);
- 巡检质量的机器评分/审计(未来单)。
