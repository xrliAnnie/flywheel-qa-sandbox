# FLY-2238 Fable 单旋钮与自动更新 — 探索
Issue: FLY-2238 (https://linear.app/geoforge3d/issue/FLY-2238/模型-fable-全面升级-51builtin-aliasrunner-defaultconfigyaml模板-revision)
日期: 2026-09-01
基于: 无

## Founder 改向后的目标

版本数字只存在于模型注册 authority；所有会“跟随当前 Fable”的消费层只保存 family alias `fable`，在真正创建不可变执行载体时才解析一次 canonical id。今天的 `claude-fable-5-1` 是自动同步得到的当前值，不应再成为 resolver、项目 YAML 或 workflow template 的新散点 pin。

目标状态：

- repo builtin 注册今天的 `claude-fable-5-1` / `[1m]`，只作 `models.json` 缺席或失效时的代码级兜底；旧 Fable 5 ids 继续 legacy-accepted；
- `RUNNER_DEFAULT_MODEL`、`.flywheel/config.yaml` 与 live `tpl_code` design node 保存 `fable`；
- run materialization 是 alias 的唯一解析边界；所有新 schema-v2 executable node 都写 `dispatchPinned` receipt，snapshot 保存当时 canonical id，run 中途永不重解析；
- 复用已有 00:00 / 12:00 updater shuttle 做一次 Anthropic Models API 同步，不新增 daemon、timer 或告警层；
- API/credential/file 任一失败都保留现值，绝不阻塞 shuttle/deploy；只有成功升级 authority 才经既有通知管线发一条消息。

## 已核事实

- `packages/config/src/model-builtins.ts` 仍把 `MODEL_IDS.FABLE` 定义为 `claude-fable-5`，builtin alias `fable` 因 collision guard 抢不过同名 overlay。
- `~/.flywheel/models.json` 已由 Founder 注册 5.1 base/1M 与 heavy tier，但同-id overlay 会整条替换 builtin entry，导致 builtin `fable` aliases 丢失。
- 同一 live overlay也没有 `contextWindowTokens`；same-id merge必须保留 overlay未显式覆盖的 builtin optional metadata，否则新 resume/receipt机制会在生产形状上失效。
- `role-adapter-resolver.ts` 的 fallback 仍硬编码旧 full id；`.flywheel/config.yaml` 的 runner role 也保存旧 full id。
- template validator 在正常校验时会把 alias canonicalize；`allowUnsupportedModels: true` 的 governed authoring lane 可以保留 raw alias。`materializeWorkflowRun()` 会重新用 live registry 正常校验，再把 canonical manifest 和 resolved dispatch 写入不可变 snapshot。
- management writer 当前会在 `parseSelection()` 与 `applyManagementDagEdit()` 两处把 alias 改回 `entry.id`，所以需要让 workflow authoring 保留调用者的受验证 spelling。
- `resolveNodeDispatchAtLaunch()` 对没有 `dispatchPinned` 的 snapshot 会重读 live template；目前普通 `tpl_code` node 没有该 bit。新 schema-v2 run 必须把所有 executable node pin 入 snapshot，旧 snapshot 则保留 legacy live-template 行为，避免 retroactive 语义变化。
- 生产只剩 `tpl_code@9` 是 live Fable pin；`tpl_eng_heavy@5` 已 retired 且无 binding，Founder 明确裁定不迁、不 boot migrate、不启动第二个 StateStore owner。
- Anthropic 官方 Models API 是 `GET /v1/models`，结果按发布时间新到旧排列并带 `created_at`。2026-09-01 的脱敏真实探针复用现有 Keychain subscription OAuth，返回 HTTP 200；`claude-fable-5-1`、`claude-fable-5` 都携带 `max_input_tokens:1000000` 与 `max_tokens:128000`。
- 官方 `ModelInfo` 还提供 `max_input_tokens`；future Fable 的 resume window应随同步写进 registry，不能把 Fable 5 的QA测量外推到未知版本。
- configured model 未显式 `dispatch: true` 时不会进入 dispatch lookup；自动同步生成的 base/1M 必须显式开放 dispatch surface，否则 family alias 与 heavy tier 都会 fail-safe 回退。
- Lead resume window、fleet/Lead shell fallback、token pricing 与 HTML label/color 仍按旧 full id 分支；它们也是 current-Fable consumer，必须改成 numeric family-aware 逻辑，不能把下一次升级留成隐藏代码改动。
- Bridge management stage/apply 要求 loopback same-origin header；publication CLI 必须从环境解析 base、拒绝非 loopback并设置匹配的 `Origin`。首次从 seed revision 走 management publication 会把 `seed_owner` 变成 `founder`，需要作为治理 consequence 明示和验收。
- schema-v2 validator当前保留 raw node model，`dispatchPinned`本身不会 canonicalize；materialization必须先用同一个 captured snapshot把每个 executable node改成 canonical bytes，再标 pin。
- `claude-lead.sh` 的 resolver-unavailable恰逢 compiled dist缺失，不能再调用另一个依赖 config dist的命令。正常 resolve后必须在既有 `${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}` root留下 version-free、owner-only last-good authority receipt，退化时 gate与launcher读取同一 generation。

## 锁定范围

1. Fable 5.1 builtin fallback、Fable 5 legacy identities、family binding 与 same-id overlay alias 保留；
2. resolver/YAML/template consumer 改存 `fable`；
3. workflow authoring 保留 alias、materialization 单次解析并为所有新 schema-v2 executable node pin snapshot；
4. 复用 updater shuttle 的 bounded one-shot sync、原子 `models.json` 写入与既有 notification route；
5. 只迁 live `tpl_code`，明确排除 retired `tpl_eng_heavy`；
6. Lead/session/fleet fallback、token pricing与可视化全部按 Fable family工作；
7. 聚焦 TDD、全仓 gates、结构化 code review 与 PR。

不改历史 run/snapshot、历史 template revision、token history、Lead runtime 配置、服务生命周期或 deployment ownership；不新增常驻 watcher，不自动重写运行中的载体。

## 验收判据

- 无 overlay 时 `fable → claude-fable-5-1`；旧 `claude-fable-5` / `[1m]` 仍 accepted、dispatchable、non-selectable。
- 当前 same-id overlay 不丢 `fable` / `fable-1m` aliases；未来新 Fable overlay 可由 family binding 接管 aliases，跨 id collision guard 仍有效。
- self-hosting config 保存 `fable`，新 runner argv 为 `--model claude-fable-5-1`。
- governed `tpl_code` revision 保存 `model: fable`；新 run snapshot 保存 `claude-fable-5-1`，旧 run 不漂移。
- updater 每次既有 invocation 最多 probe 一次；版本按数值段单调比较，5.10 高于 5.9；新 entry 显式 dispatch；任何写后验证失败都原子恢复原文件与现行 resolution；成功变更只通知一次。
- 新 schema-v2 run 的实际 node launch在 authority 或 published template变化后仍使用 materialized canonical；旧 snapshot语义不变。
- Lead resume从 API-derived context metadata决策；dist退化从 last-good receipt启动；pricing和报告渲染能处理未来 numeric Fable ids，无逐版本 consumer literal。
- `tpl_eng_heavy` current revision 与 retired 状态不变。

## 安全护栏

- OAuth token 只在现有 Keychain credential reader 与请求 header 中短暂存在，不进 argv、stdout、日志或 models file。
- `models.json` 必须拒绝 symlink/异常 owner 或 mode，以同目录 0600 临时文件、flush、atomic rename 更新；任何解析/写入或写后 registry 验证失败都用相同协议恢复旧 authority。
- API 只接受精确 `claude-fable-<数字段>` base id，排除 `[1m]`/未知 suffix；选择逻辑显式逐段数值比较，不信任字符串排序。
- 模板 mutation 只走 Bridge-owned management CAS/publication/audit 面；operator CLI 只连 loopback并提供 same-origin header，不裸 SQL、不并发打开 production DB、不临时 unretire/rebind 模板；publication 的 `seed_owner=founder` consequence 必须读回并报告。
