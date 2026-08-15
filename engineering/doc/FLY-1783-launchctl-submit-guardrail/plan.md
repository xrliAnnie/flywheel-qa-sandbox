# FLY-1783 launchctl submit 旁路补拦 — 实施计划

Issue: FLY-1783 (https://linear.app/geoforge3d/issue/FLY-1783/infraguardrail-补拦-launchctl-submit-旁路-detached-重启只许走-request-restartsh)
日期: 2026-08-15
基于: research.md
Review: Codex design review 3 轮 — R1 4 项 + R2 4 项全采纳,R3 **APPROVED**(附 1 条非阻断实现提醒,已折入 C4 注)

## 0. 一句话

四层互补堵死「launchd 一次性 job 触发 restart-services」旁路:①护栏补词+扩条件(agent 层硬拦)、②restart-services 拒绝「被 launchd 直接执行」(job 已建成后的最后一道)、③测试合同(防未来倒退)、④rules 红线(覆盖无 hook 的 Codex Lead)。全部 Tier-1 生效,零服务重启(复用既有 `deploy_failed` alert kind,不碰 TS 侧 alert 合同)。

### 实现期 Lead 裁定补充(2026-08-15,code review R1 后)

以下三点取代本文后续对应的早期实现片段/残余接受:

1. P1/P2 对 quote-aware shell segment 做判断;纯 `grep`/`rg` source inspection 先摘除,但 command/process substitution、`rg --pre` 与相邻 mutation 仍硬拦。P4 只把真正的 crontab 写入视为 mutation,`crontab -l | grep/rg ...` 放行。
2. self-detach 的 1 秒观察期保留 child status:仍活着才 `disown`;已退出时 `wait`。exit 0(含既有 lock-contention no-op)原样成功,非零才 fail-loud,不再把快速正常完成误报成 detach failure。
3. 静态合同先逐个断言扫描文件存在且可读,并区分 grep rc=1(无命中)与 rc>1(扫描失败);missing-file mutation control 防 vacuous green。

## 1. 范围

**改**:`scripts/hooks/flywheel-restart-guard.py`、`scripts/restart-services.sh`、`packages/teamlead/lead-rules-base/founder-only-authority.md`、测试三处、`.github/workflows/ci.yml`(新测试文件枚举 1 行)。
**不改**:`scripts/lead-alert.sh` 与 TS 侧 alert-kind 合同(R1-#1:kind 白名单是跨 shell/TS 的共享合同 — `LeadAlertNotifier.ts` `ALERT_EVENT_TYPES` + kind-contract + copy + routing;加新 kind 会破坏「零服务重启」承诺。改为复用既有 `deploy_failed` kind + 独立日级 signature,零合同改动)、bypass 记账合同、storm gate(根因②另单)、Bridge/updater plist、install-restart-guard.sh。

## 2. 改动清单

### C1 护栏扩展 — `scripts/hooks/flywheel-restart-guard.py`

1. **P1 mutating 表补词**:`MUTATING_LAUNCHCTL` 加 `submit`(事故命令从此命中 P1)。
2. **新标识正则**(guard 内新常量):
   ```python
   RESTART_SCRIPT_RE = re.compile(r"restart-services|self-ship-restart|update-flywheel", re.I)
   ```
3. **P1 第二条件扩成析取**:`P1_RE ∧ (FLYWHEEL_LABEL_RE ∨ RESTART_SCRIPT_RE)` — 堵 label 规避形(`-l com.foo.x -- bash …/restart-services.sh`)。
4. **P2 标识表补词**:`PROC_IDENT_RE` 加 `restart-services` — `pkill -f restart-services`(杀在飞 wave)从此被拦。*小幅超出 issue 字面范围,理由:事故 runbook 明令「在飞 wave 别杀」,一词之改与本单同根因同层,拆单不值得。design review 如判超范围可单独摘除,不影响其余。*
5. **新模式 P4(scheduler 旁路)**:
   ```python
   SCHEDULER_RE = re.compile(r"\bcrontab\b", re.I)
   # scan_block 内,P3 之后:
   if SCHEDULER_RE.search(cmd) and (RESTART_SCRIPT_RE.search(cmd) or FLYWHEEL_LABEL_RE.search(cmd)):
       return "P4"
   ```
   只收 `crontab`。`at`/`batch` 刻意不收:`\bat\b` 在自然语句里高频(误报面不可控),且 macOS atrun 默认禁用 — 记 residual。
6. **DENY_REASON 补一行**(放在「正确做法」之前;R1-#2/R2-#4 措辞精确化 — 三种机制各说各的语义,不笼统归为一种):
   `"launchctl submit 退出即重拉;crontab 周期重跑;自装 plist 可被配置成重拉 — 2026-08-14 就是 submit 造成 66 连发重启风暴。"`
7. docstring 同步(P1 条件、P4、事故引用)。

### C2 restart-services 结构性自卫 — `scripts/restart-services.sh`

**(a) 拒绝「被 launchd 直接执行」**(R1-#2 收窄后的准确承诺:本层只保证拒绝 *launchd 直接以本脚本为 job 程序* 的形态 — 即事故的 submit 形态与等价手写 plist 直指本脚本的形态;launchd→wrapper→本脚本、或 plist 自带 `FLYWHEEL_RESTART_FOREGROUND=1` env 的形态归入 §6 残余,由 C1/C5 层兜)。

判定谓词抽成**纯函数**,生产调用点只传只读 `$PPID`,**无任何 env seam**(R1-#2:生产 env override = 给无 hook 调用方送 bypass;删除):

```bash
# FLY-1783: pure predicate — no side effects, unit-testable via the extracted
# harness. Args: $1 = caller ppid, $2 = foreground flag value.
_rs_is_direct_launchd_invocation() {
    [[ "$2" != "1" && "$1" == "1" ]]
}
```

调用点:参数解析结束、`validate_restart_contract` 调用**之前**(任何 mutation 之前;告警 helper 定义在前,可用):

```bash
if _rs_is_direct_launchd_invocation "$PPID" "${FLYWHEEL_RESTART_FOREGROUND:-0}"; then
    log "ERROR: started DIRECTLY by launchd (ppid 1) — refusing before any mutation (FLY-1783)."
    log "A submit-style job relaunches on every exit — the 2026-08-14 66-spawn storm shape."
    log "Detached restarts have exactly one sanctioned path:"
    log "    bash ~/Dev/flywheel/scripts/request-restart.sh"
    alert_launchd_refusal "refused direct launchd invocation of restart-services.sh (ppid 1); see FLY-1783 / incident 2026-08-14"
    exit 78
fi
```

(R2-#4:拒绝日志点名事故机制「submit-style job」,不再对所有 launchd job 笼统断言重拉。)

告警 helper(与 `alert_discord_plugin_integrity` 同款**日级** signature 先例;R1-#1:复用既有 `deploy_failed` kind — TS 侧合同零改动;**不能**复用 `alert_severe`,它是分钟级 signature,10 秒一拉的拒绝循环会变成每分钟一条的告警风暴;R2-#1:保留 `deploy_failed` 既有的 founder-mention 缺席警告,与 `alert_severe` 对齐):

```bash
alert_launchd_refusal() {
    # $1 = body. DAILY signature — a relaunch-looping refused job must alert
    # at most once per day, not once per relaunch.
    if [[ -z "${FLYWHEEL_FOUNDER_USER_ID:-}" ]]; then
        log "WARNING: FLYWHEEL_FOUNDER_USER_ID not set — deploy_failed alert will NOT @-mention the founder" >&2
    fi
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
        --kind deploy_failed --severity severe \
        --title "restart-services refused a direct launchd invocation" --body "$1" \
        --signature "restart-guard-launchd-refusal-$(date -u +%Y%m%d)" \
        ${FLYWHEEL_FOUNDER_USER_ID:+--mention-user "$FLYWHEEL_FOUNDER_USER_ID"} 1>&2 || true
}
```

要点:
- 判据 `FOREGROUND≠1 ∧ ppid==1` 在**这个收窄后的承诺范围内**无合法出现形态(research §3 推论,S1–S6 全实测:updater 链双重豁免、request-restart 不直调、交互 shell ppid≠1、detach child 带 FOREGROUND=1);
- fail-closed 方向正确:极端误判也只是「响亮拒绝 + 指路」,不会静默吞掉重启;告警失败(`|| true`)绝不改变拒绝结果;
- 测试直接调用纯函数(focused harness 抽取),不需要伪造 ppid。

**(b) self-detach spawn 验活 — 明确定位为 best-effort 即时启动检查**(R1-#3:`kill -0` 只能证明「此刻 PID 存在」,**不承诺** lock 竞争等 1 秒后的失败会被父进程如实上报 — 那些仍由 child 自己的日志负责。不做 readiness marker:对本单的事故面,即时死亡检测已闭环,marker 是过度工程):

```bash
detach_log_dir="${FLYWHEEL_RESTART_DETACH_LOG_DIR:-/tmp}"   # 测试/QA 房隔离用
detach_log="${detach_log_dir}/flywheel-restart-detached-$(date +%Y%m%d-%H%M%S).log"
… nohup spawn 原样 …
sleep 1
if ! kill -0 "$detach_pid" 2>/dev/null; then
    log "ERROR: detached restart child died within 1s (PID $detach_pid) — failing LOUD."
    log "NOT retrying via any re-spawning scheduler. Last log lines:"
    tail -n 20 "$detach_log" >&2 || true
    exit 1
fi
```

**有意的合同变化**:此前 child 秒死时父进程仍 `exit 0`(静默假成功);现在这一类改为非零 + 日志尾。正路调用方不受影响(updater 走 FOREGROUND=1 不进此块)。

**(c) 头部注释**:self-detach 块上方补一段「唯一 sanctioned detach = 本块(进程组 + nohup + disown);绝不引入 session-leader 重执行或 launchd 一次性 job 提交;detach 失败 = 停下上报,绝不静默换机制」。措辞**刻意避开** `setsid` / `launchctl submit` 字面(C4-T5 静态合同会 grep 这些 token,注释不能自己踩)。

### C4 测试(TDD:先写红,后实现)

**T-guard — `scripts/hooks/test-flywheel-restart-guard.py`(扩 matrix,CI 已接)**

must-block 新增:
| 形态 | 断言 |
|------|------|
| 事故逐字命令(`launchctl submit -l com.flywheel.restart-bus-manual -o … -- /bin/bash …/restart-services.sh --force`) | P1 deny |
| label 规避:`launchctl submit -l com.foo.x -- bash /Users/…/scripts/restart-services.sh --force` | P1 deny |
| 嵌套:`bash -c "launchctl submit -l com.flywheel.x -- …restart-services.sh"` | deny(裸串扫描) |
| env 注入载荷:`launchctl submit -l com.foo -- /bin/bash -c 'FLYWHEEL_RESTART_FOREGROUND=1 bash …/restart-services.sh'` | deny |
| `echo '* * * * * bash …/restart-services.sh --force' \| crontab -` | P4 deny |
| `pkill -f restart-services.sh` | P2 deny |

must-pass 新增(0 误报 in-matrix):
`launchctl list`;`launchctl print gui/501/com.flywheel.bridge`;`launchctl submit -l com.test.probe -- /usr/bin/env`(无 flywheel 标识);`launchctl remove com.test.probe`(同);`bash scripts/request-restart.sh`;`crontab -l`;`git log --oneline scripts/restart-services.sh`;`bash scripts/test-restart-services.sh`。

out-of-matrix 已接受误报类照旧(如 `grep -n "launchctl submit" scripts/restart-services.sh`)— 不断言、docstring 记一笔。

**T-restart — 落点改为 `scripts/__tests__/restart-self-detach.test.sh`(R1-#4:该 focused harness 已用 sed/awk 抽取真实 parse+detach seam,CI `:433` 已接;大 harness `test-restart-services.sh` 的 hermetic 用例硬编码 `FLYWHEEL_RESTART_FOREGROUND=1`,非 foreground 用例塞不进去;且该大 harness 在本机有宿主基线失败,不适合承载新断言)**

**R3 非阻断实现提醒(实施时必须照做)**:现有 harness 头部的 `log() { :; }` 是空操作 stub,而 T1c/T3 要断言经 `log` 发出的文案 — 新增的 refusal/early-death harness 变体要给 `log` 一个**可观察** stub(stderr 透传或独立日志文件),且只作用于新变体,既有 detach 用例的输出合同不动。

**seam 分层(R2-#1 定稿)**:shim 打在**最低层** — 假的 `lead-alert.sh` 可执行文件(记录完整 argv 到文件、可配置退出码),harness 抽取并运行**真实的** `alert_launchd_refusal` helper 与真实拒绝块;`date` 以 PATH shim 固定为恒定 UTC 值(byte-exact signature 断言不许撞午夜换日)。恒真谓词 stub 只用于把拒绝块压进 deny 分支,但必须**记录收到的实参**并断言(R2-#2:防调用点漂移 — 生产调用点少传 `$PPID`、换参数顺序、或改回 env 推导时 CI 必须变红)。

| # | 场景 | 断言 |
|---|------|------|
| T1 | 纯函数单测:`_rs_is_direct_launchd_invocation 1 0` / `1 ""` | 返回 0(拒) |
| T1b | `_rs_is_direct_launchd_invocation 1 1`(updater/detach-child 形态)、`_rs_is_direct_launchd_invocation <非1> 0`(交互 shell 形态) | 返回 1(放行) |
| T1c | 拒绝块全链(记参谓词 stub 压 deny 分支 + 真 helper + 假 lead-alert.sh + 固定 date。注:bash 的 `$PPID` 在 shell 启动时固化、orphan reparent 不更新,「真实孤儿」形态无法决定性构造,真 launchd 形态留 §5 QA) | exit 78;stderr 含 request-restart.sh 指路;launchctl shim **零调用**;谓词 stub 收到的实参 == (harness shell 的真 `$PPID`, 期望的 foreground 值);假 lead-alert.sh 捕获的 argv **逐字**含 `--kind deploy_failed` 与 `--signature restart-guard-launchd-refusal-<固定date输出>`(R1-#4/R2-#1:在 helper 内层断言精确 argv 才证明日级去重形态) |
| T1c-src | 调用点源码断言 | `grep -F '_rs_is_direct_launchd_invocation "$PPID" "${FLYWHEEL_RESTART_FOREGROUND:-0}"'` 逐字命中生产脚本恰 1 次(R2-#2 的第二道防漂移) |
| T1d | T1c 且假 lead-alert.sh 退出码非零 | 仍 exit 78 — 证明**真实 helper 内层的** `\|\| true` 吸收了失败(R2-#1:此断言只有 lead-alert 层 shim 能给;stub 在 helper 层会在 `set -e` 下先炸,Codex 已实测) |
| T2 | `FLYWHEEL_RESTART_FOREGROUND=1`(updater 形态) | 不拒,照常进入既有 foreground 流程(沿用 harness 现有断言) |
| T3 | detach 路径 + `FLYWHEEL_RESTART_DETACH_LOG_DIR=<指向一个普通文件>`(`<file>/x.log` 确定性 "not a directory";R2-#3:chmod 式「不可写目录」在特权 CI 下不成立) | 非零 exit;stderr 含 fail-loud 行;shim 记录里 `launchctl` 无 `submit\|load\|bootstrap` 调用(**deliverable 3 的逐字断言:fallback 不产生 KeepAlive 语义 job**) |
| T4 | detach 正常路径:测试用**两阶段 child**(写 started marker → 存活越过父进程 1s 探针 → 写 completion marker → 退出;R2-#3:现有 harness 的 child 秒退,不改会误入早死分支) | exit 0;detach_log 落在 override 目录;disown 后无法 `wait` 回收 — 以 completion marker + 有界轮询 PID 消失代替,超时则 kill 该 PID,**然后**才清理 temp 目录 |

**T5 静态源合同 — 新文件 `scripts/__tests__/fly1783-restart-detach-contract.test.sh`**

`grep -E '\bsetsid\b|launchctl[[:space:]]+submit'` 扫 `scripts/restart-services.sh scripts/request-restart.sh scripts/self-ship-restart.sh scripts/update-flywheel.sh` → 必须零命中(含注释,见 C2-c 措辞纪律)。**阳性对照**:对注入了违禁 token 的临时副本跑同一谓词必须变红(证尺子)。
CI:ci.yml 显式加 `bash scripts/__tests__/fly1783-restart-detach-contract.test.sh` 一行(枚举守卫 `ci-shell-suite-enumeration.test.sh` 强制分类,漏加会红)。

### C5 rules 红线 — `packages/teamlead/lead-rules-base/founder-only-authority.md`

在「Order of precedence」节前新增:

```markdown
## R4 — Fleet Restart Discipline (FLY-1783, 2026-08-14 incident)

Detached / survive-your-own-replacement full restarts have EXACTLY ONE sanctioned path:

    bash ~/Dev/flywheel/scripts/request-restart.sh

It enqueues the standalone com.flywheel.updater (outside the Lead fleet); the
initiating Lead is itself replaced by the wave. That is the point — you do not
need to outlive the restart, the updater does.

Hard red lines (no judgment calls):
- NEVER `launchctl submit` (or any hand-rolled launchd job / crontab entry)
  pointing at restart-services.sh. Submit-style jobs re-run on EVERY exit —
  on 2026-08-14 this produced 66 chained restarts and 20 minutes of Bridge
  downtime.
- macOS has no `setsid`; do NOT improvise detach chains (`nohup setsid …`)
  and do NOT invent a replacement when a detach attempt fails. A failed
  detach means STOP and report — never silently switch mechanisms.
- Emergency direct `restart-services.sh` (updater/queue broken, Lead/founder
  explicitly aware) runs it as a plain synchronous child in your shell — the
  script detaches itself. You never wrap it in a scheduler.

Enforcement: the FLY-913 PreToolUse guard hard-blocks the scheduler shapes at
the Bash boundary (Claude sessions), and restart-services.sh itself refuses to
run as a direct launchd child (ppid 1). This section is the behavioral layer —
it also binds Leads with no hook layer (Codex).
```

覆盖:cos + dept、Claude + Codex(FLY-350 bundle)。companion/external 不装载(不碰基建,维持现状)。

### C6 不做清单(scope 纪律)

- 不动 storm gate、不动 Bridge plist、不动 bypass 合同;
- 不拦 `launchctl bootstrap/load <任意 plist 路径>` 的两步旁路(工具边界,research §8);
- 不加 `at|batch` 到 P4(误报面);
- 不给 install-restart-guard.sh 加东西(hook 文件本身变了,installer 原样 converge)。

## 3. 实施顺序(TDD)

1. RED:T-guard matrix 新行(跑红)→ C1 → GREEN;
2. RED:T5 静态合同(先对阳性对照证尺子,本体应直接绿 — restart 三脚本今天就无违禁 token;它防的是未来)→ C2-c 注释措辞核对;
3. RED:T1/T1b/T1c/T1d/T2 → C2-a → GREEN;
4. RED:T3/T4 → C2-b → GREEN;
5. C5 rules(文档,无测试;`lead-rules-bundle` 既有测试若快照文件清单需同步则跟改);
6. ci.yml 枚举行 + 门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `python3 scripts/hooks/test-flywheel-restart-guard.py` + `bash scripts/__tests__/restart-self-detach.test.sh` + `bash scripts/__tests__/lead-alert-strict-delivery.test.sh` + 新 T5。
   **全量 `test-restart-services.sh` 的门槛 = 「无新增失败」而非「全绿」**(R1-#4 实测:本机当前基线 125 pass / 8 fail,宿主状态相关;实施前先跑一次冻结 pre-change 基线,实施后对照)。R2-#3:冻结与对照按**失败用例名字全集**做,不按 125/8 计数 — 计数对照下「一个新失败顶替一个旧失败」会被漏掉。不许把宿主基线失败伪报成本单回归,也不许拿宿主噪声当挡箭牌吞新失败。

## 4. 部署与生效(全 Tier-1,零服务重启)

| 件 | 生效方式 |
|----|----------|
| 护栏 py | merge 后任一 Lead start 自动 converge(claude-lead.sh:1139),或手动 `bash scripts/hooks/install-restart-guard.sh` 立即生效;hook 逐次调用现读 `~/.flywheel/bin/` |
| restart-services | 脚本按 repo 路径现读,merge 即生效(lead-alert.sh 零改动;`deploy_failed` 是 TS 合同既有 kind,Bridge 侧行为零变化) |
| rules R4 | 各 Lead 下次 start 时 rules-bundle 重建生效 |

## 5. merge 后独立 QA 建议(本设计节点不执行)

1. **护栏真机**:带 hook 的会话里发事故形态命令 → 观察 deny 文案(这一步 QA agent 自己就能做,被拦即证);
2. **真 launchd E2E**(agent 发 submit 会被①拦 — 本身即第一证;真 submit 段需 bypass 记账(响一条 alert,先知会)或 founder 亲手):`launchctl submit -l com.test.fly1783-probe -o /tmp/fly1783-probe.log -- /bin/bash <repo>/scripts/restart-services.sh` → 观察 log 3 个拒绝周期(每周期含 FLY-1783 refusal 行;Bridge /health 全程不动;`launchctl list` 无 restart 副作用)→ `launchctl remove com.test.fly1783-probe` → claims.db 当日恰 1 条 signature `restart-guard-launchd-refusal-<日期>` 的 `deploy_failed`;这一步同时是 bash-`$PPID`==1 真形态的唯一权威验证(hermetic 层做不出决定性孤儿,见 T1c 注);
3. **正路回归**:`request-restart.sh --dry-run` 照常;下一次真实 updater 重启照常(ppid 豁免验证已由 T2 hermetic 覆盖,真机以生产下一次自然重启为准)。

## 6. 风险与回滚

| 风险 | 评估 | 兜底 |
|------|------|------|
| 护栏新误报 | in-matrix 0 误报有断言;out-of-matrix 为既有 accepted 类的等量延伸(research §6;本设计过程亲测:写含 `pkill`/`kill -0` + `com.flywheel` 文本的 heredoc 被现役护栏 P2 误拦 — 换非 Bash 工具写文件即绕开,代价可接受) | deny 文案指路;bypass 通道在 |
| ppid 拒绝误伤 | 收窄后的承诺(拒绝 launchd **直接执行**本脚本)内无合法出现形态(S1–S6 实测);万一误判 = 响亮拒绝非静默失败,方向正确 | exit 78 文案自带正路;revert 即回 |
| launchd→wrapper→本脚本 / plist 自带 FOREGROUND env(R1-#2 点名的绕过形态) | **残余**,本层不承诺覆盖(ppid 推断到不了;更强的 provenance 合同对本单是过度工程) | C1 拦 agent 构造此类命令;C5 红线管行为;事故 runbook 管人工 |
| detach 验活只覆盖「1 秒内即死」 | **best-effort 即时检查**(R1-#3 收窄):1 秒后的失败(如 lock 竞争)仍由 child 日志负责,父进程 exit 0 不承诺 child 最终成功 | 文案与注释写明承诺边界 |
| 拒绝循环告警刷屏 | 显式日级 signature `restart-guard-launchd-refusal-<UTC日期>` + claims.db → 天级 1 条 | T1c 逐字断言 signature |
| 回滚 | 单 PR revert;护栏可 `install-restart-guard.sh --uninstall` 单独摘除 | — |
