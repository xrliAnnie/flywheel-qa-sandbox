# FLY-1605 cmux workspace 名字显示成原始命令 — 实施计划

Issue: FLY-1605 (https://linear.app/geoforge3d/issue/FLY-1605/cmuxfounder-直令-workspace-名字显示成原始命令1621-两条-spawn-路径缺-rename-调用-刷新现存名字)
日期: 2026-08-02
基于: research.md
修订: R9(R1-R7 = 首个 design session 折入 R1:6 R2:5 R3:2 R4:3 R5:2 R6:1 全部意见后 APPROVED;
会话重启后 R8 保真复核 + R9 APPROVED,增量 = bootstrap 挂载点(T17)与根因 A 的 17:10 活体追证)

## 0. 一句话

修两个真根因:① watcher mutator lease 的进程身份渲染固定为 UTC/C(时区切换不再让所有 ledger
写入被拒、create 全线回滚成无名 workspace);② 新增幂等、strict-authority 的 title reconcile
(stock migration),以「经 create 同款 adoption gates 验证过的」tmux 窗口为真相源,把
workspace 名 + tab 名两个显示面一起对齐——既当场刷好现存错名与孤儿重复,也防再犯。

## 1. 改动清单(`scripts/flywheel-cmux-sync.sh` + `scripts/test-cmux-sync.sh`,不碰其他文件)

### Fix A — 身份渲染固定 UTC/C:同文件**两处**同型病灶(根因 A;R1-1 收窄 + R3-2 补全)

**A-2a `_process_incarnation`(`:6126`)** — `ps` 调用改为
`TZ=UTC LC_ALL=C ps -o lstart= -p <pid>`(lease incarnation)。

**A-2b `tmux_server_generation`(`:3246-3260`;R3-2)** — 同型裸 `ps -o lstart=` 构造
`socket|pid|started`,该值**持久化**进 view-construction WAL 与 keeper inventory;跨时区后
同一存活 tmux server 渲染成不同 generation,`recover_view_construction`(`:3525-3551`)会把
live WAL 误判 stale 而 GC(其注释前提「旧 generation 的 tmux session 不可能仍存活」此时为假)。
同样固定 `TZ=UTC LC_ALL=C`,并配兼容策略(R4-1:**绝不自动迁移**):
- 恢复侧保守化:旧格式 mismatch(generation 不等、无法用 timezone-invariant 的独立内核身份
  证明是同一进程)一律**原字节 preserve + block/WARN —— 不迁移、不 stale-GC、不授权任何
  mutation**。socket path 与 PID 都可复用、探活只证明「当前 PID 活着」不证明「就是写 WAL 的
  那个进程」,started 段存在的意义正是防这两段复用,不能反过来用前两段推翻它;
- 部署序列证明 WAL 为空(§4 步骤 2 的无竞态顺序),正常运行后只会产生新 UTC 格式,
  因此不需要冒险的自动迁移路径。

- **保留 `assert_or_reuse_owned_lease` 里的 `_owner_process_matches`**(R1-1):`$$` 在
  subshell/command substitution 中保持顶层 shell PID(`:6205-6211` 已有记录),继承三元组的
  子 shell 可能活得比 owner 久;`kill -0 + incarnation` 是阻止 orphan descendant 在 owner
  已死/PID 已复用后继续写 ledger 的最后一道门。渲染固定 UTC 后,该检查对时区切换天然免疫,
  事故引信消除,防线不弱化。
- `release_mutator_lease` 现状已只校验三元组,不改。
- 兼容:旧格式 lease(本地时区渲染)经 `_classify_mutator_lease_for_rebuild` 判 stale 被安全
  rebuild;部署本来就受管重启 watcher(§4),重启后 lease 全新。
- `FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE` seam 行为不变(测试用)。

### Fix B — `reconcile_workspace_titles`:strict-authority 的 stock migration(根因 B + scope 3)

新函数。对 raw 孤儿和 pre-FLY-1550 named workspace 统一建模为**显式 stock migration**,
复用 create 路径同款 `prepared → guarded mutation → readback → committed` 可恢复事务。

**B-0 源窗口 adoption gates(R2-1:roster 本身不是 authority)**
`get_tmux_agent_windows` 的 roster 只是候选枚举;每个窗口在写入任何 `prepared` receipt 之前
必须通过 create chokepoint 同款闸门:
- `v2-*` 源:`is_v2_runner_session`(exact hex32 shape + live `@flywheel_v2_session_ref`
  stamp;`:1312-1338`)—— 同形 squatter / tmux truth rc=2 → 拒绝本窗口;
- `window_source_pane_alive`(`:4798-4806`)—— dead-husk 窗口零动作;
- canonical view 的 topology proof:复用现有 strict/legacy-grouped 兼容的链路校验
  (strict:`_linked_view_matches`;legacy grouped:现有 view-session→window 归属证明),
  证明 `session + window_id + wname + live pane` 四元组当下成立 —— 不能只凭可伪造的
  attach 字符串。

**B-1 主循环**

```
reconcile_workspace_titles(tmux_windows):        # roster 由调用方传入,不二次 snapshot(R1-4)
  generation = cmux_socket_identity()            # 入口 pin;不可读 → 本轮跳过
  ws_json = get_cmux_workspaces_json()           # rc≠0 → 本轮跳过(fail-closed)
  for (session, wid, wname) in tmux_windows:
    B-0 gates 全过 || continue                   # 拒绝即零动作 + (仅异常时)WARN
    canonical_raw = build_attach_command("${VIEW_PREFIX}${wname}")   # 字节全等基准(R1-2)
    named = [w | w.title == wname && ref ~ ^workspace:[0-9]+$]
    raw   = [w | w.title == canonical_raw && ref 合法]
    if named 非空 or raw 非空:
      keep = winner(named ?: raw)                                 # B-3 全序
      # 路由 = receipt state × 当前 workspace kind(R4-2 + R5-1;冲突/重复 receipt → fail-closed)
      # authority(ledger)与完成态(两面==wname)分离:只有 keeper_ready 才许 close extras
      case (receipt_state(generation, keep.ref), kind(keep)):
        (exact committed, named) →                                 # 零 remint、零 B-2a
          surface==wname → keeper_ready 候选;surface==canonical_raw → 按 committed
          authority 走 B-2b 分支 2 guarded 补 tab;foreign/读失败/多 surface → WARN+continue,不 close
        (exact committed, raw) →                                   # ledger 说完成、现实还没:
          guarded 恢复 workspace title(同 raw 恢复序列)→ 再走 B-2b;恢复不了 → 保守拒绝+WARN
        (exact prepared, named) →
          complete_title_migration(keep.ref, wname, generation, entry=recovery)
        (exact prepared, raw) →
          走 reconcile_prepared_ledger 既有 full recovery(guarded rename-workspace + B-2b)
        (无 receipt, *) →
          authorize_stock_candidate(keep.ref, wname, generation) || continue   # B-2a 只读(R3-1)
          _ledger_upsert prepared generation keep.ref wname        # caller 铸造(R4-2)
          若 keep 来自 raw:
            cmux_call_guarded rename-workspace(最终 guard:generation 未变 + prepared
                receipt 存在 + keep.ref 当前 title == canonical_raw + surface 仍受权)
                → readback title == wname || 保留 prepared、continue
          complete_title_migration(keep.ref, wname, generation, entry=stock)
      # keeper_ready 判定(R5-1):最终 readback 同时证明 exact committed receipt
      # + workspace title==wname + 恰好 1 个 surface 且 surface.title==wname
      keeper_ready || continue
    else:
      continue                                                     # create 路径职责
    # extras 收敛(R2-3 + R5-1:keeper 必须 **ready**(非仅 committed)才许 close)
    for extra in raw \ {keep}:
      close_workspace_by_ref --guarded extra.ref "fly1605-duplicate-raw"   # B-4
```

**B-2 授权与 completion 拆成两类入口(R2-2 + R3-1)**

**B-2a `authorize_stock_candidate`(完全只读,任何 receipt 铸造之前)**:
无 receipt 的 stock(named 或 raw)必须先通过只读授权 —— 重验 B-0 gates、cmux generation
未变、精确 ref + workspace title(== wname 或 == canonical_raw)、恰好 1 个 surface、
surface.title ∈ {canonical_raw, wname}。任何一条不成立 → **零 receipt、零 mutation、
ledger 字节不变** + WARN。授权通过后才允许 `_ledger_upsert prepared`
(prepared 不是无害 bookkeeping:create 会因 current-generation receipt 而 defer
`:4847-4850`,recovery 会把它当 ownership claim —— 授权前铸造违反 fail-closed 合同)。

**B-2b `complete_title_migration(ref, wname, generation, entry)`** —— 新 sweep(entry=stock,
经 B-2a 授权 + 自建 prepared)与 `reconcile_prepared_ledger`(entry=recovery,凭既有 exact
receipt authority 直入;`:4058-4157`)**共用**,消除后者 rename-tab 无 guard、无 readback
即 commit 的既有缺口:

```
complete_title_migration(ref, wname, generation, entry):
  entry=stock: prepared receipt 已由调用方在 B-2a 授权后铸造(caller-mints 契约,R4-2:
               helper 内绝不 mint / 绝不把 committed 降回 prepared)
  entry=recovery: 凭既有 (generation, ref) exact receipt 进入
  分支 1(显式独立,不进 cmux_call_guarded —— guard 无法表达「授权成功但不执行」`:349-368`):
    surface readback == wname 且 workspace title == wname → 零 mutation,直接 commit(receipt-only)
  分支 2:cmux_call_guarded rename-tab,最终 guard 内重验(R2-2):
    - generation 未变;
    - 该 (generation, ref) 恰有唯一 prepared/committed receipt;
    - list-workspaces:ref 存在且 workspace title == wname;
    - list-pane-surfaces:恰好 1 个 surface,且 surface.title == canonical_raw
      (其他任何值/读取失败/坏 schema → 保留 + WARN,不 mutation)
  rename 后 surface readback == wname || 保留 prepared、中止(success-but-no-effect 防护)
  _ledger_upsert committed || 保留 prepared(下一拍经同一 helper 重驱,天然收敛)
```

**Fix C 措辞相应收窄**:**直接 create 序列不变**(`create_workspace_for_window` 内联步骤
零改动);共享 recovery(`reconcile_prepared_ledger` 的 tab 分支改走 helper)属于本单改动面,
不再声称"create 路径完全不动"。

**B-3 winner 全序(R2-5,确定性、不用 shell 字典序)**:
候选先过 `^workspace:[0-9]+$`;然后
current-generation exact **committed** receipt > current-generation exact **prepared**
receipt > `pinned` > `selected` > numeric ref 最小。stale-generation receipt 不参与排序
(视同无 receipt)。

**B-4 guarded close 落在既有审计 chokepoint(R2-4 + R5-1)**:
给 `close_workspace_by_ref`(`:1165-1183`)加可选 `--guarded` 严格模式:审计日志仍由该函数
统一发出;内部改经 `cmux_call_guarded`,最终 guard 重验 same generation + **keeper ready
(committed receipt + keeper 两面 readback 均 == wname)** + extra.ref 当前 title 仍 ==
canonical_raw + extra 恰 1 个 surface 且 surface.title == canonical_raw;并**传播真实 rc**
(默认旧模式行为字节不变)。拿不到授权或 close rc≠0 → 保留 + WARN。

**挂载点**(R1-4;bootstrap 为 R8 新增):
- `sync_additive`:在 `refresh_linked_sessions` 成功(及 WAL blocked-set 建立)**之后**、
  missing-create 循环**之前**调用,传入已捕获 roster;refresh 失败 → 本拍跳过 reconcile。
- `sync_once`(`--once`):同位置显式调用(独立函数,不会自动覆盖)。
- **R8 新增(超出 R7 合同、显式标注)**`sync_additive_bootstrap`:同位置也挂载 —— bootstrap
  同持 watcher lease、同有 refresh → reconcile → missing-create 插入序,收益是部署重启当场
  刷新(不必等首个 60s 拍);配套 T17(refresh inconclusive → 零 title mutation;位置严格在
  WAL recovery 后 / missing-create 前;复用调用方 roster;首个 additive 拍再跑幂等)。

**其余要点**:
- 归属判定 = 与 `canonical_raw` **字节全等**(内嵌完整 view session 名,`FLY-160` 不可能
  误吃 `FLY-1605`);不全等(如 mufasa 的 `~` bare-shell surface)→ 保留 + WARN
  (attach 断裂是 FLY-169 职责,改名会掩盖死 surface)。
- 幂等:两面先读后写;第二拍必须零 mutation(测试断言)。
- **已命名重复 workspace(named>1)不在本 sweep close**:strict 模式现有 title-dedup 明确
  no-op(`:1220-1225`),真实边界 = 保留 + WARN,并在部署验收中列为显式人工处置项(R2-5)。
- 负载(R4-3 + R5-2 + R6-1,按安全调用链逐步列账后取值;读单位 =
  list-workspaces / list-pane-surfaces / socket_identity 各计 1;
  **同一 guard 边界内**可共用一次快照,**跨 receipt/mutation 边界**必须新读):
  - sweep 级每拍固定:1× list-workspaces + 1× socket_identity(产出 ready **candidate**,
    不充当 final readback;真正的 close 授权由 close guard 自己重验);
  - **稳态(committed+named,surface 已 == wname,无 extras)≤3**
    (surface 读 1 + guard 末尾 generation re-pin 1 + 富余 1;零 mutation);
  - **named stock/prepared 迁移 ≤10**
    (B-2a 3 + tab-rename guard 3 + post-rename readback 1 + keeper-ready proof 3);
  - **raw stock/恢复迁移 ≤14**(另含 rename-workspace guard 3 + workspace readback 1);
  - **guarded close 每 extra ≤5**(≥4 是安全下限:合帐 list-workspaces 1 +
    keeper surface 1 + extra surface 1 + generation re-pin 1,+ 富余 1)。
  每个多 IPC guard 末尾必须 generation re-pin。测试 shim 双向断言:
  (a) 不超上限;(b) 每个不可合并边界确实发生了**新**读取(防实现偷复用旧观察)。
  上限保守但不迫使跨安全边界复用;函数头注释写明(FLY-1601 教训)。

## 2. 测试(TDD;**并入 `scripts/test-cmux-sync.sh`**,R1-5:CI 显式列举该文件,无 glob 发现)

/bin/bash 3.2 闸不变;不新建测试文件、不改 CI:

| # | 用例 | 变异判据(去掉修复 → 红) |
|---|---|---|
| T1 | lease TZ 正例:hermetic `ps` shim,acquire 前后切 ambient TZ(shim 按 TZ 变输出),内部固定 UTC 后 `_ledger_transaction` 仍成功 | 还原 A-2 → 红 |
| T1b | lease 负例:`PROCESS_INCARNATION_OVERRIDE` X→Y(真实 identity drift)→ 拒绝 | 删 `_owner_process_matches` → 红 |
| T2 | lease 负例:owner 文件第三方改写(nonce 不同)→ 拒绝 | 删三元组判定 → 红 |
| T3 | `_process_incarnation` 在 TZ=Asia/Tokyo 与 TZ=America/Denver 输出全等(hermetic shim) | 还原 A-2 → 红 |
| T4 | named + surface==canonical_raw → helper 走 prepared→guarded rename-tab→readback→committed;显式 `--workspace` | 删 rename-tab → 红 |
| T4b | named + surface 是其他命令/他人 attach → 零 mutation + WARN + **ledger 字节不变**(R3-1) | 三态回归成 `!=` / 授权前铸 prepared → 红 |
| T4c | named 两面已好但无 receipt → 先过 B-2a 授权,再 receipt-only migration(零 cmux mutation,补 committed 行)(R2-3/R3-1) | 删 receipt-only 分支 / 删授权前置 → 红 |
| T4d | raw workspace title==canonical_raw 但 surface 为 foreign command → 零 receipt、零 mutation(R3-1) | 删 B-2a 的 surface 授权 → 红 |
| T5 | 无 named、2 raw → winner full migration;extra 经 `close_workspace_by_ref --guarded` 关闭 | 删 adopt → 红 |
| T5b | winner 全序:pinned > selected;`workspace:99` vs `workspace:100` numeric;stale-generation receipt 不算 receipt(R2-5) | 换 lexical sort / 计入 stale receipt → 红 |
| T5c | **named+raw 混合**(生产实态:人工 rename 后遗留 raw)→ keeper committed 后同槽 raw extras 被 guarded close;第二拍零 mutation(R2-3) | named 分支 continue 跳过 extras → 红 |
| T6 | 幂等:T4/T5/T5c 场景第二拍零 cmux mutation + **ledger 字节不变**(R4-2) | 去掉先读后写 / 第二拍重铸 receipt → 红 |
| T6b | 入口路由:健康 committed named keeper → 零 remint 零 B-2a;existing prepared keeper → entry=recovery;**committed+raw → guarded 恢复 workspace title,不直标完成;committed+foreign-surface → WARN+continue 零 close;prepared+raw → full recovery;keeper 未 ready → 零 close**(R4-2/R5-1) | 删路由 / keeper_committed 当完成态 → 红 |
| T7 | 保护:title/surface 都映射不到自家窗口(含 founder 同名私人 workspace、surface 指向别处)→ 零 mutation | 松匹配 → 红 |
| T8 | 前缀:`FLY-160-x` 与 `FLY-1605-x` 并存 → 各自 canonical_raw 全等,互不误吃 | 子串匹配 → 红 |
| T9 | 事务:prepared 写失败 / rename-workspace readback 失败 / rename-tab rc=0 但 readback 不变(success-but-no-effect)/ committed 失败 → 各停正确位置、本轮零 close、prepared 保留;下一拍经共享 helper 收敛(R2-2) | 删 readback/prepared 前置 → 红 |
| T10 | authority:每笔 mutation 的最终 guard 时 generation flip / ref title drift / **surface drift 成私人命令** → 零 mutation(R2-2) | 删 guard 内 surface 重验 → 红 |
| T11 | close authority:keeper 未 committed → 拒 close;extra title 已变/surface 数≠1/close rc≠0 → 保留 + WARN;审计行仍由 `close_workspace_by_ref` 发出(R2-4) | 删 close 最终 guard / 旁路 chokepoint → 红 |
| T12 | list-pane rc≠0 / 坏 JSON / surface 数≠1 → 该 workspace 零 mutation + WARN | 删 schema 门 → 红 |
| T13 | B-0 gates:v2 同形无 stamp squatter / tmux truth rc=2 / dead-husk / view 指向错误 window → 零 receipt、零 mutation(R2-1) | 删 B-0 → 红 |
| T14 | recovery 共享:`reconcile_prepared_ledger` 驱动的 prepared 行,guard 时 generation/ref 漂移 → 保留 + WARN;正常路径补 readback 后才 commit(R2-2) | recovery 不走 helper → 红 |
| T15 | `tmux_server_generation` 在 ambient TZ 切换前后输出恒等(hermetic ps shim)(R3-2) | 还原 A-2b → 红 |
| T16 | 旧格式 WAL 行(本地时区 started)+ `socket|pid` 相等 + server 探活存活 → **原字节 preserve + block,不迁移不 GC 不授权**(R3-2/R4-1) | 删恢复侧保守化 → 红 |
| T16b | 对照:同 socket+PID、真实 restart/PID-reuse fixture → 同样 preserve/block,绝不进入 recovery mutation(R4-1) | 加自动迁移 → 红 |
| T17 | bootstrap 挂载(R8 新增):refresh inconclusive → 零 title mutation;位置在 WAL recovery 后 / missing-create 前;复用调用方 roster;bootstrap 刷完后首个 additive 拍幂等 | 删 bootstrap 挂载测试 → 红 |

既有回归:`/bin/bash scripts/test-cmux-sync.sh` 旧用例全绿(直接 create 序列未动);
全仓 gate:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + CI 显式列举的 shell 测试逐个 `/bin/bash <file>`。

## 3. 边界(不做)

- 不动 FLY-1596 legacy grouped → A1 迁移(topology proof 只**读**现有链路证明,不迁移)。
- 不改 cmux 本体;不动 tmux session/view-session 命名。
- 不碰 FLY-1602(Lead 身份 lease)—— 同型不同体。
- named>1(已命名重复):保留 + WARN + 部署验收中列为人工处置项;不新增 close 决策点。
- bare-shell surface(`~`)不改名(FLY-169 职责)。
- lease 自断言语义(`_owner_process_matches` 在内)不弱化(R1-1)。

## 4. 部署与当场刷新(scope 3;R1-6:不硬编码 PID)

1. merge 后生产 `git pull`(watcher 经 `~/.flywheel/bin/flywheel-cmux-sync` symlink 指主仓)。
2. **受管重启 watcher(无竞态精确序列,R4-1)**:
   ① 重读并核验 lease owner(PID + incarnation + command,不用写死 PID)→
   ② `bootout` + 等旧 writer **真退出**(此后无人再写 WAL)→
   ③ 核查 view-construction WAL:为空 → ④;非空且能安全收敛 → 收敛后 ④;
     非空且不能安全收敛 → **中止部署,人工处理**(绝不在旧 watcher 活着时"等静默"越过)→
   ④ `bootstrap` 起新 watcher。
   现有 installer(`flywheel-cmux-install.sh:143-155`)bootout→wait 后立即 bootstrap,
   无检查窗口 —— 需要加可在 wait 后暂停/检查的受管入口,或用等价分步 launchctl 流程。
   兜底:恢复侧保守化(A-2b)保证即使漏查,旧格式行也只会 preserve + block,不会被误 GC。
3. 重启后新 lease 为 UTC/C 渲染;第一个 additive 拍(≤60s)reconcile 自动完成存量刷新
   (补 Lead tab 名、adopt raw 孤儿、close 多余 raw 重复)。
4. 验收(行为面,以**当时**受管 tmux 窗口集合逐项证明;今日 16/6 只是基线数字):
   - `cmux --json list-workspaces`:每个通过 B-0 gates 的受管窗口恰有一个 title==窗口名的
     workspace、零 canonical raw title;**named>1 或 preserve+WARN 项逐条列出并人工处置**(R2-5);
   - 抽样(≥1 Lead + ≥2 design)surface title == 窗口名;session JSON `panels[].customTitle` 一致;
   - 侧栏截屏对照 founder 原图;
   - watcher log 连续 2 个 additive 拍:零 `Creating workspace` 循环、零 `ledger upsert refused`;
   - 新 lease owner incarnation 为 UTC/C 渲染且 `_owner_process_matches` 通过。

## 5. 风险

| 风险 | 处置 |
|---|---|
| watcher 重启窗口内事件堆积 | 既有事件文件 + additive sweep 兜底,与历次 watcher 重启相同 |
| reconcile 改错对象(ref reuse / 同名私人 workspace / reopen 竞态 / squatter) | B-0 adoption gates + 入口 pin generation + 每笔 mutation 最终 guard 重验(generation/ref/title/**surface**)+ 字节全等 canonical_raw + T7/T8/T10/T13 |
| adoption 中途崩溃留下半迁移状态 | prepared-first 事务;共享 helper 让 sweep 与 recovery 同一收敛语义(T9/T14);任何失败本轮零 close |
| 改 `reconcile_prepared_ledger` 波及 create 恢复路径 | helper 语义 = 原路径 + guard/readback 收紧;直接 create 序列零改动;旧用例回归全绿兜底 |
| lease 防线弱化被质疑 | 不弱化:`_owner_process_matches` 保留(T1b);仅渲染环境固定 UTC/C(T1/T3) |
| 时钟阶跃(NTP)残余 | 渲染固定后仅剩阶跃恰跨校验瞬间的窄窗,行为=现状;超出本单范围 |
| session JSON 持久化滞后 | 验收以 CLI readback 为准,JSON 为辅(spike 实测 ~5s 内落盘) |
