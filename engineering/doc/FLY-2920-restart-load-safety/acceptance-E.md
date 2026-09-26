# FLY-2920 孤儿 ownership 一次退休 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 当前状态

E 本地实现已完成，规格与独立代码质量检查均无阻断项。此页不是正式代码评审门、全量 CI、QA 或生产证明。

## 已复现与修复的生产接线问题

`plugin.ts` 原 `isExecutionActive` 仅查看本轮候选快照与内存 owner registry。一个执行在异步进程/socket 探测期间恢复活跃后，旧快照不能作为退休前的最新数据库证据。现在保留这两个保守保护，并在实际回查时读取当前 `getReadoptCandidateSessions()`，以 `maintenance:orphan-active-recheck` 标记同步数据库操作。候选选择仍与先行 recovery pass 共享原快照。

- `/tmp/fly2920-E-wiring-red.log`：新增当前状态回查要求，原实现 1 failed / 9 passed。
- `/tmp/fly2920-E-wiring-green.log`：最小接线修复后 10 passed。
- `/tmp/fly2920-E-census-red.log`：生产 child-process census 精确发现 plugin marker 数量 10→11。
- `/tmp/fly2920-E-census-green.log`：审计后更新这一个计数与说明，1 passed；未放宽扫描或断言。

## 已覆盖的决定性证明

1. 文件级 A：实际 home 的 lstat=ENOENT，执行 inactive，发布精确 ownership 收据；第二次 loader/sweep 不再产出同一候选。
2. 文件级 B：home 存在且有效，完整快照证明旧 PGID 空、socket 无 holder、无相同 ownership 活体；只退休旧 ownership，不删 home。
3. session 原始字节、凭据、线程、gate hold 与工作目录不变；新 spawn UUID 和 legacy→新 generation 都重新成为候选。
4. 当前执行变活跃、完整 ledger 字节变化、home 重现、进程/socket 变化、symlink、权限和不完整探针均不得写退休收据。
5. mismatch 审计按 fingerprint/reason/evidenceDigest 幂等；证据变化才新增。反向真实孤儿清理与 keyed-home 过期 lease 解析回归保持。

相关测试选集及所有排除匹配记录在 `consumers-E.json`。宿主实际进程探测若受沙箱限制，必须单列 UNVERIFIED，不能用夹具结果代替。

## 最终实现与验证

新 spawn 写入 v4 UUID；legacy 指纹只含 execution/PGID/canonical home identity，完整 session hash 另作提交前校验。独立收据使用完整临时文件 + exclusive hard-link 原子发布，同身份并发只产生一份收据，既不改 session.json，也不删除 home。执行目录现有生命周期清理负责 sidecar。

物理缺席证明保守拒绝仍存在的原 launch leader PID（即使它换了 PGID/socket）、原 socket/home argv 引用；B 还拒绝任意旧 PGID 成员。UUID 是 ledger generation fence，不冒充进程环境标记；PID 被复用同样拒绝。完整 ps 快照不再丢弃坏行，系统 PID/PGID 行可解析，但 PID/PGID≤1 不进入清理候选。

| 具体选集 | 结果 | 日志 |
|---|---|---|
| CodexTmuxAdapter 完整具体文件 | 180 passed | `/tmp/fly2920-E-adapter.log` |
| ownership retirement | 24 passed | `/tmp/fly2920-E-retirement-final-green.log` |
| 原 orphan reaper | 37 passed | `/tmp/fly2920-E-reaper-final-green.log` |
| 完整 process snapshot | 3 passed | `/tmp/fly2920-E-kernel-green.log` |
| reown coordinator / production wiring | 53 / 10 passed | `/tmp/fly2920-E-reown.log`, `/tmp/fly2920-E-wiring-final.log` |
| timeout / kill inventory / teardown / census | 2 / 5 / 7 / 1 passed | `/tmp/fly2920-E-timeout.log`, `-kill.log`, `-teardown.log`, `-census-green.log` |
| 真实隔离边界 | 2 passed, 1 environment skipped | `/tmp/fly2920-E-real-boundary.log` |
| daemon runtime 所选 ownership/spawn/evidence/socket groups | 100 passed, 2 fixture setup EPERM, 19 unselected | `/tmp/fly2920-E-runtime-consumer.log` |
| lifecycle closeout FLY-2490 group | 11 passed, 53 unselected | `/tmp/fly2920-E-closeout-consumer.log` |

强制 `vitest related` 使用审计后的具体文件 include 配置：runner 1 file / 180 passed；teamlead 4 files / 66 passed / 1 environment skipped。完整命令、日志及内容 hash 见 `verification-E.json`。它们不替代上表逐个具体文件的验证，不是 full package suite。

`pnpm --filter 'flywheel-teamlead...' build` 通过。`pnpm lint` 首次仅新增回查链的格式不符，按 formatter 的精确差异修正后通过，保留原有 25 warnings；修正后接线 10 tests 再次通过。未改变公共 package export/API，依赖构建已包含相关 TypeScript 检查。`git diff --check` 通过。

### 环境限制与 QA 边界

现有 daemon runtime 两项真实 socket holder 测试在 `ownPgid()` 创建夹具时 `spawnSync ps EPERM`，尚未执行产品断言；未放宽、跳过或改写它们。相关真实隔离测试自身也因同一进程检查能力缺失条件跳过一项。受控进程快照、文件/socket 夹具与真实 tmux 隔离结果不能替代宿主实际 Codex 进程身份验证。三项仍需 QA 在允许 ps 的环境补证。
