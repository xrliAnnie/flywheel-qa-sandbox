# FLY-1659 supervisor 锁风暴根治 — 调研

Issue: FLY-1659 (https://linear.app/geoforge3d/issue/FLY-1659/supervisor-锁风暴根治外部重启后无收养分支15-supervisor-带锁死循环互相饿死-建窗验收噪声自杀-全舰)
日期: 2026-08-07
基于: exploration.md

## 1. 调研目标

把 exploration 里的方向 1 落到可实施精度:逐个确认 (a) 每条修复要动的精确函数/行为契约,(b) 现有安全不变量哪些必须保留,(c) 测试基建现状与新增测试的挂点,(d) 收养的正确性论证(为什么不改 lease store 也安全)。

## 2. 关键代码路径盘点(HEAD cecdb06e)

### 2.1 主循环状态机(claude-lead.sh :3231-3350)

每轮迭代顺序(与修复落点的关系):

| 步骤 | 函数 | 锁 | 修复落点 |
|---|---|---|---|
| 1 | `lead_launch_authority_refresh`(managed 时) | 无 | 不动 |
| 2 | `lead_identity_prepare_lease`(:3260)→ rc 0/3/4/5 | comm.db 内部锁(非 tmux 锁) | **rc 4 分支加收养前判**(Fix 1a) |
| 3 | rc 4 → `_lead_clear_orphan_body`(杀活体) | 无 | 收养失败才走到这 |
| 4 | rc 5 → `_lead_bound_body_ready` → `_wait_tmux_window` | 无(但内部有全量 inspect) | **LEAD_WINDOW_ID 从 archive 恢复**(Fix 1c) |
| 5 | `ensure_tmux_session`(:3324)→ `tmux_socket_ensure` | **tmux 全局锁** | **无锁快路径前置**(Fix 2a) |
| 6 | `_prepare_lead_launch`(:3338) | 无 | **archived-alive 分支加收养**(Fix 1b) |
| 7 | `lead_identity_preflight_first_conflict`(:3354) | 无 | 收养必须在此**之前**短路(否则活体被当 duplicate hold) |
| 8 | `_rules_bundle_commit_once` → `_launch_claude` | 无 | 建窗验收改直接证据(Fix 3) |
| 9 | `_wait_tmux_window`(:2020) | recover 带锁 | **稳态 cheap 探针**(Fix 2b) |

行为契约要点:

- 步骤 7 的 preflight 扫全进程表找 `claude --agent <lead_id>`,**收养场景下活体正是这样的进程**——所以收养判定必须发生在 preflight 之前并直接跳到监控,绝不能走「继续向 launch 推进」的路径。
- 步骤 8 的 `_rules_bundle_commit_once` 是 launch 前的 rules receipt 提交;收养不 launch,**不应**提交新 receipt(身体是老代按老 receipt 起的,receipt 幂等语义只对 launch 有意义)。收养跳过它,行为与「supervisor 从未死过、正在监控」一致。

### 2.2 收养判定的三重证据(全部是现成函数,零新验证逻辑)

1. **进程身份**:`tmux_supervisor_archived_process_matches "$TMUX_ARCHIVE_FILE" "$LEAD_ID"`(tmux-supervisor-guard.sh :52-67)= archive 的 pane_pid 活着 + lstart 起始时间一致(防 PID 复用)+ argv 经 `lead_identity_command_matches` 精确匹配 `claude --agent <lead_id>`(防身份漂移/wrapper 冒充)。这正是 reap 杀人前用的同一套验证——**杀人级证据用来收养,强度只高不低**。
2. **同代 server + 窗口绑定**:`_tmux_target_matches_archive "$TMUX_ARCHIVE_WINDOW_ID" true`(claude-lead.sh :1302-1312)= archive 可读 + window_id 相符 + server generation 当前(见 2.3 的 cheap 化)+ 该窗第一个 pane 的 pane_pid == archive pane_pid + 进程活体复核。
3. **body argv 事实**:已实测 `CLAUDE_ARGS` 含 `--agent "$LEAD_ID"`(:2401),证据 1 的 argv 匹配在生产形态下可判。

三重全绿 ⇒ 收养;任一不绿 ⇒ 保持现有路径(rc 4 → clear+relaunch;`_prepare_lead_launch` → hold)。**跨代(split_brain)与身份不匹配永不收养**。

### 2.3 稳态零锁的实现面

现状成本模型:

- `_tmux_generation_is_current`(:1294)= 全量 `tmux_socket_inspect` = 1×tmux 探针 + 1×`ps axww` + N×`lsof`(N = 同 uid ppid=1 tmux server 数,今天 N≥3:default+atlas+q96)。静息 0.9s,负载态数秒;监控循环每 3s 一次/lead ×15。
- cheap 替代:`_tmux display-message -p '#{pid}'`(一次 tmux socket IPC,server 直接应答,毫秒级)与期望 server pid 等值比较。tmux server 应答自身 pid 这个事实**就是**「该 socket 上这代 server 活着」的直接证据——inspect 的 ps+lsof 扫描是为了回答「socket 不可达时,谁还占着它」这个法医问题,稳态不需要。
- 设计:新增 `_tmux_generation_is_current_fast`(bounded `display-message` 等值),监控循环与 ensure 快路径用 fast 版;fast 失败(探针错/超时/pid 不等)才落 full inspect / 带锁 rescue。`_tmux_rescue_bounded_exec` 已有,可直接给 cheap 探针加超时;不引入新超时机制。
- `ensure_tmux_session` 快路径:`display-message` pid 可读 + `has-session -t =flywheel` rc 0 ⇒ 直接 `TMUX_SERVER_PID=<pid>` return 0,零锁。两探针任一失败 ⇒ 现有带锁 `tmux_socket_ensure` 全套(创建/救援语义不变)。
- 语义损失评估:快路径跳过了 inspect 的 split-brain 候选扫描。但 (a) 破坏性动作(create/signal)仍然只在带锁全检后发生;(b) 监控/ensure 快路径是只读的;(c) 真 split-brain 场景里 display-message 探针返回的是当前可达 server 的 pid,与 archive 里的期望 pid 不等 → fast 失败 → 落回 full 路径。**结论:快路径不会把 split-brain 误判成健康**,只是把法医扫描推迟到出现硬证据时。

### 2.4 建窗验收(:1961-1973)的直接证据替换

现状:create 后全量 inspect,verdict ∉ {reachable} → 杀刚建的窗。`saturated`/`ambiguous`/`unknown` 全是负载噪声可产生的 verdict——lsof 一次超时就 `scan_complete=false` → `unknown`。

直接证据设计(**只回答「我刚建的窗好不好」,不回答全服法医问题**):

1. server 未换代:`display-message -p '#{pid}'` == create 前 ensure 记录的 `TMUX_SERVER_PID`;
2. 窗有活 pane:`list-panes -t "$LEAD_WINDOW_ID" -F '#{pane_pid}'` 非空数字。

判定表:

| 证据 | 动作 |
|---|---|
| 两证据全绿 | 接受,写 archive,继续 bind |
| server pid **阳性不等**(探针成功但值不同) | 换代已发生:旧窗归属不可知,**不杀**(跨代杀窗违反 FLY-1285 不变量),清本地状态 → hold |
| pane 探针**阳性无 pane**(list-panes 成功但空/窗不存在) | 建窗即死:按现有 dead-pane 语义清理(同代守卫下 kill-window)→ hold |
| 任一探针**不确定**(超时/错误) | **不杀**。有 pane_pid 就写 archive 再 hold(让下一轮 matcher/收养分支接手);拿不到 pane_pid 则仅 hold,下一轮 `_prepare_lead_launch` 的 unarchived-window 分支照旧兜底 |

净效果:verdict 噪声永不触发杀窗;只有阳性证据才有破坏性动作。原 :1964-1973 的 inspect+verdict 判定整段删除。

### 2.5 backoff jitter 与锁等待

- 两处 backoff 站点:主循环 `TMUX_HOLD_BACKOFF`(4 处 `interruptible_sleep "$TMUX_HOLD_BACKOFF"`)与 `_wait_tmux_window` 的 `hold_backoff`。现状:3→6→12→24→30 定步长,15 个 supervisor 同刻重启 → herd 对齐。
- jitter 设计:封一个 `_hold_sleep <base>` helper = `interruptible_sleep $((base/2 + RANDOM % (base+1)))`(bash 3.2 的 `$RANDOM` 可用;cap 30s 时即 15-45s 均匀散布,满足 issue 的 20-40s 量级)。替换全部 5 个站点,不加新配置。
- 锁等待:`_tmux_rescue_effective_timeout lock` fallback 5→30(env `FLYWHEEL_TMUX_RESCUE_LOCK_TIMEOUT_SEC` override 机制已存在,不新增 flag)。×load_factor(≤4)后上限 120s;临界区自身预算(`_TMUX_RESCUE_TOTAL_BUDGET`=60s)不变,锁内工作量不受影响。Fix 1-3 落地后锁流量趋近零,此条纯兜底,让极端场景「排队等到」而不是「放弃→重扫→再排队」。

### 2.6 restart-services preflight 清理 + QA 命名规则

- 现场证据:`/tmp/q96/tmux.sock` 是 8/5 ad-hoc mutant 演练台残留,server 活着,session 名就叫 `flywheel`(带 group flywheel,完整仿真生产拓扑)。`tmux -L atlas`(Mufasa)合法必须保留。
- 设计(保守、显式、只报告+可选清):restart-services preflight 枚举同 uid ppid=1 tmux server,对 socket 路径做**显式分类**:
  - 生产 default(`/tmp/tmux-<uid>/default`)与 allowlist(`atlas`,`-L` 派生路径 `/private/tmp/tmux-<uid>/atlas`)→ 不动;
  - 已知 QA 泥地模式(`/tmp/q[0-9]*/tmux.sock`、`${SLOT_DIR}/state` 下的 slot socket)→ 视为残留候选:打印 server pid + socket + session 列表,`tmux -S <sock> kill-server`;
  - 无法分类的 → 只告警不动(fail-open 报告,fail-closed 动作)。
- QA 命名规则:QA rig 的 tmux session 一律 `qa-` 前缀(不得叫 `flywheel`)。现有 `scripts/test-deploy.sh` / `scripts/qa-framework/` grep 无 `new-session -s flywheel`(q96 是 ad-hoc 台),规则落为:`restart-services` preflight 对「非生产 socket 上出现名为 flywheel 的 session」打 severe 告警(即使不清理也让它可见),并写入 QA 框架文档。

## 3. 「shell 收养不改 lease store」正确性论证

收养后系统所处状态 = 「supervisor 从未死过、正处于监控中」的等价态:

1. **写边界**:body pane env 里的 `FLYWHEEL_LEAD_LEASE_KEY`/`FLYWHEEL_LEAD_GENERATION` 是老代 launch 注入的,与 store 里的 row(同 generation、bound)仍逐字一致 → `authorizeLeadWrite` 判定不变。收养不产生第二个写者:新 supervisor 不 launch、不 bind。
2. **账本收敛**:body 死后,`_wait_tmux_window` 返回 → 下一轮 `lead_identity_prepare_lease`:store 里 supervisor tuple(老代)已死 + holder(body)已死 → 走「全死」路径 → 正常新 generation acquire → 正常 relaunch。无死账。
3. **收养期间 store 的 supervisor tuple 指向死进程**:与今天 `holder_orphaned` 未被处理时段的账面完全相同,不引入新形态;差别只是今天这个时段以杀活体结束,修后以监护结束。任何依赖「supervisor tuple 活」的判定(acquire 的 denied_holder_alive)只会在**第三个** supervisor 出现时触发——launchd label 唯一性保证同 lead 不会有两个 supervisor,此形态今天已依赖同一保证。
4. **race 分析**:两个进程同时对同一 body 做收养判定是只读的(matches/list-panes),无破坏性;与 reap 的竞态由「reap 只在 RELAUNCH_PROVEN=1(自己看着窗死了)或 cleanup(自己要退出)时发生」保证——收养者不设 RELAUNCH_PROVEN。

结论:零 TS 改动成立。lease store 的 `adopt` 动词(把 supervisor tuple 原子改指新 supervisor)列为 follow-up(强一致账面,非本单必需)。

## 4. 测试基建现状

- `scripts/__tests__/tmux-server-rescue.test.sh` / `-lock.test.sh` / `-instrumentation.test.sh` / `-real-tmux.test.sh`:rescue 库合同 + 真 tmux 集成,新锁等待值与 cheap 探针在此扩展。
- `scripts/__tests__/lead-body-hard-clear.test.sh`:hard-clear 合同(收养 fall back 路径的既有保护)。
- `scripts/__tests__/restart-storm-gate.test.sh` / `restart-storm-wrapper-wiring.test.sh`:FLY-1081/1634 风暴门,restart-services preflight 改动在此扩展。
- 隔离手段:`FLYWHEEL_TMUX_SOCKET_OVERRIDE`(claude-lead.sh :1271,覆盖全部 tmux 操作)+ `FLY1285_RESCUE_DRY_RUN`。QA recipe 记忆:假 Lead body 的 argv[0] 必须是真 `claude`(或符合 `lead_identity_command_matches` 的形态),否则收养判定一路假阴性([lead-body-hard-clear 真机台架四卡点]);**tmux 隔离必须用 socket override / PATH shim,`TMUX_TMPDIR` 不隔离**。
- 新增:`supervisor-adoption.test.sh`(收养判定矩阵:三证据 2^3 组合 + 冷启全链)与 storm 回归(≥3 supervisor 冷 bootstrap 于隔离 socket,断言 ≤2min 全监控态、零 kill、零 lock_unavailable;阳性对照 = 同台架跑未修代码断言复现 hold 循环)。

## 5. 老栈/新栈交付事实

- 老栈(生产 4857d999)与 HEAD 在两个目标脚本上的 diff 已逐 diff 确认与 supervisor 路径无关 → 在 HEAD 上做的修复对老栈**逐 hunk 干净可 backport**。
- 部署形态:scripts-only。`claude-lead.sh` 由 supervisor 进程启动时读取——**已在跑的 supervisor 不会热加载**,生效需要 supervisor 换代(bootout/bootstrap 或 restart-services)。当前全舰 supervisor 已 bootout(仅 Mufasa 留),正好是干净上线窗口:merge/热修落盘 → bootstrap 即新代码。上线路径(老栈热修 vs 并入 run5)由 Lead 与 founder 定夺,PR 先出。
- **不许 ff 本地 main**(老栈工作区约束);本 worktree 基于 origin/main tip,PR base=main。
