# FLY-2030 最终范围与最短新建清单 — v2(§8.8 并入,两里程碑)
Issue: FLY-2030 (https://linear.app/geoforge3d/issue/FLY-2030/rayav2-大脑状态吸收-追问总管先行权限第一批全给)
日期: 2026-08-28(v1 = 同日早些时候,已被本版取代,内容在 git 历史)
基于: re-understanding.md + founder 三条页面回复 + Tadashi 指令 26edec49 / bacc4ffb(74ed0fc3 补发)/ **3f707089(founder 拍板:§8.8 并进 2030,一张单全包,两个可独立验收的里程碑)**

## 0. 已拍口径(本清单前提,⛔ 不再重议)

| # | 口径 | 出处 |
|---|---|---|
| ① | 形态 = **Lead 运行时 + 独立仓**,同时成立(Peter 类比);raya / raya-memory 两仓已建,不新建仓 | founder(26edec49 ①) |
| ② | 巡视间隔 = **可调的值**落 DB(`flag_values`,FLY-2100 加 scope 列),默认 6h,运行期改一行生效;⛔ 不写 if 开关、不写死 | founder + Tadashi 落法(26edec49 ②) |
| ③ | **A2(总管自己去各仓读)与 §8.8(各 Lead 写 summary PR 进总管仓)在 PRD 里并存**;后者牵动 11 个部门 Lead(Tadashi 第一版「只动 Raya 侧」口径已被他自己更正) | bacc4ffb/74ed0fc3 |
| ④ | **§8.8 并进 2030,一张单全包,不拆单不留缺口**;形状 = 两个可独立验收的里程碑,**一(summary 回流)先于二(吸收+追问)**,但各自可验,不做成一个大黑盒 | founder 拍板 + Tadashi 形状(3f707089) |
| ⑤ | 两个旋钮**不自己定**,列成待她拍的选项:summary 频率 · summary 粒度(§3) | 3f707089 |

## 1. 里程碑一 · summary 回流跑通

> **验收(Lead 定):六个项目各真产出过至少一条 summary PR;总管能列出未读;merge 之后不再出现。**

| # | 事 | 落在哪 | 用现成的什么 / 实核 | 必须新建的量 |
|---|---|---|---|---|
| 1.1 | **summary 存放约定**:路径/命名/格式;内容 = **事实 + 判断**(判断是必需项,PRD §8.8.2 她原话「光有 issue 一二三,总管毫无概念」) | 总管仓(文档合同) | 无现成;默认提案(implement 可调):`summaries/<project>/<YYYY-MM-DD>-<leadId>.md` + 头部字段 `{project, lead, period, facts, judgment}` | 一页合同文档,零代码 |
| 1.2 | **11 个 Lead 侧的产出能力:一个共享命令 + 规则层一段**(⛔ 不是每个 Lead 各写一遍) | flywheel(**M1 最大新建块**) | 【实核】flywheel-comm 现无 summary 类子命令;`daily-standup.sh` 是 Bridge API 触发,不是此接缝——共享命令要新写(形态建议:flywheel-comm 子命令或 scripts/ 一条:组 summary 草稿 → `gh` 在总管仓开 PR);规则层 = `lead-rules-base/` 新一段「summary 义务」,全体 Lead identity 装载 | 一条命令 + 一段规则(写一遍,11 处生效) |
| 1.3 | **总管侧未读/已阅**:open PR = 未读队列,merge = 已阅回执 | raya 侧(提示层)+ flywheel(一段规则) | 她有 shell + gh:`gh pr list`(未读)/ `gh pr merge`(已阅);**merge 权已拍**:总管自 merge、不需 founder approve,豁免**窄口径**只覆盖总管自己仓里的 summary/report PR(PRD §12.3.3/.4) | 身份提示 + **规则例外:🛑 已暂停顺手加**——措辞逐字稿单独成件送 Tadashi 审(`founder-only-authority-exemption-proposal.md`:要加什么/现文哪句挡住/加完恰好多允许哪一条),他判后才动 rules 文件 |
| 1.4 | Belle 例外通路 | — | 【实核 2026-08-28】`~/Dev/personal-assistant` **已是 git 仓且有 remote**(xrliAnnie/belle-workspace,commit 至 08-25)——PRD「不是 git 仓」已过期;implement 前最终重核一次 | **0 —— 不预建例外机制:这是决定,不是遗漏**。理由:例外的前提(非 git 仓)经实核已消失,照抄过期事实会凭空造一套多余机制;若终核推翻(仓又没了),再按 PRD「不许假装六个仓都在」补通路 |
| 1.5 | 凭证 | — | 账号级 gh token、scope 含 repo,跨仓写已可行(PRD §8.8.3 实测) | 0 |

## 2. 里程碑二 · 大脑吸收 + 追问(前提:M1 已跑通)

> **验收(Lead 定):对一个真实分岔说出那句话,而且 founder 能当场否掉它。**(即 issue 原验收锚:她在 #raya 真实对话 + 理由可溯 + 三指标在跑)

| # | 事 | 落在哪 | 用现成的什么 / 实核 | 必须新建的量 |
|---|---|---|---|---|
| 2.1 | **per-lead 模型参数透传**(gpt-5.6-sol · xhigh · 1M 进每次 thread/start\|resume) | flywheel(小) | 【实核】`buildThreadParams`(codex-lead-runtime.ts:989)只钉 approvalPolicy/sandbox/cwd/baseInstructions,无 model/effort/window 口子;`gpt-5.6-sol` 已是 `CODEX_STANDARD`;PRD §8.6.6.1「单会话参数不进 config.toml」吻合 | **M2 唯一确定代码块**:三个可选值 + 透传 + 回执核验 |
| 2.2 | 巡视触发(默认 6h,DB 可调,口径 ②) | flywheel(小) | 【实核】`flag_values` 实存(StateStore.ts:4548);定时投递沿既有 scheduler 形态(到点投一条「巡视」消息进她 inbox) | 一条 flag 注册 + 一条调度接线 |
| 2.3 | 三指标 ③(实际 window 峰值)Lead 形态下的记录 | flywheel 或 raya(小) | 【实核】Codex Lead 后端零 tokenUsage 记录;raya 的 `parseContextUsage`/`context-usage.jsonl` 合同已建 | 小接线;不接则**如实报「③ 暂缺」**,⛔ 不拿 voice 行冒充(Tadashi 26edec49 后追认盯这条) |
| 2.4 | Raya 上岗注册 | flywheel(配置) | Mufasa 同款 `backend: codex-app-server` + 既有 **full-access profile**(§8.4 全给的现成载体);`CODEX_HOME`/`#raya`/bot 均已建;`RAYA_BOT_TOKEN` 进 flywheel env 一行 | 配置;挂载位置 implement 定 |
| 2.5 | 身份与纪律(prompt 层) | raya 仓(文档) | 输入面:**summaries(M1 产出,主料)+ A2 自读各仓(补充,她自己 shell)**;纪律 = PRD §3/§4/§6/§10 行为面(沉默信号、可否掉的问句、一起想、不排序不填表、追问走 roundtable);IDENTITY.md 有底稿;注意行:语音短语不抢答(brain 已认领) | 文档内容,零代码 |
| 2.6 | 追问 Lead / 记忆 / 语音 / 指标①② | — | roundtable 现成(registry raya.json Tadashi 已认领;权限实测已够)· CODEX_HOME 记忆 + raya-memory · FLY-2074 在跑 · FLY-2029 在跑 | 0 |

## 3. 两个旋钮 —— 待 founder 拍(⛔ 本清单不选;每项附「总管每天要 merge 多少」)

**参考量级(PRD §12.2.1 的算式)**:11 个部门 Lead × 每 6h 一条 ≈ **44 PR/天**进同一个仓 ⇒ 总管每天要 merge ≈ 44 次「已阅」。

### 旋钮 ① summary 频率

| 选项 | 内容 | 对总管 merge 量的影响 |
|---|---|---|
| A | 定时(如每 6h) | 恒定可预估:6h × 11 Lead ≈ 44/天;若改**每日一次** ≈ 11/天 |
| B | 各 Lead **收工时**产出(事件驱动) | 跟着真实工作节奏走:活跃期高、静默期趋近 0;总量不可预估,但静默项目不制造空 summary(与「沉默 = 一等信号」相合) |

### 旋钮 ② summary 粒度

| 选项 | 内容 | 对总管 merge 量的影响(按 6h 定时折算) |
|---|---|---|
| A | 一 Lead 一条 | 11 × 4 ≈ **44/天**;判断最原汁(每个 Lead 自己的) |
| B | 按项目聚合(6 个项目各一条) | 6 × 4 ≈ **24/天**;⚠️ 谁执笔聚合要定(有 CoS 的项目天然是 CoS,没 CoS 的单 Lead 项目无差别) |
| C | 一周期一条全合 | ≈ **4/天**;聚合层最厚,Lead 的判断被转述一次 |

两旋钮独立于 Raya 自己的巡视间隔(口径 ②,那是她「读」的节奏;这里是 Lead「写」的节奏)。

## 4. 不做 / 已废弃(**每条都是决定,不是遗漏**——读到空缺想去补的人,先读这里的理由再动手)

- 旧 plan 全量(rev1–rev3:自建会话回路、outputSchema 合同、批结算、asks 状态机、interruptions 账本等)——**决定**:founder 打回 + Lead 形态下运行时已有等价件;C0 探针族随之废弃(新的待核点只剩 2.1 回执核验与 2.3 usage 通知,均在 implement 内做)。
- 反指标独立账本(§9.2 ③「值不值」)——**决定,暂缓**:属被打回内容,Lead 形态下是否需要独立账本留拆单时定;⛔ 不据此空缺顺手建。
- Belle 例外机制预建(1.4)——**决定**,理由见该行。
- 规则例外顺手落地(1.3)——**决定,暂停**:红线合同逐字审,提案已单独成件。

## 5. 挂起(等 Tadashi 批量回,不追)

full-access profile 口径确认(2.4 按它假设)· 追问过渡期(allowBots 班车)口径 · 验收细则展开。

## 6. 会过期的结论

| 结论 | as-of | 重核 |
|---|---|---|
| `buildThreadParams` 无 model/effort/window | 2026-08-28 flywheel main | `rg -n "buildThreadParams" packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts` |
| Codex Lead 后端零 tokenUsage 记录 | 2026-08-28 | `rg -rn tokenUsage packages/teamlead/src/lead-backends/codex` |
| `flag_values` 表实存;FLY-2100 scope 列进行中 | 2026-08-28 | StateStore.ts:4548;FLY-2100 状态 |
| flywheel-comm 无 summary 子命令;daily-standup 非此接缝 | 2026-08-28 | `flywheel-comm` 帮助输出;`head scripts/daily-standup.sh` |
| personal-assistant 已是 git 仓 + remote belle-workspace | 2026-08-28 | `git -C ~/Dev/personal-assistant log -1 && git remote -v` |
| Raya bot 权限已够(Lead 实测) | 2026-08-28 | 用 Raya token `GET /channels/<id>/messages` 实测 |
