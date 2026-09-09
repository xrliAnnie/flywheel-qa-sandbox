# FLY-2444 任意仓起一个 Lead — 实施证据
Issue: FLY-2444 (https://linear.app/geoforge3d/issue/FLY-2444/产品-任意仓起一个-lead最小闭环flywheel-lead-launcherclaude-codex-注册一行-一页文档raya)
日期: 2026-09-08
基于: plan.md

## 收口结论

- FLY-2442 已由 PR #1124 合入 `main`（merge `eca5feb8a`）。本分支在开始收口时合并了最新 `origin/main@ee113cab9`，并在冻结前再次 fetch；`git merge-base HEAD origin/main` 仍为 `ee113cab9`。
- 通用 Codex launcher 现在显式绑定最后一跳所需三键：`FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge`、`FLYWHEEL_BRIDGE_URL`、`FLYWHEEL_API_TOKEN`。URL 可继承既有 `BRIDGE_URL`，token 可继承既有 `TEAMLEAD_API_TOKEN`；最终为空时 fail-loud 退出 78。
- `verify --stage live` 的 #10 已从 `SKIP` 改为真实执行：只读检查精确 `delivery_id` 对应的 journal member、completed journal entry、`${entry_id}:out` 本地 outbox、Bridge `outbound_dedup` sent row 与非空 `message_id`；任一环缺失即非零退出。
- 本轮 #10 已从 SKIP 转为实测通过。正向链与六个负向 guard 使用真实 SQLite schema / production stores，shell E2E 还放入一个无关的更晚 outbound row，证明实现不能用“任意 sent row”误过关。
- #1–#9 及此前 QA claim 950 的证据保持有效；本轮仅补上述依赖解锁项，没有修复既存 follow-up，也没有修改 FLY-2442 的实现来迁就本单。
- 全部成功结果仍是仓内或 temp-HOME 隔离台架证据。本节点没有改生产 `projects.json`、重启 Bridge/Lead、安装生产 plist、部署、dispatch QA，或冒充 Raya 真频道验收；这些仍属于 FLY-2445 的部署窗口。

## TDD 批次与提交

| 批次 | 红灯 | 最小实现 / 绿灯 | 提交 |
|---|---|---|---|
| A–H | registry 事务、统一 launcher、host probe、carrier、#1–#9、打包与首次 provision 的既有红绿批次 | 此前 review 与 QA claim 950 已验证，收口不重写 | 见本 PR 历史 |
| I | launcher 测试要求三个 Codex outbound env；旧实现三者均为空 | 在进入 `codex-lead.sh` 前绑定 bridge mode、URL、token；缺 token fail-loud；launcher suite 29/29 | `8188dd823` |
| J | 新 inspector 单测先因模块不存在失败；shell #10 仍输出 `SKIP #10 pending FLY-2442` 并退出 1 | 新增只读 exact-chain inspector，接入 live verify；7/7 unit 与 29/29 shell suite 通过 | `49a0b53ca` |

## #10 精确链条

```text
delivery_id
  -> journal_members.entry_id
  -> journal_entries(status=completed, outbox_id=entry_id:out)
  -> outbox(status=sent, exact idempotency_key)
  -> Bridge outbound_dedup(status=sent, message_id non-empty)
```

Inspector 只以 absolute path 打开三个既存数据库，使用 `readonly + fileMustExist + query_only` 和参数化 SQL。它不建表、不迁移、不补写 receipt，也不把同一 Lead 的其他成功出站误当成该 delivery 的证明。

## 本轮可执行证据

| 命令 / 契约 | 结果 | 证明边界 |
|---|---:|---|
| `pnpm lint` | exit 0；14 条仓库既存 warning、0 error | 全仓 lint gate 通过 |
| `pnpm -r build` | exit 0；22 个参与 workspace 全绿 | 最新 main 合并后的代码可编译 |
| `pnpm test:packages:run -- --exclude ...` | RED：Claude runner 仅 `async-exec-file` 500ms timeout；其余该包 1,104 PASS / 2 SKIP | 失败测试与 runtime 相对 `origin/main` 零 diff；串行完整文件 7/7 PASS，不把隔离绿写成全门绿 |
| Comm + TeamLead 并发完整套件 | RED：所有 assertion 2,111 PASS / 2 SKIP 与 11,964 PASS / 6 SKIP，两个进程同轮均发生 Vitest worker `onTaskUpdate` timeout | 同一主机并发 worker 报告超时；作为红色 harness 尝试披露，exact-head CI 为全门权威 |
| `inspect-lead-outbound.test.ts --maxWorkers=1` | 7/7 | exact success + 六个断链 guard；production journal/outbox/dedup stores |
| summary registry CLI + migration focused tests | 11/11 | approved plan 中已不存在的旧 shell 路径不被伪造；当前 TS CLI/migration SSOT 通过 |
| `bash scripts/__tests__/flywheel-lead.test.sh` | 29/29 | 两 harness、事务、preflight、install/stop、#1–#10；#10 实际 PASS 而非 SKIP |
| `bash scripts/__tests__/flywheel-lead-packaging.test.sh` | 4/4 | payload allowlist、canonical identity、安装态 receipt re-mint |
| `NPM_CONFIG_CACHE=<temp> bash scripts/__tests__/package-onboard-smoke.test.sh` | 15/15 | 真实 npm pack/install、Bridge health、两 launcher、packaged generalized path |
| `bash scripts/__tests__/host-tmux-selection-gate-probe.test.sh` | 3/3 | probe 零写且与 gate 判定一致 |
| `bash scripts/__tests__/lead-restart-lifecycle-generic-carrier.test.sh` | 10/10 | generic carrier authority 正反格与 inventory/census |
| `bash packages/teamlead/scripts/__tests__/codex-lead-args.test.sh` | 12/12 | Codex argv/env 合同不回归 |
| `bash packages/teamlead/scripts/__tests__/codex-lead-state-dir-parity.test.sh` | 6/6 | launcher 与 runtime state root 同源 |

批准计划中列出的 `scripts/__tests__/migrate-summary-registry-cli-resolve.test.sh` 在当前 branch 与 `main` 均不存在；直接调用结果为 exit 127。收口没有擅自新增另一个测试路径来改写计划，而是执行当前 SSOT 的两个 migration/CLI suites（11/11）。

## QA / review 交接

- 判据文件保持 Lead 指定的 `qa-criteria/FLY-2444.md`，本实现节点未改写它。
- 第 6 条交接必须明确写：**本轮 #10 已从 SKIP 转为实测通过**。直接证据为 launcher 29/29 与 inspector 7/7；验证输出现在携带 exact `delivery_id`、`entry_id`、`idempotency_key`、`message_id`。
- 旧 head `bf598a3f4` 的 14/14 CI 不能证明本轮新代码；最终只以本收口 frozen head 的新 exact-head CI 作为 CI 证据。
- Review 在 frozen head 上 request-driven 发起；review 运行期间不移动 head。若有 blocking finding，等完整判决后一次性修完，再发新 head 与新 review round。
- 本轮不请求 ship/merge，不 dispatch QA；DAG orchestrator 决定后继节点。

## QA rework：npm compat mirror 的 symlink 主入口

QA 在已安装包的兼容镜像上发现两个 CLI 会静默退出 0：`packages/teamlead` 是指向 `node_modules/flywheel-teamlead` 的 symlink，而两个 ESM main guards 用 lexical `resolve(process.argv[1])` 与 real module path 比较，导致 guard 不成立。修复严格限制在 Lead 指定的两个 guard 与 package smoke：

| 批次 | 红灯 | 最小实现 / 绿灯 | 提交 |
|---|---|---|---|
| K | 真实 npm pack/install 后通过 compat symlink 调用 inspector 与 project-root preflight；两者均 `rc=0` 且无输出，新增 smoke 为 15 PASS / 2 FAIL | 两个 guard 先以 `realpathSync(process.argv[1])` 规范化 argv 路径再比较；package smoke 17/17，focused CLI unit 14/14 | `4cf5c32c5` |

可执行证据：

- `bash scripts/__tests__/package-onboard-smoke.test.sh`：17/17 PASS。兼容镜像创建后，inspector 的缺失数据库输入必须非零且输出 `outbound_inspection_error`；project-root preflight 的无效绝对路径必须非零且输出 `codex_project_root_invalid`。
- QA packaged harness 经 symlink 调用 inspector，返回 delivery `chat:qa-probe-lead:7503193750579970048` 的完整成功 JSON，Bridge `message_id=1546986792266240010`；同一路径的无效 project root 返回 78。未使用 harness 中指向错误 repo 的 real-path control 作为证据。
- `pnpm --filter flywheel-teamlead exec vitest run src/bin/__tests__/inspect-lead-outbound.test.ts src/bin/__tests__/preflight-codex-project-root.test.ts --maxWorkers=1`：2 files / 14 tests PASS。
- `pnpm lint`：exit 0，14 条既存 warning、0 error；`pnpm -r build`：22 个参与 workspace PASS。
- 默认并发 `pnpm test:packages:run` 两次均因零改动关联的随机超时退出 1；失败文件分别隔离复跑 3 files / 80 tests 与 4 files / 43 tests 全绿。随后以单 workspace、单 Vitest fork 运行同一完整脚本，所有 TeamLead assertions 为 11,964 PASS / 6 SKIP，但 Vitest 最终仍因 worker `onTaskUpdate` RPC timeout 退出 1。此处保持红色基础设施边界，不冒充本地全门绿；最终放行只取推送后 exact-head CI。

QA 后继必须重新执行 packaged #10 与 packaged project-root preflight；不能沿用 real source path、旧 head 或本轮实现节点的隔离台架来代替安装态验收。

## Review round 3 / Lead round 4 收口

Reviewer 在旧 frozen head 上返回一个 HIGH 与三个 MEDIUM；Lead 指令把本轮范围锁为四项全部修复，并要求三个 LOW 只记 follow-up：

| 批次 | 红灯 | 最小实现 / 绿灯 |
|---|---|---|
| L — packaged registry validator | 真实 npm pack/install 后，经 compat symlink 调用 `validate-projects.js` 对 `department:""` 非法名册静默 `rc=0, output=`；smoke 17 PASS / 1 FAIL | 第三个 CLI main guard 同样使用 `realpathSync(argv[1]) === fileURLToPath(import.meta.url)`；修正此前被空过掩盖的 Codex smoke fixture（`codex-generic` 是 host-gate 名，不是 schema carrier）；安装态 smoke 18/18 |
| M — composed Codex runtime preflight | 新建隔离 `raya` Codex Lead，并在共享 `.env` 放入相对 `RAYA_METRICS_DIR`；旧 preflight 错误通过，launcher suite 29 PASS / 1 FAIL | `run` 与 `preflight` 复用同一 Codex child-env 合成函数；preflight 以 `FLYWHEEL_LEAD_DRY_RUN=1` 执行真实 `codex-lead.sh` / `parseCodexLeadRuntimeConfig`；backend dry-run 不创建 state dir；suite 30/30 |
| N — production register path guard | 表驱动传入 `--projects-file`、`--receipt-file`、`--summary-config-home`，旧 shell 入口原样转发；suite 30 PASS / 1 FAIL | 在 load/lock/write 之前拒绝分离值与 `--flag=value` 两种写法，退出 64 并点名 flag；suite 31/31 |
| O — existing-project option conflicts | 向既有 project 追加 Lead 并给出冲突的 `projectRepo` / `generalChannel` / `memoryAllowedUsers`，旧 planner 不报错；unit 9 PASS / 1 FAIL | 仅对调用方实际提供的 project-level 选项做深比较；不一致返回 `lead_registry_project_options_conflict` 与准确字段名，省略则继承；unit 11/11 |

四项完成后的可执行证据：

- `NPM_CONFIG_CACHE=<temp> bash scripts/__tests__/package-onboard-smoke.test.sh`：18/18 PASS；`②e` packaged inspector、`②f` packaged project-root preflight、`②g` packaged projects validator 均经真实 compat symlink 执行。
- 六个 FLY-2444 命名 suites：launcher 31/31、packaging 4/4、host probe 3/3、generic carrier 10/10、Codex args 12/12、state parity 6/6，全部 PASS。
- `pnpm --filter flywheel-comm exec vitest run src/__tests__/lead-registry-add.test.ts`：11/11 PASS。
- `pnpm lint`：exit 0（14 条仓库既存 warning、0 error）；`pnpm -r build`：22 个参与 workspace PASS。
- `pnpm test:packages:run` 如实为 RED：唯一失败是 Comm `cli.test.ts` 的既有 `runner-stopped` 用例在全仓并发中超过 5 秒；同一完整文件以单 worker 隔离执行 54/54 PASS，目标用例 453ms。本地全门仍记 RED，不用隔离绿改写。

以下 review LOW 只登记为后继工作，本单不修改：

1. `install-exec-spec-word-split-and-unescaped-plist`：launchd exec spec 仍是空格分隔字符串，含空格/XML 元字符的路径需要 argv 化与 XML escaping。
2. `lifecycle-python3-dependency-unchecked`：install/stop 的 plist ownership 检查依赖 `python3`，应在工具/preflight 清单中显式验证。
3. `state-dir-parity-legacy-branch-predicate`：shell legacy state-dir 使用 `-d`，Bridge 使用 `existsSync`，非目录条目时判据尚未完全同源。

QA 后继除重测 **packaged #10** 与 **packaged project-root preflight** 外，还应确认 packaged `validate-projects.js` 的非法名册负向 guard；不得用 source-tree real path 代替 compat-symlink 安装态路径。新 preflight 还应以一个真实 runtime-parser 拒绝条件（例如 Raya 的相对 `RAYA_METRICS_DIR`）证明 `verify #4` fail-closed。
