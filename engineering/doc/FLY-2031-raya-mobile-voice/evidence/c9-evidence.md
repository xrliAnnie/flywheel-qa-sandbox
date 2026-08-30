# FLY-2031 随身语音 B — C9 真机验收证据
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-28
基于: plan.md

## 状态

**IN PROGRESS — QA P0 与 P1b capability 已通过；其余产品验收未通过。** 2026-08-28 R3 在真 `voice-test-2` 凑齐 P0 四判据；这是 Tadashi bot + TTS 的重复性证据，**不是 Annie 原话、也不替代 founder authority**。被动念读 fixture 仍有 identifier-only 误 ack 反例，需 FLY-2030 后重跑。Code R4 credential/标点 HIGH、Code R5 speech authority HIGH 与 Code R8 ship 裸确认跨上下文 HIGH 均已修；`20c249f` 的 R9 current-head review 已 APPROVED。R9 新指出的同-poll 解武装循环与 runtime glue 测试缺口已按 B44 TDD 收口；`c52ee92` 的精确 R10 又发现默认 no-approval fallback 会在第二轮把整个 inbox 当作 `pending` 饿死，已按 B45 用真实 runtime 回归修复。全仓 build/typecheck/test（voice 218）与 probes 15/15 通过，待修复 head 复审。结果权威是 state + bot-authored `#raya` 文字收据，speech 只旁白。P1b 有两轮：Runner 内因嵌套 Seatbelt FAIL；Lead 在 Runner 外同 scratch/no-side-effect 围栏重跑，exact disk canary **PASS**。因此 backend proposal 写能力已证，relay/filter/pref 可以进入 FLY-2030 + founder 真声验收，但尚未端到端通过。ShipGateFlow 仍等 FLY-2030、host deny-read 与 founder 真声。上述门未过前不得 complete。

## 运行授权与隔离

