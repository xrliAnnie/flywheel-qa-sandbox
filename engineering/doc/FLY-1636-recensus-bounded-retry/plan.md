# FLY-1636 restart 换代 re-census 补对称有界重试 — 实施计划

Issue: FLY-1636 (https://linear.app/geoforge3d/issue/FLY-1636/减法-follow-up-restart-换代-re-census-补对称有界重试-消灭换代成功却被记失败的窄窗竞态1634-qa)
日期: 2026-08-04
基于: 无(上游为 FLY-1634 的 `engineering/doc/FLY-1634-restart-net-deletion/plan.md` 与其 QA v2 报告 Probe D residual)
Review: Codex design review 2 轮 **APPROVED**(R1 4 项全采纳:file-backed 调用计数 / TERM_IMMUNE opt-in / T3 精确计数断言 / 账目更正;R2 零新发现)

## 1. 缺陷定位(代码审计结论)

FLY-1634 后的 `lead_body_hard_clear()`(`scripts/lib/lead-body-sweep.sh:397-464`,无 expected-pid 的 census 路径)里,sensor 读点的容错是**不对称**的:

| 读点 | 位置 | 瞬时失败的下场 |
|---|---|---|
| 首次 census(windows + tuples) | `lead-body-sweep.sh:412-428` | **有界重试**:最多 `term_attempts + kill_attempts` 次,每次 `sleep interval` |
| TERM 观察循环 | `lead-body-sweep.sh:433-440` | `observe_rc=2` 落入循环体 sleep 后重试(天然有界重试) |
| **TERM→KILL 之间的 re-census** | **`lead-body-sweep.sh:442-449`** | **单发**:`_lead_body_target_windows` 或 `_lead_body_claude_tuples` 失败一次即 `return 2` |
| KILL 观察循环 | `lead-body-sweep.sh:454-461` | 同 TERM 观察循环,有界重试 |

竞态窗:TERM 已发出、目标进程正在死(或观察循环因抖动未能确认),TERM 观察循环耗尽 → 走到 re-census;此刻 `list-panes` / `ps` 恰好瞬时失败一次 → `return 2`。调用方 `restart-services.sh:1257` 把任何非零 `clear_rc` 记为该 Lead 换代失败(走 `restart_lead_recover_job_after_failure` + `return 1`),整场部署报 degraded —— 而目标进程随后死于已发出的 TERM,**实际清场成功**。这就是「换代成功却被记失败」(founder 2026-08-04 晨「6/16 失败」症状类;1634 QA Probe D residual)。

exact-tuple 模式(`_lead_body_hard_clear_exact`)**没有** re-census 单发点:TERM/KILL 等待循环内 rc=2 都被循环重试;唯一单发是 TERM 之前的初始 probe(`lead-body-sweep.sh:367-369`),但那是 mutation 之前 fail-closed,不会产生「实际成功被记失败」,不在本 issue 范围(见 §6)。

## 2. 修法(减法:去不对称,不加机制)

给 re-census 补上与首次 census **逐字同构**的有界重试循环。复用同一组既有参数(`LEAD_BODY_CLEAR_TERM_ATTEMPTS` / `LEAD_BODY_CLEAR_KILL_ATTEMPTS` / `LEAD_BODY_CLEAR_INTERVAL`),**零新配置、零新机制**。

`scripts/lib/lead-body-sweep.sh:442-449` 由:

```bash
  rc=0
  windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
  if [ "$backend" = claude-code ]; then
    tuples="$(_lead_body_claude_tuples "$project" "$lead_id")" || rc=$?
  else
    tuples="$codex_tuples"
  fi
  [ "$rc" -eq 0 ] || return 2
```

改为(与 `:413-428` 首次 census 循环同构):

```bash
  # Re-census before KILL retries transient sensor loss exactly like the
  # initial census; a persistent failure still fails closed.
  attempt=0
  while [ "$attempt" -lt "$((term_attempts + kill_attempts))" ]; do
    rc=0
    windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ "$backend" = claude-code ]; then
        tuples="$(_lead_body_claude_tuples "$project" "$lead_id")" || rc=$?
      else
        tuples="$codex_tuples"
      fi
    fi
    [ "$rc" -eq 0 ] && break
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ "$rc" -eq 0 ] || return 2
```

要点:

- **codex backend 语义逐字不变**:re-census 继续沿用冻结的 `codex_tuples`(初次 census 的 descendant snapshot),不重新推导 —— `kill-window` 已执行,重新从 pane 推导会丢 KILL 目标。codex 分支在循环里不产生 sensor 调用,首轮 windows 成功即 break,行为与现状等价。
- **fail-closed 语义保留**:持久失败重试耗尽后仍 `return 2`(sensor failure),绝不盲发 KILL —— 与首次 census 的「persistent sensor loss fails closed」同一合同。
- **重试期间目标死透是收益不是风险**:若 re-census 重试期间目标死于 TERM,census 成功且为空,后续 KILL 循环 signal 无目标、观察循环立即判 clear → 返回成功。把原本的 false-fail 变成 true success,正是本 issue 要的结果。
- Bash 3.2 安全(与全文件一致,无新语法);`attempt` / `rc` 均为既有 local 变量,复用。
- 生产 diff:8 行 → 18 行,净 **+10 行**,单文件单函数。无任何行为面之外的改动。

## 3. 测试计划(TDD,RED → GREEN)

全部落在既有 harness `scripts/__tests__/lead-body-hard-clear.test.sh`(已在 CI `ci.yml:362` 注册,无需新注册)。

### 3.1 harness 微扩(fixture 能力,非新机制)

现有注入 `PROCESS_TABLE_FAILURES_FILE` 只能「fail 前 N 次」,打不到 re-census(首发失败被首次 census 的重试吃掉)。需两个 fixture 能力(Codex R1 #1/#2 已折入):

1. **fail 恰好第 N 次调用(file-backed 计数,R1 #1)**:`_lead_body_target_windows` 以 `inventory="$(lead_body_pane_inventory)"` 取数,fixture 在 command substitution **子壳**里执行,shell 变量计数不会持久 —— 计数器必须 file-backed。新增 `INVENTORY_CALL_COUNT_FILE`(置于 `TEST_ROOT` 下,`reset_fixture` 归零),`lead_body_pane_inventory` 覆写先读-增-写该文件,再对照 `INVENTORY_FAIL_AT_CALLS`(空格分隔的调用序号集合,命中即 `return 2`)。与既有 `PROCESS_TABLE_FAILURES_FILE` 同一 file-backed 模式,Bash 3.2 安全。选 pane inventory 而非 process table 做注入点,因为 issue 点名的是 `list-panes`,且 claude/codex 两 backend 的 re-census 都经过它。
2. **TERM 免疫目标(opt-in,R1 #2)**:新增可复位标志 `TERM_IMMUNE=0`(`reset_fixture` 复位),`lead_body_signal` 覆写在 `TERM_IMMUNE=1` 时仅 KILL 加入 `DEAD_PIDS`(TERM 只记录)——迫使流程走完 TERM 观察循环、抵达 re-census。默认 0 = 既有行为逐字不变,既有用例的 TERM 收敛覆盖不受影响;仅 T1-T4 置 1。

配 `LEAD_BODY_CLEAR_TERM_ATTEMPTS=1 / KILL_ATTEMPTS=1 / INTERVAL=0`,pane inventory 的调用序列确定为:#1 首次 census、#2 TERM 观察、**#3 re-census**、#4+ KILL 观察。

### 3.2 新用例

| # | 用例 | 注入 | 现码(RED) | 修后(GREEN) |
|---|---|---|---|---|
| T1 | **re-census 单次瞬时失败 → 换代仍记成功**(issue 验收 1,claude backend) | TERM 免疫 + `INVENTORY_FAIL_AT_CALLS="3"` | rc=2(false fail) | rc=0,且 `SIGNAL_CALLS` 含 `KILL:101`(证明走完了 KILL 段而非早退) |
| T2 | 同 T1,codex backend(`INVENTORY_FAIL_AT_CALLS` 对准该 backend 实测的 re-census 调用序号) | 同上 | rc=2 | rc=0,且 KILL 目标集 = 冻结的初次 codex tuples(201、203),不含非目标(202) |
| T3 | **re-census 持久失败仍 fail-closed 且有界**(R1 #3:用 §3.1 已定义的注入模式 + 精确计数断言) | TERM 免疫 + `INVENTORY_FAIL_AT_CALLS="3 4"`(TERM=1/KILL=1 时 re-census 重试预算恰为 2 次,即调用 #3、#4 全失败) | —(现码也 rc=2,单发) | rc=2,且 file-backed inventory 计数**恰为 4**(证明两次 re-census 尝试都被消耗 = 重试真实发生且有界)、无 KILL 信号发出 |
| T4 | 无注入回归哨兵:T1 的 fixture 形状去掉注入后 rc=0 | TERM 免疫,无失败注入 | rc=0 | rc=0(排除 fixture 本身制造假绿) |

RED 先行:先落 T1/T2/T3/T4 与 harness 微扩,跑出 T1/T2 在现码上 FAIL 的证据,再上 §2 的修补转 GREEN。

### 3.3 回归(issue 验收 3)

1634 台架照跑全绿,逐条:

- `bash scripts/__tests__/lead-body-hard-clear.test.sh`(既有 14 条断言 + 新增用例的断言,R1 #4 账目更正;基线已实测 14/14 绿)
- `bash scripts/__tests__/lead-restart-controlled-wave.test.sh`
- `bash scripts/__tests__/restart-self-detach.test.sh`
- `bash scripts/__tests__/restart-storm-gate.test.sh`
- `bash scripts/test-restart-services.sh`
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(本改动零 TS 面,但按 executor 规程全仓跑)

## 4. 净变化清单(issue 验收 2)

- 生产:`scripts/lib/lead-body-sweep.sh` 单函数 +10 行(重试循环),无新函数、无新 env、无新配置键、无新告警 kind、无 schema 变化。
- 测试:`scripts/__tests__/lead-body-hard-clear.test.sh` harness 微扩(`INVENTORY_CALL_COUNT_FILE` + `INVENTORY_FAIL_AT_CALLS` + `TERM_IMMUNE`)+ 4 用例(≈ +80 行,测试代码)。
- 文档:`CLAUDE.md` 里程碑行 + 本文件夹 docs(R1 #4:随主 PR 末 commit,惯例同全部 issue)。
- 其余文件零改动。

## 5. 实施步骤(给实现节点)

1. harness 微扩 + T1-T4 落地,跑 RED(T1/T2 FAIL on HEAD)。
2. `lead-body-sweep.sh:442-449` 换成 §2 循环,跑 GREEN。
3. §3.3 回归全绿。
4. Codex code review(`codex:rescue`)循环至 APPROVED。
5. PR(base=main),最后一个 commit 带 CLAUDE.md 里程碑行。

## 6. 诚实边界

- **只修 census 路径的 re-census 单发点**。exact-tuple 模式 TERM 之前的初始 probe(`lead-body-sweep.sh:367-369`)也是单发 return 2,但发生在任何 mutation 之前、fail-closed 不产生「成功被记失败」,且不是 issue 点名的 TERM→KILL 窗口 —— 明确不动(scope discipline;如需另开 issue)。
- **不改变 fail-closed 合同**:持久 sensor 失败依旧 rc=2 记失败。本修复只消灭「单次瞬时抖动」被当成持久失败。
- **不消灭所有 degraded 假阳性**:re-census 重试耗尽、quiescence 失败等其它失败路径原样保留;本 issue 只抹平 1634 QA Probe D 点名的这一个不对称。
- **概率量级如 issue 所述**:1634 后需精确竞态才触发(4 次真机换代 0 自然复现),本修复是抹平尾部,不是修常发故障;生产 16/16 全绿仍是 ship 后自然观察项。
