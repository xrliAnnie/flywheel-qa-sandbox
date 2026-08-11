# FLY-1671 独立重启器手动触发入口 — 探索

Issue: FLY-1671 (https://linear.app/geoforge3d/issue/FLY-1671/fix-给既有的独立重启器comflywheelupdater-fly-270加一个手动触发入口)
日期: 2026-08-11
基于: 无

## 1. 问题与方向(founder 两次修正后的最终口径)

**结构性矛盾**:只要全量重启由舰队内的某个 Lead 发起,发起者就必然要保护自己(否则执行到一半自杀、重启中断)。2026-08-10 的实测:Lead 手跑 `restart-services.sh`,14/15 生产 Lead 拿到新本体,唯独发起者 flywheel-eng-lead 的本体停留在两天前 —— 而重启报告写「15/15 成功」,完全看不出来。

**founder 第一次修正**:这不是补偿层面的问题,是架构问题 —— 发起者应该站在被重启集合之外。

**founder 第二次修正**:独立重启器**已经存在**(`com.flywheel.updater` launchd 任务 + `scripts/update-flywheel.sh`,FLY-270),不建新的。本单收窄为:**给它加一个「手动全量重启」触发入口**。

最终 scope(4 点):
1. 手动全量重启 = 往既有队列 enqueue 一个标记 + nudge updater
2. updater 收到 → 跑既有 `restart-services.sh`(updater 自己不在被重启集合 ⇒ 无需豁免任何 Lead)
3. Lead 侧纪律:今后统一重启改为 enqueue + 告知 founder;紧急手动兜底保留
4. **报告口径修正仍是最低要求**:「被接管未换本体」必须在报告里可见

红线:不许用「执行者自杀」解决;报告口径修正即使补偿不做也必须做。

验收:由 updater 发起一次全量重启,15/15 全部拿到新本体(含原发起 Lead),无任何豁免。

## 2. 既有能力审计(先查原生再建 —— 本单的教训入档项)

逐文件核对了现役代码(非 issue 描述转述):

### 2.1 `scripts/com.flywheel.updater.plist`(launchd 任务,不属于任何 Lead)
- `QueueDirectories` 监听 `~/.flywheel/self-ship-pending.d` —— 目录非空就拉起/保持 updater 运行(durable at-least-once)
- `StartCalendarInterval` 00:00 / 12:00 定时兜底 sweep
- `ProgramArguments` 指向**主仓固定路径** `~/Dev/flywheel/scripts/update-flywheel.sh` ⇒ 新代码 merge + 主仓 pull 后,updater 下次触发自动跑新脚本,**无需重装 plist**

### 2.2 `scripts/update-flywheel.sh`(updater 本体)
- 主循环:`ssq_sweep_invalid` → pending>0 且 due>0 → `process_due_markers`;pending==0 → `fallback_sweep`
- **承重事实 A**:`process_due_markers` **无条件先跑 deploy**(`default_deploy` = clean-checkout preflight → fetch → pull --ff-only → `FLYWHEEL_RESTART_FOREGROUND=1 restart-services.sh`),再逐 marker 判 satisfied → ack。即:**只要有一个 due marker,全量重启一定执行,不管有没有新代码**
- **承重事实 B**:`fallback_sweep` 只在 head/remote/deployed 有 drift 时才 deploy,无 drift 时 `nothing to do` —— 所以「裸 kickstart updater」**不能**当手动重启入口
- singleton lock(`ssq_lock_acquire`)保证同刻只有一个 updater 在跑;新 enqueue 的 marker 会被在跑实例的 rescan 循环(≤60s)接住
- 失败分类:transient(网络)退避重试;deterministic(脏 checkout / build / Lead 波次失败)5 次后 block + `severe_alert` 直达 founder

### 2.3 `scripts/self-ship-restart.sh`(既有入队机制)
- `--target-sha <40hex> [--pr n] [--issue X] [--dry-run]`:enqueue durable marker + `launchctl kickstart`(无 `-k`)nudge
- fail-close 已内建:updater 未 loaded → 拒绝(rc 69);kickstart 失败(job disabled)→ 拒绝(rc 69),不许假报成功
- marker 形状(`ssq_enqueue`,schemaVersion 2):`{targetSha, prNumber, issueIdentifier, attempts, nextAttemptAt, lastErrorClass, createdAt}`;校验只要求 targetSha 40-hex + 数值字段合法

### 2.4 `scripts/restart-services.sh`(被复用的重启执行体)
- **承重事实 C**(line 921-922):`DEPLOYED_SHA == CURRENT_HEAD` 时「skipping build, **continuing full restart**」—— 纯重启(无新代码)完整走通
- updater 是 launchd 任务 `com.flywheel.updater`,**不在** restart-services.sh 的重启对象(Bridge + Leads + cmux watcher)之内 ⇒ 天然满足「发起者在集合外」
- `FLYWHEEL_RESTART_FOREGROUND=1` 时不 self-detach,在 updater 进程内同步跑完(现役 self-ship 路径即如此)

### 2.5 核心洞察:updater 发起全量重启**已是生产反复验证的路径**
每次 self-ship(Runner merge 后 enqueue)与每次定时兜底 sweep,都是 updater 调 `restart-services.sh` 完成全量重启。**唯一缺口**是:没有新 merge 时,没有任何入口能往队列里放一个 marker。本单 = 补这个入口,几乎零新机制。

## 3. 候选方案

### 方案 A(选定):复用既有 marker 形状,target = origin/main 当前 SHA
新增薄入口脚本(工作名 `scripts/request-restart.sh`):fetch origin main → `rev-parse origin/main` 得 40-hex SHA → 调既有 `self-ship-restart.sh --target-sha <sha> --issue manual-restart` 完成 enqueue + nudge。

链路:marker 落盘 → QueueDirectories 拉起 updater → `process_due_markers` 无条件 deploy(承重事实 A)→ `restart-services.sh` 全量重启(无新代码也重启,承重事实 C)→ target 是 deployed 的 ancestor → marker ack 清除。

- 零 schema 变化、零 updater 改动、fail-close 全继承
- 语义要向 founder 讲清:**手动重启 = 收敛部署 origin/main + 全量重启**(若 origin/main 恰有未部署代码,会顺带部署 —— 这是收敛语义,不是副作用)

### 方案 B(拒绝):新 marker 类型(kind=manual-restart,无 targetSha)
`ssq_marker_is_valid` 硬性要求 40-hex targetSha,无 targetSha 的 marker 会被 `ssq_sweep_invalid` 当 corrupt 直接 quarantine。要支持新类型得改 queue lib 的校验、sweep、ack、backoff 全链 —— 改动面大、碰 FLY-270 已过多轮 codex review 的 fail-close 状态机,收益为零(方案 A 语义完全覆盖)。

### 方案 C(拒绝):裸 `launchctl kickstart com.flywheel.updater`
撞承重事实 B:无 drift 时 `fallback_sweep` 直接 `nothing to do`,重启不会发生。且无 durable marker,updater 若恰在跑会被 singleton lock 挡掉后丢失意图。

## 4. 发起者豁免机制的边界(诚实说明)

「为什么 08-10 那次 14 个换了、发起者没换」的精确分叉点在 Lead supervisor(`claude-lead.sh`)的收养判据里(FLY-1659:supervisor 以 lease store 的 bound holder 证据收养健康活体)。**本单不重推导这个分叉** —— 因为修法(发起者移出被重启集合)使分叉整体消失:updater 发起时没有任何 Lead 是发起者,不存在「必须活着执行重启」的 body。验收用实测(15/15 本体启动时间)证明,不靠推导。

## 5. 报告口径(最低要求)与 FLY-1634 边界的张力

- FLY-1634(founder 已批的简化):body liveness **不参与 deploy verdict**,成功只看 supervisor tuple 回归 + Bridge health
- FLY-1671(本单):报告必须让「被接管未换本体」可见

两者不冲突的解法:报告口径修正做成**纯观测行**(informational),不进成功判定 —— 完成播报里加一行「本体: N 新建 / M 接管 / K 未知」,观测失败记「未知」,绝不把 deploy 判成失败。数据源:supervisor 在确立 body 时已有 `LEAD_BODY_PROVENANCE=adopted|launched` 变量(claude-lead.sh),落一个 breadcrumb 文件供 restart-services.sh 波次后读取(细节归 research/plan)。

## 6. 开放问题(带进 research)

1. provenance breadcrumb 的写点、文件形状、新鲜度判据(避免读到上一波的旧记录)
2. `rn_render_completion_message` 的扩展方式(15 个位置参数已经很长)
3. Lead 侧纪律落到哪份文档(restart-guard.md / bridge-ship-discipline.md)
4. updater 发起的重启在 founder 播报里如何与 Lead 手跑区分(`--reason`)
5. 入口脚本的测试 seam(既有 SELF_SHIP_* env 覆盖 + SELF_SHIP_LAUNCHCTL 注入是否够用)
