# FLY-2238 Fable 单旋钮与自动更新 — 调研
Issue: FLY-2238 (https://linear.app/geoforge3d/issue/FLY-2238/模型-fable-全面升级-51builtin-aliasrunner-defaultconfigyaml模板-revision)
日期: 2026-09-01
基于: exploration.md

## 1. Registry authority 的可演进形状

`model-builtins.ts` 当前同时承载 canonical identities、aliases、surface/effort 和 builtin tiers。Founder 裁定：repo builtin 固定今天同步出的 5.1，只是 overlay 缺席时的 fallback；未来升级由 `~/.flywheel/models.json` authority 完成，不再提交代码换版本。

需要同时解决两类 overlay：

1. **今天的 same-id overlay**：configured 5.1 entry整条替换 builtin 5.1，会丢 `fable` aliases，也会丢新加而 overlay尚未声明的 `contextWindowTokens`。`mergeModels()` 应对相同 canonical id做 base-first alias union，并保留 overlay未显式提供的 optional builtin metadata；overlay显式提供的合法 metadata及其他 configured fields仍覆盖，最后继续跑 collision validation。
2. **未来的新 id overlay**：builtin 5.1 已占 `fable`，直接让 5.2 entry 声明同 alias 会触发跨 id collision，整段 models overlay 被 fail-safe 拒绝。应把 family alias ownership 放进既有 `bindings` authority：`bindings.fable` 指向当代 canonical base id；apply bindings 时先从所有条目移除 reserved family aliases，再把它们挂到目标 base 及其已注册 `[1m]` 变体。Updater 写新 model entries 与一处 binding，tier 保存 `fable`，不在 consumer 再写版本。

旧 `claude-fable-5` / `[1m]` 复用 Opus 4.8 的 legacy 先例：保留 registry/dispatch lookup，但 `selectableSurfaces=[]`，无 family alias、无 tier。已经 pin 的 run 可继续启动，新选择不会回到旧版本。

公开 seam：`getModelConfigSnapshot()`。测试用临时 models file 覆盖无 overlay、same-id overlay、future-id binding、跨 id collision、malformed segment 与 legacy dispatch。

## 2. Consumer alias 与 runner argv

`resolveRoleAdapter()` 在每次 decision 开头抓一份 immutable model snapshot，并在出口调用 `resolveAllowedCanonicalModel`。所以 `RUNNER_DEFAULT_MODEL` 应引用新的稳定 `MODEL_ALIASES.FABLE`（或等价 exported family alias），而不是 `MODEL_IDS.FABLE`；`.flywheel/config.yaml` 也保存 `fable`。两者最终仍在 spawn 前得到 canonical 5.1。

`ConfigLoader` 已拒绝 model 首尾空白；无需改变 schema。应更新附近注释为“配置存 alias、resolver 输出 CLI-native canonical”，不能留下“YAML 必须写 full id”的错误说明。

公开 seam：真实 repo `.flywheel/config.yaml` → `ConfigLoader` → `resolveRoleAdapter` → Claude runner launch argv。测试只 fake tmux/process 系统边界，断言唯一 `--model` 后值为当前 canonical；未知 alias 在 spawn 前 fail-loud。

## 3. Template alias 与 immutable run

`validateWorkflowManifest()` 有两种既有模式：

- normal：调用 `canonicalWorkflowModel()`，验证 registry/surface/effort 并返回 canonical id；
- `allowUnsupportedModels: true`：只保留 raw model spelling，用于 repair/governed authoring 后仍能保存其他 retired selections。

`createAndPublishWorkflowTemplateRevision()` 已支持后者，并在一次 CAS transaction 中追加 revision、publication、create/publish audit 后移动 pointer。当前真正破坏 alias 的不是 schema，而是 management writer：`parseSelection()` 返回 `entry.id`，`applyManagementDagEdit()` 又写 `registered.id`。

最窄修复只改变 workflow DAG writer：验证仍基于一次 model snapshot，但 prepared change 与 manifest 保存 trim 后的调用者 spelling（`fable`）；management projection 也回显 persisted spelling，避免 alias revision 每次都被误判为 canonical→alias change。Lead/runner/cron writers 的现有 canonical storage 不随本单扩大。

`materializeWorkflowRun()` 读取 published manifest 后调用 normal validator，但 schema-v2 validator不会像v1一样调用 `canonicalWorkflowModel()`，而是保留 raw node spelling；`buildWorkflowRunSnapshotV2()` 也直接复制。仅加 `dispatchPinned`会把 `fable` pin进 snapshot，spawn仍会对 live registry重新解析。真正的唯一边界必须显式实现为：捕获一次 model snapshot，用它把每个v2 executable node解析成 workflow-surface canonical manifest bytes，再构建 pinned snapshot。`resolveNodeDispatchAtLaunch()` 的 deliberate path另记 `pinned_snapshot`，真实失败才叫 `snapshot_fallback`。旧 snapshot缺 bit时继续现有 legacy live-template path，不 retroactively改历史语义。

Blanket pin还有产品 consequence：management console已宣称 template edit是 `new-run`，pinning使实现终于匹配承诺，但同时结束“republish后热修进行中run”的旧隐式行为。进行中载体遇到坏模型必须重启/重铸；该变化要进 UI copy、test与PR handoff。

## 4. Live template 范围与 publication 顺序

2026-09-01 Bridge read model：

| template | current | design node | persisted model | status |
|---|---:|---|---|---|
| `tpl_code` | 9 | `eng_design` | `claude-fable-5` | live/global |
| `tpl_eng_heavy` | 5 | `design` | `claude-fable-5` | retired/unbound |

Founder 已裁定 `tpl_eng_heavy` 直接出范围：不铸 revision、不做 boot migration、不启动第二个 StateStore 进程。

`tpl_code` 必须走 `/api/fleet/changes/stage|apply` 对应的 management CAS writer，并回读 revision/publication/audit。当前生产 writer 会 canonicalize alias，而 implement node 禁止 deploy/restart，因此持久化 alias 的 mutation 必须在新 writer 部署后由同一 live owner执行；绝不能为了“本节点当场写完”绕过治理面。Lead 已选择 post-deploy 方案 A：PR交付新 writer 与幂等一行命令；merge + shuttle deploy后由 Lead执行 publication，验证 persisted alias和新 run snapshot后，issue才算 complete。

HTTP guard要求 stage/apply 请求来自 loopback并带与请求 Host匹配的 `Origin`/`Referer`。因此 operator CLI应从 `FLYWHEEL_BRIDGE_URL`、`BRIDGE_URL` 或 `TEAMLEAD_PORT`解析 base，只接受 loopback，显式设置 `Origin: base.origin`；缺 header 的真实 HTTP harness应得到403。首次由 management actor发布 seed-owned template会按既有合同把 `seed_owner` 改成 `founder`，后续 seed auto-update停止。这是选定治理 lane的必然后果，必须在命令 readback与 PR handoff中明示，不能绕过或静默。

## 5. Auto-latest：复用 shuttle，不加常驻机制

Anthropic 官方 [List Models](https://platform.claude.com/docs/en/api/models/list) 说明 `GET /v1/models`列出可用模型、较新模型在前、单页最多1000，并返回 `id` / `created_at` / `max_input_tokens`；后者是该模型最大输入窗口。官方 cURL文档展示API key。本机2026-09-01又用现有 `readKeychainMonitorCredential()`等价的 subscription OAuth header做脱敏实探，HTTP 200；只输出 public model fields后得到：`claude-fable-5-1`与`claude-fable-5`均为 `max_input_tokens=1000000`、`max_tokens=128000`、`type=model`。因此 List endpoint与现有 credential确实发出本设计依赖的 window signal，而非只在 per-id endpoint或文档schema中存在。

选择算法不能仅信排序或字符串：

1. response 必须为 2xx、JSON object、`data` array；
2. 只收 exact `^claude-fable-(\d+(?:-\d+)*)$`，天然排除 `[1m]` 和未知 suffix；
3. 把版本段转为非负安全整数数组，逐段比较并补零；例如 `[5,10] > [5,9]`；
4. candidate 必须严格高于当前 authority 才算升级，永不自动 downgrade；同版本只允许把旧文件规范化为 binding/alias shape；
5. candidate的 `max_input_tokens`必须是正 safe integer；为新 base与 synthetic `[1m]` entry写入该 `contextWindowTokens`并显式 `dispatch:true`，保留所有旧 entries；`bindings.fable`只有在base/1M全都合法时才成对切换，`tiers.heavy`写 `fable`。API不给可信窗口时不自动切换。

现有 `scripts/update-flywheel.sh` 已有 singleton lock、00/12 schedule 和 urgent invocation，适合在 `update_main()` 持锁后调用一次 compiled one-shot sync CLI。CLI 复用 Keychain reader、bounded fetch 和既有 `lead-alert.sh`/alert contracts；没有自己的 timer/daemon/retry loop。结果分类：

- `updated`：atomic write 成功且 canonical 真前进，发一次 informational notification；
- `normalized` / `unchanged`：不通知；
- credential missing/expired、401/403/429/5xx、timeout、malformed response、unsafe/malformed file、write error：记录脱敏状态，保留旧文件，返回 non-blocking，shuttle 继续。

安全写入需要验证 authority path 是 owner-owned regular file、非 symlink、0600；同目录新建0600 temp，完整写入 + fsync后 atomic rename，并 fsync directory。rename后必须让真实 `getModelConfigSnapshot()` fresh reload并验证 `fable` dispatch与 heavy都指向 candidate。若 registry fail-safe丢弃新 segment，用相同安全协议恢复先前 bytes，再 fresh reload证明旧 resolution恢复；只有此后才返回 verification failure。失败注入测试证明不留下坏 authority或宽权限 residue。

## 6. Notification 复用

成功升级应使用现有 Lead alert delivery/claims/dedup 层，不直接 curl Discord。增加一个 truthful informational kind（例如 `model_family_updated`）到现有 TS union、shell allowlist、informational set、kind contract/copy；CLI 通过 `lead-alert.sh` 发 public old/new ids 与 source=`anthropic_models_api`，不带 credential、account PII 或 response body。事件 signature 绑定 family + old + new，因此一次版本跃迁只送一条，重复 shuttle 自动 dedup/no-op。

## 7. 隐藏的 current-Fable consumers

评审追踪发现版本依赖不只在 resolver/YAML：

- `resolveLeadLaunchSelection()`、fleet console和 model-policy null/default path从 `MODEL_IDS.FABLE`取 fallback，未来必须从同一 snapshot family binding取值；
- `flywheel-fleet.sh`、`claude-lead.sh` 与 `lead-session-resume-gate.sh`仍含旧 full-id fallback/精确分支。fleet可通过validator读 snapshot；但 Lead resolver-unavailable通常就是dist缺失，不能依赖相同 config dist。应在每次正常 resolve后用 dependency-free helper原子保存 last-good canonical/window receipt到 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/lead-model-authority.json`；退化时 `_lead_session_model_from_decision`与launcher读取同一 receipt generation，不能一边用旧 literal、一边用新 canonical。Resume window只读匹配模型的 API-derived metadata；缺失/不匹配继续 unknown/park，不做 family猜测；
- token pricing与 HTML label/color按旧 exact id map，5.1会被记为 unknown/$0。保持 `Record<string, ModelRate>`，允许保留 exact entries并新增 reserved `claude-fable-*` rate key。Founder确认5.1与5同价，所以两者精确内建；未来 family fallback沿用10/50时必须 warn-once，提醒 operator通过同一 pricing JSON覆写 exact/family rate，不能静默假定永久同价；

这些 seam必须用 hermetic `FLYWHEEL_MODELS_CONFIG`并 reset snapshot cache，不能读会被 shuttle更新的 ambient home authority。

## 8. TDD seams（已由重定向摘要评审确认）

- **Registry seam**：snapshot resolution/selection/legacy/collision；
- **Runner seam**：repo config 到真实 launch argv；
- **Workflow authoring seam**：management CAS publication/readback；
- **Run seam**：materialized immutable snapshot + real launch resolution before/after authority change；
- **Degraded launch seam**：good resolve写 last-good receipt；移除两个 dist seam后仍读 canonical/window，无/坏 receipt fail-loud；
- **Sync seam**：one-shot orchestration，mock 仅限 Anthropic fetch、Keychain、filesystem failure 与 notification process boundary；
- **Shuttle seam**：已有 updater shell test 断言每 invocation 一次、sync failure 不抑制既有 launchd/fetch/deploy cycle。

每次严格单个 failing spec → 最小实现 → green；不先横向铺完所有测试。预期值使用 founder contract 的 literal ids/manifest，不用实现逻辑重新计算。
