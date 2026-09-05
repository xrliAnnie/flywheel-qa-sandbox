# FLY-2146 记忆远端真同步 — 实施计划补遗（二）
Issue: FLY-2146 (https://linear.app/geoforge3d/issue/FLY-2146/2132a2-记忆定时真同步以远端上有没有为准-连续多日新鲜度验证)
日期: 2026-09-04
基于: design-correction.md

## 1. 权威与适用范围

本文件记录 Lead 对 exact-blob R6 新 HIGH `lockf-hardcoded-not-available-on-ci-linux` 的增量治理裁定。实施与复审必须同时读:

1. 锁定的 `plan.md` blob `83cbd495a7602a7d8dd1a29940961dcfb2fd1075`;
2. `design-correction.md`;
3. 本补遗。

本补遗只替换 `design-correction.md` 的单一 `lockf` 实现、60 秒双边等待、C6.1 两文件发布闭包和未归一的后端退出码。其他修正与原计划继续生效。本文件提交后按不可变 addendum 处理;后续不回写已锁定的 `plan.md`。

## 2. 可移植的共享 writer 内核锁

### 2.1 唯一锁文件与持有模式

- 锁文件仍固定为 `<lead-memory-repo>/.git/flywheel-writer.lock`,0600,必须是普通非符号链接文件。
- 取锁者先在当前 shell 打开一个保留 FD,然后在该 FD 上取 advisory lock;整个 fetch/rebase/add/commit/push 写序列结束后才关 FD。
- 锁文件从不 unlink/recreate;文件存在不表示锁仍被占用。
- 不使用 mkdir/PID 锁做 writer 互斥。进程退出、SIGKILL 或 FD 关闭后,锁必须由内核立即释放。C3 arrival state 自身的短时 mkdir/PID 锁不在此替换范围。

### 2.2 后端选择

按 `scripts/lib/qa-slot-bridge.sh` 的已有模式固定三级选择:

1. `lockf`:当 `command -v lockf` 成功时,对保留 FD 运行 `lockf -s -t 0 <fd>`;
2. `flock`:否则当 `command -v flock` 成功时,对同一 FD 运行 `flock -n <fd>`;
3. `python`:否则当 `python3 -c 'import fcntl'` 成功时,对继承的同一 FD 运行 `fcntl.flock(fd, LOCK_EX | LOCK_NB)`。

三者都不可用才是 fail-closed preflight 6。三个后端都必须是真实内核 advisory lock;不得以假成功命令、空断言或 skip 取代。选择函数无环境变量 bypass;测试需要直达某后端时,使用执行一次的常量替换副本或直接调用后端函数。

### 2.3 有界等待与持锁上限

- `sync.sh` 取锁最多等待 `SYNC_LOCK_WAIT_SECONDS=60`;到期且始终 busy 归一为 75,不做 Git mutation/远端 Git 操作,下一小时重试。
- `sync.sh` 取锁后的整个 Git 写序列必须由一个脚本内部 deadline 硬封顶为 `SYNC_LOCK_HOLD_MAX_SECONDS=600`;这是四段 120s 远端上限合计 480s 之上的全流程上限,不让 hook/本地 Git 无限占锁。deadline 终止走原有 INT/TERM 恢复与 receipt 路径,不向外泄漏 124/70 等后端码。
- `write-memory.sh` 的总等待/重试预算固定为 `LEAD_WRITE_LOCK_WAIT_SECONDS=660`,不小于 sync 的 600s 最坏持锁上限。预算内按 1s 间隔重试真实非阻塞取锁。
- 普通 writer 660s 后仍 busy 则返回已归一的可重试 75,明确输出 `deferred`;不 add/reset/删除本地记忆。未送内容留在原位,由下次 Lead hook/手工调用或下一轮 sync 重试,不伪装成已到远端。

## 3. 退出码归一与真值表

`lockf`/`flock`/Python 只在脚本**内部**对保留 FD 做非阻塞 claim,不包裹整个 `sync.sh`或 `write-memory.sh`进程。后端原始状态立即归一:

| 内部结果 | 脚本外部结果 |
|---|---|
| claim 成功 | 继续业务流程;最终码由原有业务真值表决定 |
| 后端 busy (`lockf` 75,`flock` 1,Python `BlockingIOError`) | 继续有界重试;预算耗尽才返回 75 |
| 无后端、不安全锁路径、open/chmod/后端其他错误 (`lockf` 64/70/71/73 等) | preflight 6;sync 仍按原合同尝试写证据,证据写失败则 9 |
| sync/ordinary writer 收到 INT/TERM | 脚本 trap 释放 FD;对外仍是 130/143,不被 `lockf` 70 覆盖 |

`sync.sh` 的 manifest 最终 `allowed_exit_codes` 仍是 `0,2,3,4,5,7,75`;看者仍是 `0`。6/8/9 与 130/143 仍为故意的异常。不把任何后端原始 sysexits 新增到 manifest。

## 4. `write-memory.sh` 三文件发布闭包

`write-memory.sh` 不仅进入 `sync-template.sh` 与 A1 exact-surface/first-import 合同,还必须进入 C6.1 的真实远端发布:

- `sync-template.sh` 必须对安装后的 `write-memory.sh` 执行 `chmod 755`;
- C6.1 `TOP` 集合增加 `write-memory.sh`;
- 步骤 4 的 porcelain 必须恰好三行:`README.md`、`.github/workflows/remote-observe.yml`、`write-memory.sh`;
- 步骤 5 只显式 add 这三个路径,NUL-safe 的 staged 集合也必须恰好三条;
- 步骤 6 的 admin 提交与 `git show --stat` 必须只含这三个路径;
- 发布后另外比对远端 `write-memory.sh` blob == 模板 blob,并断言 mode 可执行;
- 新机 fresh clone 必须同时含 README 所指的可执行 `./write-memory.sh`。

`first-import.sh` 是一次性已消费的 A1 路径;其测试 fixture 必须体现新 exact surface,但 acceptance 要明记当前生产根提交早于 `remote-observe.yml` 和 `write-memory.sh`,二者是 C6.1 的后续 admin 发布,不宣称它们已在历史根提交。

## 5. 必须先红的真实锁测试

1. Ubuntu `script-tests-5` 在真实 `flock` 后端上运行 `design-correction.md` §3.4 四条并发/mutation-control 断言;不许 skip,并断言实际选中 `flock`。
2. 阶段一 macOS 本机在真实 `lockf` 后端上重跑同一套四条断言,并记录实际选中 `lockf`。
3. Python `fcntl` 后端用真实继承 FD 另跑互斥+SIGKILL 后重获取断言;只可选择直达该真实后端,不得 mock 内核结果。
4. 删掉 `commit --only` 时,外部已 staged 的夹 A 必须搭便进入夹 B 提交,使 mutation control 真红。
5. 超时对照使 sync 持锁跨过短测试预算,证明 ordinary writer 在预算内不交错;释放后取锁成功。再使其跨过 ordinary writer 缩短后的总预算,断言得到 75/deferred、本地文件与既有 staged 集合都不变。
6. 后端原始 busy/运行错误的表驱动断言必须证明只有归一的 75/6 出现;从外部向 writer 发 INT/TERM 必须仍看到 130/143。

## 6. 下游指针与复审门

- C7 更新 founder HTML 时,必须明示链接 `design-correction.md` 与本补遗,并反映两次修正引入的共享 writer 锁、`write-memory.sh`、第五 CI 分片、structural 第五账、专用冻结标记与补跑口径。
- implementation report 与 milestone 必须同时引用 pinned plan blob、`design-correction.md` 和本补遗;不得声称已修改 pinned plan。
- 测试与 acceptance 要记录 Ubuntu/flock、macOS/lockf 和 Python/fcntl 的真实后端证据,以及 600s/660s 生产常量与缩短副本的时间比例。
- 本补遗提交后,对同一 `plan.md` blob 开新 exact-blob review,请求中必须点名两份补充文件。只重提 R6 的 `lockf-hardcoded-not-available-on-ci-linux`、`write-memory-not-in-publish-closure`、`lead-write-60s-timeout-below-writer-hold-time`、`lockf-exit-status-not-mapped-into-truth-table` 或 plan/addendum 指针 key,按 Lead 裁定视为已处置;出现新 HIGH correctness/security/data-loss 才再停实施并交 Lead。
