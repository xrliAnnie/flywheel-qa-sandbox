# FLY-1482 test-teardown 拿不到 cmux mutator lease — 实施计划

Issue: FLY-1482 (https://linear.app/geoforge3d/issue/FLY-1482/p2qa房-test-teardown-永远拿不到-cmux-mutator-lease-测试-slot-无法清理资源永久泄漏)
日期: 2026-08-03
基于: research.md(Codex design review R1-R5 反馈已折入,见 §10;R5 APPROVED)

## 0. 目标与非目标

**目标(= issue 验收)**
1. 生产 watcher(`flywheel-cmux-sync --watch`)正常运行时,`scripts/test-teardown.sh <slot>` 能成功清理该 slot。
2. QA 房 smoke 的 cleanup 不再静默失败(失败必须可观测)。
3. 回归测试钉死:**真 `--watch` 进程**活着时 teardown 必须能拿到锁;两把锁的语义兼容性有契约测试;新测试**接进 CI**。
4. 真机回放验收:再造等价残留(原始残留 slot3/19873/60450 已消失,research.md §2 实测),生产 watcher 活着时真跑 teardown 成功,生产锁完好。

**非目标(honest boundary)**
- 不改 FLY-1272 单一 mutator lease 模型(只补让锁握手)。
- 不全量镜像 `acquire_mutator_lease` 的 classify/rebuild 状态机进 teardown —— 但 teardown 侧对**全部可达输入**给出完整决策表(§4.3),每行要么镜像既有语义要么显式 fail-closed;共享 lib 抽取记 follow-up(FLY-1577/FLY-1618)。
- 不动 FLY-913 restart-guard。
- 不引入行为开关 flag(FLY-1466 铁律);唯一新 env 是等待时长 tuning knob(有默认值),不是 feature 开关。QA yield claim 是**状态文件**,不是 flag。
- 不处理 FLY-1618 scheduler 锁(另单);`qa-fly-60-driver.sh:1007` 的 continue-on-teardown-failure 语义保留,仅接入日志+receipt(§6.4)。

## 1. 总体设计:claim 驱动的让锁握手 + 统一锁语义 + 统一 maintenance 谓词

teardown **绝不写、绝不删共享 maintenance marker**,改用独立 **QA yield claim 文件**(`${CMUX_MAINTENANCE_MARKER}.qa-teardown`)。watcher 与所有 one-shot mutator 统一走一个 `maintenance_requested()` 谓词(base marker **或** claim)。

```mermaid
sequenceDiagram
    participant T as test-teardown.sh
    participant C as QA yield claim<br/>(cmux-maintenance.qa-teardown)
    participant W as flywheel-cmux-sync --watch<br/>(生产 watcher, launchd)
    participant L as mutator lease<br/>(/tmp/flywheel-cmux-watcher.lock)

    Note over W,L: 常态: watcher 持有 lease (mode=watch)
    T->>T: ① base marker 存在? → 拒绝退出 (fast reject)
    T->>C: ② fence 先行: 私有 temp inode 经 fd 8 写全内容并取内核锁<br/>(activity fence, mutation 全程持有, foreground child 继承)
    T->>C: ③ reap-mutex 内把已持锁 inode hard-link 发布为 claim<br/>(no-clobber) → 精确 read-back; 已存在: owner 活拒绝 / owner 死接管
    W->>C: ④ maintenance_requested() 检出 (tick 顶 / sleep 切片 / 入口)
    W->>L: ⑤ release + read-back 验证; 失败 → holding-with-request:<br/>保持持锁+零副作用+重试, 绝不假装已放
    Note over W: parked: base marker 永不碰;<br/>claim 仅在 owner 死 + activity fence 可取时 reap
    T->>L: ⑥ 有界轮询 (默认 60s): 按 §4.3 决策表经统一 reap mutex<br/>以 qa_teardown 身份取 lease (owner tmp+mv 原子写)
    T->>T: ⑦ 持锁后复查 base marker: 存在 → 放锁+删 claim+loud refuse
    T->>T: ⑧ 执行原 teardown 步骤 (不动)
    T->>L: ⑨ release lease (own 验证)
    T->>C: ⑩ own 验证后删 claim + 关 fence fd
    W->>C: ⑪ 谓词清空 → 阻塞 re-acquire → 复查谓词 (重现→再让)<br/>→ sync_additive_bootstrap → 恢复
```

关键性质:
- **老 watcher 安全**:旧代码不认识 claim → 无视 → 不 park;teardown 有界超时 loud fail。过渡窗口严格不劣于现状。
- **foreign 语义零破坏**:base marker 只属于迁移 runbook;teardown 只读;watcher 只 park 不 reap;one-shot 在 base **或** claim 下均无 mutation 退出(claim 纳入后语义增强方向一致)。
- 全程 fail-closed:不可判定 → 拒绝/park+告警;超时 → loud fail;release 验证失败 → holding-with-request。

## 2. 数据模型与 claim 合同

| 文件 | 形态 | 写方 | 删方 |
|---|---|---|---|
| `$WATCHER_LOCK_DIR/owner` | `pid\|incarnation\|mode\|nonce` 单行 | 各 mutator(统一 tmp+mv 原子写) | own 验证持有者;census 门控 rebuild |
| `$WATCHER_LOCK_DIR.reap` | retained file + fd-9 内核锁(`lockf -s -t 0` 优先 / `flock -n` 回退) | 双方 | **永不删除** |
| `$CMUX_MAINTENANCE_MARKER`(base) | 任意 | 迁移 runbook | 迁移 runbook |
| `$CMUX_MAINTENANCE_MARKER.qa-teardown`(claim) | `pid\|incarnation\|qa_teardown\|nonce` 单行 regular file | teardown | own 验证的 teardown;watcher 按 §4.2 fence 合同 reap |

**claim 发布(R2 #1 crash-atomic;R7 #1 修订 —— fence 先于发布,公共路径永不以「可创建」方式打开)**:
1. 同目录私有 temp:**经 fd 8 创建并写完整单行内容,随即在该 fd(即 temp inode)上取内核锁** —— fence 在发布前就已建立;
2. 持 reap mutex 下 `ln "$temp" "$claim"` —— 把**已持锁的 inode** hard-link 到 claim 路径(目标已存在即失败 = no-clobber;链接成功即内容完整且锁已在身);
3. 精确 read-back 确认;成功 → 只删 temp **名字**(inode 经 claim 存续,锁不断);失败/消失/被替换 → **owner/inode 感知的清理 + 关 fd 8,绝不对公共 claim 路径做任何带创建语义的 open**(`>>` 有 O_CREAT,禁用于 claim 路径 —— R7 #1 的重建漏洞即源于此)。

**claim 解析(双侧共用规则)**:regular file(`-f` 且非 `-L`;`-e || -L` 捕获 dangling symlink)、单行、4 字段、mode=qa_teardown、pid 数字、incarnation 非空。**malformed claim → 双侧 fail-closed**:teardown 拒绝 + loud;watcher park + 周期性告警(复用 `_alert_malformed_mutator_lease` 通道的新条目)—— 绝不猜、绝不删。

**接管(owner-dead stale)**:reap kernel mutex 临界区内 classify → fence 探测(§4.2)→ `rm` → hard-link publish → re-read 确认;任一步失败 → 放弃 + loud fail。

**删除**:read-back 内容 == 自己的行才删。

## 3. Chunk C1 — teardown 的 reap mutex 换 retained-file + lockf/flock 语义

**文件**:`scripts/test-teardown.sh`

1. 替换 `:86 mkdir` / 各处 `rmdir` 为镜像 `flywheel-cmux-sync.sh:6903-6944 _acquire_reap_mutex`:legacy 目录 census 门控升级;symlink/怪节点 fail-closed;`exec 9>>` retained file + `lockf -s -t 0 9` 优先、`flock -n 9` 回退(探测顺序字面一致);两者皆无 → fail-closed;release = 关 fd,永不删文件。
2. `test-teardown.sh` 增加 cmux-sync 同款 `BASH_SOURCE` guard(契约测试需 source;非行为 flag)。

## 4. Chunk C2 — watcher 侧:统一谓词 / yield / fence / 决策表

**文件**:`scripts/flywheel-cmux-sync.sh`(+ teardown 镜像侧)

### 4.1 统一 `maintenance_requested()` 谓词 + yield 状态机(R2 #2)

新谓词 `maintenance_requested()` = base marker 存在 **或** claim 存在(含异常节点判定:dangling symlink 等 → 视为 requested + 告警,fail-closed)。**按入口分相接线(R3 #1:claim 的 reap 只能在持锁后的 yield/park 路径达成,入口若被 claim 阻塞则 reaper 永不可达)**:
- 三个 tick gate(`:978`、`:6233`、`:6282`)从裸 `[[ -e $CMUX_MAINTENANCE_MARKER ]]` 改为完整谓词;
- **one-shot**(`--once/--refresh/--reap-orphan-pins`)的 `maintenance_entry_allowed` 改用完整谓词 → claim 下同样无 mutation 退出(拿到 lease 也立即放掉,run_mutator_once 结构不变);
- **watch dispatcher 的 pre-acquire gate(`:7223`)只保留 base marker 现有语义**(supervised 等 base 清除;claim **不**阻塞 watch 启动)→ `acquire_watcher_lock` 正常进行(dead-owner lease 残留由既有 census rebuild 处理)→ 成功后**立即**走 yield 检查:见 claim → release → parked → 由 parked 循环的 reap 逻辑(§4.2)自愈 stale claim。冷启动 + stale claim 因此必达 reaper,不会无锁死等;
- watcher yield 检查用完整谓词。

yield 状态机:
- 让锁:log → `release_mutator_lease` → **read-back 验证**(canonical lease conclusively absent 或非自己);
- 验证失败 → **`holding-with-request` 显式状态**:保持 lease、**零副作用**(不进 watch_main 剩余流程、不跑任何 tick 工作),每 poll 重试 release + 告警,直到 release 成功或谓词清空(清空则回正常持锁运行);
- parked(release 成功后):poll 谓词 + 定期 log;base marker 永不 reap;claim 按 §4.2 reap;
- 谓词清空 → 阻塞 re-acquire(统一等待语义,绝不 exit)→ **成功后立即复查谓词**(重现 → 再让锁重新 park)→ `sync_additive_bootstrap` → 恢复。

插入点:`acquire_watcher_lock` 成功后、`watch_main` 任何副作用前;`watch_loop` tick 顶;degraded 长退避 sleep 的**专用切片**(≤5s stat,独立于 `FLYWHEEL_CMUX_REOPEN_SWEEP`);healthy 15s sleep 不动。

### 4.2 activity fence:可跨父进程死亡的 child 存活证明(R2 #3)

census 证不了普通 foreground child(`rm`/`git`/`tmux` argv 不属 teardown family)。改用**内核锁 fence**:

- fence 建立顺序见 §2(R7 #1):**先在私有 temp inode 上经 fd 8 取锁,再 hard-link 发布** —— claim 可见的那一刻锁已在身,不存在「发布后、取锁前」窗口,也绝不以创建语义 open 公共路径;锁与 reap mutex 同款 `lockf`/`flock` 探测序,**mutation 全生命周期持有**;foreground child 继承该 open file description → 父被 SIGKILL 而 child 存活时锁仍被持有;
- watcher reap claim 的充要条件(全部在 reap mutex 临界区内):claim 良构 + owner 死(pid+incarnation)+ **非阻塞取 claim fence 锁成功**(取到即证明 teardown 家族无人持有 → 立即释放探测锁 → 删 claim);
- 取不到 fence 锁 → 继续 park(fail-closed);
- **平台真实性验证是硬门**:macOS `lockf` 与 Linux `flock` 各自用真实 parent-SIGKILL + child-survival fixture 验证「child 活 → 非阻塞取锁必失败」(C5-e)。**Darwin 主路径已在 design review R3 期间由 Codex 本机实测通过**:父 bash 3.2 进程被 SIGKILL 后,child 存活期间竞争者 `lockf -t 0` 返回 75(busy),child 退出后返回 0 —— fence 随 fd 继承存续成立;Linux `flock` 留待 CI fixture 覆盖。
- **fallback 定位为 contingency-stop,不是自动备选**(R3 #3):若某平台 fixture 硬门失败,**停止实现、回到设计评审**补一版可执行的 fence 方案(如版本化 claim schema + 唯一 process group 合同),绝不在实现现场临场启用未成形方案。
- 原「连续两 poll 观察死亡」保留为额外保守层(非证明层)。

### 4.3 lease 可达状态完整决策表(R2 #4)

teardown 侧 acquire(每 2s 轮询迭代,均先过 reap mutex)对**全部可达输入**:

| lease 观察态 | 动作 |
|---|---|
| canonical 路径不存在 | (先过 quarantine prune,见末行)mkdir + tmp/mv 写 owner → read-back 确认 |
| canonical 是 symlink / 非目录 | fail-closed 拒绝(镜像 `:6958-6961`) |
| 良构 owner + 进程活(**任意 mode**:watch/once/refresh/reaper/qa_teardown) | 继续等待(预算内) |
| 良构 owner + incarnation 证实死 + 两次稳定空 census | quarantine-rename(`.stale.$$.$RANDOM`)→ 新建 → 成功删 quarantine / 失败按 `:7016-7024` 同构恢复或保留 |
| **bounded 可读 regular** malformed/missing owner + **bounded pid candidate** + 两次稳定空 census | 按 stale 处理(镜像 `malformed-owner-no-live-mutator` 语义,R3 #2 精确化) |
| owner/pid 文件 **unreadable / symlink / non-regular / oversized**,或 command/census 不可得 | fail-closed:本轮不动(镜像 `_bounded_candidate_pid:6744-6760` + classify rc=2 语义);预算尽 → loud fail |
| malformed / missing owner + census 不稳定或有 live mutator | fail-closed:继续等待;预算尽 → loud fail |
| legacy pid-only 目录 + pid 活 | 继续等待 |
| legacy pid-only 目录 + pid 死 + 空 census | 按 stale 处理 |
| 目录存在但 owner 尚未发布(publisher 竞争窗口) | 读作 missing owner;census 含 publisher(argv 匹配)→ 等待 |
| 残留 `.stale.*` quarantine | **镜像 `_prune_stale_lease_quarantines`(:6873-6894)在 canonical 观察/创建之前执行**:regular-dir 且 census 门控通过 → 删;unknown node / census 不稳 → fail-closed(R3 #2:不能绕过既有 transition gate 继续 mutation) |

census 匹配集(双侧一致,R1 #3):`_mutator_command_matches` 加入真实 teardown argv 形态(`…/test-teardown.sh <arg>`,含 `bash …` 前缀形),shell prose 拒绝保留。

### 4.4 incarnation TZ 归一 —— **FLY-1605 的 teardown 侧补全**(生产实锤驱动,Lead 指令 `1ae9fe17`)

research.md §2.1:`ps -o lstart=` 渲染 TZ 依赖(实测 6h/1h 分叉)。R6 复核 HEAD 定位:**watcher 侧已由 FLY-1605 修掉**(`flywheel-cmux-sync.sh:6638`/`:3277` 已带 `TZ=UTC LC_ALL=C`,并有 cross-TZ 测试)—— 本单是它的**扩展**,不重做:

- 补全剩余缺口:`test-teardown.sh` 的 `cmux_process_incarnation`(:41)与 `cmux_tmux_generation`(:139)同样加 `TZ=UTC LC_ALL=C`;持久化/读取值做**首尾**空白 trim(绝不折叠内部空白 —— lstart 的内部双空格是格式一部分);
- 迁移语义:旧 TZ 渲染的存量 owner/claim 修后 mismatch → 既有 stale 分类 + census 门控处置;live legacy 主 lease 由 census(`:6803-6829`)判 busy,安全(R6 确认);
- **claim 发布→fence 竞态的结构性关闭**(R6 #1 → R7 #1 定稿):fence 在**私有 temp inode 上先建立**(fd 8 写内容 + 取锁),再于 reap mutex 内 hard-link 发布 + 精确 read-back → 才释放 mutex;消失/被替换 → abort + owner/inode 感知清理,公共 claim 路径**永不**以带 O_CREAT 语义的方式打开(§2);
- 根因收尾(老 watcher 2 天窗口内何时开始失效、env 对照)= 实现期任务。

### 4.5 owned-lease 验证连续失败的 fail-loud 自愈(watcher-only 顶层状态机,R6 #2)

老进程「宣称持锁却验锁失败」静默循环 ~2 天。设计为**只在 watch 模式、只在顶层生效**的状态机:

- 阈值**固定 3**(不新增 env/flag,遵守 §0);
- **pass 起点权威验证(R7 #2)**:每个 watcher pass 开始处先做一次权威 owned-lease 验证 —— 失败 → 置 latch + **跳过整个 pass**(零 mutation),记 1 次失败观察;
- **pass 中途失权的传播**:深层守卫(`:1561` 静默早退、`:3749` 每笔 ledger 事务)失败时置进程本地 latch 并返回**可区分的 authority-loss 结果**(区别于普通 ledger I/O 失败);每个外层 mutation 边界检查 latch → **中止本 pass 剩余工作,失权下不做任何补偿性 mutation**。特别地(生产循环本体):`create_workspace_for_window` 在 `_ledger_upsert` 因 authority-loss 失败时**保留**刚建的 unreceipted workspace(不 rollback);`rollback_unreceipted_workspace`(:5465-5473)只保留给普通 ledger I/O 失败 —— 老进程每 60s「建了又回滚」的 mutation 正是失权 rollback;
- 绝不在嵌套/子 shell 上下文 `exit`;one-shot 进程(无 supervisor)不参与;
- 一个 pass 无论深层失败几次只记 **1 次**观察;**streak 清零只发生在「完整干净 pass」之后**(pass 起点验证成功 **且** 整个 pass 无任何 authority-loss latch)—— 起点成功不清零,否则「起点过、中途失权」的循环永远累计不到阈值(R8 #2);
- 连续 3 个 pass 失败 → alert-once(既有 alert 通道)→ 在已停止 mutation 的 pass 边界受控退出,由 supervisor 拉起新进程(生产证据:新进程即刻恢复)。**阈值只推迟进程更替,绝不授权前两个失败 pass 里的任何 mutation**;
- **§4.1 修订(R6 确认答复 b)**:`holding-with-request` 期间达到阈值**不抑制退出** —— best-effort 跑既有 own 验证 release trap → 退出;替代进程按 §4.1 的 base/claim 启动语义接管;release 失败残留由替代进程的 census 门控 rebuild 安全处置。

## 5. Chunk C3 — teardown 握手编排

**文件**:`scripts/test-teardown.sh`(main :646-663 重排)

1. base marker fast reject(前置);
2. fence-先行的 claim 发布(§2 合同:temp inode 取锁 → reap mutex 内 hard-link 发布 → read-back);
3. 有界等待 + 拿锁循环(`FLYWHEEL_QA_TEARDOWN_LEASE_WAIT_S` 默认 60s;§4.3 决策表);预算尽 → 撤 claim → loud fail(带 owner 快照);
4. **持锁后、任何 mutation 前复查 base marker**(R2 #2):存在 → release lease → own-delete claim → loud refuse(保留现 `:657-663` 「持锁检查」合同);
5. trap(EXIT/INT/TERM)= release lease → own-delete claim → 关 fence fd;正常收尾同;
6. 既有 `teardown_slot` / all 循环零改动。

## 6. Chunk C4 — smoke cleanup 可观测性(R2 #5 修正)

1. 共享 helper `scripts/lib/qa-teardown-finalize.sh`:
   - `qa_finalize_teardown_slots <logdir> <slot>...` —— **一次接收 slot 列表**;single-shot key = invocation(guard 变量)**+ 每 slot** 各自幂等;
   - 调用方合同:trap 内**先捕获 primary rc**、关闭 errexit 敏感路径(`set +e` 局部)、防递归 trap;helper 逐 slot 跑 teardown(输出落 `<logdir>/teardown-slot-<S>.log`)并**聚合**各 slot rc;
   - 失败 slot → stderr 大声一行 + receipt `/tmp/flywheel-test-slot-<S>.teardown-failed`(**invocation nonce** + 时间戳 + rc + 日志尾 20 行);
   - 成功 slot → 只删**调用前已观察到且 read-back nonce 未变化**的旧 receipt(不删并发新 receipt);
   - 返回聚合 rc。
2. 退出码合同:primary 失败优先(原码不变);primary PASS + 任一 slot teardown fail → exit 2(`PASS_WITH_TEARDOWN_FAILURE`);全好 → 0。
3. 四个 smoke 接入:`qa-fly-1189-room-smoke.sh`(单 slot)、`qa-fly-529-roundtable-smoke.sh`(双 slot)、`qa-fly-529-alert-smoke.sh`、`qa-fly-153-mirror-smoke.sh`(多已部署 slot)—— 各自按其 `set -u`/`set -euo`/EXIT-only 形态接线。
4. `qa-fly-60-driver.sh:1007`:接入日志 + receipt(可观测),**保留 continue-on-failure 语义**(driver 按设计继续 deploy;行为改造记 follow-up)。
5. `pre-ship-check.sh` 不改。

## 6b. Chunk C6 — 舰队重启覆盖 `com.flywheel.cmux-watcher`(Lead 指令 `1ae9fe17`;R6 #3 修订)

昨晚舰队重启不覆盖 cmux watcher 服务,卡死的 watcher 原样穿越重启。修:

1. `scripts/restart-services.sh` 新增 watcher 重启步骤:`launchctl bootout gui/$(id -u)/com.flywheel.cmux-watcher` → **repo-pinned** `${FLYWHEEL_DIR}/scripts/flywheel-cmux-sync.sh --wait-for-watcher-exit` → **conclusive 消失核验(R7 #3)** → `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flywheel.cmux-watcher.plist`。现状 `wait_for_watcher_exit`(`:7154-7159`)KILL 后**立即返回成功、无最终 absence read-back** —— 本 chunk 内加固该 helper(升级路径末尾加有界 absence 复查),或在 restart-services.sh 侧加独立有界 absence 检查;**只有 conclusive 确认旧 watcher 消失才允许 bootstrap**。超时 / 幸存者 / census 不可判 → **跳过 bootstrap** + 结构化非 healthy outcome(`unverifiable` + shutdown 细节)进两个上报位点;
2. 位置:Lead 结果**捕获之后**(即使 Lead 结果 degraded/不可读也照跑 watcher 步)、`trigger_cmux_refresh` 之前;
3. **结构化 watcher outcome 接入 FLY-1603 终态渲染(R6 #3:否则 ⚠️ 警告发了、终态仍会假报「全量重启完成」)**:`scripts/lib/restart-notify.sh` 纳入本 chunk 范围 —— watcher 结果作为第三路 outcome(`healthy` / `missing_plist` / `bootstrap_failed` / `probe_failed` / `unverifiable` + detail)进 `rn_render_completion_message`(现只吃 Lead+Bridge,`restart-services.sh:1756-1761`、`restart-notify.sh:164-171`)与尾部 warning 路径;**任何非 healthy → 终态消息强制 ⚠️「结束/degraded」+ 带 watcher 状态,绝不含「完成」**;退出码可保持 warning-only/0;
4. 验证探针:新 watcher pid ≠ 旧 pid 且 lease owner 翻到新 pid(带超时);marker/claim 生效期间探针可保守报 degraded(不产生并发 mutation,R6 确认);
5. maintenance marker / QA claim 下的新 watcher 入口语义已由 §4.1 定义,无需特判。

## 7. Chunk C5 — 回归测试(真 watcher + RED first + CI 接线)

全部落 `scripts/__tests__/`,hermetic harness 模式(fake tmux、隔离 HOME/state、env override、bash 3.2)。

- **a. 主验收 E2E(第一个提交,先 RED)** `test-teardown-live-watcher-e2e.test.sh`:隔离环境启动**真实** `scripts/flywheel-cmux-sync.sh --watch`(真 dispatcher/watch_main/watch_loop/traps),等 owner mode=watch → 真跑 `scripts/test-teardown.sh <slot>` → 断言:成功、slot 清空、claim 清除、watcher 重新持锁、watcher 进程活。现状必 RED。
- **b. 锁语义契约**:reap mutex 双向互斥;legacy 目录升级双侧;symlink 双侧 fail-closed;**§4.3 决策表逐行正反例**(malformed/missing owner ± live census、owner 与 pid 各自的 symlink/non-regular/oversized/read-error、legacy live/dead、quarantine regular-dir/symlink/unknown-node、canonical symlink、publisher 窗口)。
- **b2. dispatcher 冷启动生命周期(R3 #1)**:真 `--watch` 启动前分别预置 —— live claim → 启动后 acquire 再 yield/park 等待;dead-owner + free-fence claim → reap + 正常启动;dead-owner + busy-fence claim(child 存活)→ park 至 child 退出后启动;malformed claim → 告警 + fail-closed park;dead claim + dead main lease → reap claim + census rebuild lease + 启动。
- **c. claim 合同**:hard-link publish 双 teardown 恰一胜;**kill seam:内容发布前崩溃 → 不留任何可见 claim(temp 不构成 claim)**;malformed claim 双侧 fail-closed + watcher 告警;foreign base marker 三时点(teardown 前 / claim 后 lease 前 / **持锁后 mutation 前** → 放锁+删 claim+refuse);owner-dead 接管 read-back;live claim 拒绝。
- **d. 统一谓词 + yield 状态机**:one-shot(`--once`/`--refresh`)在仅 claim 存在时抢到 lease 也零 mutation 退出;release 注入失败 → holding-with-request(断言零 hook/bootstrap/tmux mutation + 告警 + 谓词清空后恢复);re-acquire 后谓词重现 → 再 park;reopen flag=0 + degraded 300s 退避下专用切片仍检出 claim。
- **e. fence 平台真实性(硬门)**:macOS `lockf` / Linux `flock` 各自:真 parent-SIGKILL + child(`sleep`)存活 → watcher 非阻塞取 fence 必失败、不 reap;child 退出后 → reap 成功。父子均死 → reap。
- **f. census 对称**:live `test-teardown.sh` 进程 + missing/malformed owner → 双侧均拒 steal。
- **g. finalizer**:双/三 slot、第二 slot 失败聚合、EXIT trap + `set -e` 下 primary rc 保真、成功清旧 receipt 但不清并发新 receipt(nonce 对比)、重复 cleanup 幂等。
- **i. incarnation TZ 归一(§4.4;RED 仅限真缺口)**:watcher 侧 cross-TZ 已有 FLY-1605 测试(复用/核验,不重写);RED 的是 —— teardown 两处读取跨 TZ 验证(修后匹配)、跨实现(teardown 写 owner/claim ↔ watcher 验证)跨 TZ 一致、首尾 trim(不折叠内部空白)、**fence-先于-发布次序**(claim 可见即已持锁;消失/替换 → publisher abort + 清理,断言公共路径从未被创建语义 open 重建);旧格式存量 owner → stale 分类 + census 拒偷 live。
- **j. verify-fail 自愈(§4.5)**:watcher vs one-shot 作用域(one-shot 不触发);pass 起点验证失败 → 整 pass 零 mutation;**生产形状用例:workspace 建成后 ledger upsert 因 authority-loss 拒绝 → 断言零 rollback/rename/tmux/剩余 tick mutation,workspace 被保留**;普通 ledger I/O 失败仍走 rollback(对照);单 pass 多次深层失败只记 1 次;**连续 3 个「起点验证成功、途中失权」pass → 恰在第 3 个 pass 边界退出**(起点成功不清零的回归钉);**清零仅发生在完整干净 pass 之后**(失败 pass → 干净 pass → 失败 pass:streak 回 1 不累计);固定阈值 3 无新 env;base marker / QA claim / holding-with-request 三态下达阈值均退出;release 失败残留由替代进程 census rebuild 收拾。
- **k. 舰队重启覆盖(C6)**:hermetic(stub launchctl + repo-pinned sync script)断言 bootout → wait-for-watcher-exit → **conclusive absence 核验** → bootstrap 顺序;**wait 非零/不可判、TERM/KILL 幸存者 → 断言 bootstrap 从未被调用** + `unverifiable` outcome;missing_plist / bootstrap_failed / PID 未变 / lease owner 未翻 / owner malformed-unreadable / healthy 对照(healthy 证 bootstrap + owner 翻转)—— 每种断言 **warning 路径 + 终态消息**双位点(非 healthy 终态必 ⚠️ 无「完成」);Lead 结果 degraded 时 watcher 步照跑。
- **CI 接线**:全部新 `.test.sh` 登记 `.github/workflows/ci.yml` 显式清单 + `ci-structure.test.sh`;顺带登记既有漏网的 `test-teardown-cmux-ownership.test.sh`。Linux CI 真 `flock`,本机 QA 真 `lockf`。
- **h. 真机验收回放**(529 房,ship 后):先决条件 = §8 顺序;再造等价残留 → 真跑 teardown → 成功;断言生产 lease owner 回到 watcher、`.reap` 仍文件、无 claim 残留、生产 cmux 面零扰动。

## 8. 实施顺序 / Ship 注意

提交顺序(TDD):C5-a 主 E2E(RED)+ C5-b 契约(RED)→ C1 → C2(谓词+yield+fence)+ C5-d/e/f → C3 + C5-c(主 E2E GREEN)→ C4 + C5-g → **delta 段(R6 #4)**:核验/复用 FLY-1605 既有 watcher cross-TZ 测试 → C5-i + C5-j(RED)→ §4.4 teardown 归一 + fence 迁移 + §4.5 自愈实现(GREEN)→ C5-k + restart-notify 终态真值用例(RED)→ C6 实现(GREEN)→ CI 接线 → 文档收尾。单 PR,base=main;真机验收(C5-h)仍以受控 watcher 重启为先决。

Ship:
- teardown / smoke / helper:merge 后即生效。
- watcher:`flywheel-cmux-install.sh` 受控重启(bootout → `--wait-for-watcher-exit` → bootstrap)。**顺序硬约束:先重启并验证新 watcher yield 能力(生产 lease 命名空间外的等价 C5-a 验证),再执行 C5-h。**
- 过渡窗口(新 teardown + 旧 watcher):旧 watcher 无视 claim → 不受扰;teardown 有界超时 loud fail。严格不劣于现状。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 镜像锁代码与 cmux-sync 漂移 | C5-b 契约测试常驻 CI;共享 lib follow-up |
| claim 半写可见 | hard-link publish(内容完整才可见)+ kill-seam 测试 |
| malformed claim 永久 park | 双侧 fail-closed + watcher 周期告警(人可见);绝不猜删 |
| release 失败被吞 | read-back + holding-with-request(零副作用)+ 告警 |
| teardown child 越过 owner-dead 判定 | 内核锁 fence(fd 继承)+ 平台 fixture 硬门(失败即 contingency-stop 回评审) |
| one-shot 在 claim 窗口 mutate | 统一 `maintenance_requested()` 谓词覆盖所有入口 |
| foreign marker 等待期间到达 | 持锁后 mutation 前复查(镜像现 `:657-663` 合同) |
| 两个 teardown 并发 | claim hard-link 恰一胜 + lease mkdir 原子双保险 |
| watcher degraded 晚让锁 | 专用切片(独立于 reopen flag);60s 预算;超时带 owner 快照 |
| 多 slot finalizer 漏跑/误删 receipt | slot 列表接口 + per-slot 幂等 + invocation nonce receipt 合同 + C5-g |
| smoke 退出码变化 | 独立码只在新场景;原 PASS/FAIL 码不变 |

## 10. Codex design review 记录

- R1(2026-08-03,xhigh):CHANGES REQUESTED,6 项 —— 共享 marker 所有权污染→独立 claim;release 未验证/切片依赖 reopen flag/插入点晚→read-back+专用切片+acquire 后立即检查;census 不对称→双侧 argv+tmp/mv+quarantine;主测试 false-green→真 watch E2E first-RED+CI 登记;旧 watcher 过渡窗更糟→claim 天然免疫;cleanup 合同缺失→共享 finalizer。全部采纳。
- R2(2026-08-03,xhigh):CHANGES REQUESTED,6 项 —— ①O_EXCL 非内容原子→hard-link publish+kill seam+malformed 双侧 fail-closed(§2);②claim 未覆盖全部 mutation 入口+缺持锁后复查→统一 `maintenance_requested()` 谓词(tick gates+entry+yield)+holding-with-request 显式状态+持锁后 base 复查(§4.1/§5);③census 证不了 foreground child→内核锁 activity fence(fd 继承)+平台 fixture 硬门+备选 group 证明(§4.2);④「三种状态」依据不成立→§4.3 完整可达状态决策表+逐行测试;⑤finalizer 多 slot 合同→slot 列表+invocation nonce receipt+四形态接线+qa-fly-60-driver 显式处理(§6);⑥research 残留旧设计→§3.2-§3.5 改写+§6 结论收回。全部采纳。
- R3(2026-08-03,xhigh):CHANGES REQUESTED,3 项 —— ①冷启动 watcher 被 stale claim 无锁死等(reaper 只在 parked 态可达)→ 谓词按入口分相:watch pre-acquire gate 只看 base marker,claim 不阻塞启动,acquire 后立即 yield/park/reap 必达 reaper + b2 冷启动生命周期测试(§4.1/C5-b2);②决策表混同 malformed 与 unreadable、绕过 quarantine gate → 按 `_bounded_candidate_pid`/classify rc=2 语义拆行 + teardown 镜像 `_prune_stale_lease_quarantines` 前置(§4.3/C5-b);③process-group fallback 未成形 → 改为 contingency-stop(硬门失败即停实现回评审),不做自动备选(§4.2)。附:Codex 本机实测 Darwin `lockf` fence 继承语义成立(child 存活竞争者返回 75,child 退出返回 0),Linux `flock` 留 CI fixture。全部采纳。
- R4/R5(2026-08-03,xhigh):R4 剩两处文档一致性(research §3.2 缺 phase-split 记录;两处残留 process-group fallback 表述)→ 修正后 **R5 APPROVED**。
- R5 后追加(Lead 指令 `1ae9fe17-c170-46b1-aed9-77d71b5089ac`,生产实锤):①老 watcher「持有 vs 验证」两谓词矛盾 + 2 天验证衰减的生产证据入 research §2.1,本机交叉验证发现 `ps -o lstart=` TZ 依赖渲染 → §4.4 + C5-i;②验证连续失败 fail-loud 自愈 → §4.5 + C5-j;③舰队重启覆盖 `com.flywheel.cmux-watcher` → C6 + C5-k。
- R6 delta 复审(2026-08-03,xhigh):CHANGES REQUESTED,4 项 —— ①§4.4 与已合入的 FLY-1605 重叠(watcher 侧 `:6638`/`:3277` 已 pin)→ 重定位为 teardown 侧补全 + claim publish→fence 必须在 reap mutex 内闭合(消失/替换即 abort);②§4.5 未定义 watcher-only 顶层状态机 → 固定阈值 3、深层守卫只置 latch、pass 边界合并观察、holding-with-request 不抑制退出;③C6 未接 FLY-1603 终态渲染(会假报「重启完成」)→ restart-notify.sh 入范围 + 结构化 watcher outcome + 非 healthy 终态强制 ⚠️;④§8 未含 delta 顺序 → 补 delta TDD 段。三项咨询答复:live legacy lease census 保护安全;maintenance 期间不抑制 self-exit;C6 位置安全。全部采纳。
- R7 delta 复审(2026-08-03,xhigh):CHANGES REQUESTED,3 项执行级 —— ①`exec 8>>` 的 O_CREAT 会重建已消失的 claim → **fence 先于发布**:私有 temp inode 上先写内容+取锁,再 reap mutex 内 hard-link 已持锁 inode 发布,公共路径永不以创建语义 open(§2/§4.2/§4.4/C5-i);②pass 边界 latch 观察太晚,失锁后 `create_workspace_for_window` 仍会跑 mutating `rollback_unreceipted_workspace`(:5465-5473,= 生产循环本体)→ pass 起点权威验证 + authority-loss 可区分结果 + 失权下保留 unreceipted workspace 不 rollback + C5-j 生产形状用例(§4.5);③`wait_for_watcher_exit` KILL 后立即返回、无 absence read-back → conclusive 消失核验后才 bootstrap,超时/幸存者/不可判 → 跳过 bootstrap + `unverifiable` outcome(§6b/C5-k)。全部采纳。
- R8/R9/R10(2026-08-03,xhigh):R8 两项(总览图/§5 残留旧「先发布后 fence」次序 → 图与 §5 改为 fence-先行;pass 起点成功即清零 → 清零仅在完整干净 pass 之后)→ R9 一项(C5-j 需显式钉「连续 3 个起点成功/途中失权 pass 恰在第 3 边界退出」+「失败→干净→失败 streak 回 1」两条序列)→ **R10 APPROVED,无剩余阻塞项**。全程共 10 轮(初版 R5 批准;Lead 指令 delta R10 批准)。
