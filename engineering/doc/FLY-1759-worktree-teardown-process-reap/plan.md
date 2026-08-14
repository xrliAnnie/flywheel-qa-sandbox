# FLY-1759 worktree 拆除进程组回收 — 实施计划

Issue: FLY-1759 (https://linear.app/geoforge3d/issue/FLY-1759/worktree-拆除只删目录不回收进程组-泄漏累积-5-天撑爆内存8-13-oom-事故根因)
日期: 2026-08-13
基于: research.md

**Status**: codex-approved（design review 5 轮: R1 7项 → R2 6项 → R3 5项 → R4 4项 → **R5 APPROVED**;R5 两条非阻塞叮嘱: ①实现时 E1/E2/E7/E8 与 shell 集成 case 是 merge gate,不得 mock 替代或静默 skip;②D7 交付清单与 CI 细节保持同步 — 已照做）
**Version**: v1.5x.0（暂定,ship 取空号）

## 0. 一句话

给 worktree 拆除加一个枚举无关的进程回收步骤（cwd 扫描 → 身份栅栏点杀/组杀 → TERM→KILL→全量复核）,并在 `pruneOrphans` 既有节拍上加一层收敛清扫;杀不掉/扫不了则照常删目录但大声审计。

## 0.0 覆盖面两级声明（R2#1 定案 — 诚实口径,不夸大）

- **Tier-i(硬不变量): 所有 Bridge/引擎侧自动化拆除路径** —— Layer A on-merge、Layer B sweep、reconciler、Blueprint pre-create、DAG 引擎经由的全部 `WorktreeManager` 原语 —— 执行者(Bridge)cwd 在 main repo,与目标 worktree 无自指关系 → **删除前 reap 无条件成立**。事故的两类主泄漏(vitest workers、codex app-servers,28+ 进程)全部产生于此级;issue 验收点名的两个调用点(`.removing-` / `git worktree remove`)也都在此级。
- **Tier-ii(物理受限): runner 自己执行的命令文件路径**(spin.md step 4(b)/5、orchestrator.md cleanup) —— 执行 reap 的 runner 自己的 session 树就扎根在目标 worktree 里,**完全的 pre-delete reap 在物理上不可能**(自杀悖论:保护集必然放过自己)。此级的合同是三层:①删除前 reap **非自身进程组**(泄漏主力 —— vitest/app-server/tmux 都是独立组,不在 runner 自己的祖先链上);② runner 自身 session 树由既有 Bridge close-runner + FLY-1185 MCP descendant reaper 在会话终结时回收(既有机制,不属本单);③残留由 §5 收敛清扫在**下一个实际发生的** boot/dispatch 节拍尽力兜底(best-effort;自 ship 成功路径紧跟全舰重启 → boot 节拍很快到来,但 spin.md 4(b) 的 handoff **失败分支**是 fail-close 直接退出、不排任何重启 —— 该窗口内没有节拍,残留要等下一次自然 boot/dispatch,R3#5 如实声明)。
- 把 tier-ii 迁移到外部 owner(updater/Bridge 代 runner 拆)被**明确拒绝**: 要动 FLY-270 self-ship fail-close 控制面,爆炸半径与本单不成比例;作为 follow-up 建议单独立 issue(见 §13)。本计划的一切「全覆盖」措辞按本节两级口径解释,不再声称「每次删除都先 reap 干净」。

## 0.1 R1 反馈处置纪要

| R1 项 | 处置 |
| -- | -- |
| 1 chokepoint 不完整(spin.md/orchestrator.md/cleanup-agent.sh 旁路) | **采纳(改型,R2/R3 迭代后定稿)**:不搞「单一外部 teardown owner」重架构;§0.0 两级口径 + §5 best-effort 收敛 + cleanup-agent.sh 就地 reap + 源码合同守卫测试(本行的 R1 时点措辞已被 R2#1/R3#5 修正,以 §0.0 为准) |
| 2 终验只查初始快照/PID 复用 | **采纳**:复用仓内 `mcp-descendant-reaper.ts` 身份栅栏先例;终验改为全量重扫定点收敛,失败返回 `verified:false` 绝不空 survivors |
| 3 组信号误伤同组外部进程 | **采纳**:组信号仅当全组成员都被证明属于目标集;否则身份点杀。加共组阴性对照 |
| 4 路径守卫弱于既有权威/symlink 危险 | **采纳**:manager 派生描述符 + lstat 非 symlink 实目录证明 + 信号前复核 |
| 5 E1/E2 不确定性(sh exec/共组降级/无顺序证明) | **采纳**:detached 组 + 握手 + 全量 census 断言 + 顺序测试 |
| 6 CI 缺 lsof/预算口径错(pruneOrphans 每次 dispatch 都跑) | **采纳**:unit-tests job 装 lsof;单调总 deadline;节拍口径更正 |
| 7 契约一致性(refusedReason/返回类型措辞/导出/循环依赖) | **采纳**:`reaps[]` 聚合、incomplete 谓词补全、index 导出、路径工具抽独立模块、兼容性措辞精确化 |

## 0.2 R2 反馈处置纪要

| R2 项 | 处置 |
| -- | -- |
| 1 自删豁免违反 pre-delete 不变量 | **采纳(按 Codex 给的第二条出路)**:不再声称全路径 pre-delete;改为 §0.0 两级诚实口径 —— tier-i(全部 Bridge/引擎自动化路径,事故泄漏来源,验收点名的两个调用点)硬保 pre-delete;tier-ii(runner 自执行命令路径)= 非自身组 pre-reap + 既有会话终结回收 + 收敛兜底。外部 owner 迁移拒绝(FLY-270 控制面爆炸半径),立 follow-up |
| 2 shell twin 缺 kill-safety 合同 | **采纳**:shell reap 继承同款守卫(canonical 期望父目录 + lstat 非 symlink + 每波前复核 + `pid+lstart+command` 身份栅栏,沿用 test-teardown.sh/lead-restart-lifecycle.sh 的 lstart 先例);阴性 shell 测试;放弃 30 行上限 |
| 3 etimes 单调性不是身份栅栏 | **采纳**:身份 = `pid + lstart(LC_ALL=C) + command` **精确相等**;组信号要求全体现存成员各自有精确匹配的已捕获身份;`identityMismatchSkipped` 补进 `ReapSummary`;同 command PID 复用测试 |
| 4 E1/E2 未断言组零存活/E4 拓扑矛盾 | **采纳**:E1/E2 加「每个记录 pgid 在 fresh ps 中零存活成员」断言 + 握手后延迟 fork case;E4 改为外部 detached 组长 + worktree 内子 + 外部兄弟的正确拓扑 |
| 5 family-2 deleted-cwd 解析欠规格 | **采纳**:raw/logical 双路径规格 + Linux ` (deleted)` 标记显式归一 + 不可恢复即 incomplete-never-signal + 双平台解析测试;族 2 定位降为 best-effort 纵深,不再作为 tier-ii 的「结构性证明」 |
| 6 scanError 语义/守卫按文件粒度太粗 | **采纳**:`scanError`(信号前,零信号)与 `verifyError`(信号后终验失败)分列;合同守卫改为锚定出现次数 + 相邻标记,加突变夹具测试 |

## 0.3 R3 反馈处置纪要

| R3 项 | 处置 |
| -- | -- |
| 1 canonical-only 丢词法路径,symlink 证明失效 | **采纳**:`ReapTarget` 双路径(`lexicalPath` + `canonicalPath`);live-dir 证明在 lexicalPath 上 lstat + realpath 无漂移复核;E8 真实 fs symlink 阴性(TS + shell 各一) |
| 2 deleted-cwd 归一未贯穿信号 reaper | **采纳**:共享 `CwdRow` 解析器(raw/logical/deletedMarker),初扫与终验重扫统一按 logicalCwd 匹配;E7 真实 ubuntu 端到端过默认 reaper |
| 3 E1b 延迟 fork 不确定 | **采纳**:组长 trap 第一发 TERM → trap 内 fork + 二次握手,fork 时点被信号钉死在初扫之后;E1/E2 都跑 |
| 4 shell 只点杀 cwd 命中却声称回收进程组 | **采纳**:shell lib 加 fresh ps 后代闭包 + 子/孙跟退阳性测试,声称与实现对齐 |
| 5 tier-ii 节拍/verifyError 口径夸大 | **采纳**:§0.0 改为「下一个实际发生的节拍」+ 如实写出 handoff 失败分支无节拍窗口;`verifyError` 扩为首信号后一切不确定性且停发后续信号;三处陈旧措辞(§0.1 行 1/§5 标题/§11 自托管)已改;M 空快路径补 `identityMismatchSkipped:0` |

## 1. 交付物清单

| # | 交付物 | 位置 |
| -- | -- | -- |
| D1 | 进程回收模块 `worktree-process-reaper.ts`（纯函数 + 注入缝 + 身份栅栏） | `packages/edge-worker/src/` |
| D2 | `WorktreeManager` 四原语接入（reap 前置 + `reaperFn` config 缝 + additive 结果字段） | `packages/edge-worker/src/WorktreeManager.ts` |
| D3 | 路径工具抽离 `worktree-paths.ts`（防循环依赖;index 旧导出路径保留） | `packages/edge-worker/src/` |
| D4 | 收敛清扫:`.removing-*` 残留 + 死路径 cwd 孤儿（挂 `pruneOrphans` 既有节拍:boot + 每次 DAG dispatch 前后） | `WorktreeManager.ts` + `worktree-process-reaper.ts` |
| D5 | shell 旁路收口:cleanup-agent.sh 就地 reap + spin.md 措辞更新 + 源码合同守卫测试 | `.claude/orchestrator/cleanup-agent.sh`, `.claude/commands/spin.md`, `scripts/__tests__/` |
| D6 | Layer A / Layer B 审计接线（reap 摘要入既有事件 payload + `worktree_reap_incomplete` 事件） | `packages/teamlead/src/bridge/worktree-cleanup.ts`, `lifecycle-sweep.ts` |
| D7 | CI 接线:unit-tests job 安装 lsof + script-tests job 显式枚举两个新 shell 套件(test-reap-worktree-lib / test-worktree-removal-contract) | `.github/workflows/ci.yml` |
| D8 | 测试:单测 + CI 真实进程 e2e + host-only 真 tmux 变体 | `packages/edge-worker/src/__tests__/` 等 |

## 2. D1 — reaper 模块设计

### 2.1 公开接口

```ts
/** manager 派生的目标描述符 — reaper 不自己发明路径权威(R1#4)。 */
export interface ReapTarget {
  /**
   * 词法路径(绝对、未 realpath)。R3#1: symlink 证明必须在词法路径上做 —
   * canonical 值已被 realpathSync 解掉 symlink,lstat(canonicalPath) 永远
   * 看不见「原目标是个 symlink」这件事(同父同前缀的 lexical symlink 指向
   * 另一个真实目录时,canonical 形态完全合法 — Codex 真实文件系统探针复现)。
   */
  lexicalPath: string;
  /** realpath 后的 canonical 路径(cwd 匹配用)。 */
  canonicalPath: string;
  /** manager 路径数学派生的期望父目录(canonical)。 */
  expectedParentDir: string;
  /** `<repoSlug>-` 前缀(basename 断言用;.removing-* 后缀先剥再断言)。 */
  repoSlugPrefix: string;
  /**
   * 目标根的存在性证明,信号前由 reaper 复核(R3#1 双路径规则):
   * - "live-dir": lstat(lexicalPath) 必须是真实目录且非 symlink,且
   *   realpath(lexicalPath) === canonicalPath 仍成立,且 canonicalPath 满足
   *   期望父目录关系 — 三条每波信号前都复核;
   * - "gone": lstat(lexicalPath) 必须为 null(不存在),期望父目录关系照查。
   */
  rootProof: "live-dir" | "gone";
}

/** 共享 cwd 行解析(R3#2): 所有扫描(初扫+终验重扫)只用 logicalCwd 匹配。 */
export interface CwdRow {
  pid: number;
  /** lsof 原样输出(审计用,永不参与匹配)。 */
  rawCwd: string;
  /** 剥掉 Linux " (deleted)" 尾标后的逻辑路径;不可恢复时为 null。 */
  logicalCwd: string | null;
  /** 该行带 deleted 尾标(Linux 删除后形态)。 */
  deletedMarker: boolean;
}

export interface ReapSummary {
  /** cwd 命中的初始 PID 数(扩张前)。 */
  matched: number;
  /** 发过信号且在终验 census 中确认消失的 PID。 */
  reaped: number[];
  /** 终验 census 仍存活(或新出现)的目标 PID。 */
  survivors: number[];
  /** true = 终验全量重扫(cwd + ps)干净收敛;false 时 survivors 不可信为空。 */
  verified: boolean;
  /** 身份栅栏拦下的候选数(fresh 快照身份不符 = PID 已复用,零信号跳过)。 */
  identityMismatchSkipped: number;
  /** 信号前扫描/快照层失败;设置时**未发任何信号**。 */
  scanError?: string;
  /**
   * 首个信号之后的任何不确定性(R3#5): TERM 后 fresh census 失败、守卫复核
   * 失败、deadline 耗尽、终验重扫失败 —— 一律 verifyError + verified:false
   * 且**不再发后续信号**。与 scanError 互斥(scanError = 信号前,零信号)。
   */
  verifyError?: string;
  /** 守卫拒绝(fail-closed on kill);设置时未发任何信号。 */
  refusedReason?: string;
}

export interface ReapDeps {          // 全部可注入,默认真实现
  listCwds(): Promise<CwdRow[]>;     // lsof -a -d cwd -F pn(单次 10s timeout)→ 共享解析器产出 CwdRow
  listProcesses(): Promise<Array<{ pid: number; ppid: number; pgid: number; lstart: string; command: string }>>;
      // LC_ALL=C ps -axo pid=,ppid=,pgid=,lstart=,command= — lstart 固定 5 token
      // ("Wed Aug 13 21:14:03 2026"),解析按列位切,command 为其余全部
  kill(pid: number, sig: "SIGTERM" | "SIGKILL" | 0): boolean;     // ESRCH → false
  killGroup(pgid: number, sig: "SIGTERM" | "SIGKILL"): boolean;   // process.kill(-pgid)
  sleep(ms: number): Promise<void>;
  now(): number;                                                   // 单调 deadline 用
  lstat(p: string): { isDir: boolean; isSymlink: boolean } | null;
  realpath(p: string): string | null;                              // R4#3: live-dir 无漂移证明用,可注入
                                                                   // (null = 解析失败 → fail-closed);
                                                                   // 单测可只翻转 realpath 造 TERM→KILL 间漂移
  selfPid: number;
}

export const REAP_TOTAL_DEADLINE_MS = 25_000; // 全操作单调预算,含全部子进程与等待窗

export async function reapWorktreeProcesses(
  target: ReapTarget,
  deps?: Partial<ReapDeps>,
): Promise<ReapSummary>;
```

**进程身份栅栏(R2#3)** = `pid + lstart + command` 三元组**精确相等**。候选在首次 census 捕获身份;此后**每次**点信号前都在 fresh 快照中复核三元组,任何一项不符(含 lstart 漂移)= PID 已复用 → 零信号跳过 + `identityMismatchSkipped++`。`lstart` 是进程启动时刻的固定字符串(`LC_ALL=C` 固定 locale),同 command 的复用 PID 也无法伪造 —— 这是仓内更强先例(`scripts/test-teardown.sh`、`scripts/lib/lead-restart-lifecycle.sh` 的 PID-generation fence),比 `mcp-descendant-reaper.ts` 的 pid+command 二元组严格。**组信号的身份要求**: `killGroup(-pgid)` 仅当 fresh census 中该组**每个现存成员**都有精确匹配的已捕获目标身份;任何成员身份未捕获或不符 → 该组降级为逐 PID 身份点杀(或该成员直接不动)。

### 2.2 算法（顺序不可变,全程受 `REAP_TOTAL_DEADLINE_MS` 单调预算约束）

1. **守卫**（fail-closed on kill,任一不过 → `refusedReason`,零信号）:
   - `lexicalPath`/`canonicalPath` 均绝对、路径段数 ≥ 3;`canonicalPath` = `expectedParentDir` 的直接子项;
   - `basename`(剥可选 `.removing-*`/`.removing.<pid>` 后缀后)以 `repoSlugPrefix` 开头;
   - `rootProof` 按 §2.1 双路径规则核验(**symlink 证明在 `lexicalPath` 上做**,R3#1 — canonical 值已被 realpath 解掉 symlink,`lstat(canonicalPath)` 永远看不见原目标是 symlink;live-dir 还要求 `realpath(lexicalPath) === canonicalPath` 无漂移);
   - 三条在**每轮发信号前复核**(见步骤 5/7)。
2. **cwd 扫描**: 一趟 `listCwds()`,**只用 `logicalCwd` 匹配**(R3#2;`logicalCwd === null` 的行 incomplete-never-signal 记审计):取 `logicalCwd === canonicalPath ∨ logicalCwd.startsWith(canonicalPath + "/")` 的 PID 集 M。M 为空 → 快路径返回 `{matched:0, reaped:[], survivors:[], verified:true, identityMismatchSkipped:0}`(绝大多数拆除,零 ps 调用零信号)。
3. **census + 闭包**: 一次 `listProcesses()` 记录每个候选的身份三元组:
   - 后代闭包: M 沿 ppid 的全部子孙;
   - 目标集 T = M ∪ 后代闭包(**组员不因同组自动入 T**,R1#3)。
4. **保护集**: P = { selfPid, selfPid 祖先链, 1 } ∪ { pid ≤ 1 }。T ← T \ P。
5. **TERM 波**: fresh census 复核后发信号:
   - 对 pgid g,当且仅当 fresh census 证明 **g 的全部现存成员各自有精确匹配的已捕获目标身份(§2.1 三元组)且无一 ∈ P** → `killGroup(g, TERM)`(一组一信号);任何成员身份未捕获/不符 → 降级点杀;
   - 其余目标: 逐 PID 身份三元组复核通过才 `kill(pid, TERM)`;不符 → 跳过 + `identityMismatchSkipped++`;
   - ESRCH → false → 已死,视为成功。
6. **宽限收敛**: 轮询(250ms 步长,预算内最多 5s)fresh `kill(pid,0)`;全消失提前结束。
7. **KILL 波**: 幸存者按步骤 5 同规则(fresh census + 身份复核 + 组全属判定)发 SIGKILL;再轮询预算内最多 2s。
8. **定点终验**(R1#2 核心): **重跑 cwd 扫描 + census**(重扫走同一个共享 `CwdRow` 解析器、同样只按 `logicalCwd` 匹配,R3#2)—— 不是只查初始 T:
   - 新出现的 cwd 命中(快照后 fork/setsid 的新成员)→ 并入目标,回到步骤 5(有界:最多 2 轮补杀,预算内);
   - 终态: 最后一次全量重扫零命中 ∧ T 全员消失 → `verified:true`;
   - 重扫失败/预算耗尽/仍有命中 → `verified:false` + 如实 `survivors` + `verifyError`(重扫自身失败时),**绝不产出「空 survivors + verified」的假干净**。

### 2.3 失败语义（scanError 与 verifyError 分列,R2#6）

- **信号前**: `listCwds`/`listProcesses` 失败或超时 → `scanError`,**零信号**(半瞎不杀),调用方照常删目录。
- **信号后**(R3#5 扩展): 首个 TERM 之后的**任何**不确定性 —— TERM 后 fresh census 失败、每波守卫复核失败、deadline 耗尽、终验重扫失败 —— 一律 `verifyError` + `verified:false`,且**立即停止发任何后续信号**(半瞎状态下绝不升级 KILL)。
- `verified:false` / `survivors` 非空 / `refusedReason` / `scanError` / `verifyError` → 调用方照常删目录 + 大声审计(§7)。
- 模块 never-throw。

## 3. D2 — WorktreeManager 接入

### 3.1 接入点（全部在既有 repo lock 内、任何 FS/git 变更之前）

| 原语 | 插入位置 |
| -- | -- |
| `removeUnlocked()` | Phase 1 rename 之前(reap 本体;并处理本 worktree 既有 `.removing-*` 残留:逐个 reap + awaited rm) |
| `removeIfExistsUnlocked()` | registered 分支由内部 `removeUnlocked` 覆盖;orphan-dir 分支在 `fs.promises.rm` 之前自行 reap |
| `removeCleanWorktreeByPathUnlocked()` | `git worktree remove` 之前 |
| `removeWorktreeForce()` | `git worktree remove --force` 之前 |

`ReapTarget` 由 WorktreeManager 用自己的路径数学构造(`worktreePrefix`/`repoSlug`/baseDir 语义),reaper 不重新发明权威(R1#4)。

### 3.2 config 缝与结果透出

- `WorktreeConfig` 加 `reaperFn?: typeof reapWorktreeProcesses`(同 `bgDeleteFn` 先例);默认真实现。
- `removeCleanWorktreeByPath` / `removeWorktreeForce` / `removeRegisteredWorktree` 返回值加可选字段 `reaps?: Array<{ path: string; summary: ReapSummary }>`(聚合形态承载本体 + 多个 `.removing-*` 残留,R1#7)。
- `remove()` 从 `Promise<void>` 改为 `Promise<{ reaps?: ... }>`。**兼容性口径(精确)**: 源码级兼容 —— 已核实全部生产调用方 await 后忽略返回值;既有对返回对象做精确断言的测试随本单更新;不承诺字节级不变。
- `removeIfExists` 保持 `Promise<boolean>`;reap 摘要走 logger。
- **incomplete 谓词(统一)**: `survivors.length > 0 ∨ scanError ∨ verifyError ∨ refusedReason ∨ !verified` → 原语内 `logger.warn("worktree_reap_incomplete", {...})`,无论调用方是否消费结果。

### 3.3 D3 — 路径工具抽离

`canonicalizeWorktreePath`(现在 `WorktreeManager.ts` 内定义并导出)抽到新的依赖中立模块 `packages/edge-worker/src/worktree-paths.ts`;`WorktreeManager.ts` 与 reaper 都从它导入;`packages/edge-worker/src/index.ts` **保留原导出名**(teamlead 现有 import 不动),并新增导出 `reapWorktreeProcesses` / `ReapSummary` / `ReapTarget`(teamlead 类型消费需要,R1#7)。

### 3.4 不改的东西（明确表态）

- Layer A 的 `tmuxClosed === true` 前置门、dirty-guard、binding 四方一致校验 —— 原样;reap 是门后兜底。
- 删除决策逻辑零变化;reap 结果不新增任何 skip 分支。
- 无新 env flag、无新周期 timer、无 schema/StateStore 列变更(沿用 `mcp-descendant-reaper` 的 no-new-flag 合同先例)。

## 4. （并入 §3.3,编号保留防串引）

## 5. D4 — 收敛清扫（best-effort 纵深防御;tier-ii 兜底,不是合同证明）

**事实修正**(R1#6): `pruneOrphans()` 不只 boot 跑 —— `run-infra.ts:907`(boot)+ `DagDispatcher.ts:62,125`(**每次 DAG dispatch 前后**)。这个既有节拍正好是「拆除相邻时刻」,零新 timer。

`pruneOrphans()` 末尾追加两族收敛(共享单调预算 30s/趟 + 每族上限 8 项/趟,超出 logger.warn 点名剩余数,下一节拍继续 —— no silent caps):

- **族 1 `.removing-*` 残留目录**: glob 项目前缀父目录下 `<repoSlug>-*.removing*`(同时覆盖 TS 的 `.removing-<ts>` 与 cleanup-agent.sh 的 `.removing.<pid>` 两种后缀形态)→ `ReapTarget{rootProof:"live-dir"}` reap → awaited `fs.promises.rm`。
- **族 2 死路径 cwd 孤儿**(**best-effort 纵深,非合同证明** —— R2#5 定位): 发现与执行**共用同一个 `CwdRow` 解析器**(R3#2 —— 归一不止于发现层,信号 reaper 的初扫与终验重扫全部按 `logicalCwd` 匹配,Linux 的 `<root> (deleted)` 行因此在 gone-target reap 的重扫里同样命中,不会解析器单测绿、生产 no-op):
  - `rawCwd` = lsof 原样输出(诊断/审计用,永不参与匹配);
  - `logicalCwd` = raw 显式剥 Linux ` (deleted)` 尾标(macOS 报旧路径无尾标,不变);剥后仍无法得到语法有效绝对路径 → `logicalCwd: null` → 该行 **incomplete-never-signal**(记入审计,零动作);
  - `logicalCwd` canonical 后位于 `<expectedParent>/<repoSlug>-*` 之下 → 推导 worktree 根;根 (a) **不在 `git worktree list`**(registered 校验)且 (b) **盘上不存在**(lstat null;同路径已重建 → 在盘 → 双证据不成立 → 不动,天然安全)→ `ReapTarget{rootProof:"gone"}` reap。
  - 解析器双平台测试: macOS 旧路径形态、Linux 根/嵌套 ` (deleted)` 形态、同路径重建、垃圾行;**E7 必须在真实 ubuntu CI 上走默认 reaper 端到端**(真删目录 → 真 ` (deleted)` cwd 行 → 真信号收敛),不允许只测发现层解析器(R3#2)。

定位(R2 修正): 族 2 依赖删除后的 cwd 归因,而 research §1.R6 已判定这不是合同行为(lsof 缓存名,best-effort)——所以它是**纵深防御**,负责把逃过任何拆除路径(tier-ii 自删路径、rogue 路径)的泄漏在下一个 boot/dispatch 节拍**尽力**收敛,不构成 tier-ii 的正确性证明;tier-ii 的合同见 §0.0 三层结构。

## 6. D5 — shell 旁路就地收口 + 源码合同

- **cleanup-agent.sh**(R2#2: 继承完整 kill-safety 合同,不设行数上限;实现为 cleanup-agent.sh 同目录 sibling lib `.claude/orchestrator/lib/reap-worktree.sh`,它跑在无 node dist 保证的宿主项目里,不能依赖 edge-worker 构建产物):
  1. **路径守卫**(每波信号前复核): 目标必须是绝对路径、canonical 后是 canonical(`PROJECT_ROOT`) 的父目录之直接子项、basename 带 `$(basename PROJECT_ROOT)-` 前缀;`lstat` 证明真实目录且非 symlink;任何一步歧义(含 SQLite 读出的 `worktree_path` 为空/相对/畸形)→ **fail-closed 零信号**,只走原有目录删除;
  2. **身份栅栏**: 候选捕获 `pid + lstart + command`(`LC_ALL=C ps -p <pid> -o lstart=,command=`),每次 TERM/KILL 前 fresh 复核精确相等 —— 直接沿用仓内 `scripts/test-teardown.sh` / `scripts/lib/lead-restart-lifecycle.sh` 的 lstart PID-generation fence 先例;
  3. **后代闭包**(R3#4: 没有闭包就不许声称「回收进程组」): cwd 命中候选后,用一次 fresh `ps -axo pid=,ppid=` 快照沿 ppid 建后代闭包,非保护后代逐个捕获身份并入目标集;然后逐 PID 点杀(无组信号,收窄误伤面)TERM→grace→KILL→逐 PID 复验;保护集 = `$$` + 祖先链;
  4. **shell 测试**: 阳性含**子/孙进程跟退** case(组长 cwd 命中、孙进程 cd 到别处 → 闭包仍杀到);阴性: `/`/错误父目录输入、**真实文件系统 symlink 根**(不是注入的 lstat 假行,R3#1)、census 不可读、PID/lstart 不符 → 全部零信号。
- **spin.md**(按 §0.0 两级口径):
  - step 5(通用清理,runner 自删自己的 worktree): 指引改为「先对**非自身进程组**做 reap(调用 lib,保护集天然放过自己的祖先链),再 remove」——它清得掉泄漏主力(vitest/app-server/tmux 独立组),清不掉 runner 自己,后者由既有会话终结回收 + §5 兜底;文档原文注明这个物理边界,不假装干净;
  - step 4(b)(自 ship): 同样先做非自身目标 reap 再 remove;残留兜底按 §0.0 tier-ii ③ 的如实口径(成功路径 boot 节拍很快到来;handoff 失败分支无节拍,等下一次自然 boot/dispatch)。**不再使用「豁免」措辞 —— 两步都执行力所能及的 pre-reap,只是诚实声明自身 session 树清不掉。**
- **orchestrator.md**: cleanup 段指向 cleanup-agent.sh 的新 reap 步骤。
- **源码合同守卫测试**(`scripts/__tests__/test-worktree-removal-contract.test.sh`,R2#6): 不按文件白名单放行 —— 对每个 allowlist 文件断言**精确出现次数 + 相邻锚定标记**(每处合法出现的上一/下一行必须带 `# FLY-1759 reap-first` 类标记或位于 WorktreeManager 已知函数锚点);**突变夹具**: 测试内把一个合法文件复制到沙箱、注入第二处裸 `git worktree remove`、断言守卫必红。QA 域 test-teardown.sh/test-restart-services.sh 按域注记入 allowlist(FLY-1482 属地)。

## 7. D6 — 审计接线（teamlead 侧）

- `worktree-cleanup.ts`(Layer A): `reaps` 并入 `worktree_cleanup_done` payload;incomplete 谓词命中(含 `refusedReason`/`!verified`,R1#7)→ 另插 `worktree_reap_incomplete` 事件(`store.insertEvent`,event_id 带 executionId + path hash 幂等)。
- `lifecycle-sweep.ts`(Layer B): 同样并入 `lifecycle_sweep_worktree_removed` payload + incomplete 事件。
- `WorktreeCleanupAttestation` 加可选 `reaps?`(additive)。

## 8. D7 — CI 接线

- `.github/workflows/ci.yml` unit-tests job(含 heavy = edge-worker)加一步 `sudo apt-get update && sudo apt-get install -y lsof`(script-tests job 的既有 apt 步不共享,R1#6 已核实)。e2e 测试**不 skip**: lsof 缺失 = 红,fail-loud。
- **script-tests job 显式枚举新 shell 套件**(R4#1 — 本仓 FLY-1496 合同: 不在 ci.yml 里点名的 shell 套件只在作者机上跑过): 加显式 step 运行 `scripts/__tests__/test-reap-worktree-lib.test.sh`(shell reaper 行为套件)与 `scripts/__tests__/test-worktree-removal-contract.test.sh`(源码合同守卫);该 job 已装 lsof/ripgrep。按仓内惯例同步更新 CI-structure 断言(如有)覆盖这两条命令。此 workflow 变更列入 D7 与 §12 实施顺序。

## 9. D8 — TDD 测试计划

### 9.1 单测（mock 注入,`worktree-process-reaper.test.ts`）

1. 守卫全分支: 相对路径 / 父目录不符 / 前缀不符 / `live-dir` 但 lstat 是 symlink / `gone` 但路径在盘 → `refusedReason` + 零 kill。
2. 闭包: 后代闭包正确;**组员不因同组自动入 T**;保护集剔除。
3. 组信号判定: 全组 ∈ T → 一次组信号;组含外部成员 → 点杀且外部成员零信号(R1#3)。
4. 身份栅栏(R2#3): fresh 快照中 pid 复用 → 跳过不信号,覆盖三形态: command 变 / **同 command 但 lstart 变** / 同 command 且启动时刻秒级接近(近等 etimes 场景,lstart 精确相等仍能分辨);`identityMismatchSkipped` 计数断言;TERM 后新 fork 成员在终验重扫出现 → 有界补杀轮覆盖;组信号前任一成员身份未捕获 → 断言降级点杀且该成员零信号。
5. TERM→KILL 升级、ESRCH=成功、假时钟宽限。
6. 失败语义(信号前): listCwds/listProcesses 抛错/超时 → `scanError` + **零信号总量**;守卫拒绝 → `refusedReason` + 零信号。
7. **post-TERM fail-stop 表驱动矩阵**(R4#2 — 每行断言三件事: sticky `verifyError`、`verified:false`、失败点之后信号日志**零增长**):
   - TERM 后 fresh census 失败 → 不发 KILL;
   - TERM 后 lexical lstat/realpath 漂移(单测只翻转注入的 `realpath` 结果,R4#3)→ 不发 KILL;
   - TERM 后 deadline 耗尽 → 不发 KILL / 不进补杀轮;
   - 终验 cwd 重扫失败 → 不进补杀轮,`survivors` 绝不假空。
8. M 空快路径: 零 ps、零信号、`verified:true`、`identityMismatchSkipped:0`。

### 9.2 真实进程 e2e（CI 可跑,`WorktreeManager.reap.e2e.test.ts`）

每 case: mkdtemp 真 git repo + `git worktree add` → worktree 内 spawn 真进程 → 真实拆除原语 → 断言。进程夹具统一为**握手式 detached 组**(R1#5): spawn `{detached:true}` 的 shell 脚本,脚本内再 fork 孙进程,各成员把 `pid/pgid` 写进握手文件,测试等握手齐再拆除;记录的身份用于终验与 afterEach 点杀(只杀记录过身份的 PID,绝不触碰 vitest 组)。

| case | 拆除路径 | 断言 |
| -- | -- | -- |
| E1 | `remove()`(`.removing-` rename,调用点 A);夹具 = detached `sh` 组长 + `sleep` 孙 + 另一独立 detached `sleep`(混型);变体 E1b(R3#3 确定性时序): 组长 **trap 第一发 SIGTERM → 在 trap 里 fork 恰好一个新子 + 写第二握手文件 → 新子存活跨过第一波** —— fork 时点被 TERM 信号本身钉死在「初扫 census 之后」,不靠 sleep 赌调度;断言新子 PID 不在初扫 census、被后续补杀轮清掉 | 拆除后三重断言(R2#4): ①记录的每个 PID 消失(ESRCH);②**每个记录的目标 pgid 在 fresh 全量 ps 中零存活成员**(按 pgid 列过滤,不是只查记录 PID);③fresh cwd 重扫零命中。目录消失;`reaps[0].summary.verified === true`、`survivors=[]`、`matched ≥ 3` |
| E2 | `removeCleanWorktreeByPath()`(`git worktree remove`,调用点 B);同夹具(含 E1b TERM-trap fork 变体) | 同 E1 三重断言 + `removed: true` |
| E8 | 真实文件系统 symlink 阴性(R3#1): 同父目录下建 `flywheel-X`(真目录,内有活进程)与 `flywheel-Y` → symlink 指向 X;以 Y 为目标调 reap | `refusedReason`(lexicalPath lstat 是 symlink)+ X 内进程**全部存活**;真实 fs,不用注入 lstat 假行 |
| E3 | 阴性对照 ①: 进程 cwd 在 main repo | 拆除后仍活,`matched` 不含它 |
| E4 | 阴性对照 ②(共组,R2#4 修正拓扑): **测试自己**在 worktree **外** spawn detached 组长;组长 fork 两个子 — 子 α cd 进 worktree(cwd 命中,是目标),子 β cwd 在外。α 是 cwd-match 但组长/β 既非 cwd-match 也非任何 match 的后代(组长由测试 spawn,不在 T) | 组含非目标成员 → 禁组信号 → α 被身份点杀;**组长与 β 存活**(拆除后 kill(pid,0) 成功) |
| E5 | 顺序证明(R1#5): 注入 deferred `reaperFn`,resolve 前断言目录仍在、`git worktree list` 仍含该 worktree | rename / `git worktree remove` 都发生在 reap resolve 之后 |
| E6 | `.removing-*` 残留(§5 族 1): 预置 `x.removing-123` + 内部活进程 → `pruneOrphans()` | 进程零存活(同 E1 三重断言)+ 残留目录消失 |
| E7 | 死路径孤儿(§5 族 2,best-effort): 手工 rename+rm 模拟旁路拆除,留下 cwd 指向死路径的活进程 → `pruneOrphans()`;含 Linux ` (deleted)` 形态与同路径重建变体 | 进程零存活;同路径重建变体**零动作**;在册/在盘的活 worktree 内进程不受影响(内建阴性) |

回归防线语义: E1/E2 的三重 census 断言就是「删目录但进程还活着 = FAIL」的 CI 判决器;实现回退 = 必红。

### 9.3 host-only 真 tmux 变体（`.real-tmux` 命名 + 显式功能守卫）

- 守卫 = 运行时探测(`tmux -V` 可执行 + 非 CI env),探测不过 `describe.skipIf` 跳过 —— 文件名不承担 skip 语义(R1#6)。
- case: worktree 内 `tmux -D -S <worktree>/t.sock` 起真 server(复刻 FLY-1663 形态)→ `remove()` → tmux server 进程零存活。

### 9.4 shell 测试（文件名与 CI 接线见 D7）

- `scripts/__tests__/test-reap-worktree-lib.test.sh`: 阳性 bash 回归(真 `sleep` 进程 + lstart 捕获 + 复验;**含子/孙跟退 case**: 组长 cwd 命中、孙进程 cd 到别处 → 后代闭包仍杀到,R4#4/R3#4)+ §6 全套阴性(`/`/错误父目录/**真实 fs symlink 根**/census 不可读/PID+lstart 不符 → 零信号)。
- `scripts/__tests__/test-worktree-removal-contract.test.sh`: 源码合同守卫(含突变夹具:向合法文件注入第二处裸 remove → 守卫必红)。

### 9.5 全仓门

`pnpm lint` + `pnpm -r build` + CI 全量(host 上只跑定向文件,全量以 CI 为准)。

## 10. 验收对照表（issue 硬要求 → 本计划;覆盖面按 §0.0 两级口径,验收点名的调用点全在 tier-i）

| issue 要求 | 落点 |
| -- | -- |
| 进程组零存活 PID,复验不是发信号 | §2.2-8 定点终验(全量重扫)+ E1/E2 三重断言(记录 PID ESRCH + **每目标 pgid fresh ps 零存活** + cwd 重扫零命中) |
| 子/孙进程一起跟退 | 后代闭包 + E1/E2 detached 组含孙进程 + E1b 快照后延迟 fork 变体 |
| 两个调用点各一个 case | E1(`.removing-`)+ E2(`git worktree remove`)—— 两者均为 tier-i Bridge 侧原语,pre-delete 硬保 |
| 不得按进程类型枚举 | 检测 = cwd 扫描,模块零进程名匹配;E1/E2 混型夹具让枚举式实现假绿不了 |
| 删目录前先回收 | tier-i: §3.1 接入点全部在 FS/git 变更之前 + E5 顺序证明。tier-ii(runner 自删): 非自身组 pre-reap,自身组物理不可行,§0.0 三层合同诚实声明 |
| CI 可跑回归 | E1-E8 纯 `sleep`/`sh`,ubuntu CI 可跑(D7 装 lsof + 显式枚举 shell 套件) |

## 11. 部署与风险

- **部署**: 纯代码,随 PR → merge → 下一班统一重启生效;无迁移、无 config 变更。
- **自托管**: Bridge 拆 runner worktree 时真杀残留 —— 意图本身;Bridge/Lead cwd 在 main repo/home,cwd 判据 + 守卫双重排除。自 ship 路径按 §0.0 tier-ii 三层合同(非自身 pre-reap + 会话终结回收 + §5 best-effort 兜底),不再使用「豁免」表述。
- **风险 1 误杀**: 无关进程 cd 进 runner worktree(如人工查看)会被杀。缓解: runner worktree 是专属工作区,人工进入本就异常;审计留全 PID 证据。接受。
- **风险 2 锁窗**: reap 最坏 ~25s(REAP_TOTAL_DEADLINE_MS,含 lsof 10s 单次超时 + 两波等待 + 补杀轮)在 repo lock 内;M 空快路径(绝大多数)只花一趟 lsof(~0.5s 实测)。收敛清扫 30s/趟预算跑在 pruneOrphans 节拍(boot + DAG dispatch 前后),不在单 worktree 拆除的热路径上。
- **风险 3 lsof 依赖**: D7 显式安装;缺失 = e2e 红,不假绿。
- **风险 4 收敛清扫误杀活 worktree 进程**: 族 2 双重证据(未注册 ∧ 不在盘)使活 worktree 结构上不可命中;E7 内建阴性对照。

## 12. 实施顺序

D3(路径抽离,纯移动)→ D1(reaper + 单测含 post-TERM fail-stop 矩阵)→ D2(原语接入 + E1-E5 + E8)→ D4(收敛清扫 + E6/E7)→ D6(审计)→ D5(shell 收口 + 合同测试)→ D7(CI: unit-tests 装 lsof + script-tests 显式枚举两个 shell 套件)→ 全仓门。

## 13. 明确不做 + follow-up

**不做**: QA slot shell 拆房本体(FLY-1482 域;其 `worktree remove --force` 在合同 allowlist)/ 常驻 Lead 容量(FLY-517/779)/ 全 fd 扫描 / 新周期 timer / 新 env flag。

**Follow-up(建议另立 issue,不阻塞本单)**: tier-ii 外部 owner 迁移 —— 把 spin.md 自 ship / runner 自删 worktree 的清理职责移交 detached updater 或 Bridge(带 worktree 身份进 durable handoff,在 updater pull 前完成 reap→census→remove),使 tier-ii 也获得完整 pre-delete 不变量。本单拒绝就地做的原因: 触碰 FLY-270 self-ship fail-close 控制面,风险与本单泄漏修复不成比例(R2#1 处置,取 Codex 给出的诚实收窄出路)。
