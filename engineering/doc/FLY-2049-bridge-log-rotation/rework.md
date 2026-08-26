# FLY-2049 Bridge 日志轮转真运行 — 返工记录
Issue: FLY-2049 (https://linear.app/geoforge3d/issue/FLY-2049/infra日志-bridge-日志轮转未生效部署后-bridge-日志-94106mb-持续增长无任何轮转产物-查根因并让轮转真跑起来)
日期: 2026-08-25
基于: qa-report.md

## 1. 为什么 attempt 1 被打回

独立 QA 对 head `ff1219708` 的正向轮转验收通过，但它同时证明两条故障注入会把 Bridge 拉死：symlink generation 触发 `log_generation_unsafe`，fresh lock 在 2× 阈值触发 `rotation_stalled`。Code review R1 还指出普通文件形态的 stale lock 永远不会被目录-only 回收器处理。Lead 指令 `[lead-instruction aa829be2-e20e-4309-bc29-aa2475c5ca9f]` 因此要求 implement attempt 2：日志层任何失败都不得阻止 Bridge 启动或杀死它。

## 2. RED → GREEN

| 注入 | RED | GREEN |
|---|---|---|
| `ln -s` 占 `.1` | strict append 抛 `log_generation_unsafe`，Bridge callback next-tick exit | symlink 本身改名为 `.1.corrupt.<pid>.<ts>`，target 不跟随、不改字节；active 继续变 `.1`，新 active 继续写 |
| `touch` 普通文件 lock 并设旧 mtime | `mkdir` 失败后因 lock 非目录直接放弃 | directory 或 regular file 都可在 mtime ≥5 分钟后做 identity-checked quarantine/reclaim |
| fresh lock + active ≥2× cap | `rotation_stalled` 抛错，当前 bytes 不进主日志，Bridge 退出 | 当前 append 成功；adapter 只 latch rotation-disabled，后续 bytes 仍 short-FD 进入 active，Bridge 在线 |
| unsafe raw startup capture | wrapper/daily 在 exec 前退出 | 不碰 unsafe target，raw fd 改到 `/dev/null`，原 node/tsx 命令照常启动 |
| marker while Bridge healthy | probe 不读取，无法主动通知 | probe 首次立即提醒、默认每 60 分钟重醒；operator 清 marker 后 all-clear |

`run-bridge.ts` 同时取消两条证据破坏路径：不再因 logging callback 调用 `process.exit(1)`，也不在每次 boot 清除旧 marker。logging setup 自身抛错时只写 raw stderr/marker并继续 `main()`。

## 3. 定向证据

- `pnpm --filter flywheel-config test:run -- log-rotate.test.ts rotating-stdio.test.ts`：673/673；新增 generation quarantine、ordinary-file stale lock、stall-only rotation disable cases全绿。
- `bash scripts/__tests__/bridge-liveness-probe.test.sh`：31/31；marker 立即提醒、小时重醒、清除 all-clear。
- `bash scripts/__tests__/packaged-seams.test.sh`：17/17；wrapper 与 daily 在 raw capture symlink 下 target 原样且启动命令仍执行。
- 重新构建 `flywheel-config/dist` 后运行 `bash scripts/__tests__/flywheel-log-rotate.test.sh`：14/14。故意跨阈值时 PID 38267 在线，`.1` 528 bytes、active 367 bytes、oldest→active `cmp` 完全一致、active/`.1` 均无 producer-held FD。

## 4. R1 MEDIUM 处置

| finding | disposition |
|---|---|
| startup evidence 被 boot 擦除 | 修复 marker boot-clear；raw capture 仍按“最近一次 pre-bootstrap”设计截断，durable failure 证据由 marker 保留到 operator 清除 |
| short-FD syscall cost | 接受 correctness tradeoff；洪水已由 FLY-1995 消除，若 profiling 出现实际成本，另做有 crash-tail 证明的 batching |
| unsafe generation 可杀 Bridge | 已修为 recoverable quarantine + continue rotation |
| stale lock 可造成 crash loop | 已修 ordinary-file/directory reclaim；fresh stall 只停 rotation并持续提醒，Bridge 在线 |

`qa-report.md` 仍是 attempt 1 精确 head 的历史证据，不代表 attempt 2 最终 QA verdict；DAG 的 QA 节点应在新 exact head 上用 stale ordinary-file lock、symlink `.1` 与三连启动重新验收。
