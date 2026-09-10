# FLY-2446 两种 Lead 真房驱动 — 实施说明
Issue: FLY-2446 (https://linear.app/geoforge3d/issue/FLY-2446)
日期: 2026-09-09
基于: plan.md

实现归 implement，执行归 QA（Lead 裁定 c7213d53）。本次只验证 hermetic dry-run 与单元测试；**真房 NOT_RUN**。FLY-2455 slot bootstrap 未合入前不得宣称真房通过。

## 输入与已有隔离房

先按 `doc/qa/framework/529-room-playbook.md` 与 `scripts/test-deploy.sh` 部署现有 529 slot，使用一个 Claude Lead 与一个 Codex Lead 的既有 extra-lead 机制。驱动不会创建 bot、部署 slot、启动生产 Raya、重启服务或修改 launchd。它使用已运行的 slot Bridge、Lead 与通用 voice daemon。

```sh
node scripts/qa/fly2446-two-lead-run.mjs \
  --slot-dir /tmp/flywheel-test-slot-2 \
  --raya-cli /absolute/reviewed-raya/packages/cos/dist/cli.js \
  --claude-lead <slot-Claude-agentId> \
  --codex-lead <slot-Codex-agentId> \
  --claude-recorder-env TEST_BOT_TOKEN_3 \
  --codex-recorder-env TEST_BOT_TOKEN_4 \
  --dry-run
```

`--raya-cli` 是明确的被测构建产物输入，不搜索 HOME/默认 checkout，不增加 Raya 配置开关。真正执行由 QA 将 `--dry-run` 换成 `--run`。房间内 QA 人工口述测试句并等待 Lead 回帖与朗读；驱动不会用事件日志或合成音频代替这次口述。

驱动读取已有 `room-info.json`、`bridge-launch.json` 和 room 指向的 projects 文件。两个 Lead 必须在该文件唯一，backend 必须分别为 `claude-code` 和 `codex-app-server`。从 `~/.flywheel/test-slots.json` 的 `slots[].tokenEnvVar/botAppId/channelId` 交叉核对 Lead 与录音 bot；所有 bot 都只能使用 `TEST_BOT_TOKEN_N`。voice bot、两个 Lead、两个录音 bot 身份必须各不相同。凭据只取 slot 的 `secretEnvironment` mode-0600 文件，不 source 全局 `.env`。

已有 slot 必须显式提供这些生产代码已经使用的坐标：

- Bridge launch 中的 `FLYWHEEL_COMM_DB`、`FLYWHEEL_MEETING_NOTES_CONFIG`、`FLYWHEEL_VOICE_HOST_CONFIG`、`FLYWHEEL_VOICE_STATE_DIR`、`FLYWHEEL_VOICE_CODEX_HOME`；相关 DB、state、CODEX_HOME 与证据路径必须在 slot canonical 根内，无符号链接。
- voice-host 的 `qaVoiceChannelIds` 必须包含 registry huddle 语音房；huddle 来自两个 Lead 的现有 project。
- `room-info` 中的 slot 私有 master token、built build SHA 与实际 `/health` 的双 SHA 一致。驱动不会补造缺失的配置、权限或运行实例。

缺少以上任何条件时退出非零；当前 FLY-2455 bootstrap 缺口应在这里明报，不回退到生产 DB、CODEX_HOME 或 voice bot。

## 执行与证据

两场串行共用同一 voice 构建 SHA。每场在 slot canonical meeting 根写入独立 UUID 的测试会议输入，通过**真实 Raya built CLI → Flywheel `createVoiceIntentPort` → Bridge** 调用 start/stop，仅传 meetingId。此前已有非终态会议则拒绝覆盖。

录音 bot 使用已存在的 `createDiscordDeps` 与 Opus decoder，只录 voice bot 的房内声音，以接收时间放入 PCM 时间轴并输出 WAV。驱动观察 SQL `live` 后等待 `voice_outbound.confirmed`，随后 stop 并观察 SQL `ended`。它核对：

- `mailbox.source_kind=voice`、ACKED、`chat:<lead>:<message>` 与 journal 同 deliveryId；
- outbound 作者为该 Lead bot，confirmed 并有 attempt token；
- 使用真实 `selectMeetingTranscript`，trusted 且非空；
- confirmed 的 claimed_at → finished_at 时间段内录音峰值超过整场峰值下 25 dB。全零或区间无声均失败。

证据写入 `<slot>/e2e-evidence/fly2446-<uuid>/<lead>/`，包含 WAV、脱敏 events、meeting 与 receipt。receipt 包含录音 SHA、时长、SQL 行与音频区间指标；原始音频不上传。运行总报告是 `EVIDENCE_COLLECTED`，**不是 QA PASS**。缺证据或异常写 `INCOMPLETE` 并退出非零。

两点仍需 QA 独立完成：RG 默认/配置开关三次实测记录；平台 realtime credit 用量凭据。总报告分别明确 `NOT_RUN` / `NOT_MEASURED`，不会用此脚本替代 plan §4 全部负向守卫或最终 QA 裁定。Raya 仓 merge ≠ deploy：生产 checkout/brain 重启/preflight 由班车完成，以 `~/.flywheel/raya/deploy-receipt.json` 为准；本驱动不宣称上线。

## 实现验证

```sh
node --test scripts/__tests__/fly2446-two-lead-run.test.mjs
pnpm exec biome check scripts/qa/fly2446-two-lead-run.mjs scripts/__tests__/fly2446-two-lead-run.test.mjs
```

测试包含零副作用 dry-run、529 身份与路径拒绝、两种 harness 顺序、真实 PCM 区间分析，以及 mailbox/journal/selector/outbound/音频缺证据的拒绝。网络、生产文件和真房未在 implement 阶段访问。CI 注册由主实现节点负责。
