# FLY-2131 Raya 大脑:summary 吸收 + 追问 + 可见汇报 — 探索
Issue: FLY-2131 (https://linear.app/geoforge3d/issue/FLY-2131/rayav2-m2-大脑summary-吸收-追问-可见汇报承接-fly-2030-m1)
日期: 2026-08-28
基于: 无(上游 = FLY-2030 文件夹全套:scope-final.md v2 · plan.md v2 · summary-contract.md · raya-identity-draft.md · founder-only-authority-exemption-proposal.md;以及 FLY-2097 qa-report.md 移交节)

## 0. 这张单是什么

FLY-2030 在 founder 拍板下收在 M1(summary 回流机制,flywheel PR #975 已 merge),M2(大脑吸收 + 追问)以**新单 FLY-2131** track。founder 2026-08-28 22:35Z 拍板:merge 后 FLY-2030 干净关单,不 reopen。

继承的 M2 义务清单(issue 枚举六项,均有 Linear 记录):

| # | 义务 | 来源 |
|---|---|---|
| 1 | **吸收**:Raya 把各项目 summary 真正读进自己的记忆,成为她回答 founder 的背景知识 | FLY-2030 M2 本体(M1 只建了回流) |
| 2 | **追问**:没看懂的地方,自己去问该项目的 Lead | FLY-2030 M2 本体 |
| 3 | **可见汇报**:每轮 review/吸收后在她自己的 channel 发汇报(时间+数量+做了什么);吸收不许黑箱 | founder 22:04Z 原话新增 |
| 4 | **安全栓两道**:① Raya merge authority 激活前,无 `--match-head-commit` 的 summary merge 机械拒绝(TOCTOU);② `summary_registry_activation_preflight` CLI 源缺失时 fail-closed | M1 QA 升级的硬性项 |
| 5 | **开场 prompt 身份**:语音侧开场指令自带 Raya 身份与 founder 称呼 | FLY-2097 移交项(qa-report §D 白纸黑字划给本单) |
| 6 | summary-registry-cli 测试 flaky(提 timeout 或 stub spawn) | FLY-2030 QA 记档 follow-up |

**继承范围的读法(本探索的第一个判断)**:issue 标题写「大脑:summary 吸收 + 追问 + 可见汇报(承接 FLY-2030 M1)」,范围标题写「继承 FLY-2030 已立的 M2 义务清单」。FLY-2030 plan §3 的 M2-a(模型参数)/ M2-b(巡视触发)/ M2-d(Raya 上岗)/ M2-e(身份 M2 段)是义务 1「吸收」的**构成性前提**——没有部署的 Lead 运行时和巡视触发,吸收在物理上不存在;它们不是额外范围,是义务 1 的实现基座。M2-c(指标③ tokenUsage 记录)是原 M2 验收「三指标在跑」的一部分但未出现在本单枚举里——处置见 §4 待确认。

## 1. 现状盘点(2026-08-28 实核,细节与复核命令在 research.md)

**M1 已落(flywheel main,PR #975)**:
- `flywheel-comm summary`(投递)+ `summary verify-pr`(当前 head 只读 verifier,输出 verifiedHeadSha)+ `summary-registry migrate|verify-activation`(迁移/激活栅栏)。
- `summary_registry_activation_preflight` 已接进 `restart-services.sh`(pull 之后、任何 mutation 之前)。
- canonical assignment(closed 枚举 `summaryRole`)、granularity 单一来源 `~/.flywheel/summary-config.json`、双规则装载路径、窄口径豁免条款。

**M1 尚未闭环(不是本单义务,是本单前置)**:
- raya 仓 PR #4(summaries/ 合同)**仍 open**——成对 merge 的 raya 半边未落;部署、founder 拍粒度旋钮、迁移均 pending。开发用预构 fixture 先行(原 M1 实现体在做)。

**Raya 现状**:
- **不在** `~/.flywheel/projects.json`(未注册为 Lead;merge authority 未激活——这正是安全栓①要求「激活前」到位的窗口)。
- raya 仓两条已 merge 腿:apps/brain(#raya 文字对话,launchd 常驻)+ apps/voice(按需 realtime 语音)。
- 语音开场指令:`config.realtime.startInstructionsFile` 机制存在但**生产未配**,现跑硬编码一行「你是 Raya。始终用简短、自然的中文口语回答;需要工具时可以委托后台 Codex。」——FLY-2097 QA 实测:换 prompt 通道后她自称 Raya(2/2)但叫不出 founder 名字(0/2),因为旧时代那声「Xiaorong」来自 Codex 账号个性化,不是 Raya 认识 founder。

**两道安全栓的病灶已定位**:
- ①:M1 的 `--match-head-commit` 纪律只写在身份稿(prompt 层)。机械层缺一个「verify→merge 原子绑定」的唯一通路。
- ②:`restart-services.sh:181` 的 `[[ -f "$source_cli" ]] || return 0` 是字面上的 fail-open——CLI 源缺失时整个激活栅栏静默放行。

**flaky 根因已定位**:`summary-registry-cli.test.ts` 第二个用例未注入 `validateTeamleadCandidate`,落进 default validator 的 `spawnSync("pnpm", ["exec","tsx",…])` 真子进程;冷启动 tsx 编译可超 vitest 默认 5s。

## 2. 核心设计问题与方向

### Q1 「读进记忆」具体指什么?(义务 1 的实质)

merge = 已阅回执只证明「她看过」,不证明「成为背景知识」。方向:**三层记忆,零新子系统**——
1. **归档层**(已有):merge 后 summary 文件永在 raya 仓 `summaries/`,她随时可 grep(A2 自读的一部分)。
2. **工作记忆层**(本单钉死):每轮吸收后,她把「每个项目现在怎样」的增量写进 **raya-memory 仓的 MEMORY.md**(FLY-2074 F4′ 刻意可写、独立版本化),按项目分节,引用 summary 文件路径作 provenance。这就是她回答 founder 的背景知识,且 git 历史 = 吸收的审计面。
3. **会话层**(既有运行时行为):Codex thread 的上下文;thread 轮换靠 2 层重建,不靠祈祷。

否决的替代:只靠 CODEX_HOME 隐式记忆(黑箱,与义务 3「不许黑箱」直接冲突);建向量库/摘要索引(为 11 条/轮的量级造基础设施,违反 enforce simplicity 与 founder「只删不加」红线)。

### Q2 可见汇报怎么保证数字是真的?

Prompt 层「叫她汇报」挡不住幻觉数字。方向:**安全栓①的 merge 唯一通路顺手留证**——`flywheel-comm summary merge` 每次成功 merge 追加一行 JSONL 回执(ts / repo / PR / project / verifiedHeadSha)到她 state 目录;汇报数字从本轮回执数出来,QA 拿回执对 channel 消息核数。一石二鸟:栓①的机械层与汇报的可核性共用同一个文件,不另造账本。

空轮(巡视醒来但无新 summary)是否也发?默认**有吸收才汇报**(避免 6h×4 的「无事」刷屏,与 PRD §6.3「沉默是一等信号」相合);给 founder 一行可切的「空轮也报心跳」选项。验收锚「一轮吸收后 channel 出现汇报」按有吸收轮定义,不受影响。

### Q3 安全栓①的「机械拒绝」边界在哪?

Raya 是 full-access Lead,理论上能敲裸 `gh pr merge`。能做到的机械层:**唯一受认可通路里没有任何不带 `--match-head-commit` 的代码路径**(命令内部 verify→取 verifiedHeadSha→带栓 merge,一步完成;head 在 verify 后被推进 ⇒ gh 端拒绝 = TOCTOU 闭合),加身份/规则红线「merge 只许走这条命令」,加天然审计面(merge 历史 + 回执文件互核)。做不到的:阻止一个蓄意绕过红线的模型进程调用裸 gh——那是所有 full-access Lead 共有的信任边界,不为本单单独造围栏。这条边界诚实写进 plan 与 founder HTML。

### Q4 开场 prompt 的 founder 称呼用哪个名字?

QA 实测旧通道叫的「Xiaorong」是 Codex 账号个性化。方向:开场指令写明「founder 是 Annie(李晓蓉 / Xiaorong Li),当面称呼用 Annie」——两名并列供模型识别,称呼锚定一个;founder 想改是改一行的事,不设为需要她先拍的门。长度预算:FLY-2097 的退出协议以「追加」方式接在本单内容之后,总长受 8,192 上限,本单内容压在 ~6,000 字符内。

### Q5 追问的触发面

身份稿(raya-identity-draft)已写对两个触发:Judgment 缺/空 ⇒ 不算 read material,PR 保持 open(= 保持未读),去 roundtable @ 该 Lead 问,拿到答案才吸收才 merge;读了没看懂 ⇒ 同路。本单不新设计追问协议,只把身份稿 M2 段落地 + 真机验收一次真实追问往返。roundtable 通道与 registry(raya.json)是既有件/Tadashi 已认领的配置项。

## 3. 不做(每条都是决定,不是遗漏)

- 不建吸收专用的向量库/索引/新服务(Q1)。
- 不为栓①造 gh 拦截围栏或独立审计 daemon(Q3,边界如实写)。
- 不动 FLY-2030 plan §3 已过六轮 design review 的基座设计(M2-a 参数链 / M2-b flag+GatePoller rider+lead_events / M2-d TUI 部署形态)——原样承接,只做过期复核;复核已确认接缝未漂移(research.md §1)。
- 不碰 FLY-2097 的退出协议实现(它以追加方式接在本单内容后,冲突面为零)。
- 空轮心跳默认不发(Q2,一行可切)。

## 4. 待确认(非阻塞,已 ask Tadashi)

- **M2-c(指标③:Raya thread 的 tokenUsage → context-usage.jsonl 记录)是否随本单落**:原 M2 验收含「三指标在跑」,但本单 issue 枚举未含。接缝已知(TUI demux 的 `thread/tokenUsage/updated` → 既有 v1 row 合同),做是小接线。默认按**做**设计(验收如实报③状态),Tadashi 答复若砍则从 plan 删一节,不牵动其他。
