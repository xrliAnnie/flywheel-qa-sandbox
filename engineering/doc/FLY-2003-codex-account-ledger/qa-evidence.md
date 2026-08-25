# FLY-2003 账号台账 — QA 实证
Issue: FLY-2003 (https://linear.app/geoforge3d/issue/FLY-2003/账号台账-codex-接号器整理三号对齐身份自动记账杜绝错账)
日期: 2026-08-25
基于: plan.md

## 结论

候选实现把 Codex 身份范围收敛为 `school`、`personal`、`business`，并修复了 QA 发现的三个问题：发布包缺失 registry、最终 ledger snapshot 写失败会误杀 runner birth、`status` 在 ledger 不可写时丢失身份输出。身份/auth/contract 校验继续 fail-closed；只有 provisioning 的最终观测写与 `status` 调用点是 best-effort，ledger writer core 本身继续 fail-loud。

## 529 实证边界

本轮 529 使用实现 commit `2d7e6a8ee179225038c152e4a97331b46daa1849`。隔离 Bridge `/health` 的 `buildSha` 与 `artifactBuildSha` 都与该 SHA 相同。529 没有伪造 Lead，也没有声称在同一隔离房里重放了整条 failure→Lead→Founder 链；证据按三段记录。

### A. 真实 Codex birth failure

- 在隔离 slot 中启动真实 Bridge，使用 slot-local HOME、真实 `codex-tmux` adapter，并故意提供不存在的 `FLYWHEEL_CODEX_SOURCE_HOME`。
- `/api/runs/start` 接受了 QA execution `9a032fe1-91e9-4d2d-99ec-bbbe391373da`。
- adapter 随后真实失败，错误为 source auth 不存在；Bridge 落了 `session_failed`。
- 隔离 StateStore 行最终为：issue `FLY-2003`、role `qa`、adapter `codex-tmux`、status `failed`、started `2026-08-25 15:50:35.743Z`、terminal `2026-08-25 15:50:37Z`。

这证明 birth failure 是 runtime 真路径，不是直接写数据库或调用测试 seam。

### B. 真实 Discord 正向投递

- 经真实 Bridge `account_rotation` event 与显式 sender token 投递到隔离 Alerts Discord。
- Discord message id：`1541839185357307984`。
- 时间：`2026-08-25T15:58:27.776Z`。
- 内容：`🤖[自动] 🔁 Codex 账号轮转：personal → school（FLY2003-529-positive-control-20260825T0859）`。
- 该 Alerts channel 对 Founder 可见；Founder 后续明确裁定这条测试消息可以保留。它是本轮唯一已知的生产可见副作用。

这只证明 Bridge→Discord 的正向送达，不把它冒充为 A 的 Lead relay。

这条消息是合成 positive-control event，不是真实 profile switch。测试后 live `auth.json` 解析仍为 `personal` / `primary` / `pro`；`~/.codex/auth.json` mtime 为 `2026-08-23T22:03:17-0700`，`~/.codex/.active` mtime 为 `2026-08-23T08:34:05-0700`，都早于 8 月 25 日的 529，两个 active sidecar 也都为 `personal`。因此没有生产 credential/profile mutation，也不需要恢复账号。

### C. failure→Lead mailbox→relay seam

529 没有重放这一整段。生产事实补足该 seam：前任 execution `292f7fed-dced-44a7-9f26-cdece7b05c1e` 在 `2026-08-25 05:37:26Z` 被 zombie reaper 从 `running` 转为 `failed`，`last_error` 是 dead pane 的两次 absent probe。生产 `lead_events` 同时产生 `session_zombie_detected`（event id `zombie-292f7fed-dced-44a7-9f26-cdece7b05c1e`），归属 `flywheel-eng-lead`，并在 `2026-08-25 05:37:31Z` 标记 delivered。Lead 随后处理该失败并派发本次 resume。

因此证据拆分为：A 验证真实 529 birth failure，B 验证真实隔离 Discord delivery，C 由生产 zombie 事实验证 Bridge→owning Lead 的投递与后续处理。没有把三段描述成一次端到端重放。

## 429 负向控制

- 临时 PATH stub 让真实 fallback wrapper 收到 `429 rate limit FLY2003-529-negative-control-20260825T0859` 并退出 7。
- 当前 `scripts/codex-with-fallback.sh` 保持原账号、打印人工恢复指引并返回 7；没有调用 `codex-profile next/use` 或 `account-rotation-notify`。
- 正向消息时间之后查询隔离 Discord，新增 `Codex 账号轮转` 消息为 0。
- `scripts/codex-with-fallback.sh` 与 vendored fallback 的静态扫描也没有自动 profile/rotation caller。

这证明普通 429 不会自动切号或制造 rotation 通知。

## 自动化验证

- `pnpm lint`：exit 0；0 errors，8 个与本改动无关的既有 warnings。
- `pnpm -r build`：exit 0，22 workspace 构建通过。
- FLY-2003 targeted Vitest：4 files，191/191 通过。
- `pnpm --filter flywheel-config test:run`：43 files，661/661 通过。
- `bash scripts/__tests__/codex-guard.test.sh`：44/44 通过。
- `package-onboard-smoke.test.sh`（隔离 npm cache）：14/14 通过，覆盖真实 pack/install、所有 embedded package import、`better-sqlite3` native load、Bridge `/health` 与 Lead launcher dry-run。
- ledger writer core 单独 7/7 通过，证明调用点 best-effort 没有把 writer core 变成静默成功。

主机上的默认全包命令也执行了，但未获得 clean exit：macOS sandbox 禁止 Terminal.app automation；并发/重载下若干既有 real-process tests 超过各自 5–15 秒 timeout。失败项逐个隔离后通过：`flywheel-comm` 整包在 15 秒 timeout 下 1614/1614 通过，Team Lead 三个失败文件 23/23 通过，Claude runner real-tmux prompt 2/2 通过，Voice subprocess 6/6 通过。Team Lead 的 hardened 重跑完成 9494 passes / 6 skips，剩 4 个既有高负载 timeout 与一个 worker RPC timeout；它们不在 FLY-2003 diff 内。最终 GitHub CI 作为 clean-machine 的 authoritative full-suite 证据。

## 环境清理

隔离 slot 已停止，`/health` 随后不可达。sandbox 阻止 `ps`，所以没有声称完成进程级全机 census；精确测试 Bridge 通过持有的 PTY 停止，slot 数据与 lock 被可恢复地移到 `/private/tmp/fly2003-complete-slot-1-20260825-0900` 及对应 lock archive。生产 Bridge、生产 credential/profile 与生产 ledger 均未改动；上文已单独披露 Founder 可见的 positive-control Discord message，不能把本轮概括为“生产零可见痕迹”。

## DAG QA attempt 1 返工

独立 QA 在被测 head `e314e00ddbcade37724e325add20a0a1f539b34d` 找到两个同类 MEDIUM 缺口：`use` / `save` 在 credential 已不可逆写成功后仍会让 ledger 写失败决定进程失败；`list` 会让单个损坏的非权威 snapshot 摧毁整个三号 live health 视图。

implement attempt 2 先补三条真实 CLI RED 测试，确认修复前 `list`、`use`、`save` 都以 exit 2 失败；随后只把 ledger I/O 降级为 best-effort：

- `use` / `save` 先输出真实 credential 操作成功，再尝试 observation；失败时 exit 0，并在 warning 中同时给出 profile 与 snapshot path。
- `list` 单独捕获每个 profile 的 snapshot read；损坏项保留 live `ready` / `invalid` 事实，`lastObservation=null`、`ledgerUnreadable=true`，human 行显示 `[ledger unreadable]`，并在 stderr 给出 profile 与 snapshot path。
- writer core 与 live credential / identity 验证继续 fail-loud；只有派生 ledger 的调用点 best-effort。

返工后的聚焦验证结果：

- `codex-shim.test.ts`：17/17 通过，其中三条新增回归测试分别覆盖 corrupt snapshot、`use` ledger 写失败、`save` ledger 写失败。
- FLY-2003 account 相关 suite：204/204 通过。
- `flywheel-config`：661/661 通过；shell guard：44/44 通过。
- `pnpm lint` 与 `pnpm -r build` 均 exit 0。
- `pnpm test:packages:run` 在本机全并发下未 clean exit：headless macOS 无法连接 Terminal.app，长时 Vitest worker 出现固定 RPC timeout，Team Lead 9,500+ 测试聚合时有 17 个 5 秒超时/资源争用失败。失败文件改用单 worker、隔离 npm cache 复验后 168 个测试中 167 个一次通过；唯一仍触碰 5 秒边界的 preflight 用例单文件复验 4/4 通过（该用例 4.317 秒）。受影响失败文件均不在本 PR diff 内。
- 其余包的分包验证通过：`flywheel-comm` 1614/1614、`edge-worker` 1282/1282、`voice-bridge` 673/673；Claude runner 903 passes / 2 skips，其中单个 4 分钟 profile 文件按既有 suite 边界拆跑取得有效 exit 0。Core 219/219（排除唯一要求真实 Terminal.app 的 headless-incompatible integration）。

QA 同时指出两份仓库外全局文案仍描述五号与自动轮换。该项不在本 PR 的代码范围内，已进入 `plan.md` 部署清单：部署时更新 `~/.claude/rules/codex-multi-account.md` 与 `~/.claude/skills/codex-image/SKILL.md`，本 runner 不直接写生产 `$HOME`。
