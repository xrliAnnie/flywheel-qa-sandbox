# FLY-2274 切换窗口脚本与恢复件 — 实施计划
Issue: FLY-2274 (https://linear.app/geoforge3d/issue/FLY-2274/cutover窗口件-fly-2264-手册要求的-5-个窗口脚本-supervisor-恢复件审过hash-固定可演练)
日期: 2026-09-02
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` and
> `superpowers:test-driven-development`; execute inline in this TURN-owned worktree, one RED→GREEN batch at a time.

**Goal:** 交付 FLY-2264 窗口所需的受审 supervisor、旧 tmux stop、phase-b、自动验收与 hash 安装载体，
使操作者无需现场改脚本即可演练并开窗。

**Architecture:** 小型 source-only libraries 统一 launchctl fail-closed 分类与 exact tmux inventory；
窗口脚本只通过参数、固定文件名和 JSON artifacts 通信。所有 destructive target 在首个 mutation 前完整
预检，执行后重新以同一 authority 闭合。

**Tech stack:** Bash 3.2-compatible shell、jq、launchctl、ps/lsof/pgrep/file、tmux、Homebrew、curl、
现有 Flywheel gate/cmux/path hygiene scripts。

---

## 0. 不变量与文件地图

### 新增 production artifacts

- `scripts/cutover/FLY-2264/generate-supervisor-labels.sh`：枚举/校验 19 个 supervisor，stderr 打印排除项，stdout 只输出 labels。
- `scripts/cutover/FLY-2264/supervisor-labels.txt`：2026-09-02 样本（Bridge、liveness probe、watcher、16 Leads）。
- `scripts/cutover/FLY-2264/lib/launchd-window.sh`：plist Label、launchctl loaded/absent、updater enabled fail-closed primitives。
- `scripts/cutover/FLY-2264/bootout-supervisors.sh`：先写完整 recovery，再 bootout loaded labels并证明 absent。
- `scripts/cutover/FLY-2264/restore-supervisors.sh`：Bridge-first，只 bootstrap 原先 loaded 的 exact plist并闭合原状态；兼作 §5.5 正向恢复。
- `scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh`：host tool 与 stop script 共用 exact extractor；
  stop/verifier可选用launchctl coalition做local ownership decoration，不改变host receipt shape。
- `scripts/cutover/FLY-2264/stop-old-tmux-servers.sh`：union全量预检、只豁免exact atlas coalition
  tuple/socket、out-of-scope evidence report、fresh closure。
- `scripts/cutover/FLY-2264/phase-b-link.sh`：30 秒外层预算中的六条逐字合同。
- `scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh`：七项 JSON artifacts + hash summary。
- `scripts/cutover/FLY-2264/install-window-artifacts.sh`：0700 staging/install + sha256 manifest。

### 新增 tests

- `scripts/__tests__/fly2264-supervisor-window.test.sh`
- `scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh`
- `scripts/__tests__/fly2264-stop-old-tmux-real.test.sh`
- `scripts/__tests__/fly2264-phase-b-link.test.sh`
- `scripts/__tests__/fly2264-verify-native-cutover.test.sh`
- `scripts/__tests__/fly2264-install-window-artifacts.test.sh`

### 最小既有文件修改

- `scripts/host-terminal-cutover.sh`：source shared inventory library，保持 CLI/receipt JSON 不变。
- `scripts/__tests__/host-terminal-cutover.test.sh`：characterization 断言 refactor 前后 inventory shape 相同。
- `scripts/restart-services.sh`：`leads-restart-status.json` additive 保存既有 `total`。
- `scripts/test-restart-services.sh`：断言 healthy/degraded terminal status integer total。
- `engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md`：补 installer/hash/fresh census、§4.3/§7.1
  Flywheel-vs-foreign判据、§5.5 forward restore 与 §8.2 recovery命令。
- `.github/workflows/ci.yml`、`scripts/__tests__/ci-shell-suite-manual-only.txt`：分类六个新 shell suites。
- `engineering/doc/milestones/FLY-2274.md`：PR literal last commit。

所有测试只在临时 HOME/PATH/socket/repo 执行；任何测试 ledger 出现 production label target、
`/opt/homebrew/bin/brew link` 真调用、`request-restart.sh` 或非 fixture socket 都立即失败。

## 1. Supervisor manifest、bootout 与 recovery（第一批）

### 1.1 RED：generator/sample

在 `fly2264-supervisor-window.test.sh` 先建立 19 个合法 plist + 明确排除 updater/auxiliary 的临时
LaunchAgents。测试：

- generator stdout 逐字等于 sorted 19 labels，包含 `com.flywheel.bridge-liveness-probe` 与 16 Leads；
- stderr 逐条列出 updater 与所有 auxiliary 排除 labels；stdout 不混诊断；
- 缺 fixed label、零 Lead、symlink plist、filename/Label mismatch、duplicate Label、不可解析 plist 均非零；
- `supervisor-labels.txt` 逐字等于 production只读 census 的19-label样本，且无 updater/auxiliary。
- bootout在任何launchctl mutation前调用generator并要求live census与传入sample逐字相等；新增/缺失label
  阳性对照必须红且bootout ledger为空。
- 19项中任一pre-existing unloaded必须在完整recovery publish后、首个bootout前红，mutation ledger为空。

运行：

```bash
bash scripts/__tests__/fly2264-supervisor-window.test.sh
```

预期 RED：脚本/样本不存在。

### 1.2 GREEN：generator 与 library

实现 generator 与 `lib/launchd-window.sh`：

- 用 Python `plistlib` 从 regular non-symlink plist 取唯一 Label；
- allowed predicate 只含 bridge、bridge-liveness-probe、watcher、lead.*；updater explicit forbidden；
- launchctl classifier 只把 rc=0 解释 loaded、known-not-found 解释 absent；
- updater `print` + `print-disabled` 判据复用 `request-restart.sh` 语义；
- 所有 label/path/JSON string 拒绝 CR/LF 与 unsafe 字符。

运行 supervisor test，直到 generator 组 GREEN。

### 1.3 RED→GREEN：bootout/recovery

逐个加入测试并先看 expected failure：

1. 全 loaded：recovery 在首个 bootout ledger 前已存在且包含 19 个 exact path/loaded=true；bootout 后
   fresh generator重新枚举的全部in-scope labels均known absent，updater前后 loaded+enabled。
2. 混合 loaded/unloaded：bootout在任何mutation前失败且recovery保存false；standalone restore fixture
   Bridge-first，只bootstrap原loaded，false条目仅断言absent；正向全loaded fixture的bootstrap顺序必须是
   Bridge、liveness、watcher、Leads。
3. bootout rc非零、post-print仍 loaded、unknown absence诊断、print transport failure、malformed recovery、
   wrong uid/path/Label、updater present/disabled/unloaded、bootstrap failure 每条都点名 label并非零。
4. 失败在第 N 个 label 时 recovery 已完整可用；restore 不调用 `install-bridge-launchd.sh`、kickstart、
   bootout 或 updater mutation。

GREEN 后运行：

```bash
bash -n scripts/cutover/FLY-2264/*.sh scripts/cutover/FLY-2264/lib/*.sh
bash scripts/__tests__/fly2264-supervisor-window.test.sh
```

检查 inbox，提交并 push：

```bash
git add scripts/cutover/FLY-2264/generate-supervisor-labels.sh \
  scripts/cutover/FLY-2264/supervisor-labels.txt \
  scripts/cutover/FLY-2264/lib/launchd-window.sh \
  scripts/cutover/FLY-2264/bootout-supervisors.sh \
  scripts/cutover/FLY-2264/restore-supervisors.sh \
  scripts/__tests__/fly2264-supervisor-window.test.sh
git commit -m 'feat(FLY-2274): add supervisor window recovery artifacts'
git push -u origin flywheel-FLY-2274
```

随后 `progress --phase implement --cursor 3/8 --set-chunk supervisor=done` 并向 Lead 发 30 分钟报告。

## 2. stop-old-tmux-servers（第二批）

### 2.1 RED：锁住现有 extractor

先扩 `host-terminal-cutover.test.sh`，断言 processInventory entry keys、空 inventory、image extraction
failure 与 pgrep transport failure；运行确认新增 shared-library existence assertion RED，原有 shape 用例
仍 GREEN。

### 2.2 GREEN：抽 shared library

把 `extract_tmux_image`/`inventory_tmux_servers` 无语义变化搬进
`lib/tmux-process-inventory.sh`；host tool 设置 jq/die callbacks 后 source。运行完整既有 host cutover test，
要求 receipt golden 与 rc 不变。

### 2.3 RED：hermetic stop branches

`fly2264-stop-old-tmux-servers.test.sh` 用 stub pgrep/ps/lsof/file/launchctl/OLD_TMUX ledger覆盖：

- 3 条 server + 1 条 attach client union 正向逐 socket分类，只 stop servers，client无kill调用；
- `launchctl print pid/serverPID`唯一resource coalition name：只有exact
  `com.xiaorongli.atlas-growth`=reviewed exemption，stdout/report含label/socket/image且kill ledger无它；其它
  coalition全部in-scope；zero/multi/malformed/transport coalition=unknown并在首个kill前红；不以socket
  basename或default/atlas allowlist分类；
- attach client不按自身cmux coalition分类，而是用其socket probe得到server PID并继承server scope；
  Flywheel server的cmux client必须进入bounded reap，atlas socket client随atlas exemption；
- absolute OLD_TMUX、`tmux 3.5a`、JSON exact schema/unique tuple/old image 全部预检；
- union外non-exempt/unknown live tuple、PID reuse、start unreadable、image变化、socket消失/多归属、
  server/client command ambiguity、client probe pid/path mismatch、kill失败、post tuple仍存、kill后新
  non-exempt/unknown server、pgrep/lsof/file/ps/launchctl transport failure均非零；exact atlas respawn只更新report；
- union tuple在preflight前已自然退出记`satisfied_vanished`并继续；所有server停后known clients以targeted
  PID+lstart最多10秒reap，再执行一次final full census，超时与final残留分别红；
- 每条 unknown 以 JSON 或稳定文本列出；任何 preflight failure 的 kill ledger 必须为空；源码 grep 禁止
  `pkill` 与 default/atlas-only循环。

### 2.4 GREEN + 真实私有演练

实现 stop 脚本：一次initial full census+全量role/server-coalition分类；除exact atlas exemption外都取target，每target前
只重证该PID lstart/command/image/socket/coalition，
kill后轮询该tuple；known clients targeted bounded reap后恰好一次final full census闭合，确保约30个server
仍在120秒预算内。再写real test：

- 用 `/usr/local/Cellar/tmux/3.5a/bin/tmux -S <mktemp socket>` 启 3 个 target + 1 个 control；
- 用 shared extractor 生成只含3 targets的 union；为避免 control 成为 unknown，真实演练在隔离 process
  inventory wrapper中只暴露 target PIDs，同时独立用真 client验证 control；
- stop 后 target PID/start tuples与 sockets消失，control socket仍可 `display-message`；
- trap 仅 exact client + exact temporary sockets，绝不访问 production socket。

运行：

```bash
bash scripts/__tests__/host-terminal-cutover.test.sh
bash scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh
bash scripts/__tests__/fly2264-stop-old-tmux-real.test.sh
```

检查 inbox，提交、push、progress `stop_tmux=done`。

## 3. phase-b-link（第三批）

### 3.1 RED

`fly2264-phase-b-link.test.sh` 首先把backslash continuation规范化后静态断言 runbook §5 六个logical
commands逐字存在，再复制脚本到 temp 并只替换
absolute brew/tmux/Cellar paths为 stubs。依次运行：

- 全绿：ledger只有 `brew link tmux`、`brew pin tmux`、`tmux -V`、`file`、`brew list --pinned`；
- link/pin rc、realpath、version、file无arm64、pinned无tmux六个负例逐项非零并打印固定 item id；
- ledger/source不得出现 unlink、upgrade 或其它 formula。

预期 RED：脚本不存在。

### 3.2 GREEN

实现恰好六项、`set -euo pipefail`、`fail item detail`。真实 30 秒由外层 run-step，不在内部加可绕
budget seam。运行 `bash -n` + phase test，提交、push、progress `phase_b=done`。

## 4. verify-native-tmux-cutover（第四批）

### 4.1 RED：持久化 updater total

在 `scripts/test-restart-services.sh` 断言三种 status fixture `.total` 是integer且等于已有
`leads_total`。确认RED后，最小扩
`write_leads_restart_status(status,failed,skipped,total)` 与调用点，schemaVersion 1 additive，再GREEN。
unloaded supervisors不在 restart-services 内恢复；§5.5 必须先用受审 recovery artifact 达成19/19 loaded。

### 4.2 RED：七项 verifier matrix

`fly2264-verify-native-cutover.test.sh` 建立完整临时 HOME/LIVE_REPO/PATH 与 stub ledger；golden arm含：

- updater status reason=updater, skipped=0, failed=0, total=16, deployed/health双 SHA；
- 16 loaded Lead plists，gate census stub输出 exact counts，四 carrier receipts；
- native realpath/version/file/pin；shared inventory含native in-scope image、old atlas server与连接两个server
  的cmux clients；Flywheel client必须native，atlas server/client单列informational且golden仍pass；
- 16 Lead PID+lstart两侧夹`ps -o pid=,flags=`的hex flags且无P_TRANSLATED；各PID的lsof txt records
  排除AOT/Rosetta runtime/dylib后必须唯一main image，`file -b`含arm64 slice（universal x86_64+arm64
  通过），与各一actual child；固定
  `/bin/bash` native control sysctl=0单列且不归因给Lead；
- watcher loaded、owner exact tuple、fresh heartbeat，cmux verify-sidebar JSON pass；
- Bridge/Lead PATH native-first，source-tree hygiene pass。

测试另含Darwin real `/bin/ps -o flags=` native positive control；若live P_TRANSLATED PID存在则做real
negative control，否则明确skip，不能由stub替代。Lead/child的universal arm64-capable fixture在flags=0时
通过、P_TRANSLATED置位时失败；x86-only main image即使flags=0也失败。
`ps comm`因macOS 16字符截断不得参与identity/allowlist；identity仅PID+lstart。
golden生成七份0600 JSON + summary并 exit0。然后表驱动逐项破坏至少一条：bad/missing total、failed>0、
SHA mismatch、15/17 Leads、census parse/rc、receipt mismatch、wrong link/version/arch/pin、non-exempt
legacy/new/unknown-owner tmux、old cmux client、lstart drift、translated/actual x86、watcher owner/heartbeat/sidebar、PATH
reverse、hygiene rc。
每臂必须对应 artifact status=fail + 总 rc非零；producer invalid JSON/transport failure不得伪造 pass。

### 4.3 GREEN

实现 verifier common helpers：safe regular file、atomic artifact、capture rc/stdout/stderr且只保存bounded
非秘密摘要、exact PATH parser、launchctl/ps identity recheck。cmux双snapshot先独占执行，其余六个producer
并行写各自temp/artifact；Bash 3.2 `kill -0` exact-PID poll共享110秒deadline，超时TERM+bounded reap并为
所有未完成producer写fail artifact。summary记录duration与sha256。artifact明确区分
`actualProcessTranslatedFlag` 与 host-only `nativeControlTranslated`。

运行 verifier test、restart status regression、`bash -n`，提交、push、progress `verification=done`。

## 5. 0700 installer + manifest（第五批）

### 5.1 RED

`fly2264-install-window-artifacts.test.sh`：

- 在 absolute 0700 temp WINDOW_DIR 安装全部 scripts/sample/libs；所有 installed files 0700；
- `sha256-manifest.txt` 0600、排序、无绝对 source path、无自指，`shasum -a 256 -c` 全过；
- 改一字节后的阳性对照必须让 `shasum -c` 红；
- relative/symlink/wrong-mode/wrong-owner destination、source symlink/missing artifact、staging collision均零发布或非零；
- repeated install 要么 exact idempotent，要么在 mutation 前 fail，不能留新旧混合集。

### 5.2 GREEN

实现同 parent staging + 完整 hash verify + atomic publish，manifest 最后发布；同步给runbook §1添加installer、
manifest check、generator fresh diff，§0.6命名受审restore为唯一bootstrap例外，§5.5添加 Bridge-first
forward restore/fail-closed预期，§8.2添加literal recovery restore命令。另说明quota-monitor gate refusal会在
monitor启动前退出、可能产生预期alert；§4.3/§7.1明确只豁免positive
`com.xiaorongli.atlas-growth` server及其socket clients，不bootout/不kill、不动plist，只写
label/socket/image informational；其它coalition/clients仍in-scope，unknown红。
运行 installer test，再在 temp
目录执行实际 installer与 `shasum -c`，保存命令输出到 progress摘要（不提交临时 artifact）。提交、push、
progress `installer=done`。

## 6. 聚焦与全仓 verification

使用 `superpowers:verification-before-completion`。先查 inbox，然后运行：

```bash
bash -n scripts/cutover/FLY-2264/*.sh scripts/cutover/FLY-2264/lib/*.sh \
  scripts/__tests__/fly2264-*.test.sh
bash scripts/__tests__/fly2264-supervisor-window.test.sh
bash scripts/__tests__/host-terminal-cutover.test.sh
bash scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh
bash scripts/__tests__/fly2264-stop-old-tmux-real.test.sh
bash scripts/__tests__/fly2264-phase-b-link.test.sh
bash scripts/__tests__/fly2264-verify-native-cutover.test.sh
bash scripts/__tests__/fly2264-install-window-artifacts.test.sh
bash scripts/test-restart-services.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-structure.test.sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

若 `command -v shellcheck` 成功，再对所有新增/修改 shell 运行 shellcheck；不存在则在 handoff 说明。
任何失败先读 `superpowers:systematic-debugging`，写/保持能复现的 RED，再修最小代码。

完成审计还要 grep 证明：

- production mutation只存在窗口脚本，tests没调用生产 label/socket/brew/restart；
- no `pkill tmux`、no `install-bridge-launchd.sh`、no unlink/upgrade、no env feature switch；
- 每个显式交付物、失败分支、positive control与 JSON artifact均有测试命名对应。
- 五个hermetic suites在ci.yml literal enumeration；Darwin-only真3.5a suite在manual-only且带Darwin guard、
  portable temp root；enumeration/ci-structure均GREEN。
- installer与tests的mode/owner probe先GNU `stat -c`再BSD `stat -f`；file/shasum输出在Ubuntu suite用stub
  固定，不依赖BSD格式；新增独立FLY-2274 CI step，不改被ci-structure逐字锁住的FLY-1364 step。

## 7. Code review、milestone 与 PR

1. `stage set code_review`。
2. 按 runner contract 用 `codex:rescue` 支持的仓库入口跑本头 review；同时注册
   `gate review_code --no-block` + `request-review --type code`，poll `reviewVerdict`。
3. CHANGES_REQUESTED：对每个 blocking finding先写/确认 RED，修复、跑聚焦+全仓门、commit/push，
   新开 questionId 新一轮；APPROVED advisories 用 `ask --report` 转 Lead。
4. review通过后再次 inbox。新增 `engineering/doc/milestones/FLY-2274.md`，把它作为 literal last commit；
   不再 progress commit或修改代码。
5. push，`gh pr create`；不 merge、不 deploy、不 dispatch QA。
6. 对 Lead instructions `ed9043bf-...`、`eb993d4b-...`、`fcf098f6-...` 分别发含完整 id 的 DONE report，
   附 commits/PR/verification。
7. `complete --route needs_review --pr NUMBER`，park实现 phase，等待 DAG controller。

## 8. 逐项完成审计

- [ ] 19-label generator/sample包含 bridge-liveness-probe，stderr列全部排除项，updater永不进 manifest。
- [ ] bootout前完整0600 recovery；每个 loaded label bootout后known absent；updater前后loaded+enabled。
- [ ] supplied manifest与fresh live census逐字相等；post-bootout fresh scope零loaded，drift在mutation前红。
- [ ] bootout前19/19 loaded；pre-existing unloaded保存recovery后红且零mutation，确保§5.5/§7 count可达。
- [ ] restore Bridge-first且只bootstrap original plist/original loaded entries，不调用安装器/kickstart/bootout；
  runbook §5.5在§6发票前调用并说明old-code fail-closed循环是预期过渡态。
- [ ] stop按command/socket区分server/client，只stop server；每次target fresh PID+lstart+image+socket重证，
  launchctl server coalition只豁免exact atlas，client继承server scope；atlas evidence不kill，unknown红；
  vanished tuple satisfied，non-exempt clients bounded reap，initial/final full census在120秒预算内，无new in-scope server。
- [ ] 3 target真3.5a server消失、control private socket存活，无生产socket访问。
- [ ] phase-b六个logical commands逐字，六个故障阳性对照变红，无unlink/upgrade/其它formula。
- [ ] verifier七项各写JSON，updater skipped/failed/total皆来自terminal status，failed=0。
- [ ] artifact 04除atlas server/socket clients外所有tmux process native；atlas informational，unknown ownership红。
- [ ] §0.6允许唯一受审restore例外；§5.5达成19/19 loaded后updater wave可达；full gate receipts/PID flags native evidence、
  watcher/sidebar、runtime PATH/hygiene全覆盖。
- [ ] installer 0700 artifacts + 0600 sha256 manifest，tamper control红。
- [ ] bash-n、每个新增test、shellcheck(若有)、lint/build/packages全绿。
- [ ] five hermetic shell suites CI-enumerated、real 3.5a suite manual-only/Darwin-guarded，CI structure绿。
- [ ] code review APPROVED、milestone literal last commit、PR、DONE receipts、needs_review route 完成。
