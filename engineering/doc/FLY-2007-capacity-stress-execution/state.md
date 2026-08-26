# FLY-2007 执行状态 —— 续接文件（**restart / compact 之后先读这一份**）

Issue: FLY-2007 (https://linear.app/geoforge3d/issue/FLY-2007/容量压测执行-fly-1986-方案落地执行阶段-0-基线-1-标定-2-可转移性-3-生产标定产出-runner-放行阈值)
日期: 2026-08-25（写于 08-24 21:0x PT）
基于: spec-baseline.md（冻结）、spec-amendments.md（冻结后裁决）、conclusions-phase0.md（报告）

> ⚠ 写这份文件是因为 context 到了 98%，明天三个窗口还有十几个小时。
> **先落盘、再压缩** —— 这份文件是计划的唯一权威副本。

---

## 1. 已确立的主结论（不要重新推导，直接用）

> **基线不可刻画** —— 不是「达标」也不是「不达标」，而是**被测服务在一个测量窗口的时长内，会被它自己的 `EventLoopGuard` 存活看门狗周期性 SIGKILL**，因此「`b` 是多少」这个问法还不成立。

**证据位置**：`conclusions-phase0.md` §3；原始证据在 `evidence/prior-2026-08-24-evening/`（含 README）。

**关键数**（已核实，可直接引用）：
| 事实 | 值 |
|---|---|
| 冻结设计要求被测对象身份不变 | **2.5 小时** |
| 08-24 晚一个 Bridge 实例实际存活 | **61 分钟**（15:47 → 16:48） |
| 当晚 `load1` 峰值 | **61.38**（15 分钟均值 34.28） |
| 当晚三次采集尝试 | **两次**直接死于自杀式重启 |

⚠ **可证伪**：出现一个 Bridge 连续存活 ≥2.5 小时 **且**窗口干净跑完的观测，这条结论就该改口。

⚠ **报告里不给 `b` 的任何点估计**（Tadashi 2026-08-24 裁定）。原始数字留在 evidence 的 README 里，**不要**搬进结论页。

---

## 2. 明天三窗的完整执行方案

### 2.0 ⚠ 前置：开窗前必须先报机器状态给 Lead

**这是硬前置，不是礼貌。** 开第一窗之前跑：

```bash
uptime | sed 's/.*load/load/'
python3 -c "
import json,urllib.request
from datetime import datetime,timezone
h=json.loads(urllib.request.urlopen('http://localhost:9876/health',timeout=120).read())
st=h['liveness']['bridge_started_at']
print('Bridge uptime: %.1f h'%((datetime.now(timezone.utc)-datetime.fromisoformat(st.replace('Z','+00:00'))).total_seconds()/3600))"
```

把 **load + Bridge uptime** 经 `flywheel-comm ask --lead flywheel-eng-lead --exec-id db7ee0c2-d16d-43ad-9083-ded597dffb5e` 报给 Lead，**由他判断要不要先等**。

### 2.0b 采集环境记录（08-25 开窗前的已知事实）

| 事实 | 值（08-25 08:18 PT 实测） |
|---|---|
| `load1` | **17.18**（5 分 11.32 / 15 分 10.29）—— 比 08-24 晚峰值 61.38 低一个量级 |
| Bridge uptime | **8.3 小时**，build `5a8fe51bf` —— 是昨晚那个 61 分钟实例的 8 倍，**首次明显超过 2.5 小时窗口需求** |
| deployed vs origin | `5a8fe51bf` **落后** ⇒ **12:00 PT 班车会部署并重启** |
| 班车将部署的 build | main tip 在 15:15-15:20Z 又合入三单，现为 **`6978e2ee9`**（Tadashi 告知） |

⚠ **12:30 开窗前必须再报一次机器状态** —— 班车会把 uptime 清零，`8.3 小时`这个数届时作废。
⚠ 「≥1 窗在 restart 后 >4h」由**第三窗（17:50）**满足（离约 12:06 的重启 5.7 小时）。

### 2.1 时间与命令

区间：**12:00 班车之后 → 00:00 班车之前**（选白天是为生产代表性，Lead 已批）。
窗口：**12:30-15:00 / 15:10-17:40 / 17:50-20:20**（每窗 30 块 × 300 秒 = 2.5 小时，间隔 10 分钟）。

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-2007
nohup bash scripts/qa-fly-2007-phase0-run-all.sh > /dev/null 2>&1 & disown
```

- ⚠ **必须 `nohup` + `disown`** —— harness 曾在半途 kill 掉后台任务（见 §4）。
- evidence 根默认 `engineering/doc/FLY-2007-capacity-stress-execution/evidence/phase0/`（现在是**空的**，已备好）。
- **唯一该盯的日志**：`evidence/run-logs/chain.log`；每窗自己的在 `evidence/run-logs/window-N.log`。

### 2.2 每窗采什么

L1 = `GET /health`（截止 500ms，2 秒栅格，150 tick/块）；L2 = `GET /api/sessions`（截止 2s，3 秒栅格，100 tick/块）。**J = 30 块/窗**。

### 2.3 判据（**冻结，不许改**）

- 判据 = 阈值-计数**精确二项**界；权威结局集 **{A, U}**（N 已证不可达，见 spec-amendments §1）。
- **A** 需要一个窗里 **≥16/30 区块 >0.20**（或 ≥24/30 >0.10）。08-24 之前的观测最坏只有 8/30 ⇒ 预期落 **U**。
- 分析命令（**三窗齐了之后**）：
  ```bash
  node scripts/qa-fly-2007-phase0-analyze.mjs \
    --evidence engineering/doc/FLY-2007-capacity-stress-execution/evidence/phase0 \
    --freeze-commit $(git rev-parse HEAD) \
    --out engineering/doc/FLY-2007-capacity-stress-execution/evidence/final
  ```
  （`--repo-root` 已删除；冻结根从分析器自身路径推导。跑一次约 20 秒 + 模拟。）

### 2.4 失败怎么记（**不许改判、不许洗掉**）

- 服务/宿主类原因（`collector_guard_abort` / `health_unreachable` / `signal` / 意外重启 / `timer_late` 超限）⇒ **不可重跑替换**（Tadashi 裁决 (A)）⇒ 该轮不可认证。
- **失败的 attempt 留在 ledger 里，不删不改名不搬走** —— 它们**本身就是主结论的证据**。
- ⚠ **不要**为了让数据算数而把失败重新归类。宽松读法对执行者有利，正是预注册要防的。
- 三窗若再次跑不完：**照 §1 的主结论定稿**，失败 attempt 进证据链。

---

## 3. 还没做完的事

- [ ] **明天开窗前报机器状态给 Lead**（§2.0，硬前置）
- [ ] 跑三窗（§2.1）
- [ ] 三窗齐 ⇒ 跑分析（§2.3）⇒ 填 `conclusions-phase0.md` §6（曝光缺口 + 已采区块）与 §7（下一步）
- [ ] 三窗跑不完 ⇒ 直接按 §1 定稿
- [ ] `conclusions-phase0.md` §5.2 已写好环境事实；§8 已写好评审留痕
- [ ] **开 PR**，然后 `flywheel-comm complete --route needs_review --pr <NUMBER>`
- [ ] PR body 要写明：主结论、FLY-1995 为前置依赖、以及 §5 的全部限定（未跑 A/A ⇒ 观察者效应未排除；B 结构性不可达；参数集门无拒绝域；A1 被命名不被假设）

---

## 4. 今晚踩过的坑（**每一条都可能再犯**）

### 4.1 ⚠ 监控看错文件 = 永远绿（代价：3.5 小时空转）

我的监控盯 `chain.log` 和 `r1/r2/r3.log`，而链实际写 `chain2.log` 和 `n1/n2.log`。
**`chain.log` 至今 0 字节** ⇒ 终止信号永远等不到 ⇒ 链 16:54 就死了，我一直以为它在跑。

**正确做法（已固化进 `qa-fly-2007-phase0-run-all.sh`）**：
- runner 与 watcher **从同一个变量**推导**同一个** canonical 路径。两个名字指同一件事，就是上面那次的成因。
- **唯一该盯**：`evidence/run-logs/chain.log`（不是 `chain2.log`，不是 scratchpad 里的 `n*.log`）。
- **监控启动时先断言目标文件存在且在增长**，否则监控自己就是个不会变红的检查。

### 4.2 ⚠ 「没有坏消息」被当成「好消息」—— 今天犯了五次

| # | 现象 | 真相 |
|---|---|---|
| 1 | `npx biome check` 报 clean | `npx biome` 解析到一个**假包**（0.3.3，不是 linter）。真的是 `pnpm exec biome`（2.1.4） |
| 2 | 等待循环永不触发 | `[ "$a" \> "$b" ]` 在这个 shell 里**报错**而不是比较 |
| 3 | 后台任务 exit 0 ⇒ 以为窗口在跑 | 相对路径找不到脚本；那个 0 来自末尾的 `echo` |
| 4 | 监控一直绿 | 见 §4.1 |
| 5 | 「dry run」启动了真采集 | `${WINDOWS:-1 2 3}` 把**空字符串**当未设置。要用 `${WINDOWS-...}` |

⇒ **通则：验产物，不验返回码。** 每窗开跑后用 **attempt 目录 + block 输出行数** 自证一次。
⇒ `run-all.sh` 已内建：拒绝相信「completed 但 block 行数 < 30」的窗口。

### 4.3 其它

- `git mv` 对已释放的 `owner` 文件会失败并中断整条命令 —— 用普通 `mv` + `git add -A`。
- 相对路径的 `mkdir -p` 在 cwd 漂移时会造出嵌套的 `evidence/engineering/doc/...` 空树。**用绝对路径。**
- Bridge 重启期间 `/health` 是 **connection refused（0.6ms）**，与「服务已死」外观相同。**别只凭一次 refused 下结论**，看 `lsof`（不带 `-sTCP:LISTEN` 过滤）与进程启动时间。

---

## 5. 环境事实：CI 全仓红（**不是本单造成的，不要去修**）

Tadashi 2026-08-25 告知：**今天 03:25 之后全仓 CI 都红**，形态是 job 拿不到执行器（0 step、无执行器名），**疑似账号 Actions 额度耗尽**，已上报 founder。

⇒ 出 PR 时 CI 可能不绿。**如实记录即可，不要去改 CI 配置。**

---

## 6. 关键坐标（省得重新找）

| 项 | 值 |
|---|---|
| worktree | `/Users/xiaorongli/Dev/flywheel-FLY-2007`，分支 `flywheel-FLY-2007` |
| exec-id | `db7ee0c2-d16d-43ad-9083-ded597dffb5e` |
| 冻结 commit（spec 自此零字节改动） | `5ce14e9dee5eaa404fca7f3d7cdf250c08e5d3e1` |
| 测试 | `bash scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh`（94/94，约 35 秒） |
| Lead | `flywheel-comm ask --lead flywheel-eng-lead --exec-id db7ee0c2-...` |
| 评审留痕 | `codex-design-review-r{1..14}.md`（⚠ R13 是收窄只读框架，**不可与 R5–R12 同等分量引用**） |
