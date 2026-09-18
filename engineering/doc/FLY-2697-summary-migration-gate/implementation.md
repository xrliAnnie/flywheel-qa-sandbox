# FLY-2697 summary presentation 迁移受管入口 — 实施记录
Issue: FLY-2697 (https://linear.app/geoforge3d/issue/FLY-2697/raya-并仓m0-code-fly-2619-summary-presentation-迁移的受管入口wrapper只部署不执行幂等-校验)
日期: 2026-09-17
基于: plan.md

## 1. 权威与边界

- 实现按本目录 `plan.md` v8 施工，并逐字段核对 `origin/flywheel-FLY-2696@8b8d64e75` 的 §4.3 / §4.4。
- S4 尚未合入本分支，所以三个子命令都要求显式 `--state-root`；没有提前引入 `resolvePersonaStateRoot` 默认解析。
- 本单只部署代码。没有接入 updater，没有执行生产迁移，没有建立或解除围栏，也没有激活 persona。
- `scripts/lib/updater-raya-deploy.sh:1025-1049`、旧 migration CLI、共享 migration I/O 和 package manifest 均未修改。

## 2. 已实现

- `summary-presentation-migration.ts` 提取一次性输入冻结与 bounded source digest，并允许既有迁移核心消费同一份 frozen inputs。
- `summary-presentation-store.ts` 增加 nullable `completed_at_ms`、write-once completion、legacy adoption，以及 claimed member 的只读查询接口。
- 新增 `raya-summary-presentation-gate.ts`：
  - `preflight` 只读地产生绑定 window、DB identity、workspace persona、source digests、state/lock roots、tool blobs 与 deployed SHA 的 `authorizedPayloadDigest`；
  - `execute` 先取得既有 Raya deploy lock，再重读所有授权输入；只在确需迁移或受权补齐旧行 `completed_at_ms` 时打开 RW；
  - `verify` 独立重算 migration state、cursor/boundary、三个 source digests、逐 seq disposition、claimed group/member 引用与 orphan count；
  - 按 S4 `M0ReceiptV1` 写 `m0-execution.json`、`m0-dispositions.jsonl`、`m0-receipt.json`，均为 0600 原子落盘；
  - receipt 已完整有效时返回 `unchanged`，不刷新 `generatedAt`，不改 DB 或证据文件。
- 状态目录与 persona 父目录逐级拒绝 symlink；DB 在 RW 前和最终只读复验前都复核 canonical path/dev/inode。

## 3. TDD 修正记录

在继承的 wrapper 草稿上补红测后，修正了以下真实缺陷：

1. receipt-only 崩溃重建会把新的 `generatedAt` 当成 identity 冲突；现在复用已有 receipt，只重建缺失 jsonl。
2. claimed round 只检查 group 存在、未检查 group 的 project/lead 身份；现在通过 store 读接口核对 member、source seq、group 身份与合法 state。
3. `verify` 在 migration state 之前检查 receipt，导致 migration 本身缺失时误报 `receipt_missing`；现在先完成 DB 复验。
4. receipt 的 `generatedAt` 可被改成任意字符串而仍通过；现在要求 canonical UTC ISO8601 且不晚于观察时钟。
5. `execute` 在取得 deploy lock 之前读取 persona/tool/deployed-sha；现在只在锁内重读并计算授权材料。
6. state/persona 的中间父目录 symlink 可绕过最终路径的 `lstat`；现在逐级拒绝。
7. code review 复现了无预先 admitted row 的 v2 journal round：migration 会正确归类为 `needs_reconciliation`，旧 verifier 却仅凭 `contract_version` 强制期待 `eligible`，使已完成 DB 永久无法出 receipt；现在只有 DB 当前 disposition 为 `eligible`/`claimed` 的 v2 round 才按 eligible 验证，其余仍从 ledger/decision 独立重算，并新增该 fallback 的端到端回归。
8. code review round 2 补出了同一矩阵的 decision-backed cell：operator decision 可把 fallback v2 round 归类为带非空 `evidenceRef` 的 `eligible`，而 verifier 仍硬编码 null；现在对这类行重新执行 `classifyRound` 核对 disposition 与 evidence，其余 admitted/claimed v2 语义不变，并保留独立 tamper 检测。
9. GitHub Actions 计费恢复后的精确头 run `35314819668` 首次产生真实代码判决：Quick Gate 只在 Biome formatter 处失败；本地复现后仅按 formatter 输出折行，`pnpm lint` 恢复退出码 0（仍保留仓库既有 warning），35 个聚焦测试与 typecheck 复验通过。

## 4. 验证证据

- `pnpm --filter flywheel-teamlead typecheck`：通过。
- `pnpm -r build`：通过。
- `pnpm lint`：退出码 0；输出保留仓库既有、与本改动无关的提示和 warning，不宣称零诊断。
- 聚焦 Vitest 三件套：3 files、35 tests 全绿（gate 23、migration 6、store 6）。
- 物理只读断言覆盖 DB、`-wal`、`-shm` 与三份状态文件：DB/`-wal` 比较存在性、bytes、mtime；`-shm` 比较存在性与 bytes、排除 mtime。另有真实 SQL UPDATE 阳性对照，证明同一快照器能观测 db/wal 写入。
- 负例覆盖非 `raya/raya` 零 I/O、缺失/畸形授权参数、相对/软链接路径、state/lock root 漂移、活锁、preflight 漂移、mid-run source 漂移、DB inode 替换、receipt/jsonl/round 篡改、单边证据与 claimed 引用损坏。
- `node --test scripts/__tests__/fly-2006-retention-consumer-gate.test.mjs`：9/9 通过；`node scripts/fly-2006-retention-consumer-gate.mjs` 返回 `ok:true`、`errors:[]`。
- `bash scripts/__tests__/updater-raya-deploy.test.sh`：40 passed、0 failed；既有 `updater-raya-deploy.sh:1025-1049` 路径未断开。
- protected-path 三点 diff 检查：通过。
- 编译产物 smoke：真实 `dist` wrapper 运行 `preflight` 成功；wrapper 与 migration 模块的文件 hash 均与授权 payload 中的 tool blob digest 一致。
- 本地 package gate 在 `233baf25c5b798b614f443e1ec81ac8a13ac1bfe` 运行。receipt `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-3GZvnz/summary.json` 已记录 10 个 package 通过；`flywheel-claude-runner` 两次均为 50 files、1341 tests、零断言失败，唯一错误为允许分类的 `onTaskUpdate` worker RPC timeout。随后 `flywheel-teamlead` 聚合在无关的 `lead-capability-read.test.ts` 出现 2 项失败（一个 15 秒超时、一个并发状态下错误码漂移）。Lead 于 2026-09-18 05:50Z 因九个实现节点同时运行全量、FLY-2467 已知并发假红及主机 load1 96→117，主动 TERM 本轮并裁定不得重启；receipt 因此没有完整终态。本地 aggregate 按 Lead 裁定跳过，最终 aggregate authority 改为 PR 精确头 CI。
- 按不可达套件规则隔离重跑 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/lead-capability-read.test.ts`：1 file、20 tests 全绿。聚合红灯仍如实保留，不调查已由 Lead 解释并终止的并发中断。

exact-head CI 与 code review 在 PR 最终 head 产生后记录；本节不提前声称它们已通过。

## 5. 不可逆边界

代码合并只会随 Bridge schema migrate 幂等增加 nullable `completed_at_ms`，不改任何 migration 行。真正的 M0 `execute` 仍是 FLY-2680 §11.1a 的独立逐实例 founder 运维授权，且必须发生在 B2 围栏内；本实现、测试与 QA 均不得对生产库执行。
