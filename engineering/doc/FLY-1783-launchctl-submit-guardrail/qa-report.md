# FLY-1783 launchctl submit 旁路补拦 — 独立 QA 报告

Issue: FLY-1783 (https://linear.app/geoforge3d/issue/FLY-1783/infraguardrail-补拦-launchctl-submit-旁路-detached-重启只许走-request-restartsh)
日期: 2026-08-15
基于: plan.md

被测 head: 332695e7029561e559720af8208af02318dfe8c2（PR #850，OPEN / 非 draft / MERGEABLE，local == origin == PR head）
QA 时间: 2026-08-15 02:00–02:40（本机 macOS 生产宿主）
证据目录: `/tmp/fly1783-qa`（launchd 日志、两臂对照、baseline 对照）

---

## 0. 判定

**FAIL** on 332695e7 — 两个真实缺陷，均已在实现者**未提交的在飞返工**里被修掉（QA 实测确认修复方向有效）。
核心机制（护栏拦截 + launchd ppid 拒绝 + 真 Discord 告警）在 332695e7 上**已经验证有效**，
FAIL 的原因是这两条附带行为回归，不是主机制失败。

---

## 1. 主机制：真机 E2E 全部 PASS（对 332695e7）

### 1.1 C1 护栏 — 逐条前后对照（BEFORE = origin/main，即当前生产已装版本）

| 形态 | main（现装） | 332695e7 |
|---|---|---|
| 事故逐字命令 launchctl submit -l com.flywheel.restart-bus-manual … restart-services.sh --force | ALLOW | **DENY** |
| label 规避（com.example.qa + restart-services.sh） | ALLOW | **DENY** |
| bash -c 嵌套 submit | ALLOW | **DENY** |
| submit + FLYWHEEL_RESTART_FOREGROUND=1 载荷 | ALLOW | **DENY** |
| crontab 写入 restart-services | ALLOW | **DENY** |
| pkill -f restart-services.sh（杀在飞 wave） | ALLOW | **DENY** |
| submit 指向 self-ship-restart.sh / update-flywheel.sh | ALLOW | **DENY** |

9 条正路命令（request-restart.sh、launchctl list/print、无关 submit/remove、crontab -l、git log、
test-restart-services.sh、update-flywheel.sh）两版**都** allow — 零回归。
deny 文案实测含 2026-08-14 事故引用 + request-restart.sh 指路。
护栏自带 matrix：149 passed / 0 failed。

### 1.2 C2a restart-services 的 ppid 拒绝 — 真 launchctl submit E2E（本单最关键的一段）

标尺先验：launchctl submit 起的进程实测 ppid=1（直执行形态与 exec-wrapper 形态**都**是 1，
所以 QA 用的 exec-wrapper 形态在被测属性上与事故形态等价）。

隔离（四层，任一层单独够用）：沙箱 HOME / BRIDGE_URL 指向空闲端口 19876 /
FLYWHEEL_RESTART_LOCK_WAIT_SECS 故意非法（既有 validate_restart_contract 会在拒绝检查的**下一条语句**中止）/
沙箱无告警凭据。另跑 Control A（同沙箱、普通 shell、ppid≠1）实测 exit 1 停在 validate，
证明拒绝点之前不存在任何 mutation，且闸确实起作用。

| 臂 | 结果 |
|---|---|
| **BEFORE**（origin/main 脚本，同一 launchd job） | 无任何拒绝；**4 次重拉，间隔约 10 秒**（02:10:44 / :54 / 02:11:05 / :15）= 事故的 66 连发形状被现场复现；只被 QA 兜底闸挡住（LastExitStatus 256 = exit 1） |
| **AFTER**（332695e7 脚本，同一 launchd job） | **5 次重拉全部 exit 78**（LastExitStatus 19968 = 78<<8），每次都打出 FLY-1783 四行拒绝并指向 request-restart.sh；**完全没有出现兜底闸的 validate 报错** → 说明拒绝发生在 validate 之前，是拒绝在挡，不是 QA 闸在挡 |

两臂全程：生产 Bridge PID 70681 不变、/health 200、~/.flywheel/deployed-sha mtime 不变、
launchctl 无残留 job、crontab 未动。

### 1.3 新告警调用点 — 真 Discord 投递（隔离 529 房 #test-flywheel-alerts）

跑真 alert_launchd_refusal（从被测脚本逐字抽取）→ 真 lead-alert.sh → 真 bot token → 真 Discord API：

- 第 1 次：HTTP 200 sent，频道里出现真消息（标题 restart-services refused a direct launchd invocation，deploy / deploy_failed）
- 第 2 次（同 UTC 日）：delivery receipt already sent → **日级 signature 去重生效**，频道内该 marker 消息数 = 1
- queue=0、deadletter=0；生产 claims.db / alert-queue / 生产告警频道**零触碰**（实测生产 claims.db 只有无关的 cmux_cleanup / mailbox_dead_letter 行）
- 告警投递失败时（sandbox 无 projects.json）拒绝仍是 exit 78 — 真机复现了 T1d 的断言

**N-to-N 说明（不静默跳过）**：本 diff 的 Discord 面**只有**这一条 shell 侧 alert 发送，
lead-alert.sh / alert kind / Bridge 侧零改动；没有 relay、没有 thread 标题/徽章/置顶 header/状态行渲染、
没有 founder 交互、没有 roundtable、没有跨 Lead 协作。因此没有跑双 Lead N-to-N 拓扑
（它不会触及本 diff 改的任何东西），改为在 529 隔离告警频道做了真 Discord 投递验证。

### 1.4 其余层

- C5 Lead 红线：R4 落在 founder-only-authority.md；实测 cos 与 dept 两种角色的 rule bundle **都**包含该文件；FLY-26 rules split 93/93 通过。
- 测试合同：restart-self-detach 10/10、fly1783 静态合同（含阳性对照）PASS、CI 枚举守卫 181 条全分类通过、lead-alert strict delivery 24/24。
- 仓库门：pnpm lint 0 error / 7 warning（与 main 逐字相同，本 diff 零 TS/JS/JSON 改动）；pnpm -r build 全绿。
- test-restart-services.sh：branch 126 pass / 7 fail，origin/main baseline **同样** 126 pass / 7 fail，
  **失败用例名字集合逐条相同**（不是计数对照）→ 零新增失败、零顶替。7 条是宿主基线项。
- 未跑全量 pnpm test:packages:run：本 diff 零 TS/JS 改动，且本机跑全量 vitest 会压死生产 Bridge（既有纪律）。

---

## 2. FAIL 的两条 — 都在 332695e7 上实测复现

### F1（阻断）self-detach 把「1 秒内成功完成」误判成 detach 失败

332695e7 的 C2b 顺序是先 disown 再 kill -0。子进程若在 1 秒观察窗内**正常退出（exit 0）**，
父进程读到的是「PID 不在了」，于是走 fail-loud 分支。

实测（同一 harness、同一子进程体、只换被测脚本版本）：

- 332695e7：exit_code=1，打印 "ERROR: detached restart child died within 1s … failing LOUD"，而子进程日志里明明是 "child ran ok"
- 未提交返工版：exit_code=0，打印 "Detached restart child completed within 1s with exit 0"

影响：detach 后快速正常收尾的形态（例如 lock 竞争 no-op）会被上报成硬失败并返回非零。
本单自己的 T4 用例用的是「刻意撑过 1 秒的两阶段 child」，所以**测不到**这一格。

### F2（应修）护栏把 restart-services.sh 的只读 grep/rg 硬拦了

332695e7 把 restart-services 加进 PROC_IDENT_RE（P2）后：

| 只读诊断 | main | 332695e7 | 未提交返工版 |
|---|---|---|---|
| grep -n 'kill -0' scripts/restart-services.sh | allow | **deny** | allow |
| rg 'launchctl submit' scripts/restart-services.sh | allow | **deny** | allow |
| grep -rn 'pkill' scripts/restart-services.sh | allow | **deny** | allow |
| crontab -l \| grep restart-services | allow | **deny** | allow |

影响：出重启故障时最该做的第一动作（读这个脚本）被自己的护栏挡住，
而且 deny 文案会把人往 request-restart.sh 引，与实际意图无关。
plan §6 把 out-of-matrix 误报列为「已接受类」，但这几条落在本单**自己**的排障动线上，
不是无关误报；实现者的在飞返工也确认了这一点该修。

---

## 3. 交接说明

QA 开跑时 worktree 是干净的；02:29–02:33 期间实现者在**同一个共享 worktree**里
写入了未提交的返工（护栏加 quote-aware read-segment 掩码 + _p4_hit；restart-services 改成
「先 kill -0 再 disown，退出则 wait 取真实状态」；两个测试文件与 plan 同步）。
上面所有真机 E2E 都在 02:29 之前跑完，**描述的是 332695e7**；
只有第 2 节两张对照表额外跑了返工版做对比（已逐列标注是哪个版本）。

QA 没有在仓库里写任何文件；交接时 git status 的 6 个 modified 全部是实现者的在飞返工。
复测需要新的冻结 head（committed + pushed）+ 新的 verdict attempt 凭据。

证据保留在 `/tmp/fly1783-qa`（launchd 两臂日志、baseline 对照、失败用例名字集合），
以及 QA scratchpad 的探针脚本，等 Lead / Annie 看完再清。
