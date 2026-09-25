# FLY-2760 Codex Lead 模型行显示错公司/型号/effort — 探索
Issue: FLY-2760 (https://linear.app/geoforge3d/issue/FLY-2760/dashboardlead-模型行-fleet-console-把-backendcodex-app-server-的-leadmufasa)
日期: 2026-09-24
基于: 无

## 1. 问题陈述

管理台（`http://localhost:9876/`，`packages/teamlead/src/bridge/fleet-console-html.ts`）「Lead 模型」表里，
`backend: "codex-app-server"` 且 `projects.json` 没钉 `model` 的两个 Lead（growth/mufasa-lead、flywheel/codex-infra-bot-lead）
被渲染成 **Anthropic → 账户默认 → 账户默认**，运行参数栏显示「暂无受管应用证据」。

founder 2026-09-19 15:43Z 截图确认；Lead 15:33Z 已向 founder 报过这两位是「Codex high」。

## 2. 实读事实（2026-09-24，本机只读）

### 2.1 注册表 `~/.flywheel/projects.json`

| Lead | backend | model | effort | department |
|---|---|---|---|---|
| growth / mufasa-lead | codex-app-server | **缺席**（键不存在，不是 `null`） | high | growth |
| flywheel / codex-infra-bot-lead | codex-app-server | **缺席** | high | infra |
| raya / raya | codex-app-server | gpt-6-astra | high | — |

> `model` 缺席 = 「按 FLY-231 模式不归一化，absent stays absent」（`ProjectConfig.ts:150`）。页面代码里 `!lead.model` 对 `undefined`/`null` 一视同仁。

### 2.2 这两位 Lead **实际在跑什么**

三层来源逐个核过：

| 来源 | mufasa | codex-infra-bot | 说明 |
|---|---|---|---|
| launchd plist `FLYWHEEL_LEAD_MODEL` | 无 | 无 | plist 只有 `FLYWHEEL_LEAD_RULES_BUNDLE`，模型 env 由 `canonical-lead-identity.sh` 从 projects.json 投影，缺席即 `unset` |
| 隔离 CODEX_HOME `config.toml` 的 `model =` | `~/.codex-mufasa`：**无** | `~/.codex-infra-bot`：**无** | 两家只有 `[notice] hide_rate_limit_model_nudge = true`；codex-cli 0.154.0 / 0.156.1 |
| 最新 session rollout（`sessions/…/rollout-*.jsonl`，`turn_context.model`） | **gpt-6-astra / high** | **gpt-6-astra / high** | 这是线程真正生效的值，来自 Codex 二进制的内置默认 + projects.json 的 effort |
| 运行时日志 `/tmp/flywheel-lead-growth-mufasa-lead.log` | `native runtime config unavailable: bootstrap_settings_mismatch` ×N | 同 | 见 §2.4 |

结论：**真实型号 = gpt-6-astra（注册表标签「GPT-6 Astra」），真实 effort = high**。型号不在 Flywheel 任何配置文件里，只有运行中的线程知道。

### 2.3 页面为什么显示成 Anthropic / 账户默认 / 账户默认

渲染链：`buildTopologyView`（`management-topology-source.ts`）→ `ManagementLeadView.dispatch.current` → 页面 `modelControl(lead.dispatch,"lead",…,providerLocked=true,selectionNullable=true)`。

1. `currentLeadSelection(lead)`（topology-source.ts:96）：`if (!lead.model) return null;` —— **model 缺席时整个 selection 为 null，effort=high 被一起丢掉**。同一函数在 `management-existing-writers.ts:166 selectionFromLead` 有一份逐字镜像。
2. `modelControl`（fleet-console-html.ts:314）：`value` 为 null 且 `providerLocked` → `provider = catalog.providers[0]`。`buildModelCatalog("lead")` 按 `MODEL_PROVIDERS` 的对象顺序输出，**第一项永远是 anthropic** → 公司栏落到「Anthropic」。
3. 同函数 L340/L342/L345：`value` 为 null → 型号、effort 两个 `<select>` 都选中 `<option value="">账户默认</option>`。effort 下拉还因 `!model` 被 `disabled`。
4. `leadTuningEvidence(lead)`（L368）：backend 分支正确识别 codex，但 `lead.tuning` 为空（原因见 §2.4）→「暂无受管应用证据」。

所以问题不是「页面不知道 backend」，而是：**注册表投影把「没钉型号」翻译成了「什么都没有」，页面再把「什么都没有」翻译成了「第一家公司 + 账户默认」**。

### 2.4 为什么「受管应用证据」也是空的（决定了型号的可得来源）

Codex Lead 的热配置链路（FLY-2131）：`NativeLeadRuntimeConfig.bootstrap(threadId, tuning)` 在线程就绪后先 `thread/read` 读回线程当前 `{model, reasoningEffort}`，再要求它与 projects.json 的 `tuning.model/effort` 完全一致，否则抛 `bootstrap_settings_mismatch`，`ready=false`，inbox 的 `readRuntimeConfig` / `applyRuntimeConfig` 都会拒绝（`runtime_hot_config_unsupported`）。

- 对未钉型号的 Lead，`tuning.model` 为 `undefined` → **必然** mismatch → 永远没有 `LeadConfigOperation`，`tuningByLead` 为空。
- 但注意：runtime 在抛错**之前已经拿到了真实 pair**（`pair = readThreadSettings(threadId)`），只是没有落盘、没有对外暴露。这是本设计里「真实型号」最短的可得路径。

### 2.5 Bridge 侧现有能不能拿到真实型号

| 途径 | 可行性 |
|---|---|
| `LeadConfigView.actual`（inbox `readRuntimeConfig`） | 需要一个已存在的 operation target（operationId / configDigest / threadId），未钉 Lead 没有；且 runtime `isSupported()` 为 false，会拒绝 |
| 运行时 manifest（`fleet-data.readCarrier` 的 `manifestModel`） | manifest 只有 Claude v2 载体写；Codex Lead 无 manifest |
| Bridge 直接读 rollout（`readLeadTurnEvidence`） | 需要 `codexHome` + 线程的 rollout 路径；`CODEX_HOME=~/.codex-<homeKey>` 的 homeKey 只在 launcher 脚本里，注册表不含；rollout 内容含模型输出，是「模型可影响」的数据 |
| 读 `config.toml` 的 `model =` | 当前两家都没有这一行；即便有，也只是「配置值」不是「线程生效值」 |

**没有任何 Bridge 现成读路径能得到 gpt-6-astra。** 要么加一条 runtime → Bridge 的证据通道，要么诚实显示「未钉型号」。

## 3. 相关方与消费者

- **founder**：看管理台判断每位 Lead 在用哪家/哪型/多大 effort；截图是唯一验收。
- **Eng Lead（Tadashi）**：15:33Z 已报「Codex high」，页面与口径不一致。
- 消费 `ManagementLeadView` 的代码：`fleet-console-html.ts`（渲染）、`management-console-dom.test.ts` / `fleet-console-html.test.ts` / `management-topology-source.test.ts`（测试）、`management-existing-writers.ts`（写路径用镜像函数 `selectionFromLead`）。
- 消费 `leadTuningWriteCapability` 的代码：topology-source（读）、existing-writers `resolveLeadTarget`（写）。
- 消费 Codex Lead state dir 的代码：`lead-config-runtime-adapter.ts`（`resolveCodexLeadStateDir`）、`fleet-data.ts`（`readCarrier` 只读 Flywheel state）。

## 4. 约束（founder / 项目规则）

1. **不按 Lead 名字特判**；只按 `backend` 通用处理（founder 原则）。
2. 页面顶部「当前显示配置值；实际生效以进程验收为准」保留。
3. UI 不硬编码资格规则：能力位由服务端派生（FLY-247 inc2a 原则）。
4. 一个真源，不镜像词表（`currentLeadSelection` 与 `selectionFromLead` 目前就是镜像）。
5. `dispatch.current` 是写路径的比对基准（`updateDraft` 用它判「有没有改」）：**不能为了显示把 `current` 伪造成一个注册表里并不存在的钉定值**，否则 UI 会把「用户没改」和「注册表没钉」混为一谈。
6. 页面 JS 通过字符串拼接进 `<script>`，测试用 happy-dom `Function(script)()` 执行；改 `modelControl` 签名要兼顾 `fleet-console-html.test.ts` 里用 `runInNewContext` 单独抠 `renderLeadRows` 的测试。

## 5. 设计选项

### 选项 A：只改 Bridge 投影 + 页面（配置值诚实化）
- backend=codex-app-server → 公司固定 OpenAI（由 `MODEL_PROVIDERS.openai.label` 取，不在 UI 写死）。
- effort 直接投影注册表的 `effort`（与 model 是否钉定无关）。
- 型号未钉 → 显示「Codex 默认 · 未钉型号」而不是「账户默认」。
- 若 `tuning.actual/observed` 有值（已钉 Lead）继续沿用。
- 优点：改动全在 Bridge，重启 Bridge 即生效；零跨进程协议。
- 缺点：**看不到 gpt-6-astra**；与 issue「型号读该 Lead 实际生效的 Codex 型号」只满足一半。

### 选项 B：A + 运行时线程设置证据文件（推荐）
- runtime 侧 `NativeLeadRuntimeConfig` 在 `bootstrap()` 拿到 `thread/read` 的 pair 后（不管随后是否 mismatch）原子写 `<stateDir>/thread-settings.json`；每个 `turn/completed` 再读一次线程设置并在变化时改写（覆盖 founder 在 TUI 里 `/model` 手改的漂移）。
- Bridge `fleet-data` 新增一枚只读传感器读这个文件（大小上限、O_NOFOLLOW、schema 校验、与 `<stateDir>/thread-id` 比对防陈旧），投影为 `ManagementLeadView.runtimeSettings`。
- 页面：型号未钉且有 `runtimeSettings` → 显示「运行中 · GPT-6 Astra · 未钉」并标注观察时间；没有 → 退回 A 的「Codex 默认 · 未钉型号」。
- 优点：真实型号来自线程本身（与 rollout 里的 `turn_context.model` 同一事实），不读模型可控数据，不需要 inbox 新协议、不需要凭据。
- 缺点：**要等 Lead 进程用新 build 重启**才会有文件；在那之前 mufasa / codex-infra-bot 显示 A 的诚实占位。这是部署边界，不是设计缺陷，必须写进页面与验收。

### 选项 C：inbox 新增免 operation 的 `readThreadSettings` 方法，Bridge 轮询
- 优点：实时。
- 缺点：新增 socket 方法 + 鉴权 + 每次轮询对每位 Codex Lead 发一次 RPC；同样要等 Lead 重启才支持；比 B 多一整层协议面。**否决**。

### 选项 D：Bridge 直接读 rollout
- 否决：需要 launcher 私有的 homeKey，且读的是模型可影响的数据文件（已有 `readLeadTurnEvidence` 也只在 runtime 进程内、且要 app-server 给路径）。

### 选项 E：在 projects.json 给两位 Lead 钉上 `model: "gpt-6-astra"`
- 这是运营动作不是代码修复；且会让页面「碰巧对」——下一次 Codex 默认升级时又错。可以作为 founder 的后续运营选项（钉定后热配置也能接管），但不替代本单。

## 6. 推荐

**选项 B**，分两层交付于同一 PR：
- 层 1（Bridge 投影 + 页面）：Bridge 重启即修正公司/effort/占位文案；单元测试可完全覆盖。
- 层 2（runtime 证据文件 + Bridge 传感器）：Lead 下次重启后显示真实型号；页面在文件缺席时明确写「等待运行时证据（Lead 需用新版本重启）」。

同时把 `currentLeadSelection` / `selectionFromLead` 合并为一个导出函数，消灭镜像词表。

## 7. 待 Lead 裁定 / 非阻塞问题

1. **未钉型号 Codex Lead 的写能力**：现状 `leadTuningWriteCapability(codex, hot=true)` 报可写，但 runtime 对未钉 Lead 必然 `runtime_hot_config_unsupported`，stage 一定失败。设计拟改为服务端规则：codex 且未钉 → 只读 + 原因「先在 projects.json 钉型号（受控迁移）」。是否同意把这条能力位收窄？（非阻塞，默认按只读做。）
2. 层 2 的 runtime 改动会进 `codex-lead-runtime.ts` / `codex-lead-tui-runtime.ts` 共用的 `NativeLeadRuntimeConfig`；不需要 Lead 立即重启，等 updater 班车即可。是否接受「重启前页面显示诚实占位」的边界？（非阻塞，默认接受。）

## 8. 非目标

- 不改 `projects.json`、不重启任何 Lead、不改 launcher / plist。
- 不动 Runner 默认、DAG 节点、Cron 的模型行。
- 不修 `policyCatalog` 里内联的 `"anthropic"?"Anthropic":"OpenAI"` 标签镜像（workflow 面，另开单）。
- 不做跨厂商切换 UI（FLY-2459 受控迁移仍是唯一路径）。