- Lead gate: `bdf1640c-25c8-46ff-a5a5-cf0c4ed579da`（已回复：QA bot、N=3 分钟、房间=`voice-test-2`、P3=非生产 test object）。
- 真人声冲突 gate: `fd6c5316-a490-4cd4-95ba-b9da6de79564`（已回复；§7 真人声不削弱，P2/P3 与真人声打包成最后一次 founder 在场轮，QA 轮不能据此 complete）。
- 宿主启动 gate: `339fcd8a-36bb-4609-8fa5-24c3d6a0db22`（已回复；Lead 已 host-bootstrap 唯一 label；并明确 `launchctl submit` 不是等价路径、禁止再用）。首次 RunAtLoad 因 `voice_mode_not_requested` 正常退出，job 仍已注册。
- exact emitter / 重载 gate: `6637f9fb-0900-4a1e-9ae5-b5f1a63af31b`（已回复；唯一授权 emitter 为 Tadashi bot `1516207680836866219`，只写 QA allowlist；TTS 只能做重复性，不能替代真人轮）。
- R1/R2/R3 host reload gates: `312b5599-68df-4e93-b12c-77f8e31d5929`、`c131aa97-679b-4cc6-9975-b78b4c3ff365`、`ed164842-0db3-4657-b61e-54ee06b9a594`；每轮均由 Lead 只重载 `com.xrli.raya.voice.fly2031.qa`，生产 label / plist / env 未动。
- Code R5 stale-head review gate: `3d7ab7d3-b5cb-47f4-bb6e-fde2854ba8fa`；返回 `reviewedHeadSha=2d9daed`，不是请求的 `ba26a17`，所以不能作为当前 head 审查。两个可独立复现 HIGH 仍按 design gate `bc179a92-b41b-4303-9ee9-5bc7bda9047d` 的 A+P1b 方案修正。
- Code R6 stale-head review gate: `756c5069-01e5-400c-b0dd-9ad356372598`（request `3fdb8b92-75e9-4000-be48-8dee78264514`）；请求已 push 的 `e063f45`，structured 仍返回 `reviewedHeadSha=2d9daed`。该结果无效且不重复修旧 head findings；已上报 Lead，P1b PASS 证据提交后另开 current-head review。
- Code R7 stale-head review gate: `f0a46db4-4fd6-415a-8abf-b2ef06cb5b48`（request `614bf611-1a92-42c6-968d-a893a12a8cf0`）；请求并远端核对 `d2552cf`，structured 第三次仍返回 `reviewedHeadSha=2d9daed`。已通过 report `59dcc349-5a4b-498e-924b-59bb965c5d2c` 上报为 review bridge 绑定故障；等待 Lead 修复后再开 gate。
- Code R8 current-head review gate: `e83fa24f-5bbd-4403-8a4a-546cb63c60e2`（request `4b47ebc0-dc89-41e6-8763-c8c870449fdd`，nested target `.review-raya`）；`reviewedHeadSha=85efe41`，1 HIGH + 10 advisory。blocking HIGH 是裸「对/确认」可能被随后的其它问题劫持；B43 已用 prompt assistant cursor + 后续 speech-injected 解武装修复，focused 50/50、voice 216/216、全仓门与 probes 通过，待新 head 复审。
- Code R9 current-head review gate: `a537a577-edcc-4733-81e4-f583e9a19877`（request `45993818-d6d8-43ab-a181-84a8099aa3e9`，nested target `.review-raya`）；`reviewedHeadSha=20c249f`，**APPROVED** + 10 advisory。advisories 已 report Lead；本轮新增的同-poll arm/disarm 循环与 runtime glue 测试缺口已按 B44 TDD 收口并过全仓门，其余 carried-over 项不冒充 hard gate。
- P1b actual gates: `a491425a-1bb0-4544-87c4-5f51969b1236`（Runner 内嵌套 Seatbelt FAIL）与 `e0748593-5cd8-4e87-8eb1-6cb7fb30ca51`（Lead 在 Runner 外同 scratch/no-side-effect 围栏原样执行，PASS）。不是 prompt 重试：两轮差异只有是否嵌套在 Runner sandbox；两轮原件都保留。
- 验收房: Discord `voice-test-2` (`1542708795720081408`)；不得改生产 General 配置。
- 文字面: `#raya`；发言和消息链接必须来自真 Discord，不以 fake transport / harness 代替。
- 进程: 从本 worktree 构建并由验收专用 launchd 配置启动；不得切换或修改生产 checkout `~/.flywheel/raya/code`。
- 状态: 验收专用 state / metrics / outbox；归档前做 token 和个人信息脱敏，禁止把任何 secret 写入仓库。
- 2030 状态来源未落地时，inbox 内容允许由 fixture 生成，但必须标作“内容假、界面真”。

## 场次清单

| 场次 | 真实操作 | 必须归档 | 通过条件 |
|---|---|---|---|
| P0 常开流 | 操作者在 `voice-test-2` 自闭麦 ≥ Lead 指定 N，之后开麦说一句可核对的话 | 起止时间、脱敏 `audio_counters`、user/assistant transcript 摘录、房内录音包络 | user 转写对得上；assistant transcript 出现；房里真听见声音；上行 `sent` 帧数与运行时长/20ms 同量级。任何一格缺失即不通过 |
| P1b proposal 真落盘 | 隔离 scratch cwd/outbox，真 realtime handoff 要求后台只创建随机 exact `.action.json` | 两轮 manifest/JSONL、场后空 outbox | **PASS**：Runner 内嵌套 Seatbelt 轮 FAIL 原样保留；外部 host 轮 random canary 284 bytes exact、commandExecution exit 0、validator SHA-256 固定、场后删除。只认磁盘，assistant 文本不算 |
| 念读与筛选 | fixture 写入 ≥6 条（含 ≥2 `needsDecision`）；真房收听；真人说筛选偏好；退出并重新启动同一验收配置 | fixture manifest、`acks.jsonl`、filter file 前后 diff、两场 transcript/音频包络 | 主动开口、先念需决定项、溢出续念；第二场规则仍在且同类 item `ack=filtered` |
| 存活信号 | 真房静坐到验收配置的 interval；真人说调整频率；继续等待下一次 | 配置值、preference file 前后 diff、两次对应 transcript/时间戳 | 主动报平安机制与口头保存偏好仍待 FLY-2030 + founder；成功只认 state + bot 文字收据，不认 spoken `saved` |
| P2 relay 拒绝 | 真 Codex 提案一个 `quotes` 不存在于 founder transcript 的 relay | `.action.json` / `.taken`、权威 `receipts.jsonl`、`#raya` bot 文字收据、assistant 后续 transcript、Discord 目标频道消息前后证据 | P1b capability 已过；产品场 pending。必须 `status=rejected`、目标频道零发送，speech 不构成 receipt |
| relay 阳性与错号 | 真人说“告诉 Tadashi，FLY-1833 那单先停一停”；另造目标为 FLY-1838 的负例 | founder transcript id/原文、念回 transcript、readback、state receipt、`#raya` bot receipt/Discord message link；负例 receipt | P1b capability 已过；产品场 pending。目标频道 messageId + bot 文字 + state 三方可核，任何口头“已转告”不算 |
| P3 用嘴批 ship | Lead 指定测试 gate；它念编号；founder 当前 session 说“确认” | S0–S8 时间线、卡片/绑定快照（脱敏）、Discord receipt link、Bridge HTTP 结果、`voice_approval_attempt` audit | receipt-first；POST 五字段来自同一绑定；Bridge 返回 `written=true`；它只念 Bridge 返回结果。任一级失败不得声称批准成功 |

