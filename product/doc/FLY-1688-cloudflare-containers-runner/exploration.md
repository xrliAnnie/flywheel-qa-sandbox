# FLY-1688 Cloudflare Containers 作为 Runner 底座 — 探索

Issue: FLY-1688 (https://linear.app/geoforge3d/issue/FLY-1688/researchhl-cloudflare-containers-作为-runner-底座-价格-凭据安全-远程-tmux-可观测性fly)
日期: 2026-08-10
基于: 无(本 issue 首份过程文档;上游是 FLY-1005 的 research/plan,见 §2)

---

## 1. 这一单是什么、不是什么

**是**:把「Cloudflare Containers 当 Runner 底座」这个**具体选项**的三个未知量测出来 —— ①凭据安全 ②价格 ③远程可观测性 —— 让 Annie 在**有数字**的情况下重新拍一次。

**不是**:
- 不是推翻 FLY-555「先物理机、出于安全」。那条 2026-06-24 的判断在本单里是**被检验的对象**,不是被推翻的前提。
- 不是重做 FLY-1005。多机通用架构(单 hub + 无状态卫星、锚点 A/B/C、warm pool、profile 分池、状态 sync)FLY-1005 已经做完并 merge,本单**只做 Cloudflare Containers 这一个具体底座的增量**。
- **不出结论、不出 PRD、不给采纳建议。** 这是 research-explainer:摆事实和取舍,由 Annie 和 HL 一起决定。

## 2. 上游已定、本单不重开的事

| 来源 | 已定的事 | 对本单的意义 |
|---|---|---|
| FLY-555(EPIC,Backlog) | Annie 2026-06-24:「先物理机、出于安全」(主要安全考虑),「成熟后考虑云端」 | 本单 = 那句「成熟后考虑云端」的一次带数字的复核 |
| FLY-1005(Done) | 横向扩展主线 = 单 Bridge hub + 无状态卫星/云节点;刻意不做跨机 StateStore 一致性;云节点阶段容器化从可选变必需 | 架构不重推。Cloudflare Containers 只是「弹性镜像节点」的一种具体实现 |
| FLY-1005 §3.7f | 节点复用前必须 sync-to-latest、跑完 cleanup | Cloudflare 的 ephemeral disk 天然强制这条,见 research §4.3 |
| FLY-624(Backlog,Low) | 多机版 tmux-attach:置顶一条**带机器标识**的命令;Bridge 必须记录每个 runner 在哪台机 | ③ 直接接这条写,不另起炉灶 —— 只是「哪台机」换成「哪个容器实例 ID」 |
| FLY-1072 / FLY-517 | 并发天花板 / 2026-07-09 全 runner 阵亡(内存水位) | 「我们确实顶到过单机天花板」的事实依据 |
| Annie 本单 issue | Containers 无硬性运行时长上限;关闭走 SIGTERM→15min→SIGKILL;我们已扛得住随时被杀 | 已核实为真(research §4.3),**不是本单的卡点** |

## 3. 三个开放问题(逐条在 research.md 回答)

### ① 凭据安全(Annie 明确最关心)
- Runner 现在到底拿着哪些凭据?各自怎么拿到、怎么续期?
- 搬到远端容器后存哪、谁能读、泄漏面多大?Cloudflare 提供什么?
- 容器被攻破的爆炸半径是什么?能不能做到「一次性、最小权限」?
- **Annie「先物理机出于安全」的原判断,是被缓解了还是仍然成立?**

### ② 价格
- 内存 / CPU / 时长 / 出网各自怎么计费?
- 按我们真实形态(峰值 ~27 并发、单个 4–13 小时)估一个月多少钱?
- 跟自己买几台物理机比,盈亏平衡点在哪?

### ③ 远程可观测性(接 FLY-624)
- Annie 的要求很具体:不需要一直显示,只要出问题时**一条成熟、随时可用的命令**点进去看 tmux 在跑什么。
- 业界成熟做法有哪些、各自代价?
- Cloudflare Containers 具体支持哪种?能不能 exec 进去?

## 4. 方法与诚实前提

1. **凭据那一问先审 codebase 再查厂商文档** —— 不问「云上一般怎么放 secret」,先问「我们这套现在到底带着什么」。审计位点见 research §2,均给 file:line 或实测命令。
2. **厂商数字全部标注来源 + 页面更新日期**,标记【厂商自报】。
3. **本机实测的标【实测】**;查不到的直接写【查不到】,不猜。
4. **零动手验证** —— 本单没有 Cloudflare 账号、没有部署、没有真跑过一个 Runner 容器。所有 Cloudflare 侧结论都是**文档推导**,不是实测。这条限制在 research §6「本单没覆盖什么」里再重申一次。
5. 并发数据口径沿用 Annie 在 issue 里的原话:`last_activity_at` 当结束时间会**高估**并发,当上界看。

## 5. 显式假设

1. 若上云,Runner 形态不变:仍是「一个 issue 一个干净 session」,tmux + Claude Code CLI(或 codex/agy/kimi),在 git worktree 里干活、push 分支、开 PR。
2. Lead **不上云**(FLY-555 已定,常驻数月 + isolate 休眠)。本单只谈 Runner。
3. Bridge/StateStore 留主机(FLY-1005 Option A)。本单不重新论证。
4. 成本对照里的物理机价格是**假设参数**,不是报价 —— 因此 §5 给的是**盈亏平衡公式**,Annie 可以代入她自己的真实机器价。
5. 本单不评估 Cloudflare 以外的云底座(AWS/GCP/Fly.io…)。想横向比要另开。

## 关联

FLY-555(父,先物理机的原判断)· FLY-1005(多机通用 research/PRD,Done)· FLY-624(多机版 tmux-attach,③ 的落点)· FLY-1072 / FLY-517(并发天花板 / OOM 事故)· FLY-346(沙箱化)· FLY-353(session-log,云端 failover 的前提)
