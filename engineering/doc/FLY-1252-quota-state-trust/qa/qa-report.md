# FLY-1252 claude-accounts.json 配额状态可信化 — QA 报告
Issue: FLY-1252 (https://linear.app/geoforge3d/issue/FLY-1252)
日期: 2026-07-16
基于: plan.md, exploration.md, research.md, 本分支 implement phase 已提交的代码 (PR #618 @ 04f2e5959)

**结论: FAIL(kickback)** — FLY-1252 的核心修复(guard 硬拒耗尽号 / store 变真 / bypass 响亮 /
回滚安全)全部正确且已验证;但 **锁获取路径引入了一个真实回归(advisory ③ 命中)**:锁父目录
持续缺失时 `withMkdirLock` 进入**无上限、无退避、无 fail-loud 的同步忙等**(实测 99.4% CPU 不退出),
把 quota-monitor daemon 的事件循环钉死——正是本 issue 要根治的「wedged 进程拖垮 Lead」失效类。
**这一条阻塞 ship,退回 implement 修复。** 其余 QA 项全 PASS。

---

## 1. 🔴 阻塞项 — advisory ③ 锁忙等回归(BLOCKER,必须修)

**文件**: `packages/teamlead/src/account-heal/mkdir-lock.ts`,`withMkdirLock` 获取循环(~L217–253)。

**回归**: FLY-1252 改写了该循环的非-EEXIST 分支。
- **改前**(merge-base `3d862dea2`):`if (code !== "EEXIST") throw err;` —— 任何非-EEXIST 错误
  (含 ENOENT=父目录缺失)**立即抛出** = 有界、fail-loud、0% CPU 浪费。
- **改后**(本分支):
  ```
  if (code !== "EEXIST") {
    try { rmdirSync(lockPath); } catch {}
    if (code === "ENOENT") continue;   // ← 回到 for(;;) 顶,不检查 deadline、不 sleep
    throw err;
  }
  ```
  `deadline` 检查(L249)与 `await sleep(retryMs)`(L252)**只在 EEXIST 分支里**。ENOENT 的 `continue`
  两者都绕过 → `mkdirSync(lockPath)` 因父目录缺失再抛 ENOENT → 立即再 continue → **同步紧忙等,永不退出、永不退避、永不告警**;因该路径无 `await`,还**阻塞整个事件循环**。

**失败场景(可复现)**: 锁路径 = `~/.flywheel/claude-accounts.lock`;若父目录 `~/.flywheel` 在 daemon
运行期持续缺失(被清理脚本/磁盘异常删掉),daemon 下一次 `withAccountsLock`(active 轮询 / 候选验证 /
切号)获取锁 → 进入忙等 → 钉死一个 CPU 核 + 事件循环卡死 → daemon 不再轮询、不再切号、不再告警。

**实测证据**(`qa/qa-fly-1252-lock-busyloop.{sh,mjs}`,独立子进程 + 墙钟看门狗):
```
[FLY-1252 QA lock ③] FAIL: withMkdirLock did NOT settle within 6s (child %cpu=99.4)
   — unbounded busy-loop on missing parent dir (advisory ③).
```
`timeoutMs=500` 的调用 6s 后仍 99.4% CPU、`state=RN`、零输出(有界逻辑应 <1s 抛 timeout)。

**期望 vs 实际**: 期望 = 有界(抛 timeout / fail-loud)+ 退避;实际 = 无界同步忙等 + 事件循环阻塞。

**严重度**: HIGH(latent)。触发条件是异常态(父目录持续缺失,非日常耗尽路径),但一旦触发,
失效模式是硬 wedge(CPU 钉死 + 事件循环卡死)、发生在可靠性 daemon 上,且此机器长期高负载
(load 18,有夜间 OOM/crash 史)——CPU 钉死在这里格外危险。且这是 FLY-1252 亲手引入的回归。

**修复方向(小改,implementer 定)**: ENOENT 路径必须同样受 `deadline` 约束并 `await sleep(retryMs)`
再重试(或按 N 次上限 fail-loud,或恢复改前的立即抛出语义)。核心:acquire 循环**任何**分支都不得
无界紧忙等。修完 `qa/qa-fly-1252-lock-busyloop.sh` 应转绿。

---

## 2. 其余 QA 项 — 全 PASS

### 2.1 Lead QA scope 逐条(Tadashi 2026-07-16)

| # | scope 项 | 结果 | 证据 |
|---|---|---|---|
| ① | daemon 观察回写 store(G3 时间戳/单写者/last-observed-wins),不再全 null | ✅ | `quota-monitor.test.ts`+`account-store.test.ts`+e2e runtime-replay(3 号双窗口投影一致) |
| ② | 手动 use/next 切前实测 → 耗尽号**硬拒**(非警告)+ 报「哪个号有量」(actionable) | ✅ | `claude-profile.test.ts` 12 条 + e2e + 突变对照 B(exit 32 + `Suggestion: use shopping`) |
| ③ | **busy-loop probe** 锁父目录缺失不得忙等 | 🔴 **FAIL** | 见 §1 |
| ④ | 响亮 bypass:log + 一条告警、绝不静默 | ✅ | e2e bypass 段(两独立 claim)+ `claude-profile.test.ts` bypass 用例 |
| ⑤ | kill-switch 回滚:撤 CUTOVER 后 legacy 读真数据 | ✅ | e2e runtime-replay legacy 双场景(store-truth / live-guard) |
| ⑥ | TOCTOU fencing:唯一 holder-marker + dead-PID-only stale-break + 不误杀活但卡住的 holder | ✅ | `mkdir-lock.test.ts`+`claude-profile.test.ts` 锁用例(live holder 永不 age-steal) |
| ⑦ | env-override 一致性 | ✅ | `claude-profile-cli.ts` 同时 `delete QUOTA_BYPASS`+`delete QUOTA_PREVERIFIED`,仅 `quotaPreverified===true` 再注入 PREVERIFIED;`quota-guard-cli.test.ts`+`claude-profile-cli.test.ts` |

### 2.2 自动化测试(FLY-1252 自有)

| 层 | 命令 | 结果 |
|---|---|---|
| teamlead 单测(FLY-1252 相关 10 文件) | `vitest run` 定向 | **142 passed** |
| claude-runner bash 集成 `claude-profile.test.ts`(含 12 FLY-1252 live quota guard) | `vitest run` | **58 passed** |
| hermetic e2e 事故复现 | `scripts/qa-fly-1252-quota-state-e2e.sh` | **exit 0**,3 段 PASS |
| 独立突变对照(guard 是否 load-bearing) | `qa/qa-fly-1252-guard-mutation.sh` | **exit 0**(A 阳性/B 修复/C 突变复现事故) |
| biome lint(11 源文件) | `biome check` | exit 0 |
| tsc typecheck | teamlead + claude-runner | 各 exit 0 |

### 2.3 突变对照(anti-vacuous-green,`qa/qa-fly-1252-guard-mutation.sh`)

同一 scratch 环境跑生产 launcher 三路:**A** 真 guard+healthy → 切成功(不是 block-everything);
**B** 真 guard+exhausted → exit 32 + Keychain/.active 未动 + store 落真 7d=100%/reset;
**C** 瞎子 guard(永远 exit 0)+exhausted → 切成功(**事故复现**)。证明 exit-32 判定精确、可区分、load-bearing。

## 3. 全量套件失败的甄别(非 FLY-1252 回归)

teamlead 全量套件在 load 18 下有 38(run1)/53(run2)个失败——**两次数量不同本身即证明是 flake**。
12 个失败文件**无一 import FLY-1252 改动模块**(grep 全 NONE):`codex-lead-runtime.test.ts`(22 个,
已知 TMPDIR 与 `~/.flywheel` 重叠的环境性假失败)、`tmux-lookup.real-tmux` / `worktree-quarantine`(real
tmux/git,环境敏感)、`bridge` / `runs-route-registration`(server 启动)、`post-ship-finalization` /
`run-dispatcher`(Promise.all exactly-once 计时)。FLY-1252 自有 10 文件隔离跑 142/142 全绿 → 这些失败
是 load/env flake,**不是 FLY-1252 回归**。(另有 vitest worker `Timeout calling onTaskUpdate` = load 伪失败。)

## 4. 生产安全

- 生产 `~/.flywheel/claude-accounts.json` mtime = `2026-07-16T01:16:42`(QA 会话 `~04:xx` 之前)**未写**。
- 所有 harness `env -i` + scratch HOME/pool/store/lock + mock server + 桩 security,零生产副作用。

## 5. 复现命令

```bash
# 阻塞项(当前 RED,修后应转绿)
bash engineering/doc/FLY-1252-quota-state-trust/qa/qa-fly-1252-lock-busyloop.sh

# 全绿项
bash scripts/qa-fly-1252-quota-state-e2e.sh
bash engineering/doc/FLY-1252-quota-state-trust/qa/qa-fly-1252-guard-mutation.sh
(cd packages/teamlead && npx vitest run src/__tests__/account-store.test.ts \
  src/__tests__/quota-guard-cli.test.ts src/__tests__/quota-monitor.test.ts \
  src/__tests__/switch-executor.test.ts src/__tests__/mkdir-lock.test.ts \
  src/__tests__/account-summary.test.ts src/__tests__/claude-profile-cli.test.ts \
  src/__tests__/quota-monitor-runtime.test.ts src/__tests__/quota-monitor-alert-contract.test.ts \
  src/bridge/__tests__/kind-contract.test.ts)
(cd packages/claude-runner && npx vitest run test/claude-profile.test.ts)
```
