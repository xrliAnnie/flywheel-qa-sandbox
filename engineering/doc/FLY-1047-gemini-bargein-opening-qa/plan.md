# FLY-1047 /gemini 打断开关 + 开场音真机 QA — 实施计划
Issue: FLY-1047 (https://linear.app/geoforge3d/issue/FLY-1047/qa-fly-967-gemini-打断开关-开场音真机验证pr-501-6c3ec409)
日期: 2026-07-09
基于: research.md

> **给 Implement 阶段的执行合同**。本单是 QA issue:「实现」= 搭 rig、跑真机、收证据、出 verdict —— **绝不改 PR #501 源码、绝不 ship、绝不碰生产**。设计已过 Tadashi brainstorm gate(APPROVED,含 scope 声明:OFF 档不做真机、①经 allowUserIds seam + 物理真人差异留 Annie A8)。
>
> **判据总表见 research.md §3(锚点表)** —— 执行时逐条打勾,本 plan 不重复,只给步骤与命令。

## 0. 红线(每步生效)

1. **不改源码**:PR #501 的任何 tracked 文件一律不动;QA 自己的脚本全部放 scratch 目录(untracked,照父单 qa-injector 先例)。
2. **venue 冻结**:只进 staged guild `1485787271192907816` / General VC `1485787273193853170`;不建/不改/不删频道、不改权限、不踢人;结束一切参与者退出 VC。
3. **生产隔离**:Bridge 只用隔离 :9877。注意分工:**runner** 硬拒 9876(gemini-staged 守卫,QA runner 保留);**staged-bridge.mjs 本身不拒 9876** → launcher 必须显式 `STAGED_BRIDGE_PORT=9877` 且前置断言(继承 env 不许生效)。不碰生产 StateStore/config/Bridge;`.env.staged` 的值不进任何日志或文档。
4. **父单 worktree 只读**:`/Users/xiaorongli/Dev/flywheel-FLY-967` 只作参考读取,不在里面跑任何进程、不写任何文件。
5. **claude-in-chrome 连不上 → 立刻 escalate Tadashi**(flywheel-comm ask),不 retry 循环。
6. **环境失败 ≠ 行为 FAIL**:Gemini 529/quota/网关类失败重试一次,再失败 escalate;只有可复现的 PR 行为偏差才记 FAIL。

## P1 — 环境搭建(预计 15-20min)

1. 建 QA 专用 detached worktree(先 fetch 再核 head,QA 纪律:验的必须是将 ship 的 commit):
   ```bash
   git -C /Users/xiaorongli/Dev/flywheel fetch origin flywheel-FLY-967
   gh pr view 501 --repo xrliAnnie/flywheel --json headRefOid   # 期望 6c3ec4093db29b7661bcc1b6ae27711476b9b859;漂了 → 停,报 Tadashi
   git -C /Users/xiaorongli/Dev/flywheel worktree add --detach /Users/xiaorongli/Dev/flywheel-FLY-1047-qa-target 6c3ec409
   ```
2. 装依赖 + 重建三 dist(staged-bridge 依赖 teamlead dist):
   ```bash
   cd /Users/xiaorongli/Dev/flywheel-FLY-1047-qa-target && pnpm install
   (cd packages/voice-core && pnpm build) && (cd packages/voice-bridge && pnpm build) && (cd packages/teamlead && pnpm build)
   ```
3. 前置门 — 单测独立复证(全绿才继续;失败即 FAIL 证据):
   ```bash
   (cd packages/voice-core && pnpm vitest run)     # 期望 116
   (cd packages/voice-bridge && pnpm vitest run)   # 期望 131
   (cd packages/teamlead && pnpm vitest run src/__tests__/linear-comment-and-lookup.test.ts)  # 期望 18
   ```
4. 素材核查:`~/.flywheel/qa-fly967-staged/interrupt-zh-48k.wav` 在;probe WAV 若父会话 scratchpad 已清,用 `say`(中文声)出 aiff → `ffmpeg -i probe.aiff -ar 48000 -ac 2 -c:a pcm_s16le probe-zh-48k.wav` 重生成(语料 = 一句能引出长回答的中文问题,如「请把这周 board 上 In Progress 的事情都给我讲一遍」)。
5. 开跑前查机器负载(`uptime`);load 过高先报 Tadashi 定时窗(memory 教训:crash 常因 load)。

## P2 — rig 组装(scratch 目录,预计 20-30min)

全部放本会话 scratchpad(或 `/tmp/fly1047-rig/`),不进任何 worktree:

1. **`qa1047-runner.mjs`**(QA staged runner)— 以 `packages/voice-bridge/e2e/gemini-staged.mjs` 为底,改四点:
   - import 指向 **自己 worktree** 的 `dist/cli.js`(绝对路径);
   - `config.allowUserIds = ["1523232391349403850"]`(pool-06 —— ears 注入 seam,本单唯一新组装点);
   - hold 机制改为**显式关停**:轮询 quit 文件(`/tmp/fly1047-runner-quit`)+ **bounded 上限 12min** 兜底(gemini-staged 的固定 sleep 对两幕流程太短太僵;Gemini 音频 session 有 ~15min 上限,verdict 里记录实际 session 时长);
   - assistant 块 **不设 bargeIn**(被测点:默认 ON)。
   - 保留 9876 硬拒守卫 + `FLYWHEEL_BRIDGE_URL=http://127.0.0.1:9877`。
2. **`qa1047-probe.mjs`**(pool-06 单-bot 合并探针)— qa-injector + qa-out-capture 合并为**一条 voice 连接**(`selfMute:false, selfDeaf:false`):
   - 常驻订阅 orchestrator(`1523230048243417178`)→ opus decode 48k stereo → 落盘 s16le(带**首/末字节时间戳日志**,①-3 的「戛止」证据);
   - trigger 文件(`/tmp/fly1047-inject-cmd`)驱动 `player.play(WAV)`,每次注入打**时间戳日志**(①-1 的对时基准);
   - 结束时 s16le → WAV 存档 + Gemini STT 转写(qa-out-capture 同款判 GARBLE 逻辑)。
   - **fallback(探针合并态不稳时)**:退回两幕串行 —— 幕一只跑 capture(qa-out-capture 原样),幕二只跑 injector(qa-injector 原样),证据面等价、少一路同幕交叉证据,报告注明。
3. 起隔离 Bridge(后台,log 落文件):
   ```bash
   set -a; source ~/.flywheel/qa-fly967-staged/.env.staged; set +a
   [ "${STAGED_BRIDGE_PORT:-9877}" = "9877" ] || { echo "refuse: STAGED_BRIDGE_PORT=$STAGED_BRIDGE_PORT != 9877"; exit 2; }
   STAGED_BRIDGE_PORT=9877 node packages/voice-bridge/e2e/staged-bridge.mjs > /tmp/fly1047-rig/bridge.log 2>&1 &
   ```
   (staged-bridge 自身不拒 9876,端口由 launcher 钉死 —— 红线 3)

## P3 — 幕一:③ 开场音不丢 + ② 静默不误掐(预计 10min)

1. 探针先进 VC(开始采集,belt-and-braces:开场首 chunk 前就在收)。
2. **claude-in-chrome**(Tadashi 已确认根因修复,全新会话应能连):
   - `tabs_context_mcp`(createIfEmpty)→ 新 tab 开 `https://discord.com/channels/1485787271192907816/1485787273193853170`;
   - 以 Annie 登录态加入 General VC,**加入即 mute 麦克风**(mute 保 ② 静默前提;founderPresent 只看 voice state);
   - **截图 1(runner 起前)**:Annie + 探针在 VC(证明 initial-check 应看到真人;Note-taker/orchestrator 此时还没进 —— 它们由 daemon 启动时才加入)。
   - **连不上 → 立刻 escalate Tadashi,停在这一步。**
3. 起 QA runner(带 `FLYWHEEL_GEMINI_AUTOSTART="FLY-1047 QA 幕一"`,log 落 `/tmp/fly1047-rig/daemon.log`)→ autostart 2s 后开 round → 断言走 `enterLive("initial-check")` 路径(Chrome 已先在场)。**截图 2(runner 起后)**:Annie + 探针 + Note-taker + orchestrator 全员在 VC = rig 组装完成证据。
4. 开场 turn 完整播完 + 继续静默 hold ≥60s(② 观察窗;全程无人说话、无注入)。
5. 现场核对 research.md §3 的 ③-1…③-5、②-1…②-2 全部锚点;daemon log + 探针 WAV + STT 输出 + 截图归档。

## P4 — 幕二:① 打断能停(预计 10min)

1. 同一 daemon 继续(session 仍 live 听人说话):trigger 注入 **probe WAV**(中文问题)→ 助理开答(log「response started」+「turn begin」)。
2. 答话进行中(首 chunk 后 2-4s)trigger 注入 **interrupt-zh-48k.wav** → 现场核对 ①-1…①-3:「response cancelled (barge-in) — flushing speaker」≤3s、flush 后该 turn **零新 response-audio /「first audio chunk」/ playback 写入**、探针采集音频在 cancel 点戛止(尾音 ≤1s)。注意:cancelled turn 不发 response-done → 「turn end — dropped=D」日志可能整段缺席,dropped 计数只当机会性诊断,**不是**判据(review R1 #2)。
3. **fallback**(probe 引不出回答/回答过短不够注入窗口):收尾本轮,重起一轮 autostart round,在**新一轮开场 turn 中段**注入 interrupt —— ③ 已在幕一验过,这轮开场被掐正是 ① 的证据;报告注明用了 fallback 路径。
4. ①②③ 若有任何一条不过:先按红线 6 区分环境失败 vs 行为偏差;行为偏差 = 记 FAIL + 保全现场证据(log 全文 + WAV),不尝试修复。

## P5 — 收尾与清场(预计 10min)

1. daemon:写 quit 文件(或 SIGTERM)触发 bounded 关停 —— `runtime.close()` 会销毁**本 daemon 的全部 bot**(Note-taker + orchestrator 一起退,Note-taker 不是外部常驻);`pkill -f staged-bridge.mjs`;探针 trigger 写 QUIT;Chrome 点 Disconnect 退出 VC → **截图 3:VC 清空** = 清场铁证。
2. autostart 建的 kickoff smoke issue:landing 正常会自动关;残留 → 照 FLY-991/992 先例 Cancel + 注明测试产物。
3. 证据归档到 `engineering/doc/FLY-1047-gemini-bargein-opening-qa/evidence/`:
   - `qa-verdict.md`(三条判据逐项 PASS/FAIL + 实测时延数 + fallback 使用情况 + 环境注记);
   - daemon/bridge/探针 log 摘录(掐掉任何 token/key 值)、OUT 采集 WAV(开场 + 打断两段)、STT 转写、Chrome 截图。
4. QA 专用 worktree 保留到 verdict 被 Annie/Tadashi 消化后再删(QA 证据留存纪律)。

## P6 — 交付(预计 5min)

1. `flywheel-comm qa-result --status pass|fail --target-exec 525f8151-8f0a-4f9a-9bdd-ea60f4d46770`(绑回父单 implement 会话)。
2. DONE 报 Tadashi(flywheel-comm ask,附 verdict 要点 + evidence 路径),由 Lead relay 进父单 [FLY-967] thread。
3. progress ledger 更新 + evidence/docs commit 进本分支(只 commit 文档与证据,零源码)。

## 验收标准(plan 级)

- [ ] 三 dist 重建于**自己的** worktree @ 6c3ec409,单测 116+131+18 独立复证全绿
- [ ] 幕一:research.md §3 ③-1…③-5 与 ②-1…②-2 全锚点命中,证据归档
- [ ] 幕二:①-1…①-3 全锚点命中(或 FAIL + 完整现场证据)
- [ ] venue 零变更、生产零接触、源码零改动(git status 干净 = 铁证)
- [ ] qa-result 已发射 + Tadashi 已收到 DONE 报告
- [ ] smoke issue 已收尾(自动关或 Cancel)

## 时间预算与止损

- 全程预算 ≤2h(不含等待 escalation 回复)。单点卡壳 >30min(Chrome 除外,Chrome 是即时 escalate)→ ask Tadashi。
- Gemini 环境失败重试一次;二次失败 → escalate,不消耗预算硬磕。
