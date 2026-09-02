# FLY-2264 arm64 tmux 门切换 — 探索
Issue: FLY-2264 (https://linear.app/geoforge3d/issue/FLY-2264/cutovertmux-fly-2190-落地-载体换-arm64-原生-tmux-先改-host-tmux-selection-gate)
日期: 2026-09-02
基于: 无

## 问题

FLY-2190 已把生产 PATH 收敛为 `/opt/homebrew/bin` 优先，但宿主 tmux 仍停在
`/usr/local/bin/tmux` → Intel Homebrew `tmux 3.5a`。现有
`scripts/host-tmux-selection-gate.sh` 把这一过渡态写死成唯一通过状态：canonical path 默认
`/usr/local/Cellar/tmux/3.5a/bin/tmux`、版本必须为 `tmux 3.5a`、镜像必须为 x86_64，且显式拒绝
arm64。已安装但未 link 的 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux` 因此不能成为载体。

本单只完成破坏性切换的代码准备：让 gate 唯一接受 arm64 `tmux 3.7c`，补齐 provisioning
的 native-first 检查，把既有 admission pause 加固成有主耐久 lease，并交付 founder 授权窗口中
使用的操作手册。本 PR 不执行 `brew link`、不写
生产 `.env`、不调用 `request-restart.sh`，也不把运行时切换误报成已经完成。

这个 gate 不能先随普通班车部署、以后再择时切换。新代码一旦部署，当前仍选中 Intel 3.5a 的
整舰会在 post-converge gate 处 fail closed，updater 失败，未来 carrier birth 也被挡住。因此
PR 合入/部署与载体切换必须是同一个 founder 授权的 cutover transaction：先打开窗口并暂停新
admission，再合入/部署硬翻转，随后立即 link、设置 cmux client、经唯一正门重启并验收。窗口外
不得合入本 PR。

## 锁定边界

- 本 PR 把默认 canonical path 改为 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`。
- 版本/架构仍 fail closed：只接受 `tmux 3.7c` 与 arm64；Intel 3.5a 是必须失败的阳性对照。
- `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH` 继续只作 hermetic test seam；生产 canonical
  写死为 3.7c 路径，不增加可回退到 Intel 的配置旋钮。
- provisioning 在 macOS 目标上检查实际 PATH：若 Intel Homebrew 存在，则 native Homebrew
  必须存在且第一次出现的位置更靠前。Linux 与没有 Intel prefix 的清洁 PATH 不受影响。
- runbook 必须复用 `scripts/host-terminal-cutover.sh` 的 preflight receipt、closure、rollback
  rehearsal、admission pause、quiescence、budgeted `run-step` 与 resume primitives；它记录
  PR 合入/部署、绝对路径 link、唯一仍需运行时设置的 `FLYWHEEL_CMUX_ATTACH_TMUX_BIN`、唯一
  重启正门及验收/回滚边界，但本身不是执行授权。
- 既有 SQLite admission pause row 增 owner lease；同 owner 才能续期/恢复，foreign active owner
  返回 409。首次 owned pause 的 id 由服务端生成，且可立即接管旧 Bridge 遗留的 NULL-owner row；
  host cutover 与 restart-services 均删除无 owner resume，外层 brake 跨 Bridge restart。
- 不动 Intel Homebrew 的其他包，不改 tmux server，不部署，不 merge。

## 已知风险

1. 新 gate 会拒绝当前仍选中 Intel 3.5a 的 post-converge updater 与 carrier birth。这是要求中
   的阳性对照，不应通过兼容双版本来掩盖；也正因如此，不存在安全的“先正常部署、以后再切换”
   间隔。runbook 必须把合入/部署放进同一破坏性窗口，并把首次拒绝当成预期 transaction 状态，
   禁止盲目重试或离开现场。
2. `FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH` 当前虽然在 gate 中存在，但生产模式把它列为
   test-only，且所有 wrapper 都会 unset。Lead 已裁定保持这一防脚枪合同，runbook 不得把它写成
   生产旋钮。
3. 3.5a client 与 3.7c server 的版本错配会让 attach 失败；运行时切换必须在无 runner 窗口做
   全舰同版本重启，不能滚动留下长时间混合态。
4. `FLYWHEEL_CMUX_ATTACH_TMUX_BIN` 必须指向可执行的 3.7c arm64 binary，避免 cmux 继续用旧
   client；设置与重启必须属于同一 founder 授权窗口。
5. gate 当前把 expected canonical 同时当作 applicability 探针。直接翻默认值会使仅装 Intel
   legacy binary、尚未写 marker 的宿主被误判 not-applicable，从 fail closed 倒退成 fail open。
   applicability 必须独立识别已知 legacy/native 安装或已有 marker，再对选择结果执行新硬门。
6. exact Cellar pin 会被后续 `brew upgrade tmux` 改写。事务中必须 pin `tmux`、读回 pin 状态，
   并把升级操作列为需另行计划的运维约束。
7. restart-services 现有无条件 resume 早于完整 Lead 波，能释放外层 cutover pause；lease owner 与
   StateStore durability 必须在破坏性窗口前由 API、shell 顺序和 restart replay 测试锁住。
8. 首次部署存在旧 Bridge→新 Bridge 的版本错位：窗口外层 pause 会先被旧 Bridge 持久为没有
   lease id 的 NULL-owner row。新代码部署后的第一个动作必须重新 `pause-admission`，原子接管该
   legacy row、废止旧 TTL，并把服务端生成的新 leaseId 写回 transaction receipt；否则后续续期和
   resume 没有 capability。

## 成功定义

- hermetic gate 测试证明 arm64 3.7c 可出收据，Intel 3.5a 与错误 canonical/version/arch 均拒绝；
- provisioning 测试证明 native-first 通过、Intel-first 与 Intel-only fail closed；
- admission lease 测试证明 same-owner renew/resume、foreign 409、Bridge restart durability、
  old-Bridge NULL-owner row 的即时 owned takeover 与 health→Lead wave→resume 无开放缺口；
- 操作手册以 `host-terminal-cutover.sh` 为事务骨架，给出合入/部署时序、绝对路径命令、pin 与
  读回验收，并明确任何 production mutation 均未在本 PR 执行；
- 全仓 gate、代码审查和 PR 流程通过后，以 `needs_review` 交还 DAG，不触发 QA/ship/deploy。
