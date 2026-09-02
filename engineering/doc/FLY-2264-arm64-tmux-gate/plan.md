# FLY-2264 arm64 tmux 门切换 — 实施计划
Issue: FLY-2264 (https://linear.app/geoforge3d/issue/FLY-2264/cutovertmux-fly-2190-落地-载体换-arm64-原生-tmux-先改-host-tmux-selection-gate)
日期: 2026-09-02
基于: research.md

## 0. 目标与裁定

本计划只交付 PR 代码、测试与 founder-gated runbook；本节点不执行 production link、`.env`
写入、server 重启、部署或 merge。host selector 从“只接受 Intel tmux 3.5a”硬翻为“只接受
arm64 tmux 3.7c”，当前 Intel 3.5a 必须成为红色阳性对照。

这不是可先随普通班车部署的“阶段 A”。Lead 对问题
`43f6b1bf-2884-48e1-b0bc-4213bcd463ef` 的锁定裁定是：不增加 staged activation marker/state/
配置旋钮；窗口外不得合入/部署本 PR。Lead 后续裁定
`33dc0da4-c6a3-4621-be79-37893a694059` 进一步锁定唯一 bootstrap 顺序：founder 批卡后由有 ship
权限的工人合入、冻结其它 merge 并证明 `origin/main == CUTOVER_SHA`，但此时**不发部署票**；先在旧
Bridge 上建立耐久 brake、停 supervisor/server、link+pin 3.7c 并写 cmux pin，最后只发一张
`request-restart.sh` 票，让 updater 在宿主已是 arm64 3.7c 后部署新 gate 并重启全舰。这样没有
“新 gate 先出生、却仍选中 Intel”的死区；`install-bridge-launchd.sh` Bridge-only 例外随之删除。

Lead 对问题 `570c6f7d-ab4a-4796-b684-ccb72308e494` 的锁定裁定：

- `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH` 不提升为生产旋钮；继续 test-only 并由 carrier
  sanitize；
- production canonical 直接写死 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`；
- production version/architecture 直接写死 `tmux 3.7c` + arm64；
- runbook 不把 canonical override 写入 `.env`；
- `FLYWHEEL_CMUX_ATTACH_TMUX_BIN` 经 sweep 确认为真实 runtime seam，只能在 founder 窗口与
  link/restart 同事务设置，不能在 PR 代码中先改默认。
- 新默认不得继续兼作 applicability probe：未写 marker、仅装 legacy 3.5a 的宿主也必须进入
  required gate 并失败，不能降级成 not-applicable。

## 1. Gate：TDD 翻转到 arm64 3.7c

### 1.1 RED

先改 `scripts/__tests__/host-tmux-selection-gate.test.sh`：

1. 成功 fixture 使用 canonical `.../Cellar/tmux/3.7c/bin/tmux`、`tmux 3.7c`、`Mach-O 64-bit
   executable arm64`；收据断言同步改为 3.7c/arm64。
2. 新增独立 Intel fixture：被 PATH 选中的 canonical 为 3.5a、版本为 `tmux 3.5a`、file 输出
   x86_64；运行 gate 必须非零，并断言明确的 fail-closed 错误且不产生 pass receipt。
3. 保留 shadow path、host/SHA/TTL/tamper、not-applicable 与 break-glass 负例，不削弱原门。
4. 运行该测试，确认旧实现至少在 arm64 成功 fixture 上 RED；不能只新增一个本来就会红的
   Intel 用例来假装 TDD。
5. 增加 shipped-default 用例：不传 `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH`，在强制
   required 下选 fixture binary，断言错误明确点名默认
   `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`；旧实现应仍点名 3.5a。
6. 增加 hermetic auto-applicability 用例：没有 marker/native probe、只有 legacy 3.5a probe 时，
   gate 必须进入 required 路径并拒绝 Intel，不得输出 not-applicable。测试通过 gate 内置、仅在
   现有 `FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1` + 临时 state root 下开放的
   `test-applicability <marker> <legacy> <native>` CLI 边界传 fixture；production actions 不接受该
   action，也不增加 source 依赖或 env path seam。
7. 两条边界负例：production mode 调 `test-applicability` 必须在任何 probe 前以 test-only 非零；
   TEST_MODE=1 但 state root 不在临时目录也必须非零。不能把 census 的早分派形状复制成未守卫入口。

### 1.2 GREEN

最小修改 `scripts/host-tmux-selection-gate.sh`：

- 顶部注释从 S1 过渡态更新为 FLY-2264 终态选择合同；
- `EXPECTED_CANONICAL` 默认改为 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`；
- 把 applicability 与 expected canonical 解耦：已有 marker 永远 required；否则，已知 legacy
  `/usr/local/Cellar/tmux/3.5a/bin/tmux` 或 native expected binary 任一存在且可执行就 required；
  两者都不存在才 not-applicable。marker 内容只代表耐久适用性，不提供版本回退；
- 在 gate 内定义纯 `resolve_applicability(marker, legacy, native)` helper；production 只传硬编码
  constants，test-only CLI 调同一个函数。gate 继续自包含，不新增 runtime/package closure；
- 版本逐字期望改为 `tmux 3.7c`；
- 架构必须包含 `arm64`，并显式拒绝 `x86_64`/`x86-64`；
- `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH` 的 test-only 限制和所有 wrapper sanitize 保持不变；
- selected → canonical → executable → version → architecture 的 fail-closed 顺序和 receipt schema
  保持不变。
- 把 not-applicable 日志从误导的 `legacy_tmux=$EXPECTED_CANONICAL` 改成同时说明 legacy/native
  probes 均缺失；把 `restart-services.sh` 的 “bound tmux 3.5a carrier” 告警改为中性的
  “required host tmux selection contract”，避免 cutover 后诊断自相矛盾。

完成后运行 gate suite；再运行 census、mount、restart-mount 与 S0-scope 四套邻接测试，修正仅与
新常量/断言直接相关的 fixture，不重构 carrier 生命周期。

## 2. Provisioning：实际 PATH 原生优先门

### 2.1 RED

先在 `scripts/__tests__/path-hygiene.test.sh` 为专用 runtime helper 添加 colon-token-order 单元测试，再在
`scripts/__tests__/provision-fleet-host.test.sh` 添加隔离集成用例，显式传入三种 PATH：

| Darwin PATH | 期望 |
| --- | --- |
| fixture bin → `/opt/homebrew/bin` → `/usr/local/bin` | PASS 并进入所选 phase |
| fixture bin → `/usr/local/bin` → `/opt/homebrew/bin` | 非零，错误点名 native 必须在 Intel 前 |
| fixture bin → `/usr/local/bin`，无 `/opt/homebrew/bin` | 非零，错误点名 native prefix 缺失 |

另保留 native-only、Linux、两 prefix 都没有的对照，证明 clean/portable provisioning 不被
macOS 特例误伤。用
`--only preflight` 作为最小观察点，并加一个非 preflight `--only validate` 负例，证明检查位于
phase loop 前、不能被入口裁剪绕过。PATH fixture 不在同一源码行同时出现 `/opt/homebrew/bin` 与
`/usr/local/bin`；用分开的变量赋值后组合，避免 source-tree hygiene scanner 把刻意逆序的测试
数据误判为 production 声明。先在旧代码上运行，确认 Intel-first/Intel-only 错误地通过。

现有 source-tree scanner 还负责三种**非 PATH**候选行：空格分隔的 node 候选、shell `||` 的 cmux
候选、逗号分隔的 GitHub CLI 列表。真实仓库 GREEN 用例继续锁定这三行仍由 substring scanner
检查，不把它们送进 colon-token runtime helper，也不为它们添加 exception。

### 2.2 GREEN

在 `scripts/lib/path-hygiene.sh` 增加只接受 colon-separated PATH 的专用 runtime helper；它按 exact
token 第一次出现位置比较。既有 `path_hygiene_native_homebrew_precedes_intel` 保持任意源码行的
substring 合同，不强行复用 runtime token primitive，避免破坏非 PATH 候选列表。
`scripts/provision-fleet-host.sh` 从 `main()` 在 host config 解析后、任何 mutation 与 phase loop 前
调用 runtime helper：

- 仅 `FLYWHEEL_PLATFORM=darwin` 适用；
- 按冒号分隔 token 的第一次出现位置比较，不用脆弱的 substring 次序；
- Intel prefix 存在时，native prefix 必须存在且第一次出现更早；
- native-only、两者皆无、非 Darwin 通过；
- apply 失败经现有 `die` 在任何 provisioning side effect 前立即返回非零；
- dry-run 仍渲染完整执行计划并输出醒目警告，计划末尾返回非零，既不误报可执行也不遮蔽
  operator 需要诊断的后续步骤。测试分别锁定 apply fail-fast 与 dry-run plan-visible/nonzero。

不修改 Intel Homebrew 内容、不安装/link tmux、不改 PATH；门只判断并报告。

## 3. Admission brake：有主、耐久的 lease

Lead 对问题 `49219544-a478-4054-bf17-146b7e946ed2` 的最终裁定：`POST /api/admission/pause`
创建/续期有主 lease 并返回 `leaseId`；`resume` 必须携带同一 id。foreign active pause 的覆盖或
resume 返回 409 并保留原 row，删除现有无条件 `resume '{}'` 路径。外层 cutover pause 必须由
`StateStore` 跨 Bridge restart 持久化；当前 `restart-services.sh` 在 Bridge health 后、操作员能续期
前就无人值守 resume，已足以证明竞态；必须删除无主 resume，不能先开放再“立刻 re-pause”。

### 3.1 RED

1. `packages/teamlead/src/bridge/__tests__/pressure-hold.test.ts`：same-owner renew/clear 成功；foreign
   owner renew/clear 失败且 row 不变；文件 DB close/reopen 后 active lease/TTL 仍在；legacy schema
   migration 的 active NULL-owner row 可被首次 owned pause 原子接管，旧 TTL 作废并获得
   server-generated owner。测试名锁定为 `legacy NULL-owner pause is atomically replaced by an owned lease`。
2. `packages/teamlead/src/__tests__/bridge.test.ts`：pause 返回 leaseId；携同 id resume 200；foreign
   pause/resume 409；缺失/非法 id 400；首次创建只接受服务端生成 id，caller 不能自造；GET/health
   不泄漏 reason 或别的 owner capability。
3. `scripts/__tests__/host-terminal-cutover.test.sh`：首次 pause 把 leaseId 写入 dual-clock receipt；
   续期从 receipt 传回同 id；resume body 逐字携带同 id；Bridge restart 后 inspect 仍 active。
4. `scripts/__tests__/restart-services-admission-pause.test.sh` 与 `scripts/test-restart-services.sh`：
   restart 自有 lease 时持有到完整 Lead wave 后才 resume；遇外部 lease 的 409 时明确保留且永不
   resume；Bridge health → Lead wave → resume 时序无开放缺口；跨版本旧 Bridge pause 响应无 id
   时不发无 owner resume，保留 legacy row 给部署后 host owned takeover。旧代码应 RED。
5. `scripts/__tests__/host-terminal-cutover.test.sh` 同时覆盖 `assert-main-sha`：有界 fetch 成功且
   expected=observed 才 rc 0，并在 receipt 记 expected/observed/pass；不匹配也记 observed 后非零；
   fetch 失败、缺失/非法 40-hex expected 均非零且不得拿陈旧 ref 通过；不修改 status/pause 字段。

### 3.2 GREEN

- `admission_pause` 增 `lease_id` 与 idempotent migration；legacy row 为 NULL/unowned。
  StateStore 继续用既有 SQLite singleton + `save()` 持久，不增加第二个状态面。
- StateStore 以带 owner/expiry 条件的单条 SQL 原子 renew/clear：同 owner 可续，expired row 可接管，
  active foreign owner 不覆盖、不删。首次 owned pause 可立即原子替换 active NULL legacy row，
  不等待旧 TTL；旧 expiry/reason 作废，按新请求写入，避免 read-then-write TOCTOU。
- Bridge 首次 pause/legacy takeover 一律由服务端生成足够长的随机 leaseId；caller 只在续期/释放时
  回传响应 id，绝不接受 caller 自造 id。resume 必填；foreign conflict 返回稳定 409 且不泄漏 id。
  health 仍只暴露 active/remaining。
- `host-terminal-cutover.sh` 从 receipt 复用 leaseId 做续期/inspect/resume；`restart-services.sh` 每个
  deploy/rollback 保存自己获得的 id，只释放自己的 lease。若它对旧 Bridge pause 成功但响应无 id，
  保留 legacy row、不发无 owner resume；两脚本删除无 owner resume 调用。
- Lead ruling `16a390ab-59e9-4357-871b-1dc1fcbe792c` 锁定 cutover bootstrap ownership：窗口先由旧
  Bridge/旧脚本写耐久 NULL-owner pause；新 `restart-services.sh` 从 0600 legacy cutover receipt
  识别该事务，在新 Bridge health + build identity 通过后、任何 Lead 波之前，以无 caller id 的首次
  owned pause 原子接管 NULL row。Bridge 返回的 nested `admissionPause.leaseId` 写入 receipt 同目录固定
  0600 handoff；文件写不成即 fail closed、不得启动 Lead 波。
- restart 路径接管来的 lease 永不自行 resume；只有没有 legacy cutover receipt、由常规 restart 从零
  创建的自有 lease 才在完整 Lead 波后 resume。新版 `host-terminal-cutover.sh` 必须从 handoff 导入同一
  id 后才可 renew/resume；handoff 缺失/权限不私有/内容非法均在 API mutation 前失败，成功 resume 后
  才删除 capability 文件。lease id 不经 env、health 或日志交接。
- `request-restart.sh` CLI 与 updater/restart target 解析合同不变。

## 4. Founder window 操作手册

新增 `engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md`。它不再自写另一套 restart/
bootout 顺序，只逐步调用 `scripts/host-terminal-cutover.sh` 的既有状态机：

0. founder 在窗口内批准 ship 卡；本实现节点不 merge，由有 ship 权限的工人执行 self-ship merge，
   立即记录本 PR merge commit 为 `CUTOVER_SHA`，随后冻结**其他 PR** 的 main merge。用受审 post-merge
   工具 `assert-main-sha --expected "$CUTOVER_SHA"` 证明 fresh `origin/main` 相等；此时不发部署票。
   窗口避开 00:00/12:00 班车边界，窗口外不得 merge/deploy。
1. 用 pre-FF 旧脚本 + 旧 Bridge 创建耐久 legacy NULL-owner pause，inspect 后做两次稳定零
   `quiescence`；再执行 `preflight-receipt` → `build-closure` → `rehearse-rollback` 与 native-first PATH
   断言。pause 后的 active-runs/dispatcher/durable-launch-claim/admission-crossing 才是无 runner 权威证据。
2. brake 保持期间依次执行 `bootout-supervisors` → `authoritative-census` → `stop-old-servers`；updater
   必须继续 loaded+enabled，且所有 17 个旧 Intel server 的 PID/start/socket disposition 必须闭合。
3. `phase-b-link` 使用绝对路径 `/opt/homebrew/bin/brew link tmux`，随后 `brew pin tmux`，逐字断言
   `/opt/homebrew/bin/tmux` realpath 指向 3.7c Cellar、版本为 `tmux 3.7c` 且 file 为 arm64。原子写入并
   读回唯一 production 变量 `FLYWHEEL_CMUX_ATTACH_TMUX_BIN`；canonical override 仍 test-only，不写
   `.env`。link 到部署票之间若 KeepAlive 拉起 Lead，旧 gate 会拒绝；admission 已 pause，这是预期
   fail-closed 状态。
4. 再次证明 frozen `origin/main == CUTOVER_SHA` 后，才发**唯一一张**裸
   `bash scripts/request-restart.sh` 票。updater 拉取 CUTOVER_SHA、build，并在已是 arm64 3.7c 的宿主上
   重启 Bridge + 全部 Lead；不调用 `install-bridge-launchd.sh`，不发第二张 services-bootstrap 票。
5. 新 restart 路径在 Bridge health/build identity 通过后、Lead 波之前接管 legacy pause，把 owner id
   写入固定 0600 handoff，并在 Lead 波结束后保持 pause。新版 host tool 从 handoff 导入同 id，续期、
   inspect、quiescence；handoff 找不到即 fail closed，不得 resume。
6. `automated-verification` 使用可观察证据：updater 的 skipped/failed/total 终态、gate 的
   `census pass plists=... generic=... codex-*=...`、逐 Lead launchd health，以及按 **carrier 类**
   的 receipt；不声称存在 16 份 Lead receipt。另验 path/link/version/file、无 Intel tmux image、
   `sysctl.proc_translated=0`、cmux 全 tab attach 与 provisioning native-first。
7. 全绿才以 receipt leaseId `resume-admission` 并删除 handoff。失败保持 brake；link 后默认向前收敛。
   确需回 3.5a 必须另取 founder rollback 授权、先把 3.5a gate 代码通过 frozen-main 正门部署，再停
   3.7c server/unlink/remove cmux pin；不得用 test-only canonical env 绕门。tmux 保持 pinned，未来
   升级另开受审 cutover。

所有验收命令在交付前以只读或 hermetic fixture 形态实际运行；生产 mutation 命令只做 shell
语法/路径审计，不在本节点执行。

## 5. 验证与 review

### 5.1 聚焦门

- `bash scripts/__tests__/host-tmux-selection-gate.test.sh`
- `bash scripts/__tests__/host-tmux-selection-census.test.sh`
- `bash scripts/__tests__/host-tmux-selection-mounts.test.sh`
- `bash scripts/__tests__/host-tmux-selection-restart-mounts.test.sh`
- `bash scripts/__tests__/host-tmux-selection-s0-scope.test.sh`
- `bash scripts/__tests__/provision-fleet-host.test.sh`
- `bash scripts/__tests__/check-global-path-hygiene.test.sh`
- `bash scripts/__tests__/path-hygiene.test.sh`
- `bash scripts/__tests__/host-terminal-cutover.test.sh`
- `bash scripts/__tests__/restart-services-admission-pause.test.sh`
- `bash scripts/__tests__/request-restart.test.sh`
- `bash scripts/test-restart-services.sh`
- `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`
- `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/pressure-hold.test.ts src/__tests__/bridge.test.ts`

### 5.2 全仓门

- `pnpm lint`
- `pnpm -r build`
- `pnpm test:packages:run`
- 每个本 PR 新增的 `scripts/__tests__/*.test.sh`（预计不新增 shell test 文件）

若全包测试出现失败，先证明失败文件/行为是否由本分支改变；不能用局部绿替代全仓结论。

### 5.3 Code review 与 PR

1. 小提交保持 TDD 批次可审计；每批更新 `progress.md`。
2. `stage set code_review` 后，经 `codex:rescue` 发起 request-driven review gate；按
   `reviewVerdict` 处理，blocking finding 修复后必须新开一轮。
3. APPROVED advisories 经 `ask --report` 转给 Lead。
4. 检查 inbox 后创建 `engineering/doc/milestones/FLY-2264.md`，并把 milestone 作为 literal last
   commit；之后不再做 progress commit。
5. push feature branch、创建 PR；不 merge、不 deploy、不触发 QA。
6. 报告完成并运行 `complete --route needs_review --pr <NUMBER>`，交还 DAG。

## 6. 完成审计

本实现节点完成证据必须逐项覆盖：

- gate 默认 canonical/version/arch 已翻转；
- arm64 3.7c 成功收据与 Intel 3.5a 红色阳性对照都由真实 gate CLI 产生；
- 非预期 path/version/arch 仍 fail closed；
- legacy-only 未标记宿主仍进入 required gate，shipped default canonical 有无 override 的独立证据；
- applicability fixture 只经现有 test mode 的专用 CLI 边界注入；gate 仍自包含，production
  mode 与非临时 test root 的负例证明该 action 不可达，且 path/`.env` 无 probe seam 或新 runtime closure；
- provisioning 在 phase 裁剪前强制 runtime native-first，apply fail-fast 且 dry-run 保留完整计划；
- founder window 冻结其他 merge，且两次票前 origin/main 都逐字等于记录的本 PR merge SHA；
- admission pause same-owner renew/resume、foreign 409、Bridge-restart persistence 与
  旧 Bridge NULL-row → 新 Bridge 首次 owned pause 即时接管并废止旧 TTL → receipt-owned resume
  时序都有可执行测试；无条件 `resume '{}'` 已删除；
- runbook 逐字调用 FLY-1944 既有状态机，覆盖 pause/续期/Bridge bootstrap/services bootstrap、
  绝对路径 link、pin、唯一重启正门与按 carrier 类验收，且没有被本 PR 实际执行；
- diff 不含生产 `.env`、Homebrew link、restart 结果或 Intel 其他包变更；
- 全仓门、代码 review、PR 与 completion route 均有权威回执。
