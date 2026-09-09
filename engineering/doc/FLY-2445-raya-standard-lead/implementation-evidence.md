# FLY-2445 Raya 标准 Lead 迁移 — 实施证据
Issue: FLY-2445 (https://linear.app/geoforge3d/issue/FLY-2445/raya-raya-迁为标准-codex-lead注册进-flywheel走-mailboxraya-仓删掉-ingest-名册)
日期: 2026-09-08
基于: plan.md

## 结论与证据边界

- 依赖 PR #1126 已合入。2026-09-09 最终验证前 fresh fetch 得到 Flywheel `origin/main@7aec153676b7f8cc9b5d1c32aab09d9d048d64e1`，当前分支 merge-base 与它精确相同；本轮 release-gap 修复提交为 `086ce8ec0`。Raya 当前代码 head 为 `d2c5de586d86ff02c66bdee5ce3d633aebbb5544`，merge-base 为 freshly fetched `origin/main@0f77e9772176c973eb1e09548b00c05ae550ef32`。
- 两仓实现已冻结；主仓随后只允许提交本证据、restart-resilient progress 与 literal-last milestone。最终 review gate 的 `reviewedHeadSha` 才是 PR 冻结 head 的权威覆盖证据。
- 本节点没有修改生产 `projects.json`、生产 mailbox、Bridge/Lead 进程、launchd 或 Raya deploy receipt；没有 merge、deploy、dispatch QA，也没有把仓内测试冒充真实 `#raya` 房间切换。
- 合入不等于上线。生产验收仍只接受 founder-only-authority R1 的 v2 `deploy-receipt.json`，且必须绑定两仓 SHA、activation、cursor/cutover 与逐跳 message/summary receipt。

## 实施结果

### Flywheel 平台

- 公共 Lead registrar 新增可选 CoS context、roundtable 与 alert 字段；既有项目行通过受锁 import 子事务更新，add 拒绝覆盖同行异值，recover 能恢复跨文件 intent。
- Raya 注册为标准 `codex-app-server` / `full-access` / TUI Lead，使用独立 identity、通用 launcher/carrier、mailbox pump 与公共 summary receipt；没有新增 Raya 专用 launcher、plist、preflight 或 recovery allowlist。
- 主动出站进入公共 Bridge。local journal/outbox 与 Bridge dedup/message receipt 绑定；ambiguous 结果持久化且不盲重发，缺 Bridge receipt 不会被当成 sent。
- 公共 `lead_actions` MCP 严格继承标准 Lead 的 `outboundMode`：Raya 的 `bridge` 模式只接收 Bridge credential；既有 `direct` full-access Lead 只接收 `DISCORD_BOT_TOKEN`，不再被 FLY-2445 的 Bridge 路径误伤，也不会在两种 transport 间 fallback。
- 一次性 cursor seed 与 source-only updater 实现 P3→P4b→P5 fence；缺/坏 seed、已推进 cursor、symlink、未知旧副作用、token/manifest/carrier 漂移均 fail-closed。
- updater 继续是唯一调度者，执行标准 P0–P7 事务，维护 v1 22 键/v2 30 键 receipt、两仓 rollback pair，并只在 receipt 原子写成功后推进 known-good anchor。P6 在替换 checkpoint 前验证 registry、summary、manifest、artifact、cursor 与 activation 的完整关联。

### Raya 仓

- 活动运行树保留 `.lead/raya/identity.md`、`packages/cos/**`、README/构建元数据；`apps/brain`、`apps/voice`、旧 runtime contracts、可执行 probes、launchd 安装器与专用 QA driver 已删除。
- root workspace 只构建/测试 `packages/cos`；活动源码、脚本、package importer 与发布入口中没有 Discord SDK、Codex App Server driver、自建 Lead roster 或 launchd 控制。
- CoS 保留 summaries、日报、portfolio/统管其他 Lead、问题/会议状态和 persona。公共平台尚未提供的 question/meeting/voice transport 明确返回 unavailable，不写 queued/delivered 假状态，也不回落旧 driver。
- CoS 的 unavailable announcement port 也明确返回 `status=unavailable`；不再返回永远无法终结的 `pending`，summary/report caller 可以做出确定性处置。
- 锁定计划允许历史审计材料保留旧术语。全仓检索仍在 `engineering/doc/**` 与 `probes/evidence/**` 的 28 个历史文件命中；活动发布面唯一相关命中是 persona 中“不得自建 Lead roster”的负向约束。因此结论是“活动程序/发布物零旧驱动”，不是“全仓字面零字符串”。

## TDD 批次

| 批次 | RED | 最小实现 / GREEN | 当前提交 |
|---|---|---|---|
| A 注册与配置 | 公共注册形状缺 Raya alert/roundtable/CoS context；跨文件 import/recover 与已有行更新失败 | 扩 registrar、candidate/recover、identity/directory 与 launcher | `e2e567798` |
| B/C 公共出站 | Lead action 可能依赖本地发送；缺 Bridge receipt/ambiguous fence | 公共 sender seam + Bridge outbound；success/403/restart/ambiguous/其他 Lead 回归通过 | `81ed83cea` |
| D Raya 业务提取 | 删除旧脑会丢 summaries、日报、portfolio、问题/会议语义 | 先固定业务测试，再提取 `packages/cos` | Raya `beeeb4f` |
| E/F 迁移与旧入口闭包 | cursor 缺失会 baseline 到 latest；旧专用 carrier 仍可被选择 | seed/readback fence、标准 updater、打包/收敛清单与负向入口扫描 | `fa5e4a5c5`, `028ffe46c` |
| G receipt fixture | inspector success fixture 只有 `status=sent`，不满足 message-id receipt | fixture 加精确非空 `messageId` | `9ec223c62` |
| H P6 checkpoint | 两仓 SHA/migration 匹配但证据对象为空时仍推进 | 完整 P6 关联校验前移到原子替换前 | `2a32db075` |
| I review/rebase 加固 | provisional review 与 fresh-main 回归暴露 dedup、quiesce、credential 与 fixture 缺口 | 按原设计修复并补负向覆盖；无产品重设计 | `e741f6b33`, `82b5981d3`, `0e70d9c19`, `d1e60c440`, `f90ac1d91` |
| J final code review 阻断修复 | round 1 发现 full-access `lead_actions` 无条件要求 Bridge，导致既有 direct Lead 无法启动 | 先以缺 `BRIDGE_URL` 的 direct 配置得到 RED，再按 `outboundMode` 选择 credential/config/send；Bridge 仍无 direct fallback | `91109faac` |
| K release-gap 返工 | CI 暴露 packaged adoption 误告警、bare repo 默认分支漂移；QA 缺 Bridge-mode 注入；Raya announce 永久 pending；installed Raya 注册链无 suite | 收敛 Raya helper 首次 adoption、显式 `-b main` 与 fixture 目录、可选且默认 direct 的 QA outbound mode、announcement unavailable terminal receipt、installed-package Raya register→preflight | Flywheel `086ce8ec0`；Raya `d2c5de5` |

## 最终本地验证

| 命令 / 契约 | 结果 | 证明边界 |
|---|---:|---|
| Raya `pnpm test` | PASS；29 files / 138 tests | 当前 Raya head 全套行为，含 announcement unavailable terminal receipt |
| Raya `pnpm typecheck`, `pnpm build`, `pnpm lint` | 全部 exit 0；lint 91 files | 当前 Raya head 声明的其余 gates |
| Flywheel `pnpm lint` | exit 0；3043 files，14 warnings / 0 errors | 最终代码树全仓 lint |
| Flywheel `pnpm -r build` | exit 0；22 个参与 workspace | 最终代码树编译 |
| Flywheel 精确 `pnpm test:packages:run` | **exit 1，非绿** | config 782、core 232/2 skip、QA 83、release 21、token 173、Comm 2128/2 skip 与先行 transport workspace 全绿；claude-runner 45/45 files、1105 PASS / 2 SKIP、零 assertion failure 后再次由 Vitest `onTaskUpdate` RPC timeout 终止，后续 workspace 未跑，不冒充完整 gate 通过 |
| `visual-capture.test.ts` 隔离复验 | 65/65 PASS；完整重跑 Comm 仍为 149/149 files、2128 PASS / 2 SKIP | 首次完整尝试的 21 个 `ELOCK_TIMEOUT` 来自运行期间机器级 ProofShot 锁争用；锁释放后隔离与完整包内均复绿，仍不改写根命令 exit 1 |
| TeamLead 变更测试集合 | 原迁移集合 15/15 files、454/454 PASS；review 修复集合 7/7 files、209/209 PASS | registrar、directory、runtime、Bridge、outbound、cursor 与 actions；新增 direct spawn/config/token 与 Bridge 回归 |
| Edge `SkillInjector.test.ts` | 14/14 PASS | Lead context skill 注入 |
| `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh` | 62/62 PASS | TUI home、full-access、按 mode forwarding 与 runtime gate；新增 direct-only credential 断言 |
| `scripts/__tests__/ci-structure.test.sh` | PASS | CI 结构与单进程约束 |
| 新增 `scripts/__tests__/raya-standard-migration.test.sh` | 11/11 PASS | seed、P4b、unresolved guard 与专用入口闭包 |
| `flywheel-lead-packaging.test.sh`, `flywheel-lead.test.sh` | 5/5、31/31 PASS | 打包、identity/cursor/receipt 与 register/preflight/install/stop/live delivery |
| `package-onboard-smoke.test.sh`（隔离 npm cache） | 19/19 PASS | 真实 pack/install 后从 installed tree 正式注册 Raya，再通过 Codex preflight |
| `packaged-seams.test.sh`, `converge-flywheel-bin.test.sh` | 17/17、15/15 PASS | packaged Raya migration helper 首次 adoption 静默且后续 drift 告警 |
| `updater-raya-deploy.test.sh`（强制 `init.defaultBranch=master`） | 31/31 PASS | fixture 显式建立 `main`，不再继承 host Git 默认分支 |
| `test-deploy-fly1389.test.sh` | 22/22 PASS | QA 可显式选择 Bridge outbound；未设置时既有 Codex slots 仍为 direct |
| host probe / generic carrier / updater | 3/3、10/10、31/31 PASS | 零写 probe、通用 carrier 归属、P0–P7/receipt/rollback |
| converge / roster / alert / closure | 22/22、15/15、25/25、7/7、31/31 PASS | 安装闭包、严格 roster prefix 与 cmux 告警闭包 |
| host census / mounts / patrol / recover / sources | 7/7、7/7、372/372、18/18、36/36 PASS | host 选择、巡检、恢复与 source convergence 回归 |

## Code review follow-ups

批准的 `plan.md` 已冻结，未因 review 改写。Round 1 的 5 个 MEDIUM 与 3 个 LOW 均为非阻断 follow-up，本节点不实现：

| Severity | findingKey | 后续工作 |
|---|---|---|
| MEDIUM | `cursor-seed-already-advanced-unreachable` | 统一 cursor writer 的 owner-only mode，恢复 `already_advanced` 的可达性与准确诊断。 |
| MEDIUM | `import-cos-context-missing-path-override-guard` | 为 import wrapper 补齐受锁路径 override 拒绝与 manifest binding 校验。 |
| MEDIUM | `cos-context-import-not-idempotent-on-replay` | 让相同 import manifest 在成功后的原样重放进入 continuation，而不是误报 stale preimage。 |
| MEDIUM | `proactive-send-ambiguous-latch-has-no-recovery` | 区分 client transport error 与 Bridge 409 ambiguous，并提供受控 reconcile/retry 语义。 |
| MEDIUM | `attachment-ingest-scope-expansion` | 单独裁定 attachment-only inbound 的 fleet-wide 产品行为与 QA，不在本迁移中扩大 scope。 |
| LOW | `no-sigterm-flush-or-close-for-lead-actions-outbox` | 补 lead-actions SIGTERM close 与 bounded pending recovery 设计/测试。 |
| LOW | `tree-digest-ignores-symlinks-and-swallows-newline-guard` | 使 tree digest 覆盖 symlink，并让 newline filename guard 真正 fail-closed。 |
| LOW | `unused-lead-directory-projection` | 在后续 consumer 落地前明确 directory projection 仍是 inert metadata，并补 end-to-end 使用证据。 |

## 验收矩阵

| 明示验收 | 当前证据 | 判定 |
|---|---|---|
| `#raya` → 同 mailbox 表 → pump → Codex adapter → Raya → Bridge，与 Mufasa 同路 | production stores/strategy 的两 bot、两 project 隔离整链覆盖；窗口、分页、重启不重放、attachment 与 Bridge reply 均走公共组件 fixture | 仓内实现已证；真实房间/部署等待 R1 receipt |
| Raya 活动面无自建 Discord ingest / App Server / roster / launchd | inventory 逐项处置、263-file 删除、workspace/importer/command 扫描与 mutation tests | 已证；历史 docs/evidence 明示保留 |
| CoS 至少 summaries 收件不断 | Raya 138 tests；summary absorption、daily report、portfolio、state/unavailable guard，announcement 不再永久 pending | 仓内已证；生产连续性等待部署窗口逐跳 receipt |
| 合入不等于上线，R1 deploy receipt 验收 | updater v2 30 键、两仓/activation/cutover/rollback 绑定及 fail-closed tests | 实现已证；生产 receipt 未记录，本节点无部署权限 |

## 收口状态

- 两仓实现与本地验证完成；Lead 指定的 F1–F4/G1/G3 全部闭合。此前 code review 的唯一 HIGH 已以 TDD 修复，其余 MEDIUM/LOW 仅为 advisory、未扩大锁定 scope。根全包门禁因可复现的 Vitest reporter RPC timeout 保持非绿，最终放行必须使用两个 PR 的新 exact-head CI，不复用旧 head CI。
- 本证据之后只提交 literal-last milestone；随后通过 `codex:rescue` 尝试 review-only companion，并注册新的 exact-head request-driven code review。
- PR body 必须披露：本迁移删除了 FLY-2383 留在旧壳上的 `scripts/qa-voice-concurrency-soak.mjs`；这是批准删除的旧 Raya voice-soak driver，不是共享平台替代实现。
