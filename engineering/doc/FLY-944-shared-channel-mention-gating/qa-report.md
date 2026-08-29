# FLY-944 shared 频道 lead-to-lead @-mention 不触发 — QA 报告

Issue: FLY-944 (https://linear.app/geoforge3d/issue/FLY-944/bugrouting-shared-频道-reply-gating-漏掉-lead-to-lead-mention-只有-founder)
日期: 2026-07-07
基于: plan.md

**Verdict: PASS** — 三段式 pipeline 的 QA 阶段独立验证。实现与 plan 逐条对齐;根因修复经决策级 E2E 证明有效;FLY-152/898 回复纪律原样保留;全套单测 + 集成测试 + shellcheck/biome/CI 全绿;部署就绪性核实通过。**+ 真机 529 房 lead-to-lead N-to-N E2E 全 PASS(Annie 选 (b),见 §8)。**

---

## 1. 被验对象(本分支已提交)

配置归一化方案(方案 A),**零插件代码改动**。改动落在 FLY-898 既有脚本/CLI/启动位点:

| 文件 | 作用 |
|---|---|
| `packages/teamlead/src/core-room-gate-cli.ts` | 新增 `--all-leads`(per-lead 角色枚举,驱动 shared 清扫) |
| `packages/teamlead/scripts/apply-core-room-mention-gate.sh` | ① 主 transform 追加清 allowFrom;② `--allowfrom-only` 模式;③ `--all-shared` role-aware fleet 清扫;④ `atomic_patch` 抽取 + 备份名 per-process 序列 |
| `packages/teamlead/scripts/claude-lead.sh` | 启动自愈:CoS-core + roundtable allowfrom-only(同 FLY-898 fail-closed 守卫内) |

根因(research §3.1 + 我方复核 `server.ts:673-790`):插件 `gate()` 里 per-group `allowFrom` 检查在 mention 判定**之前**(server.ts:724-726 早于 784-789),陈旧白名单在 mention 之前就静默丢掉了同伴 lead 的真 `<@id>`。修复 = 退役 shared 频道的 allowFrom。

---

## 2. 测试结果

| 验证项 | 结果 |
|---|---|
| CI(Build & Test,PR #484) | ✅ pass(10m44s) |
| Shell 集成套件 `apply-core-room-mention-gate.test.sh`(T1-T18) | ✅ **19/19 PASS** |
| Gate vitest(`core-room-gate*.test.ts` ×3) | ✅ **17/17 PASS** |
| 完整 teamlead vitest(5207 tests) | ✅ 5164 pass;唯一失败 `codex-lead-runtime.test.ts` 27 例 = **已知环境性假失败**(负载下 vitest worker RPC timeout / TMPDIR 在 ~/.flywheel 下),隔离 + 干净 TMPDIR 重跑 **124/124 全过**,与 FLY-944 无关(FLY-944 不碰 lead-backends/codex),且 CI 已绿 |
| **决策级 E2E `qa-fly-944-gate-decision-e2e.sh`(新增)** | ✅ **16/16 PASS**(见 §3) |
| shellcheck `apply-core-room-mention-gate.sh` | ✅ rc=0 |
| shellcheck QA harness | ✅ rc=0 |
| biome `gate_sim.mjs` | ✅ clean |
| `bash -n claude-lead.sh` | ✅ syntax OK |
| 真机 `--all-leads` 枚举(read-only) | ✅ 角色标志正确(见 §4) |
| 部署就绪:roundtable id 解析 | ✅ env + file 双源 = `1512578695468941333`(见 §5) |

---

## 3. 决策级 E2E(核心"真实行为"验证)

单测证明的是 **config 变换**;这套 harness 证明 Annie 真正报告的事 —— 退役 allowFrom **翻转了插件的 deliver/drop 决策**。做法:对事故形态的 access.json 跑**真实** `apply-core-room-mention-gate.sh`,再喂进 `gate_sim.mjs`(忠实复刻 `server.ts:720-790` 的门顺序,带行号引用;关键点 = allowFrom 门先于 mention 门)。hermetic、无网络、可进 CI。

**Scenario A — Tadashi(非-CoS)#flywheel-core,即 FSM 事故**
- BEFORE(requireMention:false, allowFrom:[annie,cass]):HL 真 @ Tadashi → **drop**(复现事故:allowFrom 吃掉了 @);founder 无 @ → deliver(白名单里只有 founder/CoS → 精确复现"只有 founder 触发")
- 跑主 transform `--id-only` → requireMention:true + mentionPatterns:[] + allowFrom:[]
- AFTER:HL 真 @ Tadashi → **deliver(FIX,当晚那条 FSM @ 现在会落地)**;HL 无 @ 闲聊 → drop(FLY-152 pile-on 纪律保留);founder 无 @ → drop(rule ②,见 §6 行为变化);founder 真 @ → deliver(不变)

**Scenario B — Cass(CoS)#flywheel-core,"CoS 听不见 HL"病**
- BEFORE(allowFrom:[annie,tadashi],缺 HL):HL @ Cass → **drop**
- 跑 `--allowfrom-only` → allowFrom:[] + **requireMention 保持 false**(CoS 从不 flip)
- AFTER:HL @ Cass → **deliver(FIX)**;HL 无 @ → deliver(CoS 听全 core,设计如此);founder 无 @ → deliver(rule ②:core 无 @ 由 CoS 回)

**Scenario C — Belle #leads-roundtable 顶层,allowFrom 缺 HL**
- BEFORE(requireMention:true,allowFrom 缺 HL):HL @ Belle → **drop**
- 跑 `--allowfrom-only` → allowFrom:[] + **requireMention 保持 true**(roundtable 纪律保留)
- AFTER:HL @ Belle → **deliver(FIX)**;无关无 @ 消息 → drop(FLY-152/314 anti-spam 保留)

三个场景精确映射 research §6 行为矩阵,复现并修复了 Annie 观测的全部三条,同时证明了 pile-on 安全不变量(非-CoS core 无 @ 仍 drop)与 roundtable 反刷屏纪律未被破坏。

---

## 4. 真机 fleet 枚举核对(`--all-leads`)

`node dist/core-room-gate-cli.js --all-leads` 产出的角色标志精确对上事故 cast:
- `flywheel-eng-lead`(Tadashi):isCoS=false, gateNonCoS=true → 主 transform(flip+清一体,pile-on 安全)
- `flywheel-cos-lead`(Cass):isCoS=true → allowfrom-only(不 flip)
- `flywheel-product-lead`(HL):isCoS=false, gateNonCoS=true → 主 transform
- `codex-infra-bot-lead` / `mufasa-lead`:backend=codex-app-server → **正确跳过**(Codex 走 runtime env,无 allowFrom 概念)
- `joycon-lead`:isCoS=false & gateNonCoS=false → core 不动(单-lead 项目,FLY-898 显式豁免)

---

## 5. 部署就绪性

- access.json 热生效(插件每消息 fresh `loadAccess`,server.ts:674)→ fleet 清扫零 Lead/Bridge 重启。
- roundtable id 生产双源可解析:`~/.flywheel/.env` 的 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 与 `~/.flywheel/roundtable.json` 均 = `1512578695468941333` → launch 自愈与 `--all-shared` 的 roundtable 退役都会正确触发(不会静默跳过)。
- 备份名 per-process 序列(`.bak.<epoch>.<pid>.<seq>`)修掉了同进程同秒对同一文件连续 patch(core+roundtable)的备份互吃(T16 断言 2 份备份);回滚 = 拷回 .bak(同样热生效)。

---

## 6. 行为变化(非缺陷,ship 时须知会 Annie)

flip 后的**非-CoS** lead(如 Tadashi):founder 在 core 的**无 @** 消息不再触发它,只有 CoS(Cass)回(plan rule ②,Annie 自定的规则)。当晚"founder 说话 Tadashi 就回"是因为他还没被 flip。plan §Ship step 2 要求 ship 时向 Annie 显式通报这条 —— **QA 确认此行为并非 regression,是设计意图**,但落地时必须点明。

## 7. 边界

原计划把真机 N-to-N Discord E2E 留给 post-merge ship 步骤。**Annie 选了 (b):merge 前就在 529 QA 房(隔离测试 guild,零碰生产配置)做真机 N-to-N。见 §8 —— 已完成,全 PASS。**

## 8. 真机 529 房 lead-to-lead N-to-N E2E(merge 前,Annie 选 (b))

**做法**:在隔离的 529 QA guild(`1485787271192907816`)起 2 个真 Claude Lead(`test-deploy.sh --mode mirror` slot 2 + slot 3,都是 role=lead 非-CoS),共享 `#test-core-mirror` 频道(`1504277055406211142`),allowBots mesh 互含。用 test bot token 经 Discord REST 发消息(接收方插件 gate 看到的是同一条真 Discord 消息,与 lead 自己发等价),观察对方 Lead 会话是否真回复。**不动任何生产 lead 配置。**

**同一插件、同一对 Lead,只把 mirror 频道 config 从 BEFORE→AFTER,行为翻转:**

| 阶段 | mirror group config | 操作 | 结果 |
|---|---|---|---|
| **BEFORE** | `requireMention:false, allowFrom:[非-sibling id]` | test-2 真 `<@test-3>` | **DROP,test-3 无回复**(复现 FSM 事故:陈旧白名单在 mention 判定前吃掉同伴 @;test-3 pane 保持 idle,消息从未注入会话) |
| **AFTER** ①| `requireMention:true, mentionPatterns:[], allowFrom:[]`(我分支 apply 脚本 `--id-only` 产出) | test-2 真 `<@test-3>` | **DELIVER,test-3 回 `ACK-FROM-TEST-3`** ✓(~14s) |
| **AFTER** ②| 同上 | test-3 真 `<@test-2>` | **DELIVER,test-2 回 `ACK-FROM-TEST-2`** ✓ |
| **AFTER** ③| 同上 | 无 @ 普通消息 | **两 Lead 都不回**(requireMention 拦下,pane 均 idle;FLY-152/898 纪律保留)✓ |

**证据**:Discord REST 抓取的真实消息(author id + content)+ 两 Lead 的 tmux pane 状态 + Claude-in-Chrome 只读截图(Annie 登录态查看 `#test-core-mirror`,完整 BEFORE→AFTER→VERDICT 叙事)。频道链接:`https://discord.com/channels/1485787271192907816/1504277055406211142`。

**过程中修掉两个 529 房环境坑(非 FLY-944 缺陷,已记 [[reference_isolated_logged_in_claude_config_dir]] 家族)**:①test-deploy 的测试 Bridge 因 `TMPDIR` 路径超 macOS Unix-socket 104 字符上限而 `EINVAL` 崩(用短 `TMPDIR=/tmp` 修)→ Bridge 崩会连带拆掉 Lead;②陈旧 `claude-sessions/*.session-id` 残留导致 redeploy resume 坏 session → claude crash-loop(部署前 `rm` session-id 强制 fresh)。

**结论**:决策级 E2E(§3)与真机 529 N-to-N(§8)从两个独立角度得出同一结论 —— 退役 shared 频道 allowFrom 后,同伴 Lead 的真 @ 从"被静默丢"翻转为"触发并回复",且无 @ 纪律保留。**Verdict: PASS。**

---

## QA 新增文件

- `packages/teamlead/scripts/__tests__/qa-fly-944-gate-decision-e2e.sh` — 决策级 E2E harness(hermetic,可进 CI)
- `packages/teamlead/scripts/__tests__/gate_sim.mjs` — `server.ts` gate() 门顺序的忠实镜像(带行号引用)
