# FLY-1389 529房测试房修缮批 — 调研

Issue: FLY-1389 (https://linear.app/geoforge3d/issue/FLY-1389/infra529房-测试房修缮批-lead-lease-超时旋钮-no-lead-模式-全局-symlink-稳定路径守则)
日期: 2026-07-20
基于: exploration.md

代码事实清单(全部行号以本 worktree HEAD = origin/main 9fa91cf6f 为准)。

## 1. test-deploy.sh(`scripts/test-deploy.sh`)

| 位置 | 事实 |
|------|------|
| ~28-34 | 顶部 `source ~/.flywheel/.env` — 生产 env 整体进入脚本进程(泄漏面) |
| 129-186 | 参数解析:已有 `--from-branch/--mode/--alerts/--digest/--extra-lead/--lead-label/--detection-lead-grace-ms`;新 flag 在此加 |
| 553 | `SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"` |
| 739-776 | 写 `${HOST_REPO}/.flywheel/config.yaml`(经 `qa_multilead_config_yaml`,`scripts/lib/qa-multilead.sh:66-106`);内容无 `qa:` 块 → auto-QA 默认关 |
| 1043-1064 | Step 1 Lead 启动:`env -u DISCORD_BOT_TOKEN` + 显式 env 列表 → `claude-lead.sh`。**不清 LEAD_WORKSPACE**(泄漏点);也不清 FLYWHEEL_LEAD_MODEL/EFFORT(lead.log 显示 model sonnet 来自 env fallback) |
| 1065-1117 | Step 1b dev-channels prompt 自动确认(依赖 Lead tmux 窗口存在) |
| 1119-1148 | Step 2 lease 等待:`for i in $(seq 1 60); … sleep 2` = **120s 硬编码**;lease 文件 `~/.flywheel/comm/<proj>/.inbox-ready-<AGENT_ID>`(JSON pid 活性检查);超时 exit 1 并 kill Lead |
| 1343-1356 | Step 2b extra-lead(campaign)同样 120s 硬编码 |
| 1368-1445 | Step 3 Bridge 启动:两个 env 分支(TEST_REPLY_BY_ISSUE on/off)都用 `npx tsx ${REPO_ROOT}/scripts/run-bridge.ts`;**均未设 FLYWHEEL_BIN_DIR / FLYWHEEL_HOOKS_DIR / FLYWHEEL_REPO_ROOT** → slot Bridge boot 会写全局 `~/.flywheel/bin`(隔离缺口) |
| 1449-1472 | Step 4 Bridge HTTP ready 等待 120s(FLY-535 注释;此处与本单无关,不动) |
| 1504-1560 | Step 5 PID 记录 + 输出 JSON(含 leadPidFile/leadLog 字段 — `--no-lead` 需给出兼容形态) |

FLY-529 先例:Bridge env 分支曾因继承生产 `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` 而 fatal,修法就是 env 块加 `-u` 清单 — LEAD_WORKSPACE 泄漏是同类,同修法。

## 2. Lead 启动器(`packages/teamlead/scripts/claude-lead.sh`)

| 位置 | 事实 |
|------|------|
| 443 | `SESSION_ID_FILE="${SESSION_DIR}/${PROJECT_NAME}-${LEAD_ID}.session-id"`(SESSION_DIR=~/.flywheel/claude-sessions) |
| 462-469 | `LEAD_WORKSPACE="${LEAD_WORKSPACE:-${HOME}/.flywheel/lead-workspace/${LEAD_ID}}"` — 调用方 env 是最高优先级 escape hatch(GEO-286/GEO-285 设计);测试房必须显式控制它 |
| 2550-2560 | `command -v agent-team-transport` 找到但 preflight 失败 → **FATAL 拒起**(断链 symlink 正是打在这里) |
| 2746 | `RESUME_FAIL_THRESHOLD=3` |
| 2895-2899 | `IS_RESUME` 置位:session-id 文件存在即 resume |
| 3009-3028 | 崩溃处理:`DURATION < 10` 才计 `RESUME_FAIL_COUNT`,else 分支(含 10-15s 的确定性 resume 失败)**清零**;`DURATION > 60` 才重置 CRASH_COUNT — 两个阈值语义不一致是放大器根源 |
| 881-889 | FLY-954 convergence 挂载(非致命)— path-hygiene 检查可同点挂载 |

**resume 预检落点**:claude-lead.sh 在 resume 分支(2895-2899 附近)前可计算 transcript 路径:`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<workspace-slug>/<session-uuid>.jsonl`,其中 workspace-slug = `LEAD_WORKSPACE` 绝对路径把 `/` 与 `.` 替换为 `-`(Claude Code 约定,例:`/Users/xiaorongli/Dev/personal-assistant` → `-Users-xiaorongli-Dev-personal-assistant`)。**预检为纯诊断日志(只记存在性,永不改动 session 状态)** — slug 属 Claude Code 内部约定无稳定 contract,删除权归 P0-c 计数器(生产)与 P0-d deploy 前置删(测试房)。实现时真机验证 slug 规则仅为提升日志准确性(含 CLAUDE_CONFIG_DIR 隔离场景,FLY-572)。

## 3. symlink 写入方(`packages/teamlead/src/bridge/sync-flywheel-hooks.ts`)

| 位置 | 事实 |
|------|------|
| 236-246 | `CLI_BINS_TO_DEPLOY`:`agent-team-transport`(→ packages/agent-team-transport/dist/bin/…-cli.js)+ `tmux-server-rescue`(→ scripts/lib/tmux-server-rescue.sh)— 本次两个断链实证恰好就是这两个条目 |
| 260-266 | `defaultRepoRoot()`:env `FLYWHEEL_REPO_ROOT` 或 `import.meta.url` 上溯 4 层 — **Bridge 从哪个树跑,repoRoot 就是哪个树**(worktree Bridge → worktree repoRoot) |
| 274-278 | `defaultBinDir()`:env `FLYWHEEL_BIN_DIR` 或 `~/.flywheel/bin` — slot 隔离 seam 已存在,只缺接线 |
| 289-393 | `syncFlywheelCliBin()`:idempotent;target 不匹配就替换(**无 canonical 判定** — 守卫落点);错误进 `result.errors` 不中断(soft-fail 语义保留) |
| 82-99 | hooks 侧同构 seam:`FLYWHEEL_HOOK_SOURCE_DIR` / `FLYWHEEL_HOOKS_DIR` |

调用点:`plugin.ts:3860-3878` Bridge boot 一次性 `syncFlywheelRuntime()`,soft-fail(catch 后 warn 继续)。守卫拒写应表现为 `errors` 条目 + 响亮日志,不改 soft-fail 外形。

## 4. 全局 bin 收敛器(`scripts/converge-flywheel-bin.sh`,FLY-954)

- REPO_ROOT 自身位置推导(R2#1 刻意不吃 env — 它是 WRITER);**从 worktree 跑它,就会把 worktree 内容 converge 进全局 bin**(内容拷贝,worktree 删除后残留旧内容而非断链 — 危害形态不同但同违规类)。canonical 守卫同样适用于它。
- 覆盖文件:三个 wrapper 拷贝(`flywheel-lead-wrapper.sh` 等),**不管 symlink** — 断链自检/hygiene 是新增段。
- 挂载点(直接复用):claude-lead.sh 每次 Lead start(非致命)、update-flywheel.sh 每日 sweep、restart-services.sh pre-kickstart(fail-loud)。
- alert 通道现成:`lead-alert.sh --kind bin_integrity_drift --severity severe` + claims.db 去重 + `🧪[sandbox test]` 前缀逻辑(STATE_DIR 非默认时)。
- 包装形态例外已有先例:`.flywheel-prebuilt` sentinel 分支(FILES 缩减)— canonical 判定须兼容 packaged 树(其 repoRoot 合法地不是 ~/Dev/flywheel,但 `.git` 不是文件、也不在 tmp,故 `.git-是文件 ∨ tmp 形态` 判据天然放行)。

## 5. teardown 与 stale 状态(`scripts/test-teardown.sh`)

- Step 4(478-484)已删 session-id 文件 — 但本次事故它没拦住(可能路径:上一轮 deploy 崩溃后未走 teardown;或 session-id 由非-slot 流程写入)。deploy 侧补一刀「起 Lead 前无条件删本 slot 的 session-id」(fresh 语义:测试 Lead 本就不该跨轮 resume)。
- manifest 清理 **HEAD 已有**(`test-teardown.sh:486-497` 删 `${PROJECT_NAME}-${AGENT_ID}.json`,测试在 test-deploy-multilead.test.sh:368-405/443-480)— 本次审计看到的残留属于「teardown 未跑」路径,非缺功能,不列新工作。
- campaign manifest(`test-deploy.sh:1227-1230`)把 `leadWorkspace` 写成全局 `$HOME/.flywheel/lead-workspace/<agent>` — extra-lead workspace 隔离须连 manifest/abort cleanup/teardown 一起改(消费同一字段)。

## 6. Bridge 对缺席 Lead 的容忍(`packages/teamlead/src/bridge/plugin.ts`)

- 718-830 `createLeadRuntime()`:mailbox backend(默认)只做 transport preflight;CommDB(rollback)才查 lease 活性。
- 4335-4374 boot 注册:runtime 创建失败 → 进 `unregisteredLeads`,**30s 定时重试注册,不 crash**("Late-registered runtime")。注意:mailbox 默认路径的 preflight 不依赖 Lead 进程存活,通常**一次注册成功**(不会反复 retry 打日志)— `--no-lead` 的可行性依据是「注册失败也软处理」这层保险,不是「必然走 retry」。
- `--no-lead` 还须处理 Lead-only 前置段:`test-deploy.sh:820-980`(identity 生成到 :961,**shared Lead rules staging 到 :980**)无条件解析生产 identity 模板 + staging rules;Bridge failure path `:1462-1475` 无条件引用 `LEAD_BG_PID`;输出 JSON `:1508-1544` 假定 `LEAD_LOG` 已赋值。fake-HOME 下 rules 段只 warn 不 fail — 测试必须用 sentinel 源目录断言「未被读取/staging」,否则 /health 通过不能证明该段被跳过。

## 7. marketplace 注册(`~/.claude/plugins/known_marketplaces.json`)

- `matt-skills` 条目(:42-47):**嵌套字段** `.source.path` 与顶层 `.installLocation` 均指 `Dev/flywheel/worktrees/fly1356-qa529/vendor/matt-skills`;`~/.claude.json:6639` 另有安装记录。hygiene 扫描必须独立覆盖 `.source.path` 与 `.installLocation` 两字段(只写 `path` 会漏嵌套形态)。
- 修指目标两候选(主仓 `vendor/matt-skills`(随 FLY-1356 merge 落地)或 `~/.flywheel/marketplaces/` 独立 copy),implement 时按 1356 merge 时序定(Lead 已确认两可)。

## 7b. 全局路径 writer 盘点(write-time 防线的覆盖集)

验收判据是「任何目录跑安装脚本,**全局配置**零临时路径」— 覆盖面是**所有全局持久化面**(`~/.flywheel` 生效态、`~/.claude` settings/plugins、LaunchAgents plist 等),不只 `~/.flywheel/bin` 字面。已确认 writer 五个(Codex R1+R2 实核):
1. `sync-flywheel-hooks.ts::syncFlywheelCliBin()`(Bridge boot,全局 bin symlink);
2. `scripts/converge-flywheel-bin.sh`(内容拷贝 converge,Lead start / daily / pre-kickstart);
3. `scripts/flywheel-cmux-install.sh:6-21`:自身位置推导 REPO_DIR + `ln -sf` 两个 symlink;
4. `scripts/install-hooks.sh:4-5,27-41`:把执行 checkout 的**绝对路径**写进全局 `~/.claude/settings.json` 的 hook command — 从 worktree 跑一次即全局持久化 worktree 路径(R2 BLOCKER 实证);
5. `scripts/provision-fleet-host.sh:22-28,332-360`:默认 home/state 目的地下的全局内容 writer(hermetic 测试用显式假 `--home`,须保留)。
其余候选(hooks/install-restart-guard.sh、daemon/standup 等)implement 期按「全局持久化面」口径复核,接判据或列明不接理由。

## 7c. macOS 路径 canonical 事实(Codex R1 实测)

`/var` 是 → `/private/var` 的 symlink:`realpath(/var/folders/...)` = `/private/var/folders/...`。temp 前缀集合必须同时含 `/tmp`、`/private/tmp`、`/var/folders`、`/private/var/folders`,且对 **canonical 化后的路径** 判;`.git`-文件判据只对 checkout **root** 成立,对 symlink 深层 target 须先向上找 owning repo root。本 worktree 自身路径不含 `/worktrees/`(`~/Dev/flywheel-FLY-1389`)— 「路径含 /worktrees/」类命名启发注定漏检,`.git`-文件判据是唯一可靠信号。

## 8. 评估项事实(P3,不改代码)

- `packages/config/src/ConfigLoader.ts:349-364`:`qa.auto` 可选布尔,缺省 off — 房内 config 无 `qa:` 块即默认关,合理。
- `packages/token-usage/src/classifier.ts:50-63`:cwd 含 `flywheel-test-slot`(还有 `/scratchpad`、`claude-501`)→ `kind:"sandbox"`;`aggregator.ts:139-142` 以 `(sandbox)` 桶 surface 不隐藏。transcript 直读配方(FLY-1356 已实践)写进 `packages/qa-framework/README.md`。

## 9. 测试基建现状(TDD 落点)

- `scripts/__tests__/test-deploy-multilead.test.sh` / `test-deploy-qa-room.test.sh`:hermetic 模式先例(A1-A3 字节兼容断言)— 新 flag/env sanitize/no-lead 的断言照此形态加。
- `scripts/__tests__/converge-flywheel-bin.test.sh`:hermetic fake-repo 模式 — hygiene/断链段测试照此扩。
- `packages/teamlead/src/__tests__/sync-flywheel-hooks.test.ts`(:339 有 bin 测试段)— canonical 守卫单测落点。
- 平台注意(FLY-1285 教训):守卫判据(`.git` 文件形态、tmp 路径)在 macOS 真机各验一次,不许只靠 hermetic stub;负向断言配突变验证(把守卫关掉确认测试变红)。

## 10. 风险点登记

1. `.git`-文件判据对 **submodule** 也成立(submodule 的 .git 也是文件)— 本仓无 submodule 部署形态,风险低;守卫报错文案写明判定依据 + env 逃生口即可。
2. packaged 树(`.flywheel-prebuilt`)与 fleet 多机(FLY-247 host.json)repoRoot 合法多样 — 判据刻意选「拒临时形态」而非「限定唯一路径」,两类合法形态天然放行。
3. resume 预检的 transcript slug 规则属 Claude Code 内部约定,无稳定 contract — 预检**永不改动 session 状态**(纯诊断日志);删除权归计数器阈值修复(生产)与 deploy 前置删(测试房)。
4. `--no-lead` 下 mailbox 注册通常一次成功;30s retry 只是注册失败时的软兜底,不是常态日志。
