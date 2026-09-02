# FLY-2264 arm64 tmux 门切换 — 调研
Issue: FLY-2264 (https://linear.app/geoforge3d/issue/FLY-2264/cutovertmux-fly-2190-落地-载体换-arm64-原生-tmux-先改-host-tmux-selection-gate)
日期: 2026-09-02
基于: exploration.md

## 当前代码证据

### Gate 的硬锁

`scripts/host-tmux-selection-gate.sh` 当前行为：

- `POST_S1_PATH` 已是 native-first：`/opt/homebrew/bin` 位于 `/usr/local/bin` 前；
- `EXPECTED_CANONICAL` 默认 `/usr/local/Cellar/tmux/3.5a/bin/tmux`；
- 规范化后的选择必须逐字等于 expected canonical；
- `tmux -V` 必须逐字等于 `tmux 3.5a`；
- `file` 输出必须含 `x86_64`/`x86-64`，并再次显式拒绝 `arm64`；
- gate/verify 收据绑定 host、目标 SHA、carrier、mount point、selected/canonical path、版本、
  架构与 900 秒以内 TTL，任何不一致都拒绝。

基线 `scripts/__tests__/host-tmux-selection-gate.test.sh` 为 12/12 通过，但它把 Intel 3.5a
当作成功 fixture，正好证明当前行为与 FLY-2264 目标相反。

### Canonical `.env` 变量不是生产旋钮

gate 在 test mode 中允许 `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH`，但 production mode 会
把非空值判为 test-only。Bridge、generic Lead、voice、quota 及三个 Codex Lead wrapper 都在
调用 gate 前 unset 该变量；`update-flywheel.sh` 和 `restart-services.sh` 的 gate 调用也会清理它。
因此“在 `.env` 设置该变量”当前不会改变生产选择。非阻塞问题
`570c6f7d-ab4a-4796-b684-ccb72308e494` 已获 Lead 明确裁定：保持 test-only override 与 carrier
sanitize，不把 canonical 提升为生产旋钮；生产默认直接写死 3.7c/arm64，runbook 删除该假步骤。

`FLYWHEEL_CMUX_ATTACH_TMUX_BIN` 的情况不同：源码 sweep 证明 carrier 没有清理它，cmux sync
会校验绝对路径与可执行性后把它传给 view attach。本 PR 若硬改该默认会在 founder 窗口前提前切
cmux client，因此保留为窗口 transaction 内写入的唯一 `.env` 变量。

### Applicability 与 expected canonical 耦合会 fail open

没有显式 `required` marker 时，gate 当前用 `EXPECTED_CANONICAL` 是否存在/可执行来推断宿主是否
属于适用范围。把默认 expected canonical 从 Intel 3.5a 直接翻到 native 3.7c 后，一台只有
`/usr/local/Cellar/tmux/3.5a/bin/tmux` 的旧宿主会被判为 not-applicable，而不是因选择到 Intel
binary 被拒绝。这会把安全门从 fail closed 反转为 fail open。

applicability 应独立于“最终允许什么”判断：已有 marker 始终 required；否则，任一已知 legacy
Intel 3.5a 探针或 native 3.7c 探针存在且可执行时都 required；只有两者都不存在的 portable
宿主才 not-applicable。marker 内容继续仅代表耐久适用性，不作为回退路径。founder 红线是不增加
任何 `.env` 可达 probe seam。判定 helper 保留在 self-contained gate 内；hermetic 测试只通过
现有 test mode + 临时 state root 下的专用 `test-applicability` CLI 参数传 fixture，production
actions 不接受该 action。shipped default canonical 另有不传 override 的用例锁定。

### Provisioning 遗留

FLY-2190 #1010 已加入 `check-global-path-hygiene.sh --source-tree`，CI 会保护仓库内 production
PATH 声明原生优先；其获批计划明确写了“provisioning 不声称自动生效（开放项）”。当前
`scripts/provision-fleet-host.sh` 已 source `scripts/lib/path-hygiene.sh`，但 preflight/validate 都
没有检查调用时实际 `$PATH` 的 Homebrew 次序。

`scripts/__tests__/check-global-path-hygiene.test.sh` 基线 21/21、`path-hygiene.test.sh` 12/12、
`provision-fleet-host.test.sh` 18/18。现有 source-tree 门不能证明新宿主实际用 native brew；
本单应在 provisioner 的所有 phase 入口之前做 macOS 运行时 PATH 检查，避免 `--only`/`--from`
绕过。

建议 runtime 判据按 PATH token 的第一次出现位置判断，而非简单字符串“存在某个 native-before-Intel
子串”：

- `/opt/homebrew/bin` 有、`/usr/local/bin` 无：通过；
- 两者都有且 native 第一次出现更早：通过；
- Intel 第一次出现更早：拒绝；
- Intel 有而 native 无：拒绝（否则 deps 会继续解析到 Intel brew）；
- 两者都无：允许 clean-host 后续安装流程；
- 非 Darwin：不适用。

这个 runtime helper 的输入是 colon-separated `$PATH`，不能替换 source-tree scanner 的 substring
判据。registry 中至少有三行不是 PATH：空格分隔的 node 候选、shell `||` 的 cmux 候选和逗号分隔
的 GitHub CLI 候选。保持 scanner 语义与真实仓库 GREEN 断言，runtime token helper 独立测试，
不会以 exception 掩盖这三类生产优先级列表。

### Cutover、部署死锁与 cmux

`scripts/flywheel-cmux-sync.sh` 在生成 attach 命令时读取
`FLYWHEEL_CMUX_ATTACH_TMUX_BIN`，要求非空值为绝对、无危险字符且可执行；
`scripts/flywheel-view-attach.sh` 最终用该 binary attach。窗口操作因而需要把它和 gate canonical
一起钉到 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`。

FLY-2190 的既有证据只证明有限的跨版本命令面，且明确警告 3.5a client 无法控制存活的 3.7c
server。源码追踪还证明“先普通部署代码、以后再切载体”不可行：`update-flywheel.sh` 在 FF 前用
旧 state-bin gate 检查，但 FF 后 `restart-services.sh` 会安装并运行新 gate；新 gate 正确拒绝
仍在运行的 Intel 3.5a，post-converge updater 以失败结束，后续 updater tick/carrier birth 也会
继续被挡。不能靠双版本兼容消除这个拒绝，因为 Intel 必须是红色阳性对照。

Lead 对问题 `43f6b1bf-2884-48e1-b0bc-4213bcd463ef` 的裁定是：不增加 activation marker、状态
文件或生产配置旋钮；撤销“阶段 A 先部署、阶段 B 另日操作”的错误框架。PR 仍只交付代码与
runbook，但 PR 只能在 founder cutover 窗口内合入/部署，作为 transaction 的第一段。首次
post-converge gate 拒绝是已知且必须现场承接的中间状态，不能当普通班车故障反复重试。

### 现有 whole-host transaction primitives

`scripts/host-terminal-cutover.sh` 已提供 FLY-1944 的整机切换骨架：

- `preflight-receipt` 与 `verify-receipt` 绑定宿主、旧/新 binary、版本、arch 与时效；
- `build-closure` 预建旧 3.5a rollback closure，`rehearse-rollback` 在副作用前证明可恢复；
- `pause-admission`/`inspect-admission` 以 dual-clock lease 暂停 runner admission；
- `quiescence` 对 runner、tmux server、supervisor 做全局 census；
- `run-step` 对 bootout、server stop、brew/link、bootstrap、自动验收等 mutation 施加预算；
- `resume-admission` 只在验收成功或回滚完成后恢复 admission。

收口裁定要求 runbook 不重写这套顺序，只逐字调用其 pause receipt/续期/bridge-bootstrap/
services-bootstrap 状态机，并把绝对路径 link/readback、pin、`.env` 更新、唯一
`request-restart.sh` 与验收放入对应 step。

### Admission pause 的 owner 缺口

`admission_pause` 已是 StateStore SQLite singleton row，setter 会 `save()`，因此能跨 Bridge restart
持久；无需新增状态面。但现有 API 不带 owner，`resume {}` 无条件删 row，且 restart-services 在
Bridge health 后、完整 Lead 波之前无人值守调用。外层 cutover pause 因而可能在操作员续期前被
释放。Lead 最终裁定是给既有 durable row 增 `lease_id`：pause 返回/可续同 id，resume 必须同 id，
foreign active owner 的覆盖/恢复 409。host-terminal-cutover 与 restart-services 都只释放自家 lease，
并删除无 owner resume 旧路。

首次部署还跨越旧/新 Bridge 合同：窗口外层 pause 由旧 Bridge 写成 `lease_id=NULL` 的 active row，
pause 响应也没有 capability。新 Bridge 对该唯一 legacy 形状采用兼容接管：部署后的首次无 caller id
owned pause 可立即原子替换 NULL-owner row，不等待旧 TTL；旧 expiry/reason 作废，由服务端生成新
leaseId并按新请求写入 expiry/reason。host 把它作为部署后的第一个动作并写回 transaction receipt，
后续 renew/resume 只回传该 id。active non-NULL foreign lease 仍 409；所有首次创建/legacy takeover
都不接受 caller 自造 id。

新 producer/consumer 合同无法部署它自身：首次发票时 production checkout 仍是旧代码。最窄且
可 bootstrap 的方案是不改三条部署关键路径；founder 窗口冻结其他 PR merge，并在第一次部署票、
link 后重启票各自发出前有界 fetch 后断言 `git rev-parse origin/main` 等于刚记录的本 PR merge
commit，把 expected/observed/pass 写入 host cutover receipt。不等即停，旧 producer/consumer 在
freeze 下解析到同一 SHA。

因为 canonical 精确钉住 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`，未来 `brew upgrade tmux`
可能令门在下次 birth 时失败。cutover 必须在 link 后执行 `/opt/homebrew/bin/brew pin tmux`，验证
`brew list --pinned` 含 tmux，并把解 pin/升级列为单独的受审变更。

## 方案选择

采用“固定 canonical/3.7c/arm64 + 独立 applicability + owned pause + main-freeze 同窗 transaction”的
最窄方案：

- 不增加 canonical/version/arch 生产旋钮，避免 `.env` 把 Intel 重新放行；
- test mode 继续能以 fixture canonical path 做 hermetic 覆盖；
- applicability 用独立 legacy/native probes 推断，避免未标记旧宿主 fail open；
- Intel 3.5a 会在 canonical、版本和架构三层中的至少一层失败；
- 收据 schema 无需迁移，现有 verify 路径会继续把探测结果与收据逐字段绑定。
- 不增加 staged activation 状态；合入/部署时序由 founder window 与 FLY-1944 transaction 约束。
- admission brake 只扩展已有 durable row，不增加 mode knob 或第二个 pause state。

## 验证策略

- RED：先把主 gate fixture 改为 3.7c/arm64，并新增 Intel 3.5a positive-control rejection；旧代码
  应失败。
- GREEN：最小改默认 path/version/arch，解耦 legacy/native applicability probes，保持所有
  test-only override 的 production sanitize，再跑完整 gate suite。独立测试不传 expected override，
  锁定 shipped default path；auto-applicability 测试证明 legacy-only host 进入 required 后被拒。
- RED：给 provisioner 新增 native-first PASS、Intel-first/Intel-only FAIL；旧代码应空过/失败。
- GREEN：在 `scripts/lib/path-hygiene.sh` 增加独立 colon-token runtime helper，provisioner 在任何
  phase/side effect 前调用；现有任意源码行 scanner 保持原语义。apply 立即失败；dry-run 打完整
  计划后带警告非零。fixture 拆分 native/Intel 字面量，避免 source-tree scanner 误报测试数据。
- runbook：窗口内冻结其他 merge，两张票前都读回 origin/main 等于本 PR merge commit；不修改
  request-restart/updater/restart-services 三条 bootstrap 关键路径。
- RED→GREEN：StateStore/API 锁 same-owner renew/resume、foreign 409 与 restart durability；两脚本
  传递 leaseId；覆盖旧 Bridge NULL-owner row→部署后 host 首个动作原子接管并写 receipt→owned
  renew/resume；restart-services 持有自家 owned lease 到 Lead 波结束，删无条件 resume。
- 回归：运行所有 FLY-2190 host selection 五套 shell tests、provisioning/path-hygiene tests、CI
  shell enumeration、host-terminal-cutover/request-restart tests，以及用户指定全仓三门。
