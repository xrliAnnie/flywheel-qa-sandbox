# FLY-2029 Raya V1 地基 — 调研
Issue: FLY-2029 (https://linear.app/geoforge3d/issue/FLY-2029/rayav1-地基独立仓-codex-身份-raya-频道-v2-语音桥-试用期三指标自动记录)
日期: 2026-08-25
基于: exploration.md

## 1. 结论

Batch 1 不需要把 Flywheel 的 Bridge、Lead runtime 或既有 voice-bridge 拆出去复用。最小且满足 PRD 的形态是两个新的私有 Git 仓：`raya` 保存 brain、独立 voice package、身份与运行说明，`raya-memory` 只保存阶段性提炼的 `MEMORY.md`。brain 与 voice 是同仓、不同进程；Raya 通过公开的 Codex App Server JSON-RPC 和 Discord API 工作。换到一台没有 Flywheel 源码的机器仍可部署。

Codex 会话在 `thread/start` 时固定 `gpt-5.6-sol`、`xhigh` 和 `1_050_000` context window。context window 只放进该请求的 `config` map，不写入 `CODEX_HOME/config.toml`。语音使用 `thread/realtime/start` 的 v2 WebSocket transport；Discord 音频只做协议所需的 PCM 转换，不另建 STT、TTS、打断状态机或对话状态机。

## 2. PRD 约束复核

### 2.1 独立产品，而不是 Flywheel 子包

FLY-1846 v1.7 §8.5 的判据是“假设使用者没有 flywheel 这个仓库”；§8.6.3 又明确 Raya 有自己的仓、自己的 channel、常驻。因而以下做法不成立：

- 在 `packages/` 增加 Raya runtime；
- import `flywheel-*` workspace package；
- 运行时从 Flywheel checkout 读取 persona、配置、memory 或音频 helper；
- 把 FLY-1911 的绝对路径、测试 token、临时 ledger 或实验开关带进产品。

Flywheel 本 PR 只承载设计、验证证据、外部仓链接与 milestone，不承载 Raya 产品源码。

### 2.2 能力默认给全，不预先裁剪

FLY-1846 §8.4 明确“默认给全部，发现某项能力出问题再针对性限制”。现有 Flywheel Codex full-access 的已验证形态不是自造 action gateway，而是 Codex 原生 `workspace-write`、network ON、明确 writable roots、`approvalPolicy=never`。Raya 沿用这个能力形态：

- `sandbox_workspace_write.writable_roots` 由 `RAYA_WORKSPACE_ROOTS_JSON` 配置，不写死 Flywheel 路径；
- `sandbox_workspace_write.network_access=true`；服务端回执必须验证这两项实际生效；
- 不加命令 allowlist、broker 或功能阉割；
- 外部 founder-only 动作仍受身份指令和目标系统自身权限约束，不在 Batch 1 新建另一套审批系统。

### 2.3 身份与记忆是两层

FLY-1846 §10.4b 的实验已经证明 Codex 的内部 memory store 跟随 `CODEX_HOME`，所以 Raya 必须使用独立 `CODEX_HOME`。同一节也证明大型 `git + MEMORY.md` 形态不会被 Codex binary 自动创建；因此另建 `raya-memory` 仓是交付内容，不以“后续会自动出现”代替。

长期记忆遵守 founder 划定的边界：保留交代要执行的事和阶段性提炼，不保存所有 Discord/语音逐字历史。启动时把代码仓的 `IDENTITY.md` 与 memory 仓的 `MEMORY.md` 作为 `baseInstructions` 输入同一个 Codex thread；运行日志与 memory Git 历史分离。

## 3. Codex App Server 契约

### 3.1 单会话 1M 配置

当前机器 `codex-cli 0.149.1` 的 experimental schema 暴露 thread/realtime 与 workspace 相关字段，但实际 JSON-RPC 会在 `initialize` 未声明 `capabilities.experimentalApi=true` 时以 `-32600` 拒绝；“schema 里看得到”不等于可直接调用。`runtimeWorkspaceRoots` 也不会成为 sandbox writable roots，真实回执会保持 `networkAccess=false`、`writableRoots=[]`。所以会话启动请求把权限配置放进 thread 的 `config.sandbox_workspace_write`：

```json
{
  "model": "gpt-5.6-sol",
  "config": {
    "model_reasoning_effort": "xhigh",
    "model_context_window": 1050000,
    "sandbox_workspace_write": {
      "network_access": true,
      "writable_roots": ["<configured absolute roots>"]
    }
  },
  "approvalPolicy": "never",
  "sandbox": "workspace-write"
}
```

`baseInstructions` 在运行时补入。模型、effort、window 都不进入 `config.toml`；`CODEX_HOME` 只负责 Raya 自己的 auth、thread state 和内部 memory store。preflight 必须用真实 binary 断言服务端回执，不以本地 params 对象自证。

官方 GPT-5.6 Sol 模型页确认模型 id 为 `gpt-5.6-sol`、context window 为 1,050,000、支持 `xhigh`。官方 Codex 配置文档确认 `model_context_window` / `model_reasoning_effort` 是配置键，CLI `-c key=value` 是 invocation override；App Server schema 则给出了更窄的 thread-level `config` 边界。

### 3.2 v2 语音与 FLY-2074 接口

生成的当前 schema 给出的最小链路是：

1. `thread/start` 创建或恢复 Raya thread；
2. `thread/realtime/start` 使用 `outputModality: "audio"`、`transport: {type: "websocket"}`、`version: "v2"`；
3. Discord Opus 解码成 48 kHz stereo s16le，2:1 downmix/box-average 成 24 kHz mono s16le；
4. `thread/realtime/appendAudio` 发送 base64 PCM 及精确 sample/channel/sample-count metadata；
5. 消费 `thread/realtime/outputAudio/delta`，验证 24 kHz mono s16le，再升采样为 Discord 要求的 48 kHz stereo raw PCM；
6. 用 `StreamType.Raw` 播放，避免 ffmpeg 把无 header PCM 误判。

FLY-1911 只证明 v2 能说、能听、能触发 Codex 工作；它的绝对路径、测试 token、PoC ledger、旧 binary 假设和实验开关均不继承。FLY-2074 正在并行重写这条 voice pipeline，裁定它在 `raya` 仓内是独立 package/dir 和独立进程，不与 brain 合进一个 runtime。本单提供 repo/toolchain、`RAYA_*` env、thread start/resume 参数和 metrics directory 契约，并负责最终集成验收；不再平行写第二份 voice implementation。

FLY-1850/1851 又要求 v2 长思考时在文字 channel 显示状态，因此 FLY-2074 产品链需要同时发布 `listening`、转写文本、工作中、断开/错误状态。Batch 1 不实现完整 meeting scheduling、notes/action-item 闭环或自造 barge-in；这些不属于 FLY-2029 验收。

Discord 侧只需 `discord.js`、`@discordjs/voice`、DAVE 支持和一个 Opus codec。现有 `flywheel-voice-bridge` 的真实事故记录证明三个必要点：`Guilds + GuildVoiceStates` intents、每 bot 唯一 voice connection group、raw PCM 明确标记 `StreamType.Raw`。这些是协议事实，可在独立仓内用最小代码重写，不能 import Flywheel package。

## 4. 三指标自动记录

### 4.1 记录格式

用 append-only JSONL，而不是数据库或 dashboard。每个样本包含 UTC 时间、runtime/session/thread id 以及：

- `process_tree_rss_bytes`：Raya brain、voice 进程与其 Codex App Server 后代进程 RSS 总和；
- `swap_used_bytes`、`swap_delta_bytes`、`swap_baseline_percent: 79`；
- `context_total_tokens`、`context_window_tokens`、`context_utilization`、`context_peak_tokens`。

另提供只读 `metrics summary` CLI，输出采样范围、RSS 当前/峰值、swap 起点/终点/变化、context 峰值/1M 占比和样本数。试用期结束直接查询 JSONL，不依赖仍在运行的进程。

### 4.2 数据源

- process RSS：brain 与 voice 各自在 `RAYA_METRICS_DIR/run/` 写 pid file；Node stdlib 启动 `/bin/ps -axo pid=,ppid=,rss=`，以这些 pid 为 roots 构造后代闭包后求和。这样 separate-process 形态也覆盖完整 Raya + Codex。只记总量与进程数，不记 argv/env；命令失败写明确 error sample，不伪造 0。
- swap：macOS `/usr/sbin/sysctl -n vm.swapusage`，严格解析 total/used/free 和单位；保存首个有效 used 作为本次试用起点，再计算 delta。当前受限 runner sandbox 会拒绝 `ps`/`sysctl`，所以单元测试注入固定输出，真实常驻环境必须做 live preflight。
- context：voice pipeline 直接消费官方 App Server 的 `thread/tokenUsage/updated`，向 `RAYA_METRICS_DIR/context-usage.jsonl` append。其 `tokenUsage.total.totalTokens`、`modelContextWindow` 是实际 thread 数据，峰值由 summary reducer 计算，不用字符数或 transcript 估算。

默认 60 秒采样一次，启动时立即采一次，收到 token-usage notification 时立即补记一次。文件 append、目录创建和 summary 读取都用 Node stdlib。

## 5. 外部资源与上线前置

### 5.1 Avatar

必须复用 FLY-1846 已入库的真实电影图 `raya-avatar-square.png`（783×783），不得生成替代图。新代码仓保留图片和来源说明；Discord bot profile 使用同一文件。

### 5.2 Discord 身份

当前 secret inventory 没有 dedicated `RAYA_BOT_TOKEN`。Bot REST token 可以创建/复用 `#raya` channel、更新已有 bot 的 username/avatar，却不能创建新的 Discord application/bot。已向 Lead 发出非阻塞 provisioning 请求；实现和离线验证不等待它，真实 `#raya`、头像、进语音房出声 E2E 必须在 token 到位后完成。

founder 自己处理 Discord category，按 PRD 不属于工程等待项。

## 6. 最小依赖与删减清单

新增运行时依赖只保留 Discord voice 协议需要的包；App Server、metrics、JSON-RPC、JSONL、subprocess、stream、PCM conversion 全用 Node 原生能力。明确不新增：

- Flywheel workspace dependency；
- database、ORM、metrics SaaS、dashboard；
- WebRTC/v3、独立 STT/TTS；
- 自造 conversation state machine、打断算法；
- 全量 transcript archive；
- 对未来全员 1M 的 fleet config。

## 7. 参考

- FLY-1846 PRD v1.7 merge: `c166d3ec7`
- FLY-1850 PRD merge: `399edd8e8d2060025bae8102948ff588cda66381`
- FLY-1851 PRD merge: `c55a14a8d16576639715a2830d837072f29ae9d0`
- FLY-1911 PoC handoff、decisions 与 evidence: `product/doc/FLY-1911-codex-voice-prototype/`
- OpenAI GPT-5.6 Sol: https://platform.openai.com/docs/models/gpt-5.6-sol
- Codex configuration reference: https://developers.openai.com/codex/config-reference
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex App Server: https://developers.openai.com/codex/app-server
