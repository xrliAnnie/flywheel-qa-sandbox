# FLY-2860 删除三套旧语音命令 — 实施计划
Issue: FLY-2860 (https://linear.app/geoforge3d/issue/FLY-2860/语音清理-删掉-geminigeminigemini-advancedelevenlabseleven与-glaw)
日期: 2026-09-25
基于: exploration.md, research.md

**Status**: v3（Codex R2 APPROVED；v3 仅同步 §10 字段摘要，见 §11）

## 0. 一句话

按脚本算出的引用图，把 `/gemini`、`/gemini-advanced`、`/eleven`、`/glaw` 以及托着它们的 voice-bridge 守护进程、gemini-agent 包、voice-core 的 Gemini Live 与 POC `talk`、全部测试台架 / spike / flag 登记 / 部署步骤删掉；voice-bridge 只留 voice-codex 在用的 Discord 库面；再用一个可复跑脚本把 Discord 上残留的四个斜杠命令删掉。

## 1. 范围

### 1.1 做
- C1 gemini-agent 整包下线。
- C2 voice-bridge：删三套命令 + 守护进程 + 只服务它们的模块；库面收窄。
- C3 voice-core：删 Gemini Live 后端、`TalkSessionRotator`、`Resident*Brain*`、POC CLI 的 `talk` 子命令。
- C4 部署壳：`run-voice-bridge.ts`、wrapper、launchd plist + manifest 行、`lib/restart-voice-bridge.sh`、`restart-services.sh` 的 voice-bridge 步骤（先红后绿）。
- C5 ProjectConfig 的 `huddle` 块退化为「退役标记」，四处冲突守卫语义不变。
- C6 flag / env 登记、CI 步骤、依赖与 lockfile。
- C7 spike、证据文件、台架。
- C8 可复跑的退役脚本：删 Discord 残留 guild 命令、检测 / 下线残留 launchd 单元。
- C9 残留门：`residue-check.sh` + 允许清单，给 QA 判据 1 一个机械判定。

### 1.2 不做（Lead 2026-09-25 裁定）
- Bridge 侧 `geminiAgentToken` / `TEAMLEAD_GEMINI_AGENT_TOKEN` / `ship_approval_request` / `runner-tier-token-preflight.sh`（Q2）→ PR follow-ups。
- Bridge 侧 `/api/voice/sessions/resident/claim` 等路由与 `meeting`/`rg` 模式（Q4）→ PR follow-ups。
- 历史文档（`engineering/doc/**`、`doc/**`、`product/doc/**`、milestones）（Q3）。
- Gemini 编码 runner、评审通道、图像技能、`scripts/fly349-engine`。
- 生产语音 voice-codex / voice-headphone 的任何行为。
- 「删后新变不可达、但不是旧命令组件」的代码：只列清单（§8），不删（CLAUDE.md dead-code 规则：先问）。

## 2. 入场与基线规则（实现第一步，必须照做）

1. 拿 TURN；`git merge origin/main`（#1306 预计已合入；#1309 若也已合入同样照做）。
2. 重跑引用图并与本计划的清单比对：
   ```bash
   node engineering/doc/FLY-2860-legacy-voice-removal/refgraph.mjs . --json "$TMPDIR/fly2860-graph.json"
   ```
   - `onlyOld` 与 research §3.1 的 62 个文件做差：**多出来的**（例如 #1309 合入后的 `resident-voice-session.ts`、`room/adapter.ts`、`huddle/GlawLeaseHeartbeat.ts`）属同一规则，直接进删除集；**少掉的**（例如纯 main 下 `audio/resample.ts` 仍被 voice-codex 用）移入保留集。
   - `shared` 里若出现本计划没点名的新文件，**停下来**在 `progress.md` 记录并问 Lead，不要猜。
   - 把删除前证据固化进本目录：`graph-before.json`（脚本输出原样）+ `deletion-manifest.tsv`。manifest 覆盖**所有**要删的文件（不只图里的非测试源码），每行 `路径<TAB>类别<TAB>证据`：
     - `src-onlyOld`：证据 = 图 JSON 的 onlyOld 条目；
     - `test`：证据 = 图的测试分类（delete / mixed，并写明主语是哪条旧命令）；图标为 `no-lib-import` 的测试逐个人工归类（例：`voice-bridge/src/__tests__/rig-config.test.ts` 第 5 行 import `../../e2e/lib/rig-config.mjs`、第 66-78 行读两个 Gemini 台架 → 随 e2e 删）；
     - `harness` / `script` / `ci` / `fixture` / `spike` / `evidence`：证据 = `git grep` 出的引用方全部在删除集里（贴出命令与结果），脚本里的动态加载（如 `scripts/qa/fly2446-two-lead-run.mjs:462-466` 动态加载 voice-bridge `createDiscordDeps`）必须单列并说明为何保留或删除。
   - 记录基线：`git rev-parse HEAD`（merge 之后）写进 manifest 头注释。
   - 收尾时 `git diff --diff-filter=D --name-only <基线>..HEAD` 必须与 manifest 的路径集合**逐行相等**（多删、少删都失败）。
   - 冻结 manifest 之前做 CLAUDE.md 要求的**外部 CLI 消费者 sweep**（本单净删 `flywheel-gemini-agent` bin、`flywheel-voice-bridge` bin、`flywheel-voice-poc talk` 子命令）：只读 grep 三个 root——插件 fork `xrliAnnie/claude-plugins-official` 的 `external_plugins/`、本机 `~/.claude/plugins/cache/*/`、主仓 `scripts/` 与 `packages/`；带执行时间戳写进 PR，缺失 / 不可读的 root 明写「未检查」，不得报成零引用。发现外部调用方 → 记录迁移或 follow-up，不扩大删除范围。
3. 本机只跑与改动相关的测试文件；⛔不跑整包测试，全量交给 PR CI。构建（`pnpm --filter <pkg> build`）允许，用来当类型闸。
   - worktree 首次跑测试若报 `ERR_MODULE_NOT_FOUND`：`pnpm install --offline` + 按拓扑 build 依赖包。

## 3. 改动清单（按 chunk，每个 chunk 一个 commit，commit 后该 chunk 相关包必须能 build）

### C1 gemini-agent 下线
- `git rm -r packages/gemini-agent`（源码 18 + 测试 12 + README / .env.example / package.json / tsconfig / vitest.config）。
- 删 `scripts/gemini-agent-guard.sh`；`.github/workflows/ci.yml` 删 `Test — FLY-1018 gemini-agent guard` 步骤（约 1071-1076 行）；`scripts/__tests__/ci-structure.test.sh` 删对应期望步骤名（约 1140 行）。
- C1 可以最先做：voice-bridge 的 `assistant/advanced.ts:19-24` 早已是 FLY-2105 的退役 throw stub，不 import gemini-agent；voice-bridge / voice-core 均不依赖 gemini-agent 包。
- `scripts/__tests__/flywheel-log-rotate.test.sh:187-188`：`ts_append_writers` 清单要求列出的每个文件都接了 `appendRotatedLogSync`；两个 gemini-agent 写者随包消失 → 删这两行，清单其余不动。
- `pnpm-lock.yaml`：`pnpm install --offline` 让 lockfile 去掉 `packages/gemini-agent` importer；用 `git diff pnpm-lock.yaml` 确认**只**删了该 importer 段（及其独占的传递依赖条目）。

### C2 voice-bridge：删旧命令 + 守护进程，收窄库面
**整文件删除**（以 `deletion-manifest.tsv` 为准；main + #1306 下为）：
- `src/assistant/*`（9）、`src/eleven/*`（6）、`src/huddle/*`（12）、`src/cli.ts`、`src/config.ts`、`src/preflight.ts`、`src/roomEars.ts`、`src/SessionSlot.ts`、`src/VoiceRoomRuntime.ts`、`src/audio/{EarsReceiver,GeminiTurnMouth,TextTurnMouth,defaultCues}.ts`、`src/brain/BrainPort.ts`、`src/discord/TivPresenter.ts`、`src/linear/BridgeLinearClient.ts`；`src/audio/resample.ts` 视重跑结果（§2）。
- 测试：research §4 的「整删」与「混合」两类中属于 voice-bridge 的全部文件，**加上** `src/__tests__/rig-config.test.ts`（图标为 no-lib-import，实为 e2e 台架的测试，见 §2）。
- 台架：`git rm -r packages/voice-bridge/e2e`（14 个文件）。

**混合文件修改**：
- `src/index.ts`：只保留仍存在模块的导出——`BotRegistry` 系、`discordWiring` 系、`LeadSpeaker` 系、`VoiceConnSupervisor`（若原本导出）、`resample`（若保留）。文件头注释改成「voice-codex 的 Discord 接线库」，删掉 FLY-545/967/1006 三方消费者的说法。
- `src/bots/discordWiring.ts`：从 `DiscordDeps` 接口与 `createDiscordDeps` 实现里删
  - 斜杠命令注册：`registerGuildCommand`、`onChatCommand`、`onChatInteraction`（删掉后仓内再无任何代码能注册语音斜杠命令）；
  - 只服务旧命令的：`tivPort`、`moveMember`、`moveMemberDetailed`、`sendMessageForId`、`editMessage`；
  - 以及只被这些成员使用的内部辅助函数 / 类型（如 `GlawInteractionLike` 风格的 duck-typed 交互切片）。
  - **保留**：research §3.3 表中保留侧引用 >0 的成员，以及通用接收诊断成员（`receiveRuntime`、`isHumanFactory`、`connectionEvents`、`voiceConnHandle`、`receiveEvents`）。
  - 删之前对每个成员再跑一次 `git grep -n "\b<member>\b" -- packages scripts ':!packages/voice-bridge/src/bots/discordWiring.ts'`，非零（且不在删除集）就保留。
- `src/audio/resample.ts`（仅当它留在保留集）：删 `StereoDownmixDecimator`（48k 立体声 → 16k 单声道，只服务旧命令的 16 kHz 输入）及其导出，保留 `upsample24kMonoTo48kStereo`。这样仓内不再有 16 kHz 房间输入代码（附带必修 #1）。
- `package.json`：删 `bin.flywheel-voice-bridge`；删 `dependencies.flywheel-edge-worker`（唯一用处是 /glaw 的 `WorktreeManager` 动态 import）；description 同步。其余依赖（discord.js、@discordjs/voice、prism-media、opusscript、@snazzah/davey）保留——voice-codex 通过 `createDiscordDeps` 用到。
- 保留原样的测试：`bot-registry`、`discord-wiring-policy`（删其中针对已删成员的用例）、`lead-speaker`、`voice-conn-supervisor`。

### C3 voice-core：删 Gemini Live、POC `talk`、Resident brain
**顺序约束**：C3 删的 `GeminiLiveBackend`、`createGenaiTransport`、`TalkSessionRotator`、`ResidentBrainManager` 仍被 voice-bridge 的 `assistant/wiring.ts`、`huddle/wireMeeting.ts`、`cli.ts` 导入 → **C3 必须在 C2 之后**（消费者先退役，provider 再收窄）。C3 的构建闸包含 voice-core、voice-bridge、voice-codex、voice-headphone 四个包。
**整文件删除**：`src/backends/gemini/{GeminiLiveBackend,genaiConnector,transport,turn-accumulator}.ts`、`src/TalkSessionRotator.ts`、`src/brain/{ResidentBrainManager,ResidentClaudeBrain}.ts`；测试 `gemini-live`、`extra-tools`、`genai-config`、`genai-connector`、`turn-accumulator`、`assistant-live-options`、`inject-context`、`qa-fly545-resilience`、`rotator`、`rotator-backend-integration`、`resident-brain`、`resident-brain.smoke`、`resident-manager`、`resident-manager.smoke`；`e2e/fly1065-live-aggregation.mjs`；`evidence/` 下 `gemini-*.json` 与 `real-live-models-list.json`（`evidence/README.md` 同步删对应行）。

**混合文件修改**：
- `src/factory.ts`：删 `buildGeminiBackend`、`buildRegistry` 里的 `"gemini-live"` 注册与 `converse` wiring 参数；保留 `buildEdgeTtsBackend`、`buildHeadlessBrain`、`buildRegistry`（edge-tts 部分）。
- `src/config.ts`：删 `VoiceCoreConfig.gemini`、`DEFAULT_GEMINI_MODEL`、`FLYWHEEL_VOICE_GEMINI_MODEL` / `FLYWHEEL_VOICE_GEMINI_KEY_ENV` / `GEMINI_API_KEY` 读取、`"gemini-live"` 后端名、`verifyConverseComponents`。
- `src/cli.ts`（`flywheel-voice-poc`）：删 `talk` 子命令及其 help 文案、`MicCapture` / `StreamPlayer` / `TalkSessionRotator` / `buildHeadlessBrain` 的 import；保留 `say`（edge-tts）。
- `src/index.ts`：删已删文件的导出与 `buildGeminiBackend`、`verifyConverseComponents` 导出。
- `package.json`：删 `dependencies.@google/genai`；description 里「converse = Gemini Live」改掉；`bin.flywheel-voice-poc` 保留（`say` 还在）。
- 测试修改：`cli-factory.test.ts`、`config.test.ts`、`public-exports.test.ts`、`registry.test.ts` 删 Gemini / talk 用例，其余不动。

### C2.5 旧编译产物退役（两个包的 build 都只是 `tsc`，删源码不会删 dist）
- 现象：`tsc` 不清理已删除源码对应的 `dist/*.js`；`scripts/package-onboard.sh:713-714` 原样递归复制 dist，`package-onboard-files.allow:168-171` 放行 `dist/*` → 复用的部署 / 打包 checkout 会把旧 `assistant/` `eleven/` `huddle/` `cli.js` 与 voice-core Gemini / Resident 产物继续带进 payload。
- 做法（有界、不改构建系统）：voice-bridge 与 voice-core 各加一个受版本控制的 `retired-outputs.json`（本单删除的源码对应的 `dist` 相对路径前缀清单：`.js` / `.d.ts` / `.js.map` / `.d.ts.map` 与整目录），`build` 改为 `node ../../scripts/lib/remove-retired-dist.mjs <pkg-dir> && tsc`。
- `scripts/lib/remove-retired-dist.mjs`：只接受落在 `<pkg-dir>/dist/` 之内的规范化路径（拒绝 `..`、绝对路径、符号链接逃逸），不存在即跳过，幂等；打印删了几个路径。配 `scripts/__tests__/remove-retired-dist.test.mjs`：①只删清单内 ②拒绝越界路径 ③重复运行幂等 ④dist 不存在时退出 0。
- gemini-agent：复用 checkout 里残留的未跟踪 `packages/gemini-agent/{dist,node_modules}` 没有 `package.json` → 不再是工作区包、也不在 `PO_PACKAGES` → 不进 payload；QA 验证时一并确认。
- 验证（Q4 附加）：同一个 checkout 先在基线构建一次，再切到删除后的头重建并跑 `package-onboard`，检查 payload 里 voice-bridge 与 voice-core 的全部退役产物、以及 `flywheel-gemini-agent` 都不存在。

### C4 部署壳（Lead 要求：先红后绿）
**RED 先行**：新增 `scripts/__tests__/restart-services-no-voice-bridge.test.sh`，断言：
1. `restart-services.sh` 不再 `source` `lib/restart-voice-bridge.sh`，全文不含 `voice-bridge` / `VOICE_BRIDGE` / `ensure_voice_bridge_for_deploy` / `restart_voice_bridge_managed`；
2. DRY RUN 文案不再提 voice-bridge（dry-run 在 `restart-services.sh:2253-2257` 打印汇总后就 exit，只能证文案与无副作用，不能证控制流）；
3. 控制流：复用 `scripts/test-restart-services.sh` 已有的 hermetic HOME 真跑桩（FLY-1224 那套 `bo_run` + curl / launchctl 桩，跑真实顶层而不是 dry-run），记录 Bridge、Lead 恢复波次、standalone voice（`com.flywheel.voice`）、deployed-sha 写入的调用顺序，断言：部署成功路径顺序不变；standalone voice 重启失败时仍走回滚、不推进 deployed-sha、仍发原告警；回滚分支里 Lead 恢复波次仍执行。另加非空的源码顺序断言（`deploy_and_verify` 内各 Step 函数调用的相对顺序）作补充；
4. `scripts/launchd/units.manifest` 不再有 `com.flywheel.voice-bridge`，`com.flywheel.voice` 行原样保留；
5. `scripts/launchd/com.flywheel.voice-bridge.plist`、`scripts/run-voice-bridge.ts`、`scripts/flywheel-voice-bridge-wrapper.sh`、`scripts/lib/restart-voice-bridge.sh` 不存在；
6. `scripts/install-voice-launchd.sh` 仍保留「发现 `com.flywheel.voice-bridge` 就拒装」的守卫行（负向守卫不许被顺手删）。
先在未改的树上跑：1/2/4/5 必须 FAIL、3/6 PASS（记录输出到 progress）；再做删除，全部 PASS。把新测试登记进 ci.yml 原 `restart-services-voice-bridge.test.sh` 所在的 FLY-1715 步骤，并同步 `scripts/__tests__/ci-structure.test.sh:1453-1459` 的 `expected_fly1715_commands` 精确列表。

**删除 / 修改**：
- 删：`scripts/run-voice-bridge.ts`、`scripts/flywheel-voice-bridge-wrapper.sh`、`scripts/__tests__/voice-bridge-wrapper.test.sh`、`scripts/launchd/com.flywheel.voice-bridge.plist`、`scripts/lib/restart-voice-bridge.sh`、`scripts/__tests__/restart-services-voice-bridge.test.sh`（ci.yml:1126 调用同步摘掉）。
- `scripts/restart-services.sh`：删 source 行（约 220-221）、DRY RUN 文案里的 voice-bridge、回滚分支里的 `restart_voice_bridge_managed` / `rollback-voice-bridge-failed` 告警段（约 3629-3631）、`ensure_voice_bridge_for_deploy` 函数（约 3659-3680）与 Step 3.5 调用（约 3911-3915）。**只删这些段落**；回滚分支里其它步骤（Lead 恢复波次等）的控制流逐行核对不变。
- `scripts/launchd/units.manifest`：删 `com.flywheel.voice-bridge` 行。
- 同步修改只为断言 voice-bridge 步骤存在的测试 / 桩：`test-restart-services.sh`、`restart-storm-gate.test.sh`、`restart-deploy-consistency.test.sh`、`restart-services-admission-pause.test.sh`、`qa-fly1501-restart-gate-e2e.sh`、`qa-fly1501-brake-missing-alert.test.sh`、`host-tmux-selection-mounts.test.sh`、`host-tmux-selection-s0-scope.test.sh`、`launchd-census.test.sh`、`launchd-units-manifest.test.sh`、`check-global-path-hygiene.test.sh`、`scripts/lib/path-hygiene.sh:161`、`ci-shell-suite-manual-only.txt`。原则：删掉「voice-bridge 这一项」的断言 / 桩，**不放宽**任何其它断言。
- `packages/claude-runner/test/fixtures/kill-path-inventory.json`：`kill-path-inventory.test.ts:227-235` 对重扫结果做完整 `toEqual` → 按**最终删除集**全量更新，不只壳脚本两条。已知条目：wrapper 与 `restart-voice-bridge.sh`（约 3471、3885 行）、`resident-brain.smoke.test.ts` 两条、`resident-manager.smoke.test.ts` 一条、`ResidentClaudeBrain.ts` 五条（约 1791-1804、1845-1870 行）。优先用该 fixture 自带的生成方式重生成，再 diff 确认只少了删除集里的路径。`kill-path-inventory.test.ts` 进本机测试清单。
- launchd census 行为核对：实现时读 census 对「已加载但不在 manifest 里的单元」怎么处理，把结论写进 PR（预期：别的机器若残留该单元会被 census 报出来，这是期望行为；C8 脚本负责清理）。

### C5 ProjectConfig `huddle` → 退役标记
- `packages/teamlead/src/ProjectConfig.ts`：删 `HuddleConfig` 的字段定义与字段级校验（guildId、voiceChannelId、orchestratorBotTokenEnv、earsBotTokenEnv、commandName、moveMembers、orchestratorBotUserId…）；`ProjectEntry.huddle` 改为 `unknown`（注释：FLY-2860 退役，仅作 legacy 冲突标记）。
- 冲突守卫语义不变：Bridge `voice-session-preflight.ts:99`、`voice-session-services.ts:121`、`voice-session-start.ts:111`、voice-codex `config.ts` 继续在 `huddle != null` 时拒绝。**这四处代码不改。**
- `lead.voice` 的字符串形式（`ProjectConfig.ts:659`，注释写着 huddle form）：它同时服务 FLY-546 耳机模式 → 保留解析，只改注释。
- `packages/teamlead/src/__tests__/huddle-config.test.ts`：改为 ①带 `huddle` 块的项目仍能被加载（不因字段不全而整份配置报错）②四处守卫对它仍报 `legacy_voice_conflict`（守卫侧已有测试的，引用即可，不重复）。
- 生产影响：7 个项目零 `huddle` 块（已核），零行为变化。

### C6 flag / env / CI / 依赖
- `packages/config/src/feature-flags/truth.ts`：删 `FLYWHEEL_GEMINI_AGENT_*`（11）、`FLYWHEEL_HUDDLE_*`（6）、`FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT`、`FLYWHEEL_BRAIN_PORT_TOKEN`、`FLYWHEEL_VOICE_GEMINI_MODEL`、`FLYWHEEL_VOICE_GEMINI_KEY_ENV`。
- `exemptions.ts`：删 `FLYWHEEL_GEMINI_AUTOSTART`、`FLYWHEEL_ELEVEN_AUTOSTART`、`FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE`。
- 同步测试：`feature-flags-drift.test.ts:133`、`feature-flags-store-policy.test.ts:67-69`、`feature-flags-registry.test.ts:594` 附近、`fly1981-legacy-snapshot.ts:43`（读清楚它是不是历史快照夹具；若是「快照必须与当前登记一致」则删条目，若是「冻结的历史输入」则保留并说明）、`scripts/__tests__/fly2102-flag-freeze.test.sh`（它要求每个例外「活着」→ 删掉已不存在文件的 `allowed_hits` 行与 `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE` 行）。
- 每删一个名字，跑 `git grep -n "\b<NAME>\b"`，排除规则与 C9 **相同**（历史档案 pathspec，含 `engineering/doc/FLY-1455-drift-guard-registry/backfill-ledger.md` 这类账本）：剩余必须为零；冻结的历史 fixture（如 `fly1981-legacy-snapshot.ts` 若判定为冻结输入）作为 C9 允许清单里的精确行例外登记。
- 不动：`GEMINI_API_KEY` 在 edge-worker 的读取；`DISCORD_OWNER_USER_ID`、`FLYWHEEL_BRIDGE_URL`、`TEAMLEAD_API_TOKEN` 等共用名。

### C7 spike / 证据
- 整目录删：`engineering/spike/FLY-980-eleven/`、`FLY-1006-eleven/`、`FLY-997-gemini-agent/`、`FLY-967-live-assistant/`、`FLY-545-huddle/`。
- `engineering/spike/FLY-968-voice-bakeoff/`：删 `s4-gemini-multisession.mjs`、`s4a-gemini-voice-sweep.mjs`、`s4b-voice-judge.mjs`、`s5-elevenlabs-agent.mjs`，以及只被它们用的 `lib/*`（先 grep 确认）；`package.json` 删 `@google/genai` / ElevenLabs 依赖（若有）。
- `engineering/spike/FLY-960-dave-stt/`：保留。

### C8 退役脚本 `scripts/retire-legacy-voice.mjs`（可复跑，默认只读）
用途：删 Discord 上残留的旧斜杠命令；检测并下线残留 launchd 单元。

- CLI：`node scripts/retire-legacy-voice.mjs [--apply] [--json <receipt>]`。默认 dry-run，只列出将删什么。
- **必查目标清单**：旧配置允许任意 `huddle.orchestratorBotTokenEnv` 与独立 guild（`ProjectConfig.ts:295-305`），历史注册者不一定在当前候选里。所以脚本接受一个受版本控制的、不含秘密的目标文件 `scripts/retire-legacy-voice.targets.json`：`[{ "envName": "<token 变量名>", "appId"?: "<snowflake>", "guildIds": ["<snowflake>"], "required": true, "note": "<来历>" }]`。实现时用 git 历史、`engineering/doc/FLY-545*`/`FLY-967*`/`FLY-1006*` 的部署记录与 founder/Lead 确认填写历史 orchestrator bot 与 guild；**空目标集直接非零退出**。
- 附加候选（`required: false`）：`~/.flywheel/projects.json` 每个项目 `leads[].botTokenEnv` 的**环境变量名** × 所有 `voiceRoom.guildId`，再加固定名 `HUDDLE_ORCH_BOT_TOKEN`、`HUDDLE_EARS_BOT_TOKEN`（存在才用）；token 先取 `process.env`，缺失时按 `scripts/qa/fly2655-voice-room.mjs` 读 `~/.flywheel/.env` 的同一规则（必须是 mode 600 的普通文件、只解析指定键名、不 `source`）；**绝不打印、不写回执**。同一 token 去重。
- 候选 guild：所有项目的 `voiceRoom.guildId`，校验 `^\d{17,20}$`，非法的跳过并在回执里记 `invalid_guild_id`。
- 每个 bot：`GET /oauth2/applications/@me` 取 `appId`（与目标文件里的 `appId` 不一致 → 失败）；全局：`GET /applications/{appId}/commands`；每个 guild：`GET /applications/{appId}/guilds/{guildId}/commands`。
- 每个 (目标, guild) 的状态精确分类：`queried_ok` / `missing_credential` / `access_denied`（403，附 Discord error code，如 50001）/ `not_found`（404，附 error code，如 10004 Unknown Guild）/ `skipped_invalid_id` / `error`。**`required: true` 的目标只有 `queried_ok` 才算覆盖**；任何 required 目标未覆盖 → 非零退出、Q2 不成立。`required: false` 的非 ok 状态只记录。
- 删除谓词（全部满足才删）：`application_id` 等于该目标 appId、`guild_id` 等于被查询的 guild、`type === 1`（CHAT_INPUT，斜杠命令；USER=2 / MESSAGE=3 右键菜单命令同名也不删）、`name` 精确属于 `glaw` / `gemini` / `gemini-advanced` / `eleven`、`id` 为合法 snowflake。任一字段缺失或非法 → 不删、回执记 `malformed`。全局同名 CHAT_INPUT 命令只列出、标 `global_found` 交人工判断（旧代码只注册 guild 级）。逐个 id `DELETE`，不用 bulk overwrite。
- `--apply`：`DELETE /applications/{appId}/guilds/{guildId}/commands/{commandId}`；429 读 `retry_after` 等待后重试一次，仍失败则非零退出；其它非 2xx 立即非零退出。删完**再列一次**，回执里写 `remaining: []` 才算成功。
- launchd：只读检查 `launchctl print gui/$(id -u)/com.flywheel.voice-bridge` 与 `~/Library/LaunchAgents/com.flywheel.voice-bridge.plist`；`--apply` 时若已加载则 `launchctl bootout`，plist 改名为 `*.retired-FLY-2860`（可逆，不删文件）。
- 回执 JSON：`{ runAt, apply, targets:[{envName, appId, required, guilds:[{guildId, status, discordCode?}], global:{status}}], found:[{appId,guildId,commandId,name,type,scope}], deleted:[…], remaining:[…], uncovered:[…], launchd:{loaded, plist, action} }`——不含 token。
- 测试 `scripts/__tests__/retire-legacy-voice.test.mjs`（node:test，注入 fake `fetch` 与 fake `launchctl` 执行器）：①dry-run 不发 DELETE ②只删白名单名、不删 `glaw2`/`Gemini` 等近似名 ③同名 type=2 / type=3 命令保留 ④全局命令不删 ⑤required 目标缺凭据 → 非零 ⑥所有 list 都 403 → 非零（不能以空 found 通过）⑦零有效 guild / 空目标集 → 非零 ⑧appId 不符 → 非零 ⑨403/404 按 error code 分类进回执 ⑩429 重试一次后成功 / 仍失败则非零 ⑪回执与 stdout 不含 token 字符串 ⑫删后复查非空则失败 ⑬重复运行幂等（第二次 found 为空、退出 0）⑭字段缺失的命令不删、记 malformed。登记进 CI 的 node 脚本测试组。
- **执行时机**：不在实现 / CI 里对真 Discord 运行；由 QA 阶段在 founder 已知情的前提下跑一次 `--apply`，回执贴进 QA 证据（判据 2）。

### C9 残留门 `residue-check.sh`
- 放在本目录：`engineering/doc/FLY-2860-legacy-voice-removal/residue-check.sh` + `residue-allowlist.txt`。
- 执行 `git grep -n -i -E "eleven|gemini|/glaw|huddle"`，排除历史档案 pathspec（`engineering/doc/**`、`doc/**`、`product/doc/**`，milestones 在 `engineering/doc/milestones/` 下已含），对剩余每一行用允许清单匹配；任何未匹配行 → 打印并退出 1。
- 允许清单格式：`精确路径<TAB>行内容正则<TAB>类别<TAB>理由`。**不允许整包 / 目录 glob**（spike 保留目录除外，且只限 `engineering/spike/FLY-960-dave-stt/` 与 `FLY-968-voice-bakeoff/` 的剩余文件，逐文件列）。混合文件（如 Bridge `plugin.ts`、edge-worker、config 测试）只放行匹配指定符号 / 行模式的行（例：`geminiAgentToken`、`GeminiRunner`、`runnerType === "gemini"`），同文件里任何旧语音残留都会不匹配而失败。
- 负例自测：`residue-check.sh --self-test` 在临时副本里往一个混合文件插入 `FLYWHEEL_HUDDLE_BACKCHANNEL_MS` 与 `wireAssistantMode` 两行，断言门失败；插入一行已放行的 `geminiAgentToken` 断言门通过。
- 允许清单按类写明归属（每类一句理由），预期涉及以下文件（实际逐行列出）：
  - Gemini 编码 runner：`packages/config/src/**`（runner-label / model-display / model-tiers / ConfigLoader.roles 测试）、`packages/core/**`、`packages/edge-worker/**`、`packages/claude-runner/test/AntigravityTmuxAdapter.test.ts`、`packages/agent-team-transport/src/__tests__/factory-backend.test.ts`；
  - Bridge scoped token（Q2 follow-up）：`packages/teamlead/src/bridge/plugin.ts`、`bootstrap-route.ts`、`types.ts`、`config.ts`、`hook-payload.ts`、`commdb-lead-runtime.ts`、`mailbox-lead-runtime.ts`、`StateStore.ts:10233` 附近、`scripts/runner-tier-token-preflight.sh` 及其测试、teamlead 里带 `geminiAgentToken` 的测试、`ci-test-costs.json`；
  - 图像 / 评审技能与非语音 Gemini：`.flywheel/agents/nodes/product_design.md`、`.flywheel/config.yaml`、`scripts/fly349-engine/**`、`docs/CONTRIB.md`、`review.json`、`scripts/fly503-consolidation/**`、`scripts/flywheel-cmux-sync.sh`、`scripts/test-cmux-sync.sh`；
  - 英文单词 eleven（与 ElevenLabs 无关）：`packages/config/src/__tests__/drift-scan.test.ts`、`packages/teamlead/src/__tests__/StateStore.release-readiness.test.ts`、`scripts/__tests__/codex-guard.test.sh`；
  - 历史注释 / 负向守卫：`packages/edge-worker/src/Blueprint.ts`、`packages/flywheel-comm/src/commands/codex-resume.ts`、`lead-rules-base/**/department-lead-rules.md`（「不要调用旧 huddle 入口」）、`scripts/install-voice-launchd.sh`、Bridge / voice-codex 的 `huddle != null` 冲突守卫与 `ProjectConfig.ts` 退役标记、本单新增的 `retire-legacy-voice.mjs` 与其测试（白名单就是这几个名字）、`engineering/spike/FLY-960-dave-stt/**`、`engineering/spike/FLY-968-voice-bakeoff/**`（剩余非 Gemini 文件若仍提到对比对象）。
- 实现结束时跑它必须 exit 0；允许清单每新增一类都要在 PR 里说明。

## 4. 执行顺序与 commit

| 序 | chunk | commit 类型 | 闸 |
|---|---|---|---|
| 0 | 入场：merge origin/main、重跑引用图、写 `deletion-manifest.tsv` | docs | manifest 与 research 差异已记录 |
| 1 | C4 RED：新增 `restart-services-no-voice-bridge.test.sh` | test | 在旧树上 1/2/4/5 FAIL、3/6 PASS |
| 2 | C1 gemini-agent | refactor | lockfile 差异只含该 importer |
| 3 | C2 voice-bridge（消费者先退役） | refactor | voice-bridge、voice-codex、voice-headphone build；保留测试 4 个文件；voice-codex 改动面零 |
| 3.5 | C2.5 旧产物退役（`remove-retired-dist.mjs` + 两包 `retired-outputs.json` + build 脚本） | fix | `remove-retired-dist.test.mjs`；旧树 build → 新树 build 后 dist 无退役产物 |
| 4 | C3 voice-core（provider 后收窄） | refactor | voice-core、voice-bridge、voice-codex、voice-headphone 四包 build + 改动测试文件 |
| 5 | C4 GREEN 部署壳 | refactor | 新测试全 PASS + §5 列出的脚本测试 |
| 6 | C5 ProjectConfig | refactor | `huddle-config.test.ts` + 四处守卫的现有测试文件 |
| 7 | C6 flags / CI | chore | config feature-flags 相关测试文件 + `fly2102-flag-freeze.test.sh` + `ci-structure.test.sh` |
| 8 | C7 spike / 证据 | chore | — |
| 9 | C8 退役脚本 + 测试 | feat | `retire-legacy-voice.test.mjs` |
| 10 | C9 残留门 + 终跑引用图 | docs | `residue-check.sh` exit 0 且 `--self-test` 过；`git diff --diff-filter=D` 与 manifest 逐行相等；终跑图的 `orphan` = 已知入口 / 桶文件豁免（`voice-bridge/src/index.ts`、`voice-core/src/index.ts`、`voice-core/src/cli.ts`（bin）、`voice-core/src/headphone/index.ts`）∪ §8 清单，二者分开列 |

## 5. 本机测试清单（只跑相关文件）

- voice-bridge：`bot-registry`、`discord-wiring-policy`、`lead-speaker`、`voice-conn-supervisor` 四个测试文件。
- voice-core：`cli-factory`、`config`、`public-exports`、`registry`、`edge-tts`、`announcer` 测试文件。
- voice-codex：**不改源码**；只跑直接 import voice-bridge / voice-core 被改符号的测试文件：`discord-room`、`receive-health`、`audio`、`daemon`（以 `git grep -l "flywheel-voice-bridge\|flywheel-voice-core" packages/voice-codex/src/__tests__` 的实际结果为准）。
- teamlead：`huddle-config.test.ts` + 守卫所在的 `voice-session-*` 测试文件。
- config：feature-flags 的 drift / registry / store-policy / flag-truth 测试文件。
- scripts：新 `restart-services-no-voice-bridge.test.sh`、`retire-legacy-voice.test.mjs`、`remove-retired-dist.test.mjs`、`ci-structure.test.sh`、以及 C4/C6 改过的每个 `scripts/__tests__/*.sh`。
- claude-runner：`test/kill-path-inventory.test.ts`。
- 类型闸：`pnpm --filter flywheel-voice-core --filter flywheel-voice-bridge --filter flywheel-voice-codex --filter flywheel-voice-headphone --filter flywheel-teamlead --filter flywheel-config build`。

## 6. QA 判据（对应 issue 的 4 条 + 附带 4 条）

| # | 判据 | 怎么证 |
|---|---|---|
| Q1 | `git grep -i eleven\|gemini` 除允许清单外为零 | `residue-check.sh` exit 0；PR 贴允许清单与每类归属 |
| Q2 | Discord 上不再有 `/gemini` `/gemini-advanced` `/eleven` `/glaw` | QA 先核对 `retire-legacy-voice.targets.json` 覆盖了历史注册者（写明来历），跑 `--apply` 后再跑 dry-run：退出 0、所有 required 目标 `queried_ok`、`uncovered: []`、`found: []`（空 found 但有未覆盖目标不算通过）；voice-bridge 守护进程已不存在，原判据「起一次 voice-bridge」改为此项（Lead Q1 已同意） |
| Q3 | 生产语音不回归 | voice-codex 全量单测、voice-core / voice-headphone / voice-bridge 保留测试、529 语音 shard（FLY-2446 两 Lead 语音驱动）绿；引擎 B 语音房真起一场 ≥60 s 不死 |
| Q4 | 精确头 full CI 全绿；package-onboard 冒烟通过 | CI 链接；**在先用基线构建过的同一 checkout 上**重建并打包：payload 里 voice-bridge 与 voice-core 的 `retired-outputs.json` 所列产物全部不存在，且无 `flywheel-gemini-agent` |
| H1 | 无 16 kHz 消费方挂在房间输入上 | `git grep -n "StereoDownmixDecimator\|16_000" -- packages/voice-bridge packages/voice-codex` 只剩与房间输入无关的行（逐条列）；#1309 若已合入，列 RoomIO `onFrame` 全部订阅方并注明采样率 |
| H2 | VoiceRoomRuntime 单槽不再被争抢 | `VoiceRoomRuntime.ts`、`SessionSlot.ts` 不存在；`git grep -n "VoiceRoomRuntime\|SessionSlot" -- packages scripts` 为零 |
| H3 | 无残留调用方传未登记的 close reason | `git grep -n "ResidentVoiceSessionClient\|resident/claim" -- packages/voice-bridge packages/voice-codex` 为零（Bridge 路由本身保留，见 follow-ups） |
| H4 | 无残留 /glaw 租约调用 | `git grep -n -i "glaw" -- packages scripts` 只剩退役脚本白名单与允许清单行 |

## 7. 回滚

- 代码：整个 PR 是删除 + 小幅剪段，`git revert` 即完全恢复；没有数据迁移、没有 schema 变化、没有 Bridge 路由变化。
- 部署：生产 `restart-services` 的 voice-bridge 步骤本来就是空操作，删掉后部署流程对生产零差异；回滚同理。
- Discord 命令：删除不可由 revert 恢复（需要旧守护进程重新注册）。可接受：这些命令今天就没有进程在处理，founder 点了只会看到「应用未响应」。
- launchd：退役脚本只改名 plist（`*.retired-FLY-2860`），改回原名 + `launchctl bootstrap` 即恢复。

## 8. 删后新变不可达、但不属旧命令组件（只列，不删，交 Lead）

- voice-core：`brain/HeadlessClaudeBrain.ts`、`brain/stream-parse.ts`、`factory.buildHeadlessBrain`（只剩 POC 用途）、`audio/MicCapture.ts`、`audio/StreamPlayer.ts`（原本只有 `talk` 用）、`package.json` 里未被任何源码 import 的 `ws` 依赖（main 上已如此）。
- voice-bridge：`DiscordDeps` 的通用接收诊断成员（`receiveRuntime`、`isHumanFactory`、`connectionEvents`、`voiceConnHandle`、`receiveEvents`）——#1309 的 RoomIO 会用。
- 最终以 C9 终跑引用图的 `orphan` 输出为准，原样贴进 PR。

## 9. PR follow-ups（写进 PR body，不另开单 —— Lead 裁定）

1. Bridge 侧 gemini-agent scoped token：`geminiAgentToken` / `TEAMLEAD_GEMINI_AGENT_TOKEN`（约 50 处路由中间件）、`ship_approval_request` 路径、`scripts/runner-tier-token-preflight.sh`。生产未设该 token。
2. Bridge 侧 `POST /api/voice/sessions/resident/claim`：删 voice-bridge 后仓内无调用方（#1309 若合入则其客户端也随本单删）；路由与 `meeting`/`rg` 模式被 voice-codex 共享，保留。
3. Bridge 侧会议纪要落地代理（`plugin.ts` 约 5117 行，原 voice-bridge landing 用）：核实是否还有别的调用方。
4. 运维数据：本机 `~/.flywheel/.env` 有 `ELEVENLABS_API_KEY` 一行（仅核键名）；是否吊销 / 删行由 founder 定。
5. §8 的新不可达清单。

## 10. 安全与边界

- 退役脚本：token 只从 env 读、只进 `Authorization` 头；回执 / 日志不含 token；guildId 走 `^\d{17,20}$` 校验；只按精确白名单删 guild 命令；默认 dry-run；Discord 响应当不可信数据，只取 C8 删除谓词需要的 `id`/`name`/`type`/`application_id`/`guild_id` 五个字段并逐一校验（见 C8）。
- 不触碰 Bridge 鉴权面、不触碰 voice-codex 源码、不改 `huddle != null` 冲突守卫。
- 不跑整包测试；不 force-push；不合并；不部署。

## 11. 修订轨迹

| 版本 | 触发 | 改动 |
|---|---|---|
| v1 | 初稿 | — |
| v2 | Codex R1（gpt-6-astra xhigh）：4 HIGH + 5 MEDIUM，全部接受 | ①manifest 覆盖全部文件类型 + 逐文件证据 + 与 `--diff-filter=D` 逐行相等；补 `rig-config.test.ts`；kill-path inventory 按最终删除集全量更新；ci-structure 的 FLY-1715 精确命令列表同步 ②C2 先于 C3，C3 构建闸扩到四包；C1 说明 advanced.ts 早已是 stub ③新增 C2.5 旧 dist 产物退役 + 「旧树构建→新树重建→打包」验证 ④C8 引入受版本控制的必查目标清单、按 Discord error code 分类、required 目标未覆盖即失败 ⑤删除谓词加 `type === 1` 与 appId/guildId 匹配 ⑥C4 控制流断言改用 `test-restart-services.sh` 的真跑桩，dry-run 只证文案 ⑦终跑 orphan 区分入口豁免与新不可达 ⑧C6 与 C9 用同一排除规则；允许清单改为「精确路径 + 行正则」并加负例自测 ⑨加外部 CLI 消费者 sweep |
| v3 | Codex R2 APPROVED（ef20e01e4），附 1 个非阻塞 MEDIUM | §10 安全摘要的响应字段列表与 C8 删除谓词对齐（五个字段） |
