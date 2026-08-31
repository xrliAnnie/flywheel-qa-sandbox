# FLY-2030 重新理解:Raya 到底要做什么 — 对齐稿(非 plan)
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: founder 2026-08-28 页面打回(四条原话)+ Tadashi 指令 662b7990

> 性质:这不是新 plan。是按 Tadashi 要求,把「我们到底要做什么」重新理解成一页,交他与 founder 对齐。旧 plan(rev1–rev3)与评审循环已全部停掉。

## 0. 我听到的打回是什么

**Raya 本来就该是一个 Lead,不是一个新物种。** 我上一版把「Lead 今天已有的能力」(在 Discord 打字、在 roundtable @ 别的 Lead、收发消息、记忆)在 raya 仓里重新造了一遍——「brain 收发层 vs Raya 脑子」那个分层就是重造的产物。打回成立。

**证据(我事后核的,不是姿态)**:flywheel 的 Codex Lead 运行时(Mufasa 正在用的那套)已经有:Discord gateway、打字指示器(`DiscordTypingNotifier`)、roundtable 线程接线、消息游标、**轮次账本(`LeadJournal`,恰好解决我 plan 里花三轮评审才收敛的「消息不丢不重」问题)**、外发通道。我 plan 里 §2.3 的十个模块,七个在这里已经存在。

## 1. 她的四条原话,四条直答

| 她问 | 直答 |
|---|---|
| 「每隔几个小时」是多少小时?有 feature flag 控吗? | **6 小时**。来源:你 2026-08-18 自己圈的(PRD §8.7.2,「aab」的第二个 a =「6 小时,且运行期可改」)。**没有 flag**——按你 8-22 的规矩(能固化就别留旋钮)固化成一条调度配置。而且 6h 只是**兜底**:主通道是事件驱动(你说话它就答、Lead 回它就接),「事件为主 + 兜底节奏」也是你 8-17 圈的 C。⚠️ 若你现在想砍掉兜底、只留事件驱动:可以,砍的是你自己 8-17 那格,一句话的事。 |
| 这些能力 Lead 都有,为什么要专门做新东西? | 你说得对,不需要。上一版是我做错了(重造)。真正要新建的压缩后见 §2——主要就一件半。 |
| 为什么分「Bridge 收发」和「Raya 的脑子」? | 不该分。那一层就是把 Lead 运行时已有的东西重造了一遍。已废弃。 |
| 是不是把简单的东西搞复杂了? | 是。重造清单已扔(还没写码,零沉没成本);下面是压到最短的清单。 |

## 2. 如果 Raya 就是「一个带语音接口的 Lead」,还剩什么必须新建

| # | 事 | 用现成的哪个机制 | 还要新建的量 |
|---|---|---|---|
| 1 | Raya 上岗为一个常驻 Codex Lead(#raya = 她的 chatChannel) | **Mufasa 同款**:Codex Lead 运行时 + 一条 Lead 注册行;`CODEX_HOME` 用她已有的 `~/.flywheel/raya/codex-home` | ≈ 配置 + 身份文件内容(IDENTITY.md 已有) |
| 2 | 模型钉死 gpt-5.6-sol · xhigh · 1M(单会话参数) | `gpt-5.6-sol` 已是 flywheel 的 `CODEX_STANDARD`;Lead 的 `thread/start` 已接受任意参数 | **本单可能唯一的一小块代码**:per-lead 的 effort/1M 参数传进去(待核,或已支持) |
| 3 | 读六仓状态 + 「静了多久」 | Lead 本来有 shell(`git log` 谁都能跑);注册表 `projects.json` 就在那 | ≈ 0(写进她的身份提示,不写系统) |
| 4 | 6h 兜底巡视 | 既有定时触发形态(xiaohongshu-scheduler / daily-standup 同族:到点投一条消息进她的 inbox) | ≈ 一条调度配置 |
| 5 | 追问别的 Lead | roundtable(每个 Lead 现成能力;FLY-282 互信名单自愈) | 0(只差把她登记进 registry——Tadashi 已认领) |
| 6 | 记忆 | Codex Lead 的 CODEX_HOME 记忆(Mufasa 同款)+ 她的 raya-memory 仓(已建) | 0 |
| 7 | **语音**(真正新的东西) | **已建成**:FLY-2074(merged,在跑)——她听见、出声回答 | 0;唯一交叉点:「进入语音模式」短语监听现在住在 raya brain 进程里,她转成 Lead 后这个小监听去留要对齐 |
| 8 | 三指标(内存/swap/实际 window) | **已建成**:FLY-2029(在跑) | 0 |

⇒ **压缩后的答案:必须新建的 ≈ 一条 Lead 注册 + 模型参数一小块 + 一条调度配置 + 身份提示内容。其余全是现成机制或已交付件。**

## 3. 一格需要在对齐时定(你的两句话现在指向不同,我不替你选)

| 你 8-18 拍的 | 你 8-27 页面上说的 |
|---|---|
| 「他有点像是一个**独立的产品**……自己的仓」;§8.5:**假设使用者没有 flywheel 这个仓库**,必须有 flywheel 源码才能用 = 设计错了 | 「这些事情现在所有的 **lead 都有这些能力**啊……为什么会需要专门做什么新的东西呢?」 |
| ⇒ 沿这句走 = Raya 自己的运行时(上一版方向,已被你打回) | ⇒ 沿这句走 = Raya 骑 flywheel 的 Lead 运行时(Mufasa 形态),**代价是她不再是「不依赖 flywheel 源码」的独立产品** |

两句都是你的原话。走 Lead 形态时,§8.5 那格怎么改口径(比如:「Raya 的产品形态 = flywheel 的一个 Lead 角色」),对齐时定一格即可。

## 4. 已建成、不浪费

语音管线(FLY-2074)、三指标记录(FLY-2029)、raya/raya-memory 仓、IDENTITY.md、专用 CODEX_HOME、Discord bot 身份——全部继续用。被打回的只是我 plan 里「在 raya 仓再造收发层」的部分,**尚未写任何代码**。

## 5. 挂起中(按 Tadashi 指令,等这轮对齐后再动)

可写根分歧(Codex R1 vs Tadashi ④)· 追问降级落点(②)· 全部 rev1–rev3 plan 内容 · design-review gate(rev3 manifest ff08a168 收到未执行)。