## 原始证据索引

运行后填写，未填写即未验：

- 授权回复 / 操作者 / N / 窗口：Tadashi bot `1516207680836866219`；self-mute 3 分钟；`voice-test-2`；R3 窗口 `2026-08-28T07:43:39.432Z`–`07:46:53.515Z`。founder 轮由 Lead 在只剩该轮时统一安排。
- 验收构建 commit + `pnpm` 版本：C9 server commit `3a73885`；continuous-stream capture fix `81d9094`；R3 emitter head `8b1eb06`；最终 PR head / `pnpm` 版本待收口。
- launchd label + 验收配置指纹（不含 secret）：`com.xrli.raya.voice.fly2031.qa`；worktree cwd；voice channel `1542708795720081408`；QA allowlist 仅 Tadashi bot；独立 `qa/FLY-2031/{state,metrics,workspace/outbox,logs}`；approval=`http://127.0.0.1:18731/api/voice`。R3 使用的是 review 前 inline-token 配置，只能支持已归档的 P0，**不得用于 P3**；新 head 要求 dedicated credential file + host deny-read attestation。R3 在 `last-human-left` 后 exit 0，当前 label not running。
- token 处置：一次诊断误把本地 non-prod approval token 打到终端；该 token 已立即轮换失效，含旧值的精确临时 dump 已删除。未涉及生产/Bridge credential，仓库与 evidence 不含新旧 token。
- 真链路 preflight：`ready=true`；Discord bot `1542068543645024257` 看见 voice channel `1542708795720081408`；Codex thread `01a046dc-ef60-7893-8d28-4243765e4971`，model `gpt-5.6-sol`，realtime=`started`。
- 空房前台诊断：`2026-08-28T05:36:56.539Z`–`05:43:09.142Z`，干净 `sigterm`；`audio_counters={silence:18597,clock:stall:59,player-idle-recovered:1}`。这只能证明空房输出时钟持续运行，**没有 participant/uplink，不能计作 P0**。
- P0 日志摘录：[`c9-p0-r3-summary.json`](./c9-p0-r3-summary.json)。同一 R3 窗口 user final（speaker=`1516207680836866219`）命中 `FLY-2031` 锚点；assistant final=`已回复收到 FLY-2031`；生成 QA TTS 明确不是 Annie 原话。
- P0 房内音频包络：self-mute `180000ms`；播放完成后 STT settle `5000ms`；emitter 从 Raya 收到 `632` Opus packet / `104807` bytes，未保存音频内容。`speakingStarts=0` 证明 arming 时流已经常开，不依赖新的 speaking edge。
- P0 时钟：`audio_counters={silence:4584,sent:9571,voice:6823,clock:stall:108,dropped:closed:2,player-idle-recovered:1}`；`(sent + stall) × 20ms = 193580ms`，与 emitter connect→clean voice exit 的 `194083ms` 相差 `503ms`（约 `0.26%`），满足“同量级且持续送帧”。
- P0 诊断轨迹：R1 的 TTS→user STT 与时钟通过，但旧 probe 等待新的 speaking edge，zero-packet fail closed；`81d9094` 改为 arming 即 subscribe。R2 Opus/时钟通过，但 probe 播完即离房，user STT 未落；`8b1eb06` 增加 5 秒 settle。R3 四判据同场通过；前两轮不冒充通过。
- P1b Runner 内轮：[`FLY-2031-P1b-backend-outbox-write-p1b-198647f5-184e-4244-b1d1-30467e9cc539-manifest.json`](./FLY-2031-P1b-backend-outbox-write-p1b-198647f5-184e-4244-b1d1-30467e9cc539-manifest.json) + JSONL，`passed=false`；三次 fileChange failed；零额度本地 `codex sandbox ... pwd` 同样 exit 71，定位为 Runner 嵌套 Seatbelt。
- P1b 外部 host PASS：[`FLY-2031-P1b-backend-outbox-write-p1b-b98e6435-47c8-4bc3-9f88-91ba09b89533-manifest.json`](./FLY-2031-P1b-backend-outbox-write-p1b-b98e6435-47c8-4bc3-9f88-91ba09b89533-manifest.json) + JSONL。`passed=true`；thread `01a047d2-e0c9-7bf3-9a81-d85e5aa75443`；284 bytes；SHA-256 `09812855d2e7edb8f64eb1938c17704250206e12b87ba93d855884c1b72d9e85`；commandExecution exit 0；场后 outbox 空。两轮的 `contractsHead=5b1f779...` 都是隔离 scratch cwd 最小 git commit，不是 Raya head；probe implementation commit=`56695a4`。
- inbox fixture manifest：隔离 state 共 6 item（2 `needsDecision`、4 非 decision），0 corrupt；真房里主动播报出现，但反复 `inbox_speech_unconfirmed`。R3 中 founder/TTS 插话后的无关 assistant final 含 `FLY-2031`，旧规则误把 `c9-inbox-report-01` 写成 `spoken`；live evidence 证明 identifier 命中不能绕过“无 user final 插话”。内容是假；该场景需用新 item id、FLY-2030 brain 合同和修复后 head 重跑，**当前不通过**。
- `acks.jsonl` 摘录：1 个已知无效的 `spoken`（`c9-inbox-report-01`，boot `c9c74514-e939-4d29-98cc-7807745f2277`）；原始行保留作反例，不删除、不作为通过证据。其余 5 item 无终态 ack。
- filter / liveness preference diff：pending（P1b capability PASS；待 FLY-2030 + founder）
- P2 action + receipt + 目标频道零发送证据：pending
- relay 阳性 Discord message link：pending
- relay 错号 receipt：pending
- P3 测试卡：[voice-test-2 非生产测试卡](https://discord.com/channels/1485787271192907816/1542708795720081408/1542771440460365875)；卡片明确写明“不是 ship 请求，不对应真实 PR，不得触发真实 ship”。
- P3 test server：`probes/c9-approval-test-server.mjs`，loopback only，Bearer fail-closed，日志不含 token；单测 2/2 通过。ShipGateFlow 由 `ship_gate` inbox 驱动，不走 P1b outbox；但新 head 的 host `/etc/codex/requirements.toml` 安装/真实 attestation、FLY-2030 item、founder 真声均 pending，因此真实 3 GET + 2 Discord fetch + 1 receipt + 1 POST 仍 pending。
- P3 Bridge audit / response：不调用真实 Bridge；本轮只接受 test server 的 `reason=non-production test object only`，真实调用计数 pending。
- 验收后停机与生产 checkout clean 证明：R3 `voice_exit{code:0,reason:"last-human-left"}`；QA label `not running`；`git -C ~/.flywheel/raya/code status --short` 为空。未投 restart 票，未改生产 label / plist / env。

## 明确不在本次结论内

- 打断。
- 存活信号的产品默认间隔。
- B4 兜底。
- at-least-once 重复念的体验形态。
- unknown-outcome 不自动重发的体验形态。
