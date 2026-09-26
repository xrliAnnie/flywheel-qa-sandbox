# FLY-2860 删除三套旧语音命令 — 实施记录
Issue: FLY-2860 (https://linear.app/geoforge3d/issue/FLY-2860/语音清理-删掉-geminigeminigemini-advancedelevenlabseleven与-glaw)
日期: 2026-09-25
基于: plan.md

## 0. 入场（plan §2）

- `git merge origin/main` → `fb1f0220e`（main 头 `ef47e9a05`；#1306 已合入，#1309 仍 OPEN、未合入，#1312 已关闭）。基线 = main + #1306，与 Lead 裁定一致。
- 重跑 `refgraph.mjs`：`{"files":3400,"prod":1240,"old":80,"onlyOld":62,"shared":18,"orphan":6}`。
  - `onlyOld` 62 个文件与 research §3.1 **逐个相同**（含 `audio/resample.ts`：#1306 之后 voice-codex 不再 import `upsample24kMonoTo48kStereo`）。
  - `shared` 18 个文件全部是 research §3.2 已点名的文件，无计划外新文件。
  - 原样输出固化为 `graph-before.json`；删除清单为 `deletion-manifest.tsv`（252 行）。
- manifest 相对 plan 文字的两处补充（同一规则、只是 plan 没逐个点名）：
  1. `packages/voice-core/evidence/`：除 `gemini-*.json` 与 `real-live-models-list.json` 外，`poc-converse.md`、`fly-959-*`（3 个）同属 Gemini Live「对话面」证据（FLY-543 POC-B、FLY-959 的四个 converse 回归），一并删；`poc-announce.md`（edge-tts 播报面）保留，README 只删对应行。
  2. `engineering/spike/FLY-968-voice-bakeoff/s4c-feed-comparison.mjs`：同样是 Gemini Live（3.1 vs 2.5）喂法对比脚本，与 s4/s4a/s4b 同类，一并删。
  3. `packages/voice-bridge/e2e/clips/short.txt`：`git rm -r e2e` 的第 15 个文件（plan 写 14 个是只数了脚本）。

## 1. 外部 CLI 消费者 sweep（CLAUDE.md FLY-1914）

执行时间：2026-09-25T21:05:05Z（UTC）。本单净删的 CLI：`flywheel-gemini-agent` bin、`flywheel-voice-bridge` bin、`flywheel-voice-poc talk` 子命令。

| root | 状态 | 结果 |
|---|---|---|
| 插件 fork `xrliAnnie/claude-plugins-official` 的 `external_plugins/` | 已检查（浅克隆 `e122f46b44ae`，2026-09-08） | `grep -rInE 'flywheel-gemini-agent\|flywheel-voice-bridge\|voice-poc\|run-voice-bridge\|gemini-agent\|/glaw\|gemini-advanced\|/eleven\b'` 零命中 |
| 本机插件缓存 `~/.claude/plugins/cache/*/` | 已检查 | 同一模式零命中 |
| 主仓 `scripts/` 与 `packages/` | 已检查 | bin / 子命令零调用方；命中只有**库**引用（voice-codex `import … from "flywheel-voice-bridge"`、`scripts/qa/fly2655-voice-room.mjs`、`scripts/qa/fly2446-two-lead-run.mjs`、`scripts/test-deploy.sh` 的 `pnpm --filter flywheel-voice-bridge build`、`package-onboard-smoke.test.sh` 的包镜像）——库保留，不受影响；`flywheel-voice-poc say` 仍保留 |

## 2. C4 RED（先红后绿）

新测试 `scripts/__tests__/restart-services-no-voice-bridge.test.sh` 在**未改动**的树（`292f81472`）上：`passed=6 failed=8`——

- FAIL（预期）：①不再 source / 提及 voice-bridge（2 条）②DRY RUN 文案 ④units.manifest 无 voice-bridge 行 ⑤四个壳文件不存在（4 条）。
- PASS（预期）：③a `deploy_and_verify` 源码顺序；③b 真跑 `rollback_and_restart … deploy_and_verify` 函数体（记录桩）——成功路径顺序、standalone voice 失败一次 → 回滚 + Lead 波次 + deployed-sha 不推进 + `update-rolled-back`、回滚时 voice 仍失败 → 先跑 Lead 恢复波次再发 `rollback-voice-failed`；④b `com.flywheel.voice` 行保留；⑥`install-voice-launchd.sh` 的拒装守卫保留。
- 负向对照：临时删掉 `deploy_and_verify` 里的 `ensure_voice_for_deploy` 调用 → ③a、③b 三条全部变红；还原后恢复。
- 说明：③b 用的是 `test-restart-services.sh` 里 `rn_run_terminal_case` 同款做法（awk 抽出真实函数体 + 桩），而不是整个 `bo_run` hermetic HOME——`bo_run` 的搭建约 400 行且只能观察顶层退出码；抽函数体能直接记录 Bridge / voice / Lead 波次 / deployed-sha 的调用顺序，更贴合本断言。`test-restart-services.sh` 自身的 `bo_run` 用例在 GREEN 阶段同步更新。

## 3. C1–C3 实施中的小决定

- C2.5 的 voice-core `retired-outputs.json` 放在 C3 同一 commit 加（源码删除后才能证明清单里没有活源码；`remove-retired-dist.test.mjs` 会断言「清单项不对应任何现存 `src/*.ts`」）。
- voice-core `VoiceCoreConfig.defaultConverseBackendId`：唯一取值原是 `"gemini-live"`，仓内无任何读取方。保留这个通用选择字段与 `FLYWHEEL_VOICE_CONVERSE_BACKEND` 读取，默认改为空串（不再内置 converse 后端）——不改 flag 登记、不扩大删除面。
- voice-core `types.ts` 是 voice-codex 实现的共享契约：不动接口形状；只删 `VoiceBackend.id` 联合里的 `"gemini-live"` 字面量（有 `string & {}` 兜底，零类型影响），并把描述已删代码的注释改成通用表述（`scrub.ts`、`transcript.ts`、`MicCapture.ts`、`HeadlessClaudeBrain.ts` 同理，纯注释）。
- `flywheel-voice-poc`：只剩 `say`；`--lead/--project/--device` 三个参数只服务 `talk`（身份文件 / 麦克风），随之删除。
- C3 构建时 voice-core 旧 dist 里真实残留的 `TalkSessionRotator` / `Resident*` / `backends/gemini/` 产物被 `remove-retired-dist` 清掉（`removed 13`），重建后 dist 无退役产物。

## 4. C4 GREEN 与一处计划偏差（已通知 Lead，question `08e604a6`）

- `restart-services.sh`：删 source 行、DRY RUN 文案、回滚分支里的 voice-bridge 段、`ensure_voice_bridge_for_deploy` 与 Step 3.5 调用；`rollback_and_restart` / `deploy_and_verify` 其余控制流不变（新测试 ③a/③b 与 RED 时一致通过）。
- **偏差：`units.manifest` 的 voice-bridge 行保留为墓碑，而不是删除。** 原因：`converge_nonlead_daemons` 的「磁盘侧」会 bootstrap 任何不在 manifest、未禁用、不在 domain 里的 `com.flywheel.*` plist。删行后，任何残留 `~/Library/LaunchAgents/com.flywheel.voice-bridge.plist` 的主机下次部署会被拉起一个指向已删 wrapper 的 KeepAlive 任务。`launchd-census.test.sh` 新用例先 RED（`converged: com.flywheel.voice-bridge`），加墓碑行 `com.flywheel.voice-bridge  -  managed  0  retired in FLY-2860 …` 后 GREEN；仍被加载的残留会以 `managed_loaded=1` 暴露。plist 文件本身照删；新测试第 4 条相应改为「只剩 managed 墓碑、无 plist 源」。
- census 行为（计划要求写明）：残留 plist 的 label 在 manifest 里（墓碑）→ 不算 unmanaged；其 Program 目标（已删的 wrapper）不存在 → census 报目标缺失异常，属期望行为，由 C8 退役脚本把 plist 改名清理。
- 测试 / 桩同步（只删 voice-bridge 这一项，不放宽其它断言）：`test-restart-services.sh`（`rollback-voice-failed` 用例改走 standalone voice，期望 `rollback-voice-failed`，仍检查 Lead 恢复波次先跑；FLY-2654 引用计数下限 48→47，因为删掉的正是一行 runtime-dir source）、`restart-services-admission-pause`（改抽 `ensure_voice_for_deploy`，同一「不回滚也释放刹车」断言）、`restart-deploy-consistency`（删死桩）、`restart-storm-gate` / `qa-fly1501-restart-gate-e2e`（样例组件名 `voice-bridge`→`voice`）、`qa-fly1501-brake-missing-alert` / `host-tmux-selection-*` / `check-global-path-hygiene` / `lib/path-hygiene.sh`（从 wrapper 清单删该 wrapper，fallback 声明计数 7→6）、`launchd-census`（「disabled managed」夹具换中性标签）、`launchd-units-manifest`（期望改为墓碑）、`ci-shell-suite-manual-only.txt`。
- `kill-path-inventory.json` 用 `scanKillPathInventory()` 重生成：只少 10 条（ResidentClaudeBrain ×5、resident-brain.smoke ×2、resident-manager.smoke ×1、voice-bridge wrapper、restart-voice-bridge.sh），全部在删除集里，其余条目逐条、顺序不变。
- 本机环境说明：`test-restart-services.sh` 的 `((n++))` 负向对照、`restart-storm-gate.test.sh`（`fault_env[@]: unbound variable`）与 `qa-fly1501-brake-missing-alert.test.sh` 在 macOS `/bin/bash` 3.2 下失败，与本改动无关；用 Homebrew bash 5（CI 同类）重跑全部通过（58/58、49/49；负向对照单行在 bash 5 下 rc=1）。

## 5. C6–C8 记录

- C6：`FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE` 在 `fly1981-legacy-snapshot.ts` 里是**冻结的历史输入**（审计要求每个历史 env 键都有去处：迁移 / `RETIRED_FLAGS` / 豁免），所以快照不改，改为在 `RETIRED_FLAGS` 登记 `{ envVar, retiredBy: "FLY-2860" }` 墓碑；`fly2102-flag-freeze.test.sh` 的精确允许行相应从 `exemptions.ts` 挪到 `truth.ts`。豁免总数 28→25；drift 用例改用仍被代码读取的 `FLYWHEEL_LINEAR_STARTED_SYNC` 作锚点。本机 `~/.flywheel/.env` 只核键名：不含任何被删的 `FLYWHEEL_*` 名（只有非 FLYWHEEL_ 前缀的 `ELEVENLABS_API_KEY`，见 follow-up）。
- C7：FLY-968 bakeoff 的 `lib/events.mjs` 仍被剩余 OpenAI / edge-tts 脚本使用，保留；spike 的 `package.json` 去掉 `@google/genai`，`npm install --package-lock-only` 后 lockfile 只剩 `ws`（纯删除）。删完后 C6 的所有 flag 名在历史档案外零命中。
- C8 目标清单（`scripts/retire-legacy-voice.targets.json`，无秘密）：
  - `FLY2860_POOL06_BOT_TOKEN`（required）：`flywheel-pool-06`「Huddle」编排 bot，app/bot id `1523232391349403850`（FLY-545 bot-provisioning / deploy-kit、FLY-1006 staged 场地），注册过 `/glaw` `/gemini` `/eleven`；
  - `FLY2860_POOL05_BOT_TOKEN`（required）：`flywheel-pool-05`，id `1523230048243417178`，在 FLY-967/1047 staged 场地做过 `HUDDLE_ORCH_BOT_TOKEN`；
  - `FLYWHEEL_GEMINI_AGENT_DISCORD_TOKEN`（optional）：gemini-agent 守护进程（`/gemini-advanced`），无部署记录能指认它用过哪个 bot。
  - guild 均为生产 guild `1485787271192907816`（全部项目的 `voiceRoom.guildId`、FLY-960/545 记录一致；staged 场地也在同一 guild）。
  - QA 运行前：`export FLY2860_POOL06_BOT_TOKEN=$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-06/token)`，pool-05 同理。
- C8 测试：14 条计划用例 + 可选候选去重 / 非法 guild 记录、`.env` 必须 mode 600、launchd dry-run 只读 / `--apply` bootout+改名 / 幂等、随包清单格式校验，共 17 条；负向对照（去掉 `type===1` 判断、白名单放宽成前缀）各让 1 条变红。

## 6. C9 残留门与终检

- `residue-check.sh`：扫描历史档案外的全部跟踪文件；词元 = 命中处向两侧扩展的 `[A-Za-z0-9_./-]` 最大串。两类命中：①含 `eleven|gemini|/glaw|huddle`（不分大小写）②`retired-identifiers.txt` 里的已删符号（如 `wireAssistantMode`、`SessionSlot`，它们本身不含 gemini 字样，但出现即算残留）。每个词元必须完全匹配 `residue-allowlist.txt` 为该**精确路径**登记的正则（逐文件、逐词元；无目录 / 包 glob），同时检查陈旧条目。
- 结果（`aa556fea6` 时）：`0 unallowed, 0 stale, 640 allowed hit(s)`；放行数会随退役脚本 / 测试 / targets 的注释增减而变化，最终头的数字见 §8；`--self-test` PASS（在临时副本的混合文件 `plugin.ts` 里插入 `FLYWHEEL_HUDDLE_BACKCHANNEL_MS` 与 `wireAssistantMode(...)` → 门失败并点名两者；插入 `config.geminiAgentToken` → 门通过）。
- 放行类别（`--report` 原样贴进 PR）：coding-runner 31 文件、bridge-scoped-token-followup 25 文件、non-voice-gemini、english-eleven、legacy-conflict-guard、retirement-marker、historical-comment、spike-history、secret-scrub-fixture。
- 残留门过程中补抓的两处遗漏（设计引用图只看 import）：
  1. `packages/teamlead/src/bridge/child-process-census.json` 仍登记已删的 `ResidentClaudeBrain.ts` → 删该条（FLY-2331 普查逐条相等）。
  2. `packages/teamlead/src/bridge/workkind-cutover.ts:826-854`：FLY-1436 workKind 切换的 stage/apply 前置按路径读 `packages/gemini-agent/dist/tools/schemas.js` 判定 `prBAssetsReady`。现网 checkout 里被忽略的旧 dist 仍在，零变化；全新 checkout 上该前置会报 `PR_B_ASSETS_NOT_DEPLOYED`。按 Lead Q2 裁定（Bridge 侧 gemini-agent 耦合不动）列为 PR follow-up，已非阻塞告知 Lead（question `c6a4a8ea`）。
- `git diff --diff-filter=D --name-only 050c887ad..HEAD` 与 `deletion-manifest.tsv` 252 行**逐行相等**（基线 `050c887ad` = merge 后仅多一个 progress 提交）。
- 终跑引用图（`graph-after.json`）：`onlyOld=0`、`shared=0`、测试全部 keep；`orphan` 6 个 = 入口 / 桶文件豁免 {`voice-bridge/src/index.ts`、`voice-core/src/index.ts`、`voice-core/src/cli.ts`（bin）、`voice-core/src/headphone/index.ts`} ∪ §8 新不可达 {`voice-core/src/audio/MicCapture.ts`、`voice-core/src/audio/StreamPlayer.ts`}。`HeadlessClaudeBrain` / `stream-parse` / `buildHeadlessBrain` 文件级仍可达（`factory.ts` 被 voice-headphone 用），但符号级已无生产调用方，照 §8 列入清单。
- 附带必修核对：H1 `StereoDownmixDecimator` 零命中；voice-codex 剩余 `16_000` 是文本截断长度、Silero VAD 自身 16 kHz 采样率、测试缩放、子进程超时，均非房间输入消费方（main + #1306 上无 RoomIO）。H2 `VoiceRoomRuntime|SessionSlot` 仅剩 `retired-outputs.json` 退役清单。H3 `ResidentVoiceSessionClient|resident/claim` 在 voice-bridge / voice-codex 零命中。H4 `glaw` 仅剩退役脚本 / 测试 / 退役说明注释。

## 7. QA@1 返工（attempt 2，基线 `160d626cf`）

QA 判定 `qa_fail`（执行 `b8ae950f`），三条：

- **F1（阻塞，产品）Discord 残留覆盖不全。** QA 对本机全部 28 个 bot 应用做只读 GET 扫描，发现退役脚本看不到的遗留命令：`flywheel-test-1`（app `1493068669444427927`，`TEST_BOT_TOKEN_1`）挂着 `/gemini` `/eleven`；staged 台架把 `/glaw` 以 `commandName: "meet"` 注册（origin/main `packages/voice-bridge/e2e/lib/rig-config.mjs:11`），`/meet` 挂在 test-1、pool-05、pool-06 上。旧 dry-run 只找到 5 条，Q2 会假通过。
  - 修复 `58000b841`：targets 支持按目标的 `extraCommandNames`（按 Discord 命令名语法校验），全局白名单仍只有四个旧名；pool-06、pool-05 与新增的**必查**目标 `TEST_BOT_TOKEN_1` 额外退役 `/meet`；项目 Lead bot 与 `TEST_BOT_TOKEN_2..6`（可选）只匹配四个旧名，永不删 `/meet`。新增测试：`meet` 只在列了它的目标上删、Lead bot 的同名命令保留、近似名 `meeting` 保留、非法 extra 名拒绝；随包清单测试钉住三个必查目标与 `meet`。19/19 通过。
  - 证据：本机只读 dry-run（未 `--apply`）找到**全部 10 条**——pool-06 `eleven/gemini/meet`、pool-05 `gemini/glaw/gemini-advanced/meet`、test-1 `meet/gemini/eleven`；3 个必查目标 `queried_ok`、`uncovered: []`、`malformed: 0`；其余 23 个 bot（test-2..6 与全部项目 Lead bot）已查询、无遗留命令；本机无 voice-bridge launchd 残留。回执 mode 600，28 个 token 值逐一比对均未出现在回执中。`--apply` 仍按计划由 QA 在 founder 知情下执行。
- **F2（阻塞，CI 红）** `packages/teamlead/src/__tests__/StateStore.flag-value-store.test.ts:335`：`RETIRED_FLAGS` 新增墓碑后，store mutator 对 `voice_qa_presence_override` 返回 `retired_flag`。修复 `c393dd4f4`：该名改入 retired 用例，`not_store_managed` 分支改用一个从未登记的名字继续覆盖；先复现红、后绿（12/12）。同时补扫了全部 `RETIRED_FLAGS` / `FLAG_EXEMPTIONS` / `STORE_MANAGED_FLAGS` 的跨包消费者：teamlead `StateStore.flag-value-scope/flag-value-store/flag-routes/management-existing-writers/flag-toggle` + `bridge/flag-store-runtime`（108）与 flywheel-comm `feature-flags`（15）全绿。教训：C6 只跑了 config 包内的相关测试，漏了 teamlead 里按名字调用 mutator 的用例。
- **F3** teamlead xiaohongshu-write `provider-process.test.ts` 在 CI 红：本 PR 对该文件零改动，本地 3/3 通过 → 需 QA 重跑 CI，不改代码。

其它：合并 `origin/main`（`9e3ba1175`，只新增 `engineering/doc/FLY-2884-*`）；`fly2102-flag-freeze` 40/40；残留门允许清单只重生成了退役脚本 / 测试 / targets 三行（新注释里的 huddle 词元），`0 unallowed, 0 stale, 656 allowed`（`742918c8c` 时），自测通过；删除集仍与 manifest 252 行逐行相等。
- **Lead 返工补充（lead-instruction `3c2aa497`）**：与 F1/F2/F3 修复一致，另要求 test-1..6 凡能读到 token 的都扫、`/meet` 进清单，并确认现有语音会话不注册任何斜杠命令。据此 `6faa2e4d8` 给 `TEST_BOT_TOKEN_2..6`（可选）也加上 `meet`；项目 Lead bot 仍只匹配四个旧名。重跑只读 dry-run：仍精确 10 条、test-2..6 已按含 `meet` 的名单查询且无命中、必查目标全部 `queried_ok`、`uncovered: []`，token 泄漏 0。本轮未 `--apply`（留给 QA）。复审：新 head 的 Codex 复审因 OpenAI 侧 `401 Unauthorized`（Lead 告知宕机）未能进行，按 Lead 指示等通知再做，不换模型。

## 8. Codex R3（返工头复审）

- 返工头 `f1f184cb7` 的复审（gpt-5.6-sol xhigh，线程 `01a0daf6-1f50-7522-b7dc-f0b3812a5dab`）：CHANGES REQUESTED，1 HIGH + 1 LOW。其余验证通过：退役脚本 19/19、teamlead 111/111、config 146/146、flywheel-comm 15/15、flag freeze 40/40、F3 本地 3/3。
- HIGH（`36fe6f658` 修复）：按 token 去重时 `guildIds` 与命令名分开合并，staged 目标（在自己的 guild 删 `/meet`）与共用同一 token 的 Lead 候选（另一个 guild、只匹配四个旧名）会让 `/meet` 扩散到候选的 guild。改为按 `(token, guild)` 保存名字集合，回执每个 guild 条目写出自己的 `commandNames`；新增回归用例，负向对照（改回整组并集）使其变红。真实只读 dry-run 不变：精确 10 条、必查目标全部 `queried_ok`、token 泄漏 0。20/20。
- LOW：文档里的残留门放行数已过时 → 改为标注测量提交（`36fe6f658` 时为 664）。

## 9. Codex R4

- R4（同线程）：R3 两条确认已修；新提 1 MEDIUM + 1 LOW。
- MEDIUM（`3de8cfbc1` 修复）：`required` 仍按整个 token 组合并——必查 guild 查询成功、同 token 的可选 guild 返回 403 时，会误把必查目标记为 uncovered 并失败退出。改为按 guild 记录 `required`（`guildRequired`），覆盖判定只看必查 guild；新用例覆盖两个方向（可选 guild 拒绝 → 通过；必查 guild 拒绝 → 仍失败），负向对照（按全部 guild 判定）使其变红。
- LOW（同提交）：身份校验失败分支的 guild 条目补上 `required` 与 `commandNames`。
- 退役脚本 21/21；真实只读 dry-run 不变（10 条、`uncovered: []`、token 泄漏 0）。
- **最终头的残留门：`0 unallowed, 0 stale, 667 allowed hit(s)`（`3de8cfbc1` 起，之后只改排除目录内的文档）**，自测通过。
