# FLY-2394 Raya Astra 配置 — 实施证据
Issue: FLY-2394 (https://linear.app/geoforge3d/issue/FLY-2394/raya模型-切到-gpt-6-astragpt-6-astra把写死的-raya-model-常量改为可配置默认-astra并验证)
日期: 2026-09-06
基于: plan.md

## 实施结果

- Raya 的 Codex session policy 现在由 `RAYA_CODEX_MODEL`、`RAYA_CODEX_REASONING_EFFORT`、`RAYA_CODEX_CONTEXT_WINDOW` 配置，默认分别为 `gpt-6-astra`、`xhigh`、`1050000`。
- contracts、brain、voice 和 C0 probe 共用同一个解析器；非法 model、reasoning effort 或 context window 会在启动前失败。
- thread start/resume 与 receipt downgrade guard 使用同一份已解析配置，不再依赖写死的 `RAYA_MODEL` 常量。
- Codex home 的顶层 `config.toml` 仍禁止设置 session model；配置只来自 owner-only `raya.env` 并通过 session 参数注入。
- context receipt 接受第一个稳定、正数且不超过 requested window 的 effective baseline，随后检测漂移、空值、非正数和超上限值。
- voice 的 Codex reasoning thread 使用上述配置；Realtime 音频链路保持原有 app-server v2 模型，不冒充不存在的 Astra realtime variant。
- README 记录默认值、owner-only env 配置、Sol 回滚值和语音模型边界。

Raya 提交（`b1b5a64..3383848`）：

- `38764ba` `feat(contracts): configure Raya Codex session policy`
- `b206f3d` `feat(brain): apply configured Codex session policy`
- `a39b942` `feat(voice): share configured Codex session policy`
- `939011b` `fix(metrics): validate configured context window`
- `149cbca` `style: format Astra session changes`
- `3383848` `fix(review): address Astra policy advisories`

## TDD 证据

- RED：brain metrics env CLI 测试按 `200000` 配置后仍得到旧的 `1050000`；实现 env 加载和 resolver 后 GREEN。
- RED：C0 config 测试读取不到 `codexSession`；probe 迁移到共享 resolver 后 GREEN。
- Review remediation RED→GREEN：首个 accepted effective window 没有 evidence event；metrics JSON 没有配置来源；metrics 被无关 reasoning value 阻断且 env-file error 不是 EX_CONFIG；reasoning allowlist 错误没有说明 Raya 的锁定策略。分别以最小变更转绿，并补 process-env/file/default 三种来源测试。
- contracts：80/80。
- brain targeted：19/19。
- voice targeted：114/114。
- C0：2/2。

## 身份与 Astra 权限

Lead 在 Raya 的 Business 身份凭据恢复后，于 2026-09-07 00:05Z 从 runner 外运行了两个真实、临时 Codex session：默认 session 返回 `ok`；显式 `-m gpt-6-astra` session 返回 `astra-ok`，receipt 报告 `model: gpt-6-astra`。这证明 Raya 当前身份具备 Astra 权限；实施节点未读取、修改或输出任何凭据，也没有重启生产 brain。

## 仓库验证

Raya 仓：

- `pnpm lint`：通过。
- `pnpm -r build`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过（contracts 80、brain 134、voice 521、QA 134）。
- `pnpm test:packages:run`：脚本不存在；改跑仓库声明的完整 `pnpm test`。
- 新增 `scripts/__tests__/*.test.sh`：无。

Flywheel 父仓：

- `pnpm lint`：退出码 0；仅有与本变更无关的既有 warnings/info。
- `pnpm -r build`：首次因 `packages/qa-framework/node_modules` 缺失失败；`pnpm install --frozen-lockfile` 后通过且无 tracked 变更。
- `pnpm test:packages:run`：在全仓并发负载下非绿；teamlead 11,377 通过、27 失败，另有 claude-runner prompt timeout。失败跨越 tmux、Claude profile、Bridge 和性能计时等未改动区域，表现为 5/15/20 秒超时与 tmux server errors。
- 隔离复跑 `prompt-overflow.real-tmux.test.ts`：2/2 通过。
- 隔离复跑 `bridge.test.ts`、`automated-message-inventory.test.ts`、`fly-1648-hot-loop-closeout.test.ts`、`epic-page-liveness.e2e.test.ts`：46/46 通过。

## Code review

- 按合同对 initial/final head 都实际调用 `codex:rescue` review-only companion；resident 外层 macOS sandbox 在 reviewer 读取 `AGENTS.md` 前拒绝 nested `sandbox-exec`（status 71），因此这些尝试不记作 PASS，也没有改用禁止的 raw `codex exec`。
- authoritative request-driven R1（gate `e6fbc078-08ca-45bf-a215-61819a068187`，request `76ad5c0f-94df-4b39-85d2-81af62adfcb9`）在 `149cbca` APPROVED，无 blocking finding，并给出两项 MEDIUM、三项 LOW advisory。Lead 要求同 PR 处理；`3383848` 增加 explicit baseline event、metrics config source、context-only metrics resolver/EX_CONFIG 语义、锁定 effort allowlist 说明和准确 README scope。
- R2（gate `5acce38c-9c7b-42ad-bd97-7171abd675ea`，request `40d35a46-05f9-4ada-a05d-10d66583e229`）在 exact final head `3383848ebf9b507642b4ab92fe61f5f1d32a2565` 返回 `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`，无 HIGH/blocking finding。剩余一项 LOW 建议 metrics summary 进一步突出 effective/configured ratio；Lead 明确不为这项新 LOW 开 R3，已把它列为 Raya PR follow-up 第一条。
- Raya PR：`https://github.com/xrliAnnie/raya/pull/25`。

## 未在实施节点执行的生产动作

- 未修改生产 `raya.env`，未重启 Raya brain，未部署或合并。
- 后续独立 QA/ship 节点应在生产 checkout 配置或确认默认 Astra，重启 brain，检查 preflight/receipt 显示 `gpt-6-astra`，并完成真实 `#raya` text + voice 验证。
- 回滚路径为 owner-only env 设置 `RAYA_CODEX_MODEL=gpt-5.6-sol` 后重启；本实施节点只验证代码和文档契约，不执行生产回滚演练。
