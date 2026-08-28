# FLY-2030 最短新建清单 — 最终版(只出清单,不写码)
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28
基于: re-understanding.md + founder 2026-08-28 页面三条回复 + Tadashi 指令 26edec49

## 0. 已拍的三条口径(本清单的前提,⛔ 不再重议)

| # | 口径 | 出处 |
|---|---|---|
| ① | **形态 = Lead 运行时 + 独立仓,同时成立**。她的类比:像 Peter——人不在 flywheel 仓里,用的却是 flywheel 这套系统。独立仓 ≠ 独立运行时;raya / raya-memory 两仓已建好 merge,**仓这条已满足,不新建** | founder 原话(Tadashi 转,26edec49 ①) |
| ② | 巡视间隔 = **可调的值,不是 on/off 开关**:落 DB 配置(`flag_values` 表,FLY-2100 正在加按项目 scope 列),默认 6h,运行期改一行生效;⛔ 代码里不写 if 开关、不写死 6h | founder「feature flag 这样的概念,default 6 小时」+ Tadashi 定的落法 |
| ③ | **(2026-08-28 02:38 Tadashi 更正后的版本)状态与 summary 是 PRD 里并存的两套**:**§5 A2**「总管自己去各仓读状态」(她圈 A,「先 A、力气放追问」)——这半没变,读状态仍是 Raya 自己做;**§8.8** 另有一整套她 8-18 晚拍的 **summary 回流机制**(各 Lead 把 summary 以 PR 写进总管自己的仓,open = 未读 / merge = 已阅)——**会牵动 11 个部门 Lead**,见 §1.5。⚠️ Tadashi 第一版口径「改动只在 Raya 侧」只读了 §5,founder 坚持后他复读全文确认**她是对的**;此处按更正版记 | Tadashi 指令 bacc4ffb(更正其 26edec49 ③) |

## 1. 最终清单(按「必须新建」从有到无排;实核标注 = 2026-08-28 读 flywheel `main` 源码)

| # | 事 | 落在哪 | 用现成的什么 | 必须新建的量 |
|---|---|---|---|---|
| 1 | **per-lead 模型参数透传** —— gpt-5.6-sol · xhigh · 1M 钉进 Raya 的每次 `thread/start\|resume` | flywheel(小) | 【实核】`buildThreadParams`(codex-lead-runtime.ts:989)今天只钉 `approvalPolicy/sandbox/cwd/baseInstructions`,**没有 model/effort/window 口子**;`gpt-5.6-sol` 已是 `CODEX_STANDARD`(config/model-builtins.ts:32);PRD §8.6.6.1「单会话参数,不进 config.toml」与此落法正好吻合 | **本单唯一确定要写的代码**:Lead 条目三个可选值 + 透传 + 回执核验。小 |
| 2 | **巡视触发(默认 6h,DB 可调)** | flywheel(小) | 【实核】`flag_values` 表实存(StateStore.ts:4548);FLY-2100 在加 scope 列;定时投递沿既有 scheduler 形态(xiaohongshu-scheduler / daily-standup 同族:到点把一条「巡视」消息投进 Lead inbox) | 一条 flag 注册 + 一条调度接线 |
| 3 | **三指标 ③(实际 window 峰值)在 Lead 形态下的记录** | flywheel 或 raya(小) | 【实核】Codex Lead 后端**没有任何 tokenUsage 记录**(零命中);raya 侧 `parseContextUsage`/`context-usage.jsonl` 合同已建(FLY-2029) | 小接线:把 Raya-Lead 轮次的 `thread/tokenUsage/updated` 落进 raya 的 metrics 文件;若判为下一批,须**如实报「Lead 形态下 ③ 暂缺」**,⛔ 不许拿 voice 的几行冒充 |
| 4 | Raya 上岗注册 | flywheel(配置) | Lead 注册行(Mufasa 同款 `backend: codex-app-server`;权限形态直接用既有 **full-access profile**,FLY-350/398——§8.4「全给」的现成载体,不新造沙箱设计);`CODEX_HOME=~/.flywheel/raya/codex-home`(已建);`chatChannel=#raya`(已建);`RAYA_BOT_TOKEN` 进 flywheel env(一行部署) | 配置;挂载位置(挂哪个 project 条目)是 implement 细节,两个先例:Mufasa(growth 下)/ infra bots(flywheel 下) |
| 5 | 身份与纪律(读六仓状态、沉默信号、开口纪律、一起想、追问、记忆边界) | raya 仓(文档) | 全部是 **prompt 层**:PRD §3/§4/§6/§10 的行为面写进她的 Lead identity;IDENTITY.md 已有底稿;读状态 = 她自己 shell 读注册表 + `git log`(§5 A2,更正版 ③ 的前半) | 文档内容,零代码 |
| 6 | 追问别的 Lead | — | roundtable 现成能力;registry `raya.json`(Tadashi 已认领);【更正存档】她的 bot 权限**已够**(Lead 实测,research §4 更正行) | 0;allowBots 并入等各 Lead 重启班车,过渡期口径由 Tadashi 定(挂起项) |
| 7 | 记忆 | — | CODEX_HOME 记忆(Codex 原生,Mufasa 同款)+ raya-memory 仓她自己 commit(已建) | 0 |
| 8 | 语音 | — | FLY-2074 在跑,不动。**交叉点消解**:brain 进程从来只做采样 + 语音短语触发(没有对话能力),Lead 形态下 brain/voice **原样保留**,Raya-Lead 是新增的说话面 | 0;一行注意:Raya-Lead 的 identity 里写明「语音短语不抢答」(brain 已认领这两个短语) |
| 9 | 三指标 ①②(内存/swap) | — | FLY-2029 在跑 | 0 |

