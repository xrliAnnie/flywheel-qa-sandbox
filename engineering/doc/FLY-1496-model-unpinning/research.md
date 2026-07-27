# FLY-1496 模型解钉根治 — 调研

Issue: FLY-1496 (https://linear.app/geoforge3d/issue/FLY-1496/v2批次0-模型解钉根治-别名表配置化-manifest-实时派生-mid-session-漂移调查-难度选型禁-opus-48)
日期: 2026-07-27
基于: exploration.md

Brainstorm gate 已过(Tadashi 批方案 A + Q1-Q4 拍板,含 Q4 细分:派发路径 fail-loud 400 / Lead boot 路径替换内建默认+告警不 brick fleet)。本文核实 exploration 遗留的事实问题。

## R1. S1 假设实证 — ✅ 铁证

Lead launcher 日志在 `/tmp/flywheel-lead-<project>-<lead>.log`(flywheel-daemon.sh `log_path()` :102-105,plist StandardOut/ErrorPath 实测确认)。

**事故夜时间线**(`/tmp/flywheel-lead-flywheel-flywheel-eng-lead.log`,2026-07-26 晚):

```
20:43:41 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
21:30:35 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
21:45:50 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
22:03:15 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
22:13:37 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
23:27:32 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
23:57:52 model drift: env=claude-fable-5 manifest=claude-opus-4-8[1m] → using manifest
```

一晚 **7 次重启**,每次 manifest(旧值 opus-4-8[1m])压过 env(fable)。与 Annie「一晚三次手动 /model 拨回」完全对上:她在 session 里拨回 → Lead 因故重启(launchd KeepAlive / 重启波次)→ manifest 再压回。**「mid-session 漂移」的主体感来源就是 S1,不需要额外的会话内降级机制来解释。**

**止血后的现状(仍带病)**:止血把 manifest 改成了裸档位别名,最新日志(07-26 16:15 / 07-27 00:41 / 06:03 三个重启波次):

```
eng-lead:        model drift: env=claude-fable-5  manifest=fable  → using manifest
rafiki-lead:     model drift: env=claude-sonnet-5 manifest=sonnet → using manifest
belle-lead:      model drift: env=claude-sonnet-5 manifest=sonnet → using manifest
tidal-echo-cos:  model drift: env=claude-sonnet-5 manifest=sonnet → using manifest
```

即 **FLY-1485 latent HIGH 已经是生产活体**:manifest 值不经 registry 解析 raw append(`claude-lead.sh:1575-1585`),裸 `sonnet`/`fable` 直达 claude CLI,由 CLI 自己的别名表定版本——版本控制权已漏出 registry。方案 A(manifest 只写不读)一并根治。

## R2. fleet apply/rollback 与 projects.json 一致性 — ✅ 兼容方案 A

- `flywheel-fleet.sh:53` `PROJECTS_JSON=~/.flywheel/projects.json` 为 SSOT;`:71` 检测 `FLYWHEEL_PROJECTS` env 分裂脑并拒跑。
- 批量引擎 `fleet_batch_apply "$cf" "$PROJECTS_JSON"`(`:628`)**写 projects.json 本身**(FLY-247 inc2a:config-write flock + write-ahead journal);快照 CAS(`:776`、`:918`)防 apply 中途配置漂移。
- **更正(Codex design review R1#1 实读代码证伪本节初稿)**:显式 rollback(`flywheel-fleet.sh:1280-1297`)只还原 manifest+plist,**不还原 projects.json**——launcher 改读 projects.json 后,"成功回滚"会以 post-apply 值起 Lead 并把还原后的 manifest 重写掉。方案 A 必须**扩展 rollback 同事务还原 projects.json 的 model/effort**(config-lock + per-key CAS + journal 阶段),plan §2.4 落。
- **等值/恢复语义约束(R1#2)**:fleet 等值比对(`:251-270`)与中断事务 recovery 的语义投影(`:448-469`、`:1574-1608`)按**原始拼写**逐字比 manifest.model/effort——launcher 若把 canonical 值写回 `model` 字段会永久 APPLICABLE / recovery fail-closed。方案 A 因此让 manifest 的 `model`/`effort` 保持 projects.json 原始拼写,canonical 实际值写**加性新字段** `resolvedModel`/`resolvedEffort`(fleet 忽略),两侧语义字节不变。
- staged manifest 写(`:946-953`)保留(desired evidence 快照);boot 后被同拼写+resolved 字段覆盖,不再被读作输入。

## R3. EdgeWorker 遗留链(S2)生产可达性 — ❌ 不可达(豁免候选)

- `new EdgeWorker` 仅出现在 `packages/edge-worker/test/**` 与 `examples/**`;生产 Bridge(`plugin.ts:61-62`)只 import `WorktreeManager` 和类型。
- 生产 runner spawn 全走 Bridge run-infra → role-adapter-resolver → TmuxAdapter(`--model` 唯一模型注入点,`TmuxAdapter.ts:856`)。
- 结论:`RunnerSelectionService.ts` / `ClaudeRunner.ts` 是**当前 Bridge 生产不可达代码**。最初倾向仅记录豁免；实施阶段因 founder 最终要求 Sonnet/Haiku 不得成为任何默认档，仍把主模型默认改为 Fable、fallback 默认改为 Opus 5 别名，并在最终 SDK 缝对主模型和整条 fallback 链执行中央 canonical/ban 守卫，防止遗留 lane 未来复活时绕过政策。

## R4. claude CLI 自身的 fallback 面

- `claude --help` 实测:存在 `--fallback-model <model>`("Enable automatic fallback to specified model(s) when the default model is [unavailable]")。
- **Flywheel 全链没有任何地方传 `--fallback-model`**(grep claude-lead.sh / TmuxAdapter / cron writer 均无)→ CLI 旗标驱动的自动降级在生产不存在。
- 剩余 CLI 内部行为(交互 TUI 撞限额时的提示/切换、账号默认模型)属外部面:所有 Flywheel 派发都显式传 `--model`(runner 默认 FLY-751 强注 `claude-fable-5`,Lead 走 manifest/env 链),本机主 `~/.claude/settings.json` 实测 `model: claude-fable-5[1m]`。账号池各 CLAUDE_CONFIG_DIR 的 settings 差异 + 撞限额 TUI 行为列入 drift-report 的「外部面」段:实施时逐账号核对 settings.json 并统一,ban 无法覆盖 CLI 内部逻辑 → 记豁免 + 缓解措施(显式 --model 全覆盖 + 账号 settings 统一 + quota daemon 切号)。

## R5. 改动点清单素材(module-level 常量消费面)

`packages/config` 模块级常量(`MODEL_REGISTRY` / `MODEL_LOOKUP` / `DISPATCH_MODEL_LOOKUP` / `MODEL_TIERS` / `DEFAULT_OPUS*`)非测试消费文件(grep 实测,19 文件):

- config 包内:`model-tiers.ts`, `runner-label.ts`, `three-stage-phases.ts`, `ConfigLoader.ts`, `runner-config-writer.ts`, `model-display.ts`, `index.ts`(re-export 面)
- teamlead:`workflow-menu.ts`, `workflow-template.ts`;bridge:`runs-route.ts`, `role-adapter-resolver.ts`, `fleet-console.ts`, `fleet-capabilities.ts`, `retry-dispatcher.ts`, `workflow-menu-routes.ts`, `management-dag-source.ts`, `management-dag-writer.ts`, `management-cron-source.ts`, `management-cron-writer.ts`, `management-topology-source.ts`, `management-ssot-providers.ts`, `management-existing-writers.ts`, `claude-review-runner.ts`
- 其他:`gemini-agent/src/config.ts`, `gemini-agent/src/index.ts`
- shell 边界:`claude-lead.sh:2295-2304`(经 dist 调 `normalizeDispatchModel`——天然每 boot 新读,只要函数内部改为热读配置即免改)

## R6. 难度档→Codex 的接线(Q1 已裁掉)

Tadashi 拍板 Codex 不进难度档(vendor 边界归 executor-routing 层)→ `role-adapter-resolver.ts:210-215` 的「dispatchModel 无 vendor 强制 claude-tmux」**无需改动**。tiers 配置校验规则:tier 目标必须是 runtimeVendor=claude 的 registry 条目(排除 codex 条目,fail loud)。

## R7. 重启触发源(S1 的放大器,非模型变更源)

三个重启波次(16:15 / 00:41 / 06:03)为 fleet 级统一重启(restart-services);另有 KeepAlive 崩溃重启(06:03:02 与 06:03:32 相隔 30 秒两次 boot,`Manifest written` banner 连发)。quota daemon 账号切换是否重启 Lead 未见直接证据(`account-switch-route.ts` 无 bootout/launchctl 调用)——重启触发器分类不影响根治设计(任何重启都走同一 boot 解析链),实施阶段 drift-report 里给一句归类即可,不再深挖。

## 结论 → plan 输入

> Founder 2026-07-27 最终映射覆盖本调研阶段的初始建议:generic tiers 为 heavy=Fable、medium/light/trivial=Opus 5;Sonnet/Haiku 不作默认档。三段式 design=Fable、implement=Codex、QA=Opus 5 的完整行也进入同一热配置。以下根治结论不变。

1. 方案 A 铁证充分、与 fleet 事务兼容,照 gate 批准落。
2. 别名表配置化落 `~/.flywheel/models.json`(bindings/models/tiers/phases/banned 五段 overlay + 内建默认 fail-safe + mtime 热读函数化),消费面按 R5 清单迁移。
3. ban 双态:派发边界 400 fail-loud;Lead boot 替换内建默认(fable)+ 响亮告警。
4. drift-report(实施阶段交付)骨架已定:S1 实证(本文 R1)、S2 豁免(R3)、CLI 外部面豁免+缓解(R4)、S4/S5/S6 审计 + ban 校验点、S7 随方案 A 消失、重启触发器归类(R7)。
