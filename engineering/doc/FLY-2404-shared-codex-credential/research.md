# FLY-2404 全机一份 Codex 凭据 — 调研

Issue: FLY-2404 (https://linear.app/geoforge3d/issue/FLY-2404/codex凭据-全机只用一份-codex-凭据runnerleadraya-的每个-codex-home-不再各存一份-authjson)
日期: 2026-09-06
基于: exploration.md

## 1. 调研目标

exploration.md 已定方案 A(每个 home 一条 symlink 指向主机真身 `~/.codex/auth.json`)。本文回答「仓库里每一个碰 auth.json 的地方在方案 A 下会怎样」,给 plan 一张可逐项勾掉的改动清单,并把几处设计细节定死(真身路径怎么配、identity 校验怎么保、分类器怎么改、清理脚本的活体判据)。全部行号以当前工作树(main 8126576cf)为准。

## 2. auth.json 消费者全清单与处置

图例:**改** = 必须改代码;**保** = 保持原样且是方案成立的守卫;**验** = 行为已正确,只需加回归测试或改注释;**—** = 不受影响。

### 2.1 出生引擎 `packages/claude-runner/src/codex-home.ts`

| 行 | 现状 | 方案 A 下 | 处置 |
|----|------|----------|------|
| 1-27 模块注释 | 「只复制 auth.json + config.toml 进新家」 | 前提反转 | 改注释 |
| 593-596 `sourceCodexDir()` | `FLYWHEEL_CODEX_SOURCE_HOME` ‖ `~/.codex` | 真身目录就是它;不再引入第二个变量 | **保**(真身路径 = `join(sourceCodexDir(env), "auth.json")`,新导出 `codexCredentialTruthPath(env)`) |
| 637-669 `readCodexSourceAuth()` | lstat 拒 symlink + `O_NOFOLLOW` + identity 校验 | 真身必须是普通文件,这条是全机唯一允许「不是链接」的地方 | **保**,并把错误信息改成「truth must be a regular file」 |
| 1406-1413 `provisionCodexHome()` legacy 路径 `atomicManagedWrites:false` | `writeFileSync` 跟随 symlink ⇒ 重 provision 会**写穿真身并 chmod 真身** | 致命 | **改**:auth.json 不再经 `writeManagedFile`,改走新 `linkCredentialTruth(home, truthPath)` |
| 1638-1697 `provisionCodexAgentHome()` keyed 路径 `atomicManagedWrites:true` | `atomicWriteFile` tmp+`renameSync` ⇒ **把链接换回普通文件** | 静默回到副本世界 | **改**:同上,同一个函数 |
| 1508-1510 | `writeManagedFile(destAuth, sourceAuth.raw)`;`.active` 写 profile | 副本制造点 | **改**:`linkCredentialTruth`;`.active` 照旧(记录 spawn 时真身 profile,供 ledger/审计) |
| 1573-1590 ledger `recordCodexAccountObservation` | 按 `fingerprintCodexHome(home)` 记 identity | identity 来自真身,不变 | — |
| 425-442 `atomicWriteFile` | 通用 | 只是不再用于 auth.json | — |
| 1748-1838 / 1970-2017 / 2026-2070 scrub 一族 | 只动 `config.toml` 的 GH_TOKEN 块 | 不碰 auth.json | — |
| 2090-2120 `removeCodexHome` | `rmSync(home,{recursive,force})` | Node `rmSync` 不解引用,只删链接 | **验**:加「删家后真身字节/inode 不变」回归测试 |
| 369-390 `ensurePlainDirectory` | 家目录本身拒 symlink | 家仍是真目录,只有 auth.json 是链接 | — |

`linkCredentialTruth(home, truthPath)` 合同(plan §3.1 落地):
1. 前置:调用方已通过 `readCodexSourceAuth` 校验真身(普通文件、identity 已知);
2. `lstat(<home>/auth.json)`:不存在 ⇒ 建链接;是链接且 `readlink` === truthPath ⇒ 幂等返回;是链接指向别处 ⇒ `unlink` 后重建;是普通文件(旧副本)⇒ 先 `openSync(O_NOFOLLOW)` 读出来做一次 identity 记账(ledger `source:"migrate"`)再 `unlink` 重建;是目录/其他 ⇒ 抛错;
3. 用**绝对路径**建链接(`symlinkSync(truthPath, dest)`;相对链接在 `cpSync` 下会被改写成绝对,见 memory `reference_node_cpsync_rewrites_relative_symlinks_into_absolute`);
4. 建完 `lstat` 复核是链接、`readlink` 等于 truthPath;绝不对 dest 调 `chmodSync` / `writeFileSync`(两者都跟随链接)。

### 2.2 Adapter / daemon

| 位置 | 现状 | 处置 |
|------|------|------|
| `CodexTmuxAdapter.ts:908-912` `assertCodexSourceIdentity` 预检 | 读真身;真身仍是普通文件 | — |
| `CodexTmuxAdapter.ts:943-953` provision 分叉 | 唯一生产调用方 | 随 §2.1 生效,不改调用 |
| `CodexTmuxAdapter.ts:2613-2645` 注释「removes per-runner CODEX_HOME (auth shell + sessions)」 | 措辞 | 改注释 |
| `codex-daemon-runtime.ts:749-755` `CODEX_HOME: opts.codexHome` | daemon 自己读 `$CODEX_HOME/auth.json` | — (symlink 由 Codex 解析,exploration §3.1) |

### 2.3 Operator 工具 `packages/claude-runner/bin/flywheel-codex-profile.mjs` / `codex-account-core.mjs`

| 行 | 现状 | 处置 |
|----|------|------|
| `readSafeFile` 101-122 / `assertReplaceableFile` 124-130 / `assertRegularFile` 45-60 | 拒 symlink | **保**。它们操作的 `--home` 默认是 `~/.codex` = 真身,真身是普通文件 ⇒ 不受影响。把它们指向 runner home 是错误用法,现在会被拒绝,这是正确的 |
| `status` 216-239 | 读 `<home>/auth.json` + `.active` 判 drift | 对真身照常;**改**一处:错误信息里加「if this is a runner/Lead home, its auth.json is a link to the truth; run status against the truth」 |
| `use` 308-332 `atomicWrite` tmp+rename | 只写真身 | — (rename 在真身上是原地替换 inode!见 §3.2) |
| `install-codex-guard.sh:151-178` 全局 shim 钉死 `global_home=$HOME/.codex` | 真身 | — |

### 2.4 Raya / Codex Lead

| 位置 | 现状 | 处置 |
|------|------|------|
| `scripts/lib/lead-address.sh:22-38` `derive_codex_lead_home` → `~/.codex-<key>` | mufasa / infra-bot 在用;`~/.codex-raya` 不存在 | — |
| `packages/teamlead/scripts/run-codex-lead-{mufasa-tui-fullaccess,mufasa-tui,mufasa-fullaccess,mufasa-writecapable,mufasa,raya-tui-fullaccess}.sh`、`run-codex-infra-bot-tui.sh` | 只 export CODEX_HOME,不 provision auth | **改**:启动前调用新脚本 `scripts/codex-home-link-truth.sh "$CODEX_HOME"`(§3.3);`run-codex-lead-mufasa.sh:55-56` 注释「copy the School profile auth there first」删掉 |
| 生产 Raya `~/.flywheel/raya/codex-home` | 仓外 provision;`codex-lead-home-rule.test.sh:64`、`raya-activation-preflight.test.sh:154` 禁止 launcher 指向它 | **跨仓 handoff**:raya 仓库的 launcher 在启动前调用 `codex-home-link-truth.sh`;本仓不新增指向该路径的代码,守卫测试不动 |
| `codex-lead-tui-home.sh:748` `[ -f auth.json ]` | 对有效链接通过,悬空失败 | **验**:补错误提示「(if it is a dangling link, the truth ~/.codex/auth.json is missing — founder must codex login)」 |
| `codex-lead-runtime.ts:225,288,453-506` CODEX_HOME 路径不重叠校验 | 路径级 | — |

### 2.5 健康 / 分类器 / 告警

| 位置 | 现状 | 处置 |
|------|------|------|
| `packages/teamlead/src/bridge/codex-global-health.ts` | 只查 PATH/二进制漂移;`reason` 五种;`plugin.ts:10467-10479` boot + 周期 tick | **改**:增 `credential` 维度(§3.4),新 reason `credential-truth-unhealthy` / `credential-link-drift`,severity severe,复用 `codex_global_unhealthy` meta-alert |
| `codex-lead-tui-home.sh:189-243 classify_auth_dead` + `1149-1163` | remote-control start 失败时,stderr 增量里含 `refresh_token_reused` 等 ⇒ 判死 | **改**:匹配到 `refresh_token_reused` 时先问真身(§3.5);真身健康 ⇒ `benign_refresh_race`,重试一次 start;真身不健康或其他码 ⇒ 原判死路径 |
| `scripts/codex-with-fallback.sh:124-126` | 一次性 wrapper 的 AUTH_EXPIRED 提示 | 改文案:提示看 `codex-global-health` 与真身,而非 `codex-profile status` |
| `packages/teamlead/src/account-heal/account-rotation-notice.ts:8` | 文案「Codex rotates its OWN per-runner auth.json」 | 改文案(纯文本,已有单测锁字) |
| `resident-codex-lead-patrol.ts:139-172` | 路径级 | — |

### 2.6 残留门 / 清扫 / QA 台架

| 位置 | 现状 | 处置 |
|------|------|------|
| `scripts/test-deploy.sh:610` `find cdxh -type f -name auth.json` | 只认普通文件 ⇒ 链接残留**不再触发门** | **改**:`\( -type f -o -type l \)`;链接残留同样是残留(泄露真身位置) |
| `scripts/lib/qa-launchd-lead.sh:247` `-f "$dest/auth.json"` | 有效链接通过 | — |
| `scripts/lib/qa-launchd-lead.sh:253-282` `qa_launchd_retire_codex_home` `rm -rf` | 不解引用 | **验**:现有 `fly1663-qa-launchd.test.sh:975-1035`「source hash unchanged」已经覆盖删家不碰源 |
| `scripts/lib/qa-codex-home-provision.mjs:106-108` 注释「shared birth engine owns credential selection and copying」 | 措辞 | 改注释 |
| `scripts/codex-tui-nudge-probe.sh:264` `[ ! -e auth.json ]` | `-e` 跟随链接,链接存在也算「copied」 | — (语义仍正确:探针家里不该有凭据入口) |
| `packages/teamlead/src/bridge/codex-runner-orphan-reaper.ts:240-300` | 只盘点 | — |
| qa-fly310 read-deny(Seatbelt `/Users/xiaorongli/.codex**` 按解析后路径) | 生产 full-access 不设 `FLYWHEEL_CODEX_LEAD_READ_DENY`;只有非生产 `flywheel-codex-lead-wrapper-mufasa-tui.sh:37` 设了 | **改**:`codex-home-link-truth.sh` 与 Lead launcher 启动前断言「READ_DENY=1 与链接真身互斥」,命中即 fail loud 而非静默 401 |

### 2.7 测试合同(现有断言在方案 A 下的命运)

| 测试 | 现断言 | 命运 |
|------|--------|------|
| `test/codex-home.test.ts:1847-1866` seeds auth.json 0600 | `statSync` 跟随链接 ⇒ 仍 0600 | 改成 `lstat` 断言是链接 + `readlink` === 源;真身 0600 |
| `:1730-1752` 字节相等 + `.active` + ledger | 经链接读字节相等仍成立 | 保留,再加 lstat 断言防退化 |
| `:1780-1802` 未知 identity 时不动预存 `auth-canary` | 预存的是普通文件 | 保留(拒绝前不动家) |
| **`:1806-1818` 拒绝 symlink 源** | 真身守卫 | **保留** |
| `:1667-1696` pin 拒绝后 auth.json/.active 字节与 mtime 不变 | `statSync(...).mtimeMs` 跟随链接 ⇒ 会跟着真身 mtime 走 | 改成 `lstatSync` + `readlink` 不变 |
| `test/codex-account-identity.test.ts:132-143` `readCodexAuthIdentity(link)` 拒绝 | 该 API 只应指向真身 | 保留 |
| `test/codex-shim.test.ts:350-360`「拒绝悬空 auth symlink」 | 针对 `codex-profile use` 写真身 | 保留 |
| `test/CodexTmuxAdapter.test.ts:517-531` 未知 identity 零残留 | 不变 | 保留 |
| `test/runner-env-isolation.real-tmux.test.ts:83-105` 探针经 `readFileSync` 读 identity | 跟随链接到测试源 ⇒ identity 相同 | 预期不改即过;跑一次确认 |
| `scripts/__tests__/fly1663-qa-launchd.test.sh:293-343` mode 600 + `.active` + source hash 不变 | `qa_test_file_mode` 用 `stat` 跟随 | 补 `-L` 断言;source-hash-unchanged 是防写穿的关键断言,保留 |
| `fly1663-qa-launchd.test.sh:404-415` 拒绝 symlink 源 | 真身守卫 | 保留 |
| `fly1663-qa-launchd.test.sh:975-1035` 退役后源 hash 不变 | 防 rm 解引用 | 保留 |
| `scripts/__tests__/test-deploy-fly1389.test.sh:653-735` 假 codex 用 `os.replace(tmp, auth_path)` 模拟刷新 | **与真 Codex 行为不符**(真身是 truncate 原地写) | 改 fixture 为原地写,并加断言「刷新后 auth.json 仍是链接」 |

## 3. 定死的设计细节

### 3.1 真身路径

`codexCredentialTruthPath(env) = join(sourceCodexDir(env), "auth.json")`。不新增 `FLYWHEEL_CODEX_TRUTH` 之类第二变量:`FLYWHEEL_CODEX_SOURCE_HOME` 已经是「真身在哪」的唯一开关,测试与 QA slot 都靠它隔离(`test-deploy.sh:901`、`qa-codex-home-provision.mjs:90`)。一个来源,不做镜像词汇。

### 3.2 谁能替换真身的 inode

Codex 自己的 `save` 是原地 truncate 写(inode 不变)。会换 inode 的只有我们的 `flywheel-codex-profile use`(tmp+rename)和 founder 手动 `cp`。换 inode 对 symlink **无害**(链接按路径解析),只对 hardlink 有害 —— 这是 exploration §5 否决 hardlink 的依据。plan 不需要为此加守卫,但探针要在 `readlink` 层校验,不能用 inode 比对。

### 3.3 `scripts/codex-home-link-truth.sh <home>`(Lead / Raya / 手动迁移共用)

- 参数校验:`<home>` 绝对路径、在 `$HOME` 下、是真目录(lstat 非链接);真身 `${FLYWHEEL_CODEX_SOURCE_HOME:-$HOME/.codex}/auth.json` 是普通文件、0600、JSON 可解析。
- 活体守卫:`pgrep -f` 该 home 路径的 `codex` 进程 ⇒ 拒绝(退出码 3,「switch only in the shuttle restart window」)。允许 `--force` 但要求 `FLYWHEEL_CODEX_LINK_TRUTH_FORCE=<home>` 显式指名(与 FORCE_PUSH_ACK 同款一次性 ack)。
- READ_DENY 互斥:`FLYWHEEL_CODEX_LEAD_READ_DENY=1` ⇒ 退出码 4。
- 幂等:已是指向真身的链接 ⇒ 退出 0 不动。
- 旧副本:`mv auth.json auth.json.pre-fly2404.<ts>`(0600,同目录)再 `ln -s`;备份文件在 `--purge-backup` 时删除。**不打印任何文件内容**。
- 输出一行:`[link-truth] home=<home> state=linked|already|refused reason=<...>`。

### 3.4 `codex-global-health` 的 `credential` 维度

输入:真身路径、家清单(`~/.flywheel/codex-homes/agents/*/*`、`~/.codex-*`、`FLYWHEEL_CODEX_EXTRA_HOMES` 里列的 Raya home)。判定:

| 检查 | 失败 reason | severity |
|------|-------------|----------|
| 真身 lstat 普通文件、0600、JSON 可解析、`tokens.access_token` JWT 有 exp | `credential-truth-unhealthy` | severe |
| JWT exp − now < 30 min(刷新窗口是 5 min,给探针提前量) | `credential-truth-expiring` | warning(不 page;若下一 tick 仍未刷新且 < 5 min ⇒ severe) |
| 每个家 `lstat(<home>/auth.json)` 是链接且 `readlink` 等于真身 | `credential-link-drift`(detail 列出漂移的家) | severe |
| 家里 `auth.json` 是普通文件(未迁移的 Lead) | 同上 | severe(班车窗口前 warning:由 `FLYWHEEL_CODEX_LINK_DEADLINE` 之前只 warn) |

**不做**:`codex exec` 探活(消耗配额,usage limit 与凭据死不可区分);也不解析 refresh token。

Alert body 固定尾句:「founder 在主机 `codex login` 一次即可全机恢复;活体进程不需重启」。

### 3.5 Lead TUI 分类器的「真身裁决」

`classify_auth_dead` 命中 `refresh_token_reused` 时追加一步:读真身 JWT exp;若 exp − now > 5 min(真身健康)⇒ 认定为良性竞争输家,`AUTH_DEAD_CODE=""`,返回 1(不判死),外层对 start 失败重试一次;否则维持原判。`refresh_token_invalidated` / `token_revoked` / `token_expired` / `could not be refreshed` 不走这条(它们不是竞争产物)。QA 用例:stderr 增量含 reused + 真身健康 ⇒ 不 die;含 reused + 真身 exp 过期 ⇒ die。

### 3.6 一次性清理脚本 `scripts/codex-home-credential-sweep.mjs`

- 范围:`~/.flywheel/codex-homes/<execution-id>/auth.json`(legacy execution home;**不碰** `agents/` keyed 家、不碰 Lead/Raya 家、不删家目录)。
- 活体判据(三条全满足才算无活体):(1) 目录名不在 CommDB `sessions` 表(`~/.flywheel/comm.db`,只读打开)且不在 Bridge `/sessions` 快照;(2) 没有任何进程的环境含 `CODEX_HOME=<home>`(`ps -E` 扫描);(3) 家里没有 `.lease`/lease 文件。
- 默认 dry-run 打印计数与前 20 个候选;`--apply` 才 `unlink`(只删 auth.json,家保留);输出 JSON 报告到 `~/.flywheel/reports/fly2404-sweep-<ts>.json`。
- 不是 Bridge 常驻逻辑,不进 orphan reaper。

## 4. 未验证 / 留给 QA 的点

1. 撕裂读(exploration §3.4)无法可靠复现,plan 只写「探针不把单次瞬时失败判死」。
2. `runner-env-isolation.real-tmux.test.ts` 预期不改即过,实现节点跑一次确认;该测试族要排除 `tmux-viewer.macos.test.ts`(memory 红线)。
3. Raya 仓库 launcher 的接入是跨仓 handoff,本仓 QA 只能验证脚本本身;Raya 切换后一个班车周期的 `codex-global-health` 全绿由 QA 节点在班车窗口后采证。
