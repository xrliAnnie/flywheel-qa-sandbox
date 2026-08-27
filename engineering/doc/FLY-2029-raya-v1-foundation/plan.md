# FLY-2029 Raya V1 地基 — 实施计划
Issue: FLY-2029 (https://linear.app/geoforge3d/issue/FLY-2029/rayav1-地基独立仓-codex-身份-raya-频道-v2-语音桥-试用期三指标自动记录)
日期: 2026-08-25
基于: research.md

## 0. 2026-08-26 范围拆分补记

Tadashi 在 implement QA 前转达 founder 的拆分：FLY-2029 的终点改为
**独立仓、Codex 身份、`#raya`、三指标 runtime/install 与 voice integration seam**；
`apps/voice` 实现及「进房 + 出声」live E2E 归 FLY-2074 的 Implement/QA。故本文后文中
关于 FLY-2074 实现落入同仓后的联合 E2E 是下游验收合同，不再阻塞 FLY-2029 PR。
本单仍须把 env、session builder、metrics JSONL/PID 与 supervisor hook 钉成可直接消费的契约，
不得用 placeholder voice 实现冒充下游交付。

## 1. 交付边界

本节点交付一个可常驻的 Raya V1 foundation，而不是完整 Chief of Staff 产品：

1. 私有 `xrliAnnie/raya` 独立代码仓；
2. 私有 `xrliAnnie/raya-memory` 独立长期记忆仓，首个版本含 `MEMORY.md`；
3. dedicated `CODEX_HOME`，每次 start/resume 都把 `gpt-5.6-sol`、`xhigh`、1M 固定在 thread request；
4. dedicated Discord bot 在 `#raya` 上岗，使用 PRD 真图，并能常驻指定 voice channel；
5. 与 FLY-2074 在同仓集成的独立 voice process：Discord PCM ↔ Codex realtime v2 双向音频桥；
6. RSS、swap delta、实际 context peak 自动落 JSONL，`metrics summary` 可查；
7. 真实房间“加入 + 听到 Raya 出声”和三指标查询证据。

不做 meeting scheduling、多人 meeting、会后 notes/action-item HTML、fleet-wide 1M 配置、dashboard、v3/WebRTC 或完整总管业务逻辑。它们不是 Batch 1 的验收条件。

## 2. 仓库与部署拓扑

```text
GitHub
├── xrliAnnie/raya          # 产品代码、IDENTITY.md、avatar、运行说明
└── xrliAnnie/raya-memory   # MEMORY.md，单独 Git 历史

当前机器（部署坐标，可配置；不引用 Flywheel checkout）
$RAYA_HOME/
├── code/                   # raya checkout（brain + voice packages）
├── memory/                 # raya-memory checkout
├── codex-home/             # dedicated CODEX_HOME + auth/thread internal state
├── data/metrics/           # resource/context JSONL + run/*.pid
├── data/state/             # thread-id / text-channel-id 等可重建游标
├── data/logs/              # 两个 launchd job 的 stdout/stderr
└── raya.env                # 0600，Discord ids/token 等运行配置
```

`RAYA_HOME` 必须显式配置为 absolute deployment root；本次受控机器把它指到可写的机器状态目录，但程序、测试和文档不假设 `~/.flywheel` 或 Flywheel repo 存在。代码仓与 memory 仓各自提交、各自 PR；Flywheel PR 只收 FLY-2029 过程文档、外部 PR/证据链接和 milestone。

`raya` 使用 pnpm workspace、TypeScript ESM、Node 22、Vitest、Biome。`apps/brain` 与 FLY-2074 的 `apps/voice` 是两个 process；根目录共享 toolchain，不共享进程状态或 secret。跨进程只共享已命名的 env/file 契约，不新建本地 RPC。

### 2.1 FLY-2074 可直接消费的运行契约

| 名称 | 规则 | consumer |
|---|---|---|
| `RAYA_HOME` | required absolute deployment root | brain + voice parent |
| `RAYA_ENV_FILE` | required absolute 0600 env file；launchd plist 只保存此指针 | brain + voice parent |
| `RAYA_CODEX_BIN` | required absolute executable | voice parent |
| `RAYA_CODEX_HOME` | required absolute dedicated home；child process 只收到 `CODEX_HOME=<此值>` | voice parent / Codex child |
| `RAYA_WORKSPACE_ROOTS_JSON` | required JSON absolute-path array；去重且至少一个；不得与 CODEX_HOME、env、state、metrics/logs 重叠 | voice thread sandbox config |
| `RAYA_CODEX_CWD` | required absolute directory；必须位于 workspace roots 内且不得与敏感路径重叠 | voice thread start/resume + launchd WorkingDirectory |
| `RAYA_IDENTITY_FILE` | required readable absolute `IDENTITY.md` | voice thread start/resume |
| `RAYA_MEMORY_FILE` | required readable absolute `MEMORY.md` | voice thread start/resume |
| `RAYA_DISCORD_GUILD_ID` | required snowflake | voice parent |
| `RAYA_DISCORD_TEXT_CHANNEL_ID` | optional；缺省时 find-or-create `#raya` 并原子保存 `data/state/text-channel-id` | voice parent |
| `RAYA_DISCORD_VOICE_CHANNEL_ID` | required target voice-room snowflake | voice parent |
| `RAYA_FOUNDER_DISCORD_USER_ID` | required；production 默认的唯一 session trigger | voice parent |
| `RAYA_SESSION_TRIGGER_USER_IDS_JSON` | optional JSON snowflake array；effective triggers = founder + 此列表；仅 QA 安装加入 probe id | voice parent |
| `RAYA_BOT_TOKEN` | required secret；只留 voice/brain parent，严禁传 Codex child / log | voice parent + brain liveness alert |
| `RAYA_OPENAI_API_KEY` | required secret；reserved for `apps/voice` (FLY-2074)，brain 不消费，严禁传 Codex child / log | voice parent |
| `RAYA_METRICS_DIR` | required absolute shared directory | brain + voice |
| `RAYA_STATE_DIR` | optional absolute directory；缺省 `$RAYA_HOME/data/state` | brain + voice parent |
| `RAYA_LOG_DIR` | optional absolute directory；缺省 `$RAYA_HOME/data/logs` | launchd jobs |

model/effort/window **不做 env option**。`packages/contracts` 的 builder 对 `thread/start` 与 `thread/resume` 固定：

```json
{
  "model": "gpt-5.6-sol",
  "cwd": "<RAYA_CODEX_CWD>",
  "approvalPolicy": "never",
  "sandbox": "workspace-write",
  "config": {
    "model_reasoning_effort": "xhigh",
    "model_context_window": 1050000,
    "sandbox_workspace_write": {
      "network_access": true,
      "writable_roots": ["<absolute root>", "..."]
    }
  }
}
```

再补 identity + memory instructions；不再把 `runtimeWorkspaceRoots` 当成 sandbox roots。App Server 的第一条请求必须是 `initialize`，并声明 `capabilities: {"experimentalApi": true}`，否则当前 0.149.1 会拒绝 workspace-root/realtime API。preflight 必须向真实 binary 发完整 initialize → ephemeral thread/start probe，并断言服务端回执的 `sandbox.type=workspaceWrite`、`networkAccess=true` 与可写集合一致；只断言本地 builder 不算通过。

服务端会把等于 `cwd` 的 root 从 `sandbox.writableRoots` echo 中去重，所以集合判据写死为：

```text
expected = canonical(RAYA_WORKSPACE_ROOTS_JSON ∪ {RAYA_CODEX_CWD})
actual   = canonical(receipt.sandbox.writableRoots ∪ {receipt.cwd})
PASS     = expected 与 actual 集合完全相等
```

`canonical(path)` 明确定义为：用 Node `resolve()` 绝对化，要求路径存在后以 `realpath()` 解析 symlink，并去除非根路径尾部 separator；expected 与 actual 的每个元素都走完全相同的函数。contract tests 至少覆盖 `cwd == one root`、`cwd nested under one root`、trailing slash 与 symlink alias 四种形状，不能退化为 contains 断言。

`RAYA_METRICS_DIR` 下的跨进程文件名固定为：

```text
resource-usage.jsonl
context-usage.jsonl
run/brain.pid
run/voice.pid
```

`context-usage.jsonl` v1 每行固定为：

```json
{"v":1,"ts":"<UTC ISO>","threadId":"...","turnId":"...","totalTokens":123,"modelContextWindow":null}
```

值必须逐字段来自 `thread/tokenUsage/updated`；`modelContextWindow` 按 schema 允许 `null`，不能因此丢掉有效 `totalTokens`。不写 transcript、prompt、配置常量或估算值。缺 `totalTokens` 才拒绝该 row；window 为 null 的样本照常写，summary 单独统计 denominator unknown。

## 3. TDD 实施顺序

### 3.1 仓库 bootstrap

1. 依据本 user turn 对“建 Raya 独立仓 + 记忆仓”的明确授权，由本 executor 使用当前已认证 `gh` 创建两个 private GitHub repo，保留最小初始 main；不删除、公开或直接提交实现到 main；
2. 各自从 `fly-2029-raya-v1-foundation` 分支工作，不直接把实现推到 main；
3. `raya` 使用 Node 22 + TypeScript ESM + pnpm workspace + Vitest + Biome；Discord voice 依赖只属于 FLY-2074 的 `apps/voice`；
4. 从 FLY-1846 merge object 复用 `raya-avatar-square.png` 与 SOURCE 文件，不生成图片；
5. `raya-memory` 的 `MEMORY.md` 只写已定身份、记忆边界和空的阶段性条目结构，不编造 Annie 的历史。

### 3.2 RED：先固定边界行为

在 `raya` 先写失败测试：

- `config.test.ts`：缺必填 env fail-loud；cwd/roots 必须 absolute 且 cwd 位于 roots 内；两者都拒绝与 CODEX_HOME、env、metrics、state、logs 重叠；effective trigger 在 Discord ready 后不得包含 Raya 自己的 bot user id；secret 不进入 log；
- `codex-contract.test.ts`：initialize 带 experimental capability；start/resume 都包含 pinned cwd、model/xhigh/1M 及 sandbox network/roots；`config.toml` 不含前三项；真实 binary probe 用 expected/actual 规范化集合断言服务端回执；
- `metrics.test.ts`：多 root pid 的 process tree 闭包、voice alive、`vm.swapusage` 单位解析、首样本 delta、nullable window、实际/配置 window mismatch、JSONL append 和 `--dir` summary；命令失败不能写 0 冒充成功；
- `integration-contract.test.ts`：所有必需 `RAYA_*` key、`RAYA_METRICS_DIR` 文件名/schema、brain/voice pid files 和 context JSONL 能被两个进程无歧义消费；
- `lifecycle.test.ts`：bot 常驻但无 trigger 时不开 realtime；启动时 founder 已在房内立即 prime；trigger 进房 prime；离房 stop；10 分钟空转后重建；二次进房重新 prime；realtime error 重连；no-rollout resume 自动换新 thread；QA probe 只有显式加入 trigger 列表才可驱动同一条主路径；
- FLY-2074 自己覆盖 PCM、Discord 与 App Server JSON-RPC 单测；本单在其实现落入同仓后运行并补跨进程 E2E，不复制那些单测对应的实现。

只在测试要求出现后写对应实现。

### 3.3 GREEN：最小模块

本单预期文件保持扁平；FLY-2074 在同仓独立增加 `apps/voice`：

```text
raya/
├── assets/raya-avatar-square.png
├── assets/raya-avatar.SOURCE.txt
├── apps/brain/src/config.ts
├── apps/brain/src/metrics.ts
├── apps/brain/src/runtime.ts
├── apps/brain/src/cli.ts
├── apps/voice/                 # FLY-2074 owner，独立 process
├── packages/contracts/src/codex-session.ts
├── packages/contracts/src/metrics.ts
├── IDENTITY.md
├── README.md
└── package.json / pnpm-workspace.yaml / biome.json
```

- `contracts/codex-session.ts`：一个 plain object builder，给 start/resume 同样的 model、xhigh、1M、sandbox network/roots 配置；不读取 secret。
- `contracts/metrics.ts`：三项 JSONL 的最小 row types、文件名和 `RAYA_METRICS_DIR` 契约；不封装 I/O framework。
- `brain/metrics.ts`：stdlib command runner、严格 parser、append-only resource writer、voice liveness、跨 resource/context JSONL 的 summary reducer。采样 interval 默认 60 秒。
- `brain/runtime.ts`：写 brain pid file、启动 resource sampler、保活并响应 signal；voice 有自己的生命周期 owner。
- `brain/cli.ts`：只保留 `run`、`preflight`、`metrics summary` 三个命令。
- `apps/voice`：由 FLY-2074 重写 JSON-RPC、PCM、Discord 和 v2 链；它 import contracts、写 voice pid 与 actual-context JSONL。本单只做 integration review/E2E。

### 3.4 REFACTOR：只删重复

GREEN 后只做机械收口：删测试没要求的 option/helper；相同的 session params 用一个 plain object builder；错误消息包含 boundary 与 cause；不为了未来 B/C 功能新增接口层。

## 4. Codex 身份与会话细节

1. `CODEX_HOME=$RAYA_HOME/codex-home`，只从 operator 指定来源复制/登录 auth，不读取 host 默认 memory；
2. `baseInstructions = IDENTITY.md + MEMORY.md`；任一文件缺失启动失败，不静默退化成无身份；
3. `initialize` 必带 `capabilities.experimentalApi=true`；握手失败直接退出，不能继续到 Discord ready；
4. 首次 `thread/start` 后不立刻保存游标，等首个真实 turn/token-usage 证明 rollout 已落盘再原子写 `data/state/thread-id`；重启先 `thread/resume`。若返回 no-rollout / invalid / deleted thread，记录原因，start 新 thread，并在首个可持久化事件后替换游标；`#raya` 与日志各留一条“身份线程已轮换”；
5. start/resume 都带 pinned cwd、固定 model、xhigh、1M、identity/memory 与 `config.sandbox_workspace_write`。preflight/运行时用规范化集合校验服务端回执确实 network ON 且完整可写集合一致，不接受静默降级；
6. FLY-2074 voice parent 启动 App Server；child 使用 functional env allowlist 与 dedicated `CODEX_HOME`，不把 `RAYA_BOT_TOKEN` 放进 child env；brain 只用 token 做 voice-down/recovered 两种 text-channel REST 告警，不启动第二个 gateway client；
7. 上一条只是减少无意 env 泄露，**不是同用户 full-access 的 secret confidentiality boundary**：workspace-write 不限制读取，模型仍可能读 host 文件。配置只保证 workspace roots 无法写 CODEX_HOME、`raya.env`、state、logs 或 metrics；能力/读取风险与现有全能力 Codex 同档，靠 founder 已接受的身份合同治理；
8. Discord bot 开机常驻房间，但 realtime session 只在 effective trigger 在房内时创建/prime。bot ready + join voice 后先读取当前 channel members；若 trigger 已在房内，立即走与 voiceState join event **同一个 idempotent create/prime 函数**。房间无 trigger 即 stop；trigger 再次进入必须重新创建/prime。trigger present 期间维持 20ms PCM silence pacing，realtime error/transport close 做有上限 backoff reconnect 并重新 prime；不让数小时冷 session 充当下一次会话。

## 5. Discord 与音频细节

1. bot ready 后 fetch 指定 guild；env 或 `data/state/text-channel-id` 有 id 就校验它确为 `#raya`，否则按名字查找/创建并原子保存运行态 id；若频道不存在且 bot 没有 ManageChannels，preflight fail-loud；
2. 读取当前 bot profile，只在 display name/avatar 与目标不一致时 PATCH；profile patch 失败记录 warning、bot 继续启动，但 live acceptance 直到 profile 匹配才通过；图片 sha256 与 repo asset 对得上；
3. 启动即进 `RAYA_VOICE_CHANNEL_ID`，`selfMute=false`、`selfDeaf=false`；这满足“她进房时房里已经有人”的已定形状；
4. production effective triggers 默认只有 `RAYA_FOUNDER_DISCORD_USER_ID`；QA 安装可通过显式列表加入 probe bot，从而用同一主路径自动回归。bot ready 后先断言 effective triggers 不含 `client.user.id`，防止 Raya 收到自己的音频形成自激；再检查当前成员并监听后续 trigger voice state。非 trigger 不 prime；speaking start 时为当前 trigger 建 Opus decoder，输出 PCM chunk 立即交 v2；
5. v2 output audio delta 写入当前 session 的 raw PCM stream，由单个 AudioPlayer 播放；5 秒 transient underflow 容忍，错误 fail-loud。server-side interruption 会停止新 delta，但已缓冲的 client audio 可能 overhang；Batch 1 不声称 native realtime 能清空它，也不把完整 barge-in 当本单验收；
6. `#raya` 发布短状态：已在听、user transcript、正在处理、Raya transcript、断开/error。状态不是完整 transcript archive。
7. voice 写 `run/voice.pid`；brain 每 60 秒验证 brain/voice pid 及后代，resource row 写 `brainAlive` / `voiceAlive`。连续 3 个样本 voice down 时向 `#raya` REST 告警一次，恢复时告警一次并重置 dedupe；若 channel 尚未 provision，写明确 alert-delivery error。voice crash 不能伪装成“最近没说话”。

## 6. 三指标验收契约

### 6.1 JSONL

`resource-usage.jsonl` 每行包含 schema version、timestamp、runtime id、reason、RSS/swap、brainAlive、voiceAlive 与 error；`context-usage.jsonl` 每行包含同一 schema version、timestamp、thread id、turn id、total tokens、nullable actual model window。brain/voice 各写自己的 pid file。无数据与 0 严格区分；summary 按时间合并两个 JSONL。

### 6.2 Summary

`pnpm raya metrics summary --dir <RAYA_METRICS_DIR>` 必须给出：

- trial 起止与 sample count；
- process tree RSS latest/peak；
- swap used start/latest/delta，以及历史参考 baseline 79%；
- context latest/peak、配置 window、实际 window、peak/实际 window 百分比；
- 1M trial validity：首个/后续实际 window 是否恒等于 1,050,000；若为 null 或其他值，醒目标注本次不是有效的 1M trial，绝不拿配置常量当分母；
- brain/voice 存活覆盖率、voice outage 区间、window-unknown 样本数和 error sample count。

context 的分子只接受 FLY-2074 从 App Server `thread/tokenUsage/updated.tokenUsage.total.totalTokens` 写下的值，分母只接受事件的非 null `modelContextWindow`。首个样本若不是 1,050,000，voice 立即在日志与 `#raya` 告警但可继续语音试用；summary 永久标记 `trialWindowValid=false`。这让 258,400 与 1,050,000 两种状态留下不同证据，才可以回答“1M 是否真的开成、是否值得给全员开”。

## 7. 真实上线与验证

在 dedicated bot token/app 与 voice room id 到位后：

1. `preflight` 校验 Codex binary/version、dedicated auth、两个 Git repo、identity/memory、Discord guild/channel/voice permissions、cwd/workspace/sensitive path 不重叠、`ps/sysctl`；并对真实 binary 跑 initialize(experimental) → ephemeral thread/start contract probe，用规范化集合断言服务端回执 cwd/network/roots/model；
2. 用两个 native `launchd` job 分别常驻 `raya brain run` 与 `raya voice run`：installer 默认把两张 plist 安装到持久的 `~/Library/LaunchAgents/`，登录或重启后由 macOS 自动重新注册；`RunAtLoad=true`、`KeepAlive={Crashed:true}`、`ThrottleInterval=60`、`WorkingDirectory=RAYA_CODEX_CWD`、stdout/stderr 指向 `data/logs/`。配置/preflight 错误固定退出码 78（`EX_CONFIG`），保留诊断但不被 `Crashed` 拉成循环；unexpected signal crash 才由 launchd 节流拉起；两者读取同一 `RAYA_*` contract，plist 不嵌 secret；当前会话以 `bootout + bootstrap` 模拟验证，真实 reboot 留待 founder 下次正常重启后由 Lead 核验；
3. 确认 bot profile 是 Raya 真图、`#raya` 存在、bot 已在 voice room；
4. founder 首次进房说一句，确认 `#raya` 出现 transcript/status，Raya 在房里发出可听语音；她留在房内时重启 voice job，确认 startup member scan 自动 prime 并恢复出声；再离房、等至少 10 分钟、二次进房，确认 session 重新 prime；期间强制一次 realtime reconnect，确认自动恢复；同一套流程由 QA trigger bot 自动跑一轮，founder 只承担最终人耳确认；
5. 运行 `metrics summary --dir`，确认 RSS、swap、context 三块都有真实样本、voice liveness 无空洞，并照实记录 effective window / 1M validity；
6. 保存脱敏命令输出、Discord 截图/消息链接和 metrics summary 到 FLY-2029 文档，不提交 token、auth 或原始长对话。

若 token 尚未 provision，代码/离线 tests/PR 继续；但不把“mock 通过”写成 live acceptance。只有 dedicated identity 的真实房间 E2E 才满足验收。

## 8. 验证矩阵

### 独立仓

- `raya` 和 `raya-memory` remote 指向各自 GitHub repo；
- `rg 'flywheel-' package.json src` 无运行依赖；
- 在没有 Flywheel checkout 的 temp HOME 做 build/test/preflight fixture。

### Raya 仓

- `pnpm lint`
- `pnpm build`
- `pnpm test`
- package audit / secret scan
- live `preflight`
- live voice loop + `metrics summary`

### Flywheel 仓

- `pnpm lint`
- `pnpm -r build`
- `pnpm test:packages:run`
- 若新增 shell harness，逐个运行

## 9. 提交与审查

1. 设计 review APPROVED 后才开始三个 worktree 的实现写入；
2. memory PR、Raya code PR 分别开 review；
3. Flywheel 当前分支提交 exploration/research/plan、verification evidence 和外部 PR 链接；
4. Codex code review 对实现 head 循环到 APPROVED；
5. Flywheel PR 最后一个 commit 新增 `engineering/doc/milestones/FLY-2029.md`，不编辑 `CLAUDE.md`；
6. 打开 PR 后以 `complete --route needs_review --pr <Flywheel PR>` 交回，不 merge、不请求 ship、不重启 Flywheel 服务。

## 10. 回滚

Raya 是新增服务，不修改既有 Flywheel runtime。回滚只需卸载 Raya 的两个 launchd job 并停止 brain/voice 进程；保留两个 Git repo、dedicated CODEX_HOME、metrics JSONL 和 memory repo，不删除试用数据。Discord `#raya` 与 bot profile 保留，除非 founder 明确要求删除。
