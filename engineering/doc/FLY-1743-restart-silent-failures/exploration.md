# FLY-1743 重启部署两处静默失效 — 探索

Issue: FLY-1743 (https://linear.app/geoforge3d/issue/FLY-1743/bughigh-重启部署路径两处静默失效中途-abort-留源码前进产物未动无检测无告警1729-引入回滚-git-status-fail)
日期: 2026-08-13
基于: 无(上游输入 = FLY-1729 PR #816 exact-head 终审的 5 条 MEDIUM advisory 中的 2 条静默项)

## 1. 问题是什么

FLY-1729(`9ccf92ab`,已 merge)给 `scripts/restart-services.sh` 加了「全舰重启前先 fast-forward 到最新 main」的前置步。终审留下两条**静默失效**(安全不变量被破坏、但没有专门 block/alert)advisory,即本单:

- **缺陷 ①(1729 引入)**:preflight 的 `merge --ff-only` 成功后 HEAD 前进;若**后续任何一步失败中止**,留下「源码(HEAD)= 新、`dist` / `deployed-sha` = 旧」的残留状态。后续那一步自己可能响亮,但**它响的是那一步失败,没有任何东西宣告「现在源码和已部署产物不一致」这个事实**。这正是 1729 要消灭的病(「合了但跑的还是旧码」)在它自己失败路径上的复现。
- **缺陷 ②(存量)**:回滚函数 `rollback_and_restart()` 用 command substitution 取 `git status --porcelain`,**该命令自身非零时 substitution 为空** ⇒ dirty 分支不进 ⇒ 控制流继续执行破坏性的 `git reset --hard`。fail-open 紧接不可逆操作,而且只在「已经出事、正在补救」的时刻触发。

母题(issue 逐字):**响亮失败可以留,静默降级不行;新引入的静默比存量的更不可接受。**

## 2. 代码审计:失败面盘点(不当 greenfield,先 grep)

以下行号基于本分支 HEAD(含 `9ccf92ab`)的 `scripts/restart-services.sh`(2681 行)。

### 2.1 关键时序(direct-restart / detached deploy body)

```
自分离 detach(≈L1176,父进程 exit 0,无 trap)
  └─ deploy body(FLYWHEEL_RESTART_FOREGROUND=1)
     acquire_lock(L1202;L1257 装 EXIT/INT/TERM trap → restart_on_exit)
     preflight_pull_latest_main(L1284)
       ├─ fetch / topology 检查(失败 = 响亮拒绝,HEAD 未动)
       ├─ merge --ff-only(L757)★ HEAD 在这里前进
       ├─ post-merge 校验(L768 mismatch / L779 status rc / L787 dirty → return 1)
     lead_identity_registry_preflight 失败 → exit 1(L1293)
     default_lead_agent_env_converge 失败 → exit 1(L1301)
     check_discord_plugin_fork rc=2 → exit 1(L1322)
     deploy_and_verify(L2675 调用)
       ├─ RESTART_NOTICE_STARTED=true(L2317)
       ├─ stop_bridge 失败 → return 1(L2340)
       ├─ build_project 失败 → rollback_and_restart 或 return 1(L2350-2364)
       ├─ mailbox barrier / health / DBI 身份 / voice-bridge 各失败点 → return 1
       ├─ Lead wave + FLY-1573 就绪闸 → return 1(L2520-2542)
       └─ ★ deployed-sha 推进(L2548 `echo CURRENT_HEAD > DEPLOYED_SHA_FILE`)
```

**残留窗口 = L757(merge 成功)到 L2548(deployed-sha 推进)之间的一切中止路径。**

### 2.2 缺陷 ① 的三层静默程度(审计发现,比 issue 描述更细)

1. **最静默**:preflight 成功后、`deploy_and_verify` 之前的顶层 `exit 1`(registry / default-lead / fork rc=2,L1293/L1301/L1322)。此时 `RESTART_NOTICE_STARTED` 仍为 false,EXIT trap `restart_on_exit`(L433)里的 `restart-aborted-unexpectedly` 告警**整个被跳过**——trap 只清锁退出。步骤自己的 alert 说的是「existing Bridge and Leads remain untouched」之类,**没有一个字提到 HEAD 已经前进、下次谁也不知道源码和产物不一致**。
2. **次静默**:preflight 自己的 post-merge 校验失败(L768/L779/L787)。merge 已成功、HEAD 已前进,告警文案却是「No build or restart was attempted」——对,但不完整:残留状态没被点名。
3. **步骤响亮、状态静默**:`deploy_and_verify` 内的各 return 1(port-stuck / build-fail-rollback-disabled / DBI-rejected / voice-bridge / 就绪闸…)。各自 alert 响亮,但都只描述那一步;`rollback_and_restart` 被调用且**它自己也失败/被阻**时(dirty / port-stuck / no-known-good / ②的 status fail-open),同样没人宣告残留。

另注:DBI 身份拒绝路径(L2433)带 first-time marker,**重复发生时降为纯静默**(alert_warning 只发第一次)。

### 2.3 缺陷 ② 的精确形状

`rollback_and_restart()` L2219:

```bash
if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no)" ]]; then
```

`git status` 自身失败(仓库损坏、index 锁、磁盘/权限问题)⇒ substitution 为空 ⇒ `-n ""` 为假 ⇒ dirty guard 不触发 ⇒ **L2228 `git reset --hard "$rollback_sha"` 照常执行**。没有 rc 检查、没有 rollback-blocked alert、没有拒绝。

对照:**同文件 preflight 段(L779-786)已经有完全正确的写法**——`status_rc=0; output="$(GIT_OPTIONAL_LOCKS=0 git status ...)" || status_rc=$?; (( status_rc != 0 )) && 拒绝+alert`。修法就是把这个 in-file 已验证 pattern 镜像过去。

相邻发现(同属「回滚路径 fail-open 紧接破坏性操作」):L2228 的 `reset --hard` **自身失败也不被检查**——函数从条件上下文被调用,`set -e` 被抑制,失败后控制流继续跑 `pnpm install/build` + 重启服务,最后可能发「已回滚成功」的 warning,**对着未知状态的工作区撒谎**。

## 3. 方案空间

### 缺陷 ①:在哪里、以什么判据检测残留

- **A. 逐失败路径补告警**(在每个 return/exit 点加「源码已前进」文案)——**否**。issue 逐字反对:「判据应当锚在结果不变量上,不是哪一步返回了非零——后者会随代码演进漏掉新的失败路径」。§2.2 数出 10+ 个中止点,而且还在演进(1573/1726/1600 各自加过)。
- **B. EXIT trap 里做终态不变量检查(选定)**:`restart_on_exit` 是**每条**退出路径(正常 exit、`set -e` 意外中止、INT/TERM)的必经收口。在那里 fresh-read 源码 HEAD 与 `deployed-sha` 文件,不一致即 `alert_severe` + 保证非零退出码。一处检查覆盖现在和将来的所有失败路径。
- **C. 下次运行时开机检测残留**——作为主检测**否**(issue 要的是 abort 当下就响);且下次运行的 preflight 天然会收敛残留(already-at → 继续 build),不需要额外机制。

B 的关键子问题 = **何时「armed」**(何时开始要求这个不变量):

- 无条件检查(每次 exit 都比)——**否**:自分离父进程、锁竞争失败、preflight 响亮拒绝(local-ahead/diverged)这些路径 HEAD 没动、也不拥有部署事务,残留若存在也是旧账,在这里响就是每次 catch-up 部署都误报一发。
- **两点 arming(选定)**:(a) `merge --ff-only` 成功的那一刻(HEAD 突变点,覆盖 preflight 自己的 post-merge 校验失败);(b) `preflight_pull_latest_main` 整体成功返回后的调用点(事务所有权点,覆盖 already-at 修复跑:上次残留、这次没 merge 但接手了收敛义务,再失败也必须响)。dry-run 永不 arm。

### 缺陷 ②:status fail-open

只有一个正确形状:**rc 显式检查,取不到状态 = 拒绝 reset + fail-loud**,镜像同文件 L779 的既有 pattern(含 `GIT_OPTIONAL_LOCKS=0`,顺带消掉 index 乐观锁竞争这类会让新硬闸误拒的瞬时非零)。同批把 `reset --hard` 自身 rc 也包上(失败 → 拒绝继续重建/重启 + severe),否则「状态未知继续跑」这个病只是从 status 挪到了 reset。

## 4. 选定方向(一句话)

**② 让回滚在状态未知时拒绝破坏(fail-closed);① 让任何没收敛到「HEAD == deployed-sha」的部署事务在退出收口处必然响亮(终态不变量)。** ② 防止把状态弄坏,① 保证弄坏了/没修完必有人知道——两者互补成闭环。

## 5. 明确不做(honest boundary)

- 不做自动修复/自动回滚残留——只检测+响亮;修复留给下一次 deliberate 重启(preflight 天然收敛)。
- 不动 per-project `project-deployed-sha` 台账(独立账本,另一个失败面)。
- 不动 preflight 响亮拒绝路径(local-ahead/diverged/unreadable)的行为与文案——它们 HEAD 未动,是 FLY-1743 分类里「带走」的 LOUD 项。
- 预先存在的残留(本次运行 preflight 前就 HEAD ≠ deployed)在 pre-arming 退出路径上不检测(见 §3 arming 讨论)。
- 不改 `restart_on_exit` 既有的 `restart-aborted-unexpectedly` / INT 逻辑,只追加不变量检查。