⇒ **必须新建 = 一小块代码(#1)+ 两条接线(#2、#3)+ 一条注册配置(#4)+ 身份文档(#5)。其余为 0。**

## 1.5 🔴 §8.8 summary 回流机制 —— PRD 里已拍、**至今没有任何单承接的缺口**(不在本清单的必须新建里,单列防丢)

| 项 | PRD 已定内容(她 8-18 晚拍的) |
|---|---|
| 机制 | 各 Lead 把 summary 以 **PR 写进总管自己的仓**;**open PR = 未读,merge = 已阅**(§8.8/§8.8.1,她自己发明的机制) |
| 内容 | **事实 + 判断**,Lead 的判断是必需项不是加分项——「光知道做了 issue 一二三,他毫无概念」(§8.8.2 她圈 c) |
| merge 权 | 总管自己 merge,不需要她 approve(§12.3.3 她的自由表述);豁免**窄口径**:只覆盖总管自己仓里、他读的那类 summary/report PR(§12.3.4 她圈 a) |
| 波及面 | **11 个真·部门 Lead** 都要新增「定期写 summary PR」行为(§8.8.3;这正是 26edec49 ③ 第一版口径漏掉的) |
| 凭证层 | 免费:账号级 gh token,scope 含 repo,跨仓写已可行(§8.8.3 实测) |
| 例外 | PRD 原话:`personal-assistant`(Belle)**不是 git 仓**,她的 summary 要另走通路,「不许假装六个仓都在」。⚠️ **此事实已过期**:2026-08-27 实测该目录有 commit(最后 2026-08-25)——implement 前重核(`git -C ~/Dev/personal-assistant log -1`),例外可能已消失 |
| 量级参考 | PRD §12.2.1:11 Lead × 6h 周期 ≈ 44 PR/天;粒度备选(一 Lead/一项目/一周期一 PR)PRD 已列,粒度是工程判断 |
| **承接状态** | **PRD §13 记着它没有进过任何 build 单(原四张单一张都没覆盖)**;Tadashi 已问 founder 要不要立单,她的答复他会转来。⛔ 在那之前:不属于 FLY-2030 的必须新建,也**不许当它不存在** |

## 2. 随旧架构消失的东西(不再做,留档防复活)

- 旧 plan 全量(rev1–rev3):`packages/codex-client` 抽包、RayaThread/TurnQueue/Router/Conversation、outputSchema 输出合同、批结算、asks 状态机、interruptions 账本、brain 补读——**Lead 运行时已有等价件或不再需要**。
- C0 探针族(P-resume / P-schema / P-read / P-subagent):其被测对象(raya 自建会话回路)不存在了。Lead 形态下新的待核点只有两个:#1 透传后的服务端回执核验、#3 usage 通知在 Lead 后端是否可收——都在 implement 内做,不需要独立探针轮。
- 反指标独立账本(§9.2 ③「打断次数 + 值不值」):属被打回内容;Lead 形态下最短是否需要单独账本,留给下一轮拆单时定,本清单不建。

## 3. 挂起中(等 Tadashi 重排,不在本清单)

可写根口径(Lead 形态下具体化为「用哪个既有 profile」,#4 按 full-access 假设,他可改)· 追问过渡期降级口径 · 验收细则(issue 原验收锚不变:她在 #raya 真实对话 + 至少一次她当场可否掉的追问且理由可溯 + 三指标在跑)。

## 4. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| `buildThreadParams` 无 model/effort/window | 2026-08-28,flywheel main | `rg -n "buildThreadParams" packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` |
| Codex Lead 后端零 tokenUsage 记录 | 2026-08-28 | `rg -rn tokenUsage packages/teamlead/src/lead-backends/codex` |
| `flag_values` 表在 teamlead.db;FLY-2100 加 scope 列进行中 | 2026-08-28 | StateStore.ts:4548;FLY-2100 状态 |
| raya/raya-memory 两仓已建并 merge | 2026-08-27 | `gh repo list xrliAnnie \| grep raya` |
