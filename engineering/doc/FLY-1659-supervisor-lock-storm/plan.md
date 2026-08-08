# FLY-1659 supervisor 锁风暴根治 — 实施计划

Issue: FLY-1659 (https://linear.app/geoforge3d/issue/FLY-1659/supervisor-锁风暴根治外部重启后无收养分支15-supervisor-带锁死循环互相饿死-建窗验收噪声自杀-全舰)
日期: 2026-08-07
基于: research.md
修订: v10(**Codex design review 9 轮 APPROVED**:R1×9 + R2×6 + R3×6 + R4×6 + R5×6 + R6×4 + R7×2 + R8×2 全折入,R9 APPROVED 附 2 LOW 建议已折入;反馈存 /tmp/codex-rescue-design-feedback-flywheel-FLY-1659-plan-round{1..9}.md)
Status: codex-approved

## 0. 一句话

给 Lead supervisor 补上「外部重启后对健康活体的 **store 授权收养** + 对无主活体的**受控换代**」两条出路(替代永久 hold 与不确定性杀活体),并把稳态监控路径改成零锁 cheap 探针、用建窗持久化取证删掉验收噪声自杀,让 15 个 supervisor 冷启动 ≤2min 全部进入监护态、KeepAlive 真实恢复。

## 0.1 与 FLY-1634 的关系(显式架构决策)

FLY-1634 删除了 **restart-services 侧**的 body 收养(deploy verdict 简化:换代就是换代)。本单**不**恢复那套机制——restart-services 的 deploy verdict 契约原样不动。

本单在 **supervisor 侧**(KeepAlive 层)把「冷启动遇到活体」从今天的「永久 hold 或不确定性杀活体」改成三分处置(§2 Fix 1):

- **store 授权收养**:lease store 以 typed `holder_orphaned` 证明「这是我这个 lead 的 bound body、它活着、老 supervisor 死了」,且现场三重硬证据全绿 → 接管监控,不杀不 hold。收养授权**只**来自 bound row 证明(R2 #1);外部/无主活体永不收养。
- **受控换代**:store 阳性证明当前 row **没有** bound 活 holder(fresh acquire),而现场有身份验证过的 archived 活体 → 无主/stale body,走既有杀人级验证 reap + 正常 relaunch(session resume)。这正是 FLY-1634「换代就是换代」的语义——只是把今天的永久 hold 换成它本来该走的路。
- **不确定 → hold,零杀**:任何 sensor/证据不确定(含 lease degraded)永不触发杀/清(事故里健康活体正是被不确定性收割的)。

**收养不授予破坏权**(R3 #2):adopted body 的 graceful teardown 权只属于「本 episode 亲手 launch 它的 supervisor」;adopter 收到 TERM 时静默退出、不碰活窗(body 继续裸奔至下一代 supervisor 再收养)。计划性换代(restart-services)在 supervisor 静默后自有显式 body hard-clear,契约不变、分开测试。此决策随设计 HTML 呈 founder 过目。

## 1. 范围

**改**(scripts-only,零 TS、Bridge 不动、无新 flag/daemon/schema):

- `packages/teamlead/scripts/claude-lead.sh` — Fix 1(三分处置 + 收养 + 破坏权 provenance)/ Fix 2(稳态零锁)/ Fix 3(建窗持久化取证 + lease-aware 收敛)/ Fix 4(jitter + backoff 收口)
- `packages/teamlead/scripts/lib/lead-identity-preflight.sh` — `LEAD_LEASE_FRESH` typed 出参(R3 #6)
- `packages/teamlead/scripts/lib/tmux-supervisor-guard.sh` — archived-process **typed 三态**共享原语(R4 #5)
- `scripts/lib/tmux-server-rescue.sh` — 新增 operation-scoped 只读探针 helper
- `scripts/restart-services.sh` — Fix 6(preflight 残留 QA server **只读告警**)
- `scripts/__tests__/` + `packages/teamlead/scripts/__tests__/` — 新增 2 套件 + 既有套件扩展 + 冻结 fixture(带 provenance)
- `.github/workflows/ci.yml` + `scripts/__tests__/ci-structure.test.sh` — 新套件接线

**不改**:lease store(`lead-lease.ts`)与 comm.db schema;Bridge;launchd plist;带锁临界区语义;真 split_brain 与身份不匹配的 hold 行为;锁等待时长(R1 #2,FLY-1336 包络);restart-services deploy verdict 契约。

**新增持久化物**(文件级,非 schema):`${TMUX_ARCHIVE_FILE%.tmux}.pending`(建窗取证记录,R2 #3/R3 #3-#5)与 **per-client fence** `${TMUX_ARCHIVE_FILE%.tmux}.client.<nonce>`(在途 client 的独立生命围栏,R7 #1——`.pending` 丢失不丢 client 账)。~~`.adopter` 声明文件~~(v3 引入,v4 删除:R3 #1 指出其 stale-takeover 无法无锁原子化;而 R3 #2 的「adopter 无破坏权」语义使原子选举的需求本身消失——净删除)。

## 2. 实施步骤(TDD:每个 Fix 先写红测)

### Fix 2 前置 — operation-scoped 只读探针(R1 #3)

`_tmux_rescue_bounded_exec` 的预算锚按「一次 rescue 操作」缓存;长命 supervisor 直接调用会在 60s 后把预算耗成 0。新增公开 helper(tmux-server-rescue.sh):

```bash
# 单次只读探针,每次调用自带新预算窗口(subshell 内清锚),绝不继承/污染调用方预算。
tmux_rescue_probe() {  # $1=timeout_sec, rest=argv
  ( unset _TMUX_RESCUE_BUDGET_ANCHOR _TMUX_RESCUE_TOTAL_BUDGET _TMUX_RESCUE_CACHED_LOAD_FACTOR
    _tmux_rescue_bounded_exec "$@" )
}
```

**三态 generation 探针**(claude-lead.sh):rc 0=同代(自报 pid == expected)/ rc 1=阳性换代(探针成功 pid 不同)/ rc 2=不确定(超时/错/非数字)。回归:连续探针跨 >60s 各自有预算。

### Fix 1 — 三分处置:store 授权收养 / 受控换代 / 不确定 hold(根治病根 A)

**授权模型(R2 #1)**:收养授权唯一来源 = typed `holder_orphaned`(rc 4):当前 row **bound**、bound holder(pid+start)活、记录的 supervisor 死。shell 侧再要求 holder tuple 与 archive pane tuple 逐字一致 + 三重现场硬证据。无 bound-row 证明的活体(unbound / 新 generation / degraded)一律不收养——可能从未 bind、无写授权,收养即永久监护 write-crippled body。

**1a. `_lead_try_adopt_body()`** — typed 四态 rc(R2 #2):

```bash
# rc 0 adopted / rc 1 positive_mismatch(身份阳性不符 → 调用方走既有 clear 全套复核)
# rc 2 positive_conflict(进程表第二 exact 活体 → 调用方走 lead_dual_active hold)
# rc 3 indeterminate(任何 sensor/TOCTOU 不确定 → 调用方 hold,零杀)
_lead_try_adopt_body() {   # $1=lease_holder_pid $2=lease_holder_start(rc4 的 bound tuple)
  local a_server a_pane a_start a_window rc
  tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 3
  a_server="$TMUX_ARCHIVE_SERVER_PID"; a_pane="$TMUX_ARCHIVE_PANE_PID"
  a_start="$TMUX_ARCHIVE_PANE_START";  a_window="$TMUX_ARCHIVE_WINDOW_ID"
  # 账面↔现场绑定: bound holder tuple 逐字等于 archive pane tuple
  [ "$1" = "$a_pane" ] && [ "$2" = "$a_start" ] || return 1
  # 证据1: pid 活 + lstart 一致 + argv 精确 claude --agent <LEAD_ID>(与 reap 同源;
  # 实现时拆内部失败形态: 阳性死亡/漂移→1,ps sensor 错→3)
  tmux_supervisor_archived_process_matches "$TMUX_ARCHIVE_FILE" "$LEAD_ID" || return 1  # (拆形态)
  # 证据2: 同代 server + window/pane 绑定 + 活体复核(全量路径;收养低频)
  _tmux_target_matches_archive "$a_window" true || return 3
  # TOCTOU: 第二次读到的 archive 必须仍是冻结 tuple
  [ "$TMUX_ARCHIVE_SERVER_PID" = "$a_server" ] && [ "$TMUX_ARCHIVE_PANE_PID" = "$a_pane" ] \
    && [ "$TMUX_ARCHIVE_PANE_START" = "$a_start" ] && [ "$TMUX_ARCHIVE_WINDOW_ID" = "$a_window" ] || return 3
  # 排除性 preflight(R1 #5): ps 扫描跳过 a_pane;发现他人→2;sensor 错→3;干净→继续
  _lead_identity_conflict_excluding "$LEAD_ID" "$a_pane"; rc=$?
  [ "$rc" -eq 1 ] || { [ "$rc" -eq 0 ] && return 2 || return 3; }
  LEAD_WINDOW_ID="$a_window"; TMUX_SERVER_PID="$a_server"
  LEAD_BODY_PROVENANCE="adopted"
  log "Adopted existing Lead body PID ${a_pane} (window ${LEAD_WINDOW_ID}); resuming KeepAlive monitoring"
  return 0
}
```

**1b. rc 4(`holder_orphaned`)四路分派**(:3273-3280 重写;**行为变更**:今天 rc4 无条件 clear——事故里正是不确定性杀了活体):

| `_lead_try_adopt_body` | 动作 |
|---|---|
| 0 adopted | `TMUX_HOLD_BACKOFF=3; _wait_tmux_window; continue`(不 rules-commit、不 launch) |
| 1 positive_mismatch | 现有 `_lead_clear_orphan_body`(内部自带全套复核)→ 现有路径 |
| 2 positive_conflict | `lead_dual_active` 告警 + hold(既有位点),零杀 |
| 3 indeterminate | hold + backoff,零杀零清 |

**1c. `_prepare_lead_launch` archived-alive 分支 → 受控换代**:`lead_identity_prepare_lease` 新增 typed 出参 `LEAD_LEASE_FRESH`(R3 #6:**每次 prepare 起始与所有 early-return 先重置为 0**,仅在校验过的 `acquired`/`idempotent` 响应后置 1;库文件 `lead-identity-preflight.sh` 入 scope 与 backport 清单;顺序转换测试 fresh→store_error / fresh→rc4 / fresh→denied)。`_prepare_lead_launch` archived-alive + `RELAUNCH_PROVEN=0`:

- `LEAD_LEASE_FRESH=1`(store 阳性证明无 bound 活 holder)且 `tmux_supervisor_archived_process_matches` 阳性 → 无主/stale body:`tmux_supervisor_reap_archived_process`(与今天 RELAUNCH_PROVEN=1 分支同一调用同一复核)→ 继续 launch。事故的永久 hold 形态在此闭环,语义即 FLY-1634 换代。
- 身份 sensor 不确定或 `LEAD_LEASE_FRESH≠1` → 现有 ambiguous/split_brain hold 原样(零杀)。

**1d. case 5(`idempotent_adopted`,同 supervisor 重入)**:`_lead_bound_body_ready` :1531 的 `LEAD_WINDOW_ID` 空时先从 archive 恢复再判(row 已 bound 到本 supervisor,授权先天成立)。**provenance 转换规则(R4 #6)**:case 5 证明的是「requester 就是记录在案的 supervisor」——若本进程已持 `launched`(本 episode 亲手建窗后重入),**绝不**降级为 `adopted`(否则 TERM teardown 语义被改);仅在 provenance 真空(冷启重入)时置 `adopted`(保守:不碰窗)。测试 launcher→case5→TERM(保留 teardown)与 blank→case5→TERM(保守不碰)。

**1e. 破坏权 provenance(R3 #1 #2,取代 v3 的 .adopter 文件)**:

- 进程内 `LEAD_BODY_PROVENANCE`:`_launch_claude` 建窗成功置 `launched`;收养路径置 `adopted`。
- **cleanup()(TERM/INT graceful 路径)对活窗的 C-c/kill-window 仅当 `launched`**;`adopted` 时静默退出不碰窗(日志注明 body preserved)。TERM launcher → 今天的 teardown 语义原样(bootout 停 lead 依赖它);TERM adopter → body 幸存,restart-services 的显式 hard-clear 契约覆盖计划性换代。
- **阳性证据的破坏动作不受 provenance 限制**:`_wait_tmux_window` 的 pane_dead=1 kill + reap(死体清理是 KeepAlive 本职,幂等且 evidence-gated),任何监护者可执行。
- 双 successor 双收养(极端形态:手工+launchd 并存)因此无害:双监护只读;TERM 任一不伤窗;body 死后双 reap 幂等,relaunch 竞速由既有 launch preflight + lease `denied_holder_alive` 收敛到单 owner。原子选举文件不再需要(v3 `.adopter` 删除;lease store CAS `adopt` 动词仍列 follow-up 供未来账面强一致)。

**1f. archived-process typed 三态共享原语(R4 #5,「不确定永不成死亡」推广到既有调用方)**:`tmux-supervisor-guard.sh` 新增 `tmux_supervisor_archived_process_state` → `live_exact` / `positive_dead_or_mismatch` / `indeterminate`(拆开今天 `archived_process_alive`/`_matches` 把「阳性死/漂移」与「ps sensor 错」折叠成同一非零 rc 的形态)。应用面:

- 收养/受控换代(1a/1c)按三态分派(已述);
- `_prepare_lead_launch` 外层:今天 `archived_process_alive` 假即 `rm archive`——sensor 错也会销证。改为仅 `positive_dead_or_mismatch` 删 archive;`indeterminate` → hold 保证据;
- `_wait_tmux_window` :2056:今天同一布尔假即 `TMUX_RELAUNCH_PROVEN=1`(sensor 错授权换代!)。改为仅阳性死亡置 RELAUNCH_PROVEN;`indeterminate` → hold;
- **`tmux_supervisor_reap_archived_process` 内部重写为 typed 转换表(R5 #2;R6 #4)**——今天它内部布尔复核,sensor 错也删 archive 并返回成功,受控换代会「以为换完了」继续 launch。新表:初检/终检 `indeterminate` → 保 archive、返回 hold-class 失败(调用方必须停下 hold);`positive_dead_or_mismatch` → 只退休元数据不发信号;仅 `live_exact` 可吃 TERM/KILL,且 KILL 前立即重验杀人级状态。**KILL 后同样 typed 复检(R6 #4:signal 接受 ≠ 进程消失)**:bounded 重验,仅 `positive_dead_or_mismatch` 才退休 archive 并返回成功;`live_exact`/`indeterminate`(短暂存活/zombie/sensor 失败,注意 macOS zombie 探针陷阱)→ 保 archive 返回 hold-class 失败供重试。故障注入:调用方证明与 reaper 初检之间 / TERM 等待环中 / KILL 前终检 / KILL 后复检(接受但仍观测到 tuple、zombie 分类、sensor 失败),四点各断;
- cleanup 与 pending 收敛器同用此原语。

监控循环与 `_prepare_lead_launch` 的 sensor-failure 回归入测(不只 rc4 收养矩阵);结构性测试断言所有旧布尔 archived-process 调用方已迁移或被证明非破坏性(R5 #6)。

**监护退出衔接**:现有 `_wait_tmux_window` 语义闭环(窗死 → RELAUNCH_PROVEN=1 + reap → 下轮 acquire 见双死 → 新 generation → resume relaunch),收养不加新退出逻辑。

### Fix 2 — 稳态零锁(根治病根 B)

**2a. 读写分离 generation 守卫(R1 #4)**:`_tmux_generation_is_current` 保持全量 inspect,继续守全部 kill 路径。新增只读 `_tmux_target_matches_archive_fast`(generation 检查用三态 fast 探针:0 过;1 失败;2 降级跑一次全量,以全量结论为准),仅用于 `_wait_tmux_window` 健康快路径与 dialog-poller。不宣称 fast 探针检测 split_brain verdict——它只证「应答者是期望代」;该路径零破坏动作,法医归带锁路径。

**2b. `ensure_tmux_session` 无锁快路径**(含既有 postcondition,R1 #4;取值形态 R4 #1;disabled 契约对齐 R5 #1):探针全 `tmux_rescue_probe` bounded 只读——①`display-message -p '#{pid}'` 数字;②`has-session -t =flywheel`;③**`show-options -sv exit-empty` == `off`**(R4 #1:`-g` 返回带键名的 `exit-empty off`,快路径会永远冷;`-sv` 与既有 rescue policy 用法一致);④keepalive session 在。**③④两条整体随 `_tmux_rescue_keepalive_enabled` 条件**(R5 #1:`FLYWHEEL_TMUX_KEEPALIVE=0` 时带锁 policy postcondition 本来就两条都不 enforce——fast path 必须同形跳过两条,否则 disabled 舰队每轮迭代都重新入锁)。以 `_tmux_rescue_ensure_success`/`_tmux_rescue_policy_postcondition` 实际清单为准逐条对齐,测试断言清单一致防 drift。全绿 ⇒ `TMUX_SERVER_PID=<pid>` return 0 零锁;任一失败/不确定 ⇒ 现有带锁 `tmux_socket_ensure`。**阳性零锁测试两形态**:enabled(enforce policy+双 session)与 disabled(`exit-empty=on`+无 keepalive session)各自反复 `ensure_tmux_session` 断言带锁 helper 零调用;漂移形态另测 fallback。

**2c. `_wait_tmux_window` recover 触发收紧**:matcher(fast)失败且 archived 进程仍活时,进带锁 recover 前先 fast 探 `TMUX_ARCHIVE_SERVER_PID`:rc 0(server 活且同代)→ 不 recover,按 unknown hold 走 backoff(server 活着时 recover 无事可做——今天这是纯锁流量);rc 1/2 → 现有 recover 路径原样。

### Fix 3 — 建窗持久化取证 + lease-aware 收敛,删验收自杀(根治病根 C;R3 #3-#5 重设计)

**取证流程**(R4 #2:nonce 用**临时窗名**承载——tmux 持久、create 原子、零秘密暴露;不读进程环境):

1. **create 前**写 pending 记录 `${TMUX_ARCHIVE_FILE%.tmux}.pending`(tab 分隔 0600):`nonce  intent_ts  expected_srv_pid  creator_pid  creator_lstart`;
2. **两阶段门控 create client**(R4 #4;R5 #3):裸 `&` 后台无法保证「先记账后动作」——tmux client 可能在父进程取到 lstart 前就完成/失败。改为:先起一个**exec 前阻塞在门上的小子进程**(读 gate fd/FIFO),父进程把该子进程 pid+lstart **原子补进 intent**,然后放行 → 子进程 `exec tmux new-window -P -F '#{window_id}	#{pane_pid}	#{pid}' …`(exec 保 pid,tuple 延续到 tmux client);父进程在放行前死亡 → gate EOF → 子进程不创建直接退出。stdout/stderr 落私有临时文件并定义清理。

**intent typed 子状态 + owner-aware 退休(R6 #1,关死同进程永久 hold)**:intent 记录带显式子状态——
- `prepared`(无 client tuple:fork 前/fork 失败):**同进程 creator** 在阳性证明「无子进程被放行」(fork 失败 rc / gate 未开)后即可退休并**原地重试**;冷启 successor 需 creator 阳性死亡 + 名形态稳定缺席;
- `client-recorded`:**同进程 creator** 以 `wait` 收割该子进程(wait 返回即该 exact child 结束的阳性证明)+ 名形态稳定缺席后退休并重试(create rc≠0 / 输出不成形的常见同进程失败在此闭环,不再落入「等 creator 死」死账);successor 仍需 creator+client 双阳性死亡;
- 保留名窗证据一律升级为全 tuple 进状态表。
同进程真测:fork 失败 / create rc≠0 / 输出不成形 → supervisor 不重启即退休 intent 并成功重试 launch。

**per-client fence(R7 #1;R8 #1 #2 自足化 + 生命周期表)**:parent 在「client tuple 记入 intent」与「放行 gate」之间,另落一份独立 fence 文件 `…/.client.<nonce>`。

- **schema 自足(R8 #1;R9 LOW-2)**:`nonce  intent_ts  expected_srv_pid  creator_pid  creator_lstart  client_pid  client_lstart  socket_path`(归一化 socket 标识**无条件持久化**——`FLYWHEEL_TMUX_SOCKET_OVERRIDE` QA seam 下冷启证据显式;socket 不匹配 → hold,绝不改探别的 socket)——successor 仅凭 fence 即可执行完整退休契约(creator 死证 + client 死证 + 期望代名形态缺席),不依赖 `.pending`。读侧逐字段校验;双账本并存时重叠字段须逐字一致,分歧 = 冲突 hold,两侧都不退休。实现时 pending 状态表**显式加 fence 列**(R9 LOW-1),使结构性测试可机械断言每行的 fence 处置。
- **生命周期转换表(R8 #2)**:(a) publish 原子(temp+mv)且落盘**先于**放行;publish 失败 = fail-stop:不放行(关 gate)、`wait` 收割 child、按 owner-aware 缺席规则清理;(b) owner 在「exact client 已收割 + archive+bind 已落盘」后即可退休 fence(**即使 rename 被跳过**——全 tuple 证据已取代在途证据);(c) 冷启 successor 退休 fence 的两条路:与匹配的全 pending/archive tuple 在 typed lease 行下配对退休,或仅凭 fence 的完整死证+期望代缺席证明;(d) 任何清理失败 → 双账本全保留 + hold。
- 崩溃注入五点:publish 前 / publish 后放行前 / create 后补全 pending 前 / bind 后删 fence 前 / rename 失败 + 冷启 successor;每个 pending 状态表行同时声明 fence 处置,并入 §3 测试清单。
- 测试(R8 #1):pending 丢失后 client 死亡 → 仅凭 fence 收敛;creator PID 复用 → lstart 拒;server 换代 → 期望代判定;可解析但两账本冲突 → hold。

`.pending` 丢失/损坏时 fence 独立存活,pre-launch 门据此仍能看见在途 client——「零证据放行」形态被关死。fence 不可解析/不确定 → hold。

故障注入:fork→记账 / 记账→放行 / 放行→结果落盘 三段各断 supervisor,每分支要么产出全 tuple、要么 intent 按上述规则可无人工退休;
3. 窗以**保留形态临时名**创建:`-n "${window_name}.p-<nonce>"`(nonce 只在窗名与 pending 里,非秘密;canonical 名 `${window_name}` 在 archive+bind 成功后 `rename-window` 恢复。**rename 前须全 archive 守卫**(R5 #5):server/window/pane 三元现验,不符或不确定 → 保留临时名不 rename——监控按 window_id 不按名,收敛器按名形态识别;换代间隙 rename 可能改到同号别窗,守卫关死);
4. create 成功 → 补全 pending:`… created_srv_pid  window_id  pane_pid  pane_start`(R4 #3:**expected 与 created 双字段并存**——mismatch 证明要前者,exact 清理守卫要后者;读侧逐字段校验,清理/重建 API 显式声明消费哪个 pid);
5. 验收 = `created_srv_pid` == `expected_srv_pid`(直接证据,无验收探针);
6. archive 写 + bind 现有流程 → **bind 成功后** rename 回 canonical 名 → 删 pending。

判定表(原 :1961-1973 inspect+verdict 验收块**整段删除**):

| 证据 | 动作 |
|---|---|
| create rc≠0 / 输出不成形 | 不杀;走 owner-aware `client-recorded` 分支(R7 #2:`wait` 收割 + 名形态稳定缺席 → 同进程退休 intent/fence 并重试),而非干等 |
| `srv_pid` 阳性 ≠ ensure 的 `TMUX_SERVER_PID` | **不杀**(跨代);pending 已含全 tuple → 收敛器;hold(split_brain 证据) |
| 同代 + lstart 到手 | archive → bind → 删 pending |
| lstart 拿不到 / archive 写失败 | **集中清理器**按全冻结 tuple 清本窗(见下);清理成功才 return 1,失败/不确定 → 保留全部证据 + hold(R3 #5) |
| bind 失败 | 同上经集中清理器;**archive/pending 只在阳性缺席证明后移除**(修正现有 :1993-2006 的 kill 失败仍删 archive 问题) |

**集中清理器 `_lead_cleanup_exact_tuple`(R3 #5)**:破坏性清理一律消费全冻结 tuple(srv_pid+window_id+pane_pid+pane_start[+nonce])且过全量 generation 守卫;**证据文件(pending/archive)只在阳性缺席证明后退休**——window 缺席经 `_tmux_window_absence_proven`,或 pane 进程死亡经 pid+lstart 阳性证明。kill-window 失败、守卫不确定、信号打断 → 保留全部证据 + hold,下轮收敛器重试。裸 window id 永不作为杀窗依据(R2 #3)。

**收敛器 `_lead_reconcile_pending_launch`(R3 #3:lease-aware)**:每轮迭代在 **lease disposition 已产生 typed 结果之后**、`_prepare_lead_launch` 之前执行。状态表(pending 形态 × archive 关系 × lease 状态):

| pending | archive | lease | 处置 |
|---|---|---|---|
| 全 tuple | 匹配 tuple | rc4 bound holder 匹配 | 退休 pending;交收养路径(1b) |
| 全 tuple | 匹配 tuple | fresh(rc0) | 退休 pending;body 交受控换代(1c) |
| 全 tuple | **有效但不同 tuple** | rc4 或 fresh | **冲突形态(R4 #6):零动作,双记录都保留,alert + hold**——绝不推断删除任何一侧 |
| 全 tuple | 无/损坏 | rc4 bound holder == pending pane tuple | **bind 后 archive 丢失**形态:身份验证绿 → 按 pending tuple 重建 archive → 退休 pending → 交收养;验证不绿 → hold 保留证据 |
| 全 tuple | 无 | fresh(rc0,无 bound holder) | archive 前崩溃的无主残窗:集中清理器按全 tuple 清(消费 `created_srv_pid` 守卫);阳性缺席后退休 pending |
| 全 tuple | 匹配 tuple | rc5(`idempotent_adopted`) | 退休 pending;进 case-5 路径(R5 #5) |
| 全 tuple | 不同/冲突 | rc5 | 零动作,双记录保留,alert + hold(R5 #5) |
| 全 tuple | 任意 | degraded/denied/sensor 不确定 | hold,保留全部证据,零动作 |
| intent-only | — | 任意 | 见下方 intent 收敛;lease 不确定同样只 hold |

**intent-only 收敛 + 保留名 pre-launch 门(R4 #2 #4;R5 #4)**:标记探针 = **窗名形态扫描**(零秘密、tmux 持久):同代 server 上 `list-windows -F '#{window_id}	#{window_name}	…'` 找 `${window_name}.p-*` 保留形态。命中恰一 → 取 pane tuple 升级为全 tuple 记录进上表;**命中多个 → 显式冲突,零动作 alert + hold**(R5 #5)。intent 退休 = **owner-aware 双契约**(R7 #2,取代任何「一律等双死」措辞):owner 在场按 `prepared`/`client-recorded` 子状态规则(上文)退休并重试;冷启 successor 需 ①creator 阳性死亡 + ②**有 client tuple/fence 时**该 client 阳性死亡 + ③期望代名形态稳定缺席(有界宽限 + 复扫)。表覆盖断言入测:任何无条件 death-only 规则回潮即红。

**pre-launch 隔离门(R5 #4,关死「一次性冷扫」漏洞;R6 #2 #3 收口)**:一次冷扫抓不住扫描后才落地的迟到窗——危险时序是「pending 丢 + 冷扫空 + canonical 已 launch + 孤儿 client 才建保留窗」。因此把保留态检查升格为 **launch 前置门**(每次要 launch canonical body 前执行):枚举 ⓐ保留名形态窗(tmux bounded 探针)+ ⓑ**账面上的** create client(见 census 契约),两者需在宽限期内**稳定为空**才放行;任一存在或不确定 → 不 launch,hold 待收敛。多保留窗 = 冲突 hold。

**census 契约(R6 #3,零秘密、有界;R7 #1 双账本)**:生产 tmux client argv 含 `-e` 注入的 API/bot token——**census 绝不做全进程表 argv 扫描**(会重开 v5 关掉的秘密边界;`pgrep -f` 另有 FLY-1482 记录在案的 prompt/decoy 假阳性类)。client 存活判定只消费 **exact client tuple**(pid+lstart 校验,不取/不存/不打印 argv),tuple 来源 = intent 记录 **∪ 独立 per-client fence 文件**(两账本独立扫,`.pending` 丢失时 fence 仍在);无任何 tuple 的形态由 intent 子状态规则处置。所有窗/进程探针一律走 fresh bounded 操作(`tmux_rescue_probe` 形态),探针卡死 → indeterminate → hold,不得无限推迟 TERM。测试:prompt-only decoy、无关 tmux client、argv 秘密零观测断言、sensor 错、超时;**决定性时序测试(R7 #1)**:放行并卡住 client → 删/损 `.pending` → 走满隔离宽限 → 断言 canonical fork 仍被 fence 挡住,直到 fence 退休或其保留窗被收敛。

**launch 前最终时序钉死(R6 #2,门的宽限等待不得让 preflight 变陈旧)**:物料/receipt 就绪 → 隔离门稳定空等待 → **exact 同 lead body preflight(此处重跑,即使主循环早前跑过)** → `lead_launch_authority_recheck` → 立即写 intent/fork,**最后两检与 fork 之间零阻塞等待**。竞态测试:首次负扫后、放行前出现 exact body → 断言零 `new-window` 调用。

真 tmux 测试钉死迟到时序:首次负扫**之后**迟到窗才出现 → canonical launch 保持被门挡住直到保留窗被收敛。

任何超时/权限/格式/generation 不确定 → 保留记录 + hold。真 tmux 测试:延迟超过宽限期的 create client、pending 损坏 + 迟到窗按名捕获(含「负扫后到达」时序)、generation 变化、sensor 失败。

前置 spike:生产 tmux 3.5 实测 `new-window -P -F` 三字段 + 临时名 create/rename 原子性;若 create 上下文字段不可用,退回两步式(exact-id bounded `list-panes` + `_tmux_window_absence_proven` 三分类),判定表与 pending 记录不变。

### Fix 4 — backoff jitter + 全站点收口(R1 #7;R2 #6)

9 处 hold 睡眠站点(主循环 `TMUX_HOLD_BACKOFF` 8 处——含两处「睡而不增」的 launch 失败路径,3s 同步环来源——+ `_wait_tmux_window` 局部 1 处)统一收口。bash 3.2 无 nameref:统一用全局 `TMUX_HOLD_BACKOFF`(`_wait_tmux_window` 弃局部变量,入口重置全局为 3,语义等价);helper 直接调用、直接改全局,不经命令替换(避免 subshell 化 `interruptible_sleep` 改信号语义):

```bash
_hold_sleep_and_advance() {
  interruptible_sleep $(( TMUX_HOLD_BACKOFF / 2 + RANDOM % (TMUX_HOLD_BACKOFF + 1) ))
  [ "$TMUX_HOLD_BACKOFF" -ge 30 ] || TMUX_HOLD_BACKOFF=$(( TMUX_HOLD_BACKOFF * 2 ))
  [ "$TMUX_HOLD_BACKOFF" -le 30 ] || TMUX_HOLD_BACKOFF=30
}
```

测试(不跨版本钉数值):同 shell 重播种同序列;每延时在 [base/2, base/2+base];推进/封顶;launch 失败路径推进断言。

### ~~Fix 5 — 锁等待拉长~~(撤销,R1 #2)

30s×factor(≤4)=120s 突破 FLY-1336 共享包络(消费方 attempt cap 90s < 120+60s)、超 restart quiescence 30s 窗口,且 bash 同步锁等待期间 SIGTERM trap 被推迟 → bootout 卡死。锁默认保持 5s;Fix 1-3 后稳态锁流量趋近零;极端场景用既有 env 临时调。真机 QA 增 TERM-during-lock 回归守现状包络。

### Fix 6 — restart-services preflight 残留 QA server **只读告警**(R1 #8 降级)

ppid=1 + 路径模式不能证明 residual(活 QA server 也是 daemon 形态)——preflight **零破坏动作**:枚举同 uid ppid=1 tmux server,非生产 socket(非 default、非 allowlist `atlas`)打审计行(pid+socket+session 列表);非生产 socket 上有名为 `flywheel` 的 session → severe 告警(既有 alerts 位点);QA 命名规则(session 一律 `qa-` 前缀)入 qa-framework 文档;清理本身 = operator 手册一次性动作(附 `/tmp/q96` 现例)/ QA-lifecycle follow-up。

## 3. 测试计划(隔离 socket 台架,不打生产 tmux;新套件接线 ci.yml + ci-structure)

**新增 `scripts/__tests__/supervisor-adoption.test.sh`**:

- 三分处置矩阵:rc4+全绿 → 收养;rc4+阳性不符 → clear;rc4+第二活体 → dual_active hold;rc4+各 sensor 错(ps 空/archive 坏/tmux 超时/TOCTOU 换 tuple)→ indeterminate hold **零杀**;强制 saturated/unknown inspect + 活 holder → 零 signal/kill;
- 授权负例(R2 #1):unbound row / fresh generation + archived 活体 → 不收养 → 受控换代(身份阳性)或 hold(不确定);crash 注入:create 后 / archive 后 bind 前 / bind 后各断一刀 → stale/unbound body 被安全收敛,永不被收养;**bind 后 archive 删除/损坏 → rc4+pending 重建 archive → 收养**(R3 #3);
- `LEAD_LEASE_FRESH` 顺序转换:fresh→store_error / fresh→rc4 / fresh→denied 不残留(R3 #6);
- typed 三态 sensor 回归(R4 #5):`_prepare_lead_launch` 外层 sensor 错 → archive 幸存 + hold(不 rm);`_wait_tmux_window` sensor 错 → 不置 RELAUNCH_PROVEN、hold;仅阳性死亡走各自现路径;
- provenance 转换(R4 #6):launcher→case5→TERM 保留 teardown;blank→case5→TERM 保守不碰窗;
- 冷启全链(隔离 socket + PATH-shim 假 claude,argv 过 `lead_identity_command_matches`):≤N 秒 "Adopted existing Lead body" 且 body 未被杀;
- KeepAlive 实证:收养后杀 body → reap→relaunch 断言;
- 双 successor(R3 #1 #2):同时冷启 → 双收养只读无破坏动作;**TERM launcher → teardown 如今天;TERM adopter(任一/全部)→ body 窗与 pane tuple 逐字幸存**;body 死后收敛单 owner(幸存者 relaunch+bind,后来者 `denied_holder_alive`);
- 计划性 vs 自发换代两契约分开断言。

**新增 `scripts/__tests__/supervisor-storm-regression.test.sh`**:

- 阳性对照(先行):**已提交冻结 fixture**(实现期一次性提取,文件头注 source commit id + checksum;CI 浅 checkout 不需历史对象)3 supervisor 冷启动 → 断言进 hold 循环;
- 修后:≥3 supervisor 冷 bootstrap → ≤120s 全监护、零 kill 新建窗、稳态窗口零 `lock_unavailable`;
- 噪声在场(仿 atlas/q96,其一带 `flywheel` 名 session)→ 仍收敛;
- 探针预算跨 >60s;fast 三态各走对分支;ensure 快路径 postcondition 漂移落回带锁修复 + 清单一致性断言;
- pending 收敛器:kill-at-each-boundary × 同进程/冷启 successor 两形态;lease-aware 状态表逐行(含 archive 不同 tuple 冲突行零动作、rc5 两行);intent 子状态:同进程 fork 失败/create rc≠0/输出不成形 → 不重启即退休并重试(R6 #1);intent-only 收敛(超宽限期迟到 create client、pending 损坏 + 迟到窗按名捕获含「负扫后到达」时序、generation 变化、sensor 失败,真 tmux);pre-launch 门竞态:负扫后放行前出现 exact body → 零 `new-window`(R6 #2);census 零秘密:prompt-only decoy / 无关 client / argv 秘密零观测 / 超时(R6 #3);ensure 与 create 之间换代 → 记录锁定 created generation、两代同号窗都不被误碰(R4 #3);**generation-change-before-rename → 保留临时名不误改名**(R5 #5/R6 #4);集中清理器:kill-window 失败/守卫不确定/信号打断 → 证据幸存 + hold(R3 #5);裸 id 永不杀窗断言;
- jitter:重播种同序列 + 区间 + 推进/封顶。

**既有套件更新**:`packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh`(rc4 无条件 clear → 四路分派;`LEAD_LEASE_FRESH` 合同)/ FLY-1285 supervisor 套件 / `tmux-server-rescue*.test.sh`(`tmux_rescue_probe` 合同 + 锁默认值不变)/ `lead-body-hard-clear.test.sh`(fall back 不回归)/ `restart-storm-gate.test.sh`(只读告警扩展)。CI:ci.yml + ci-structure 登记两个新套件。

**真机 QA(独立 QA 节点,合并前)**:issue 验收 ①-④ + TERM-during-lock 回归 + 双 successor TERM(launcher 与 adopter 两形态)实测;阳性对照先行。

## 4. 风险与保守面

| 风险 | 处置 |
|---|---|
| 收养错认(PID 复用/冒充/TOCTOU) | store bound-row 授权 + holder↔archive 逐字绑定 + 三重杀人级证据 + tuple 冻结复核 + 排除性 preflight |
| 收养 write-crippled body(R2 #1) | 授权唯一来源 = typed `holder_orphaned`;unbound/fresh/degraded 永不收养 |
| 不确定性杀活体(R2 #2,事故根因之一) | typed 四态;indeterminate/conflict 一律 hold 零杀;hard-clear 只吃阳性证据 |
| 双 successor 生命周期冲突(R3 #1 #2) | 收养不授破坏权(provenance 门);TERM adopter 不碰窗;阳性证据动作幂等;收敛靠既有 preflight+lease;无选举文件可竞态 |
| 取证不耐崩(R2 #3/R3 #3-#5) | pending create 前落盘、取证后补全;收敛 lease-aware 状态表;证据只在阳性缺席后退休;裸 id 永不杀窗 |
| intent 标记不可读 / 秘密卫生(R3 #4/R4 #2,真机已证 show-environment 不可用;进程环境含 token) | nonce 承载于**临时窗名**(tmux 持久、create 原子、零秘密);退休 = owner-aware 双契约(owner 按子状态收割重试;successor 需 creator 死 + 有 tuple 时 client 死 + 名形态稳定缺席);pre-launch 门 + per-client fence 为耐损备援 |
| sensor 错被当死亡(R4 #5,既有隐患同类根因) | archived-process typed 三态共享原语覆盖全部调用方;indeterminate 永不销证/授权换代 |
| fast 探针弱于 inspect | 只用于零破坏路径;kill 守卫全量 inspect;不确定降级全量;不宣称检测 split_brain |
| ensure 快路径绕过 policy | postcondition 四探针 + 清单一致性测试;漂移即落回带锁修复 |
| 与 FLY-1634 冲突 | §0.1:收养仅限 store 授权 bound body;无主活体走换代语义;adopter 无破坏权;deploy verdict 不动;呈 founder |
| 老栈 backport | `claude-lead.sh`/`tmux-server-rescue.sh`/`lead-identity-preflight.sh`/`tmux-supervisor-guard.sh` 逐 hunk 核对(前两者已证干净,后两者实现期核对;R5 #6);restart-services.sh(158+/59-)排除——老栈热修只带 Fix 1-4 |
| CI 浅 checkout(R2 #5) | 冻结 fixture 随 PR 提交,带 provenance |

## 5. 交付物

1. PR(base=main):Fix 1/2/3/4/6 + 2 新测试套件 + 冻结 fixture + 既有套件更新 + CI 接线 + 本文件夹 docs;
2. 独立 QA 节点真机验证报告(阳性对照 + ①-④ + TERM-during-lock + 双 successor TERM 两形态);
3. founder 设计 HTML(含 FLY-1634 决策边界);
4. Follow-up(不阻塞):lease store CAS `adopt` 动词(账面强一致);QA tmux server lifecycle(TTL/ownership)与 q96 归档清理;老栈热修包(若选老栈路径,Fix 1-4 逐 hunk backport)。
