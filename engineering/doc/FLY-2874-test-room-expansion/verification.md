# FLY-2874 测试房扩容 — 验证记录
Issue: FLY-2874 (https://linear.app/geoforge3d/issue/FLY-2874/529-房扩容-测试房-4-6-间加-slot-56bot文字频道bridge-端口-每间一个语音频道补-voice-test-456)
日期: 2026-09-26
基于: plan.md

## 实现头与本机定向验证

- 真实验收代码头：`6850eadf8bc0523e38d8467dd31344f88587af14`。该头已合入当时的 `origin/main`（`9034bddc3`），且已推到 `origin/flywheel-FLY-2874`。
- 构建：`pnpm --filter "flywheel-teamlead..." build`、`pnpm --filter flywheel-inbox-mcp build` 通过。
- 新增契约：FLY-2874 capacity 2/2、slot-pool PASS、preflight 4/4、multilead 30/30、generalized deploy PASS、qa-room 22/22。
- launchd/voice 直接相关：`fly1663-qa-launchd` 61/61、mutants 11/11、Codex Lead layers 15/15、FLY-2867 lease 4/4、FLY-2301 restart drill 3/3；voice-room 在宿主侧 19/19。
- 其余 `git grep -lF` 直接消费者已在合并前当前实现上通过：`codex-home-reconcile-cadence`、`fly1679-dev-channels-v2`（51/51；真实 raw-TTY 层因 sandbox TTY 拒绝按契约 SKIP）、`fly1773-delivery-semantics`、`qa-fly-2456-dry-run`、`qa-lead-coordinates`、`qa-room-env`、`qa-slot-env-contract`、`qa-teardown-finalize`、`restart-cmux-watcher`、`test-auto-approve-identity`、`test-cycle-bridge`、`test-deploy-discord-pointer`、`test-deploy-launch-boundary`、`test-qa-executor-529-nton-contract`、`test-teardown-cmux-ownership`、`test-teardown-lease-contract`、`test-teardown-live-watcher-e2e`、`test-worktree-removal-contract`。
- 仓库级 `pnpm lint` 当前 exit 0（25 个既有 warning，另 143 条诊断因上限未展开）；没有越界修改。变更 shell 的 `bash -n` 与最终 `git diff --check` 也单独通过。

## Discord 与 live config

- Founder 已创建 `flywheel-test-5/6` 应用并自行把 token 写入 `~/.flywheel/.env`；整个实施仅判断 `TEST_BOT_TOKEN_5/6` 非空存在，从未读取或输出 token 值。
- Lead 以 Founder 权限在 `QA Testing`（`1493080958889496760`）下创建文字频道 `1553170042206814229`、`1553170266677321808` 和语音频道 `voice-test-4/5/6`（`1553169311244361728`、`1553169528278749254`、`1553169774341652610`）。
- 只读 Discord API 验证：slot 5/6 bot 仅能访问各自文字/语音频道；另一 slot 文字频道返回 403；非 QA 的 General 频道拒绝语音。slot 1–4 原字段未改，只追加各自 voice 映射。
- live `~/.flywheel/test-slots.json` 已扩到连续 1–6，slot 5/6 端口为 19875/19876；slot 5 按 slot 2 使用 `codex-app-server/full-access`，slot 6 保持 Claude。

## 真实房硬验收（代码头 `6850eadf8`）

- slot 5：exact-head generalized + voice fixture deploy rc0，`/health` 200，host-visible lock owner 存活，voice `prepare` rc0/`READY`，随后 owner teardown rc0；目录、锁、launchd label、19875 listener、相关进程和 voice lease 全部归零。证据：`~/.flywheel/qa-evidence/slot-5/20260926T0149Z-2860to2874/`。
- slot 6：同样完成 exact-head deploy、health 200、voice `READY` 与 teardown rc0；目录、锁、label、19876 listener、相关进程和 lease 全部归零。证据：`~/.flywheel/qa-evidence/slot-6/20260926T0117Z-2874-voice-r3/`。
- N-to-N：以 slot 5 为 owner、slot 6 为 borrowed extra Lead 部署 rc0；两把锁绑定同一 live Bridge owner，health 200/exact SHA，slot 5 为 Codex carrier、slot 6 为 Claude carrier，分别使用自己的文字频道；只有 owner Bridge 监听 19875，19876 无独立 Bridge。owner teardown 5 后，5/6 目录、锁、两个 label、端口、进程与 lease 全部归零。证据：`~/.flywheel/qa-evidence/slot-5/20260926T0206Z-2874-n2n/`。
- 全程未对 slot 1–4 执行 deploy 或 teardown。

## 已归因的测试环境红灯

- current-head `test-deploy-fly1389.test.sh` 在共享主机两次出现不同失败点；第二次 `CX` crash/kickstart 已通过，但更早的 slot 31 lock 在本进程 `Claimed` 后被外部删除，同时 teardown 看到同一 guard 被别进程持有，且多个进程引用同一个固定 slot-34 socket。
- 根因是该 hermetic suite 写死全局 slot 30–35 并在启动时 `rm -rf`，与另一并发副本互相删锁/抢 guard；不是本头产品回归。Lead 接受该归因并会另开清理/并行隔离后续；本 PR 不越界重构该套件。证据：`~/.flywheel/qa-evidence/slot-6/20260926T0107Z-2874-fly1389-r2/`。

## Code review 跟进

- Round 1 在 `ac18d7a04` 上 `APPROVED`，带两条 LOW advisory。
- 范围内的遗漏已按 RED→GREEN 修复：`scripts/discord-e2e.sh` 不再只扫描 1–4，而是通过 `qa_slot_pool_count` 自动发现全部配置 slot；FLY-2874 slot-pool 合同先红后绿，`bash -n` 与 `git diff --check` 通过。
- 另一条 advisory 指出 `--alerts` / roundtable 无参数自动分配可能选到缺共享频道 overwrite 的 slot 5/6。当前路径会在频道可达性探针 fail-fast，安全性不受影响；本单锁定配置明确 5/6 仅支持 per-slot 与 N-to-N。没有为解决 LOW advisory 再引入新的四房常量或第二份 membership 配置，已把建议回报 Lead 作为后续选择。
- Round 2 在 `11bbdea2bde10b74b26a373b740e25f8b5f41345` 上 `APPROVED`，只保留上述 fail-fast LOW advisory；该建议已再次回报 Lead。

## PR scope CI 跟进

- PR #1342 首次 scoped Quick Gate 在 `11bbdea2b` 上捕获 `ci-structure.test.sh` 的 script-tests inventory 漂移：workflow 已注册 `Test — FLY-2874 six-slot pool contract`，期望清单漏了同名 step。
- 已用单行最小修复同步期望清单；本地复现先红，随后 `ci-structure` PASS、`ci-scope` 20/20、`ci-full-reuse` 28/28、FLY-2874 slot-pool PASS，且 `git diff --check` 通过。该修订只修当前 HEAD 的实际红项，不请求 full CI。

## 扫描排除项

- 历史证据不回写：`doc/engineer/qa/**`、`doc/qa/**`、`doc/engineer/test-reports/**`、`doc/engineer/research/archive/**`、`engineering/qa-reports/**` 与其他已归档 plan/research 中命中的旧 slot 记录。
- 非容量语义不改：CI shard 的 `[1-4]/4`、UUID/行号/测试计数、FLY-2456 的固定场景、普通“步骤 1–4”文本。
- 保留的负控：`scripts/__tests__/fly2874-slot-pool.test.sh` 中旧错误文案 `--slot must be 1-4`，用于证明 driver 已不再返回该文案。
- 非消费者命中不跑：只引用脚本路径的文档、打包 kill-path 夹具以及路径说明；其行为由上述直接执行消费者覆盖。

## 结论

交付与所有 issue 级硬验收均已完成，PR #1342 已创建；CI inventory 修订后的精确 HEAD 仍需重新 code review 和 scoped Quick Gate，QA 仍由后续节点拥有。
