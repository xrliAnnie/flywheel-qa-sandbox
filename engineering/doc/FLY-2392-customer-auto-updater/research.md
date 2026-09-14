# FLY-2392 客户自动更新器 + 止血 — 调研

Issue: FLY-2392 (https://linear.app/geoforge3d/issue/FLY-2392/1143b5-客户自动更新器-止血定时更新器查-customer-release-装-即时失败回滚单飞-central)
日期: 2026-09-13
基于: exploration.md

> **一句话**:逐条核实 exploration 选中方案(A1/B1/C1/D1/E/F/G/H)所依赖的真实机制,折入 Lead 对 Q1–Q5 的裁定,产出 plan 能直接引用的精确改动点、账本 schema、时序规则与测试基座。

---

## 0. Lead 裁定记录(question `4b157705-7d65-46a5-877c-f7f649287527`,2026-09-13)

| # | 裁定 | 折入位置 |
|---|---|---|
| Q1 | 自动检查间隔默认 6h,可配 | §3.1 时序模型 |
| Q2 | v1 盲重启可接受,**两个条件**:① 默认更新时窗 = 可配置的低活动小时(默认本地 03:00);② 文档明写为 v1 已知缺口,「Bridge 空闲判定」作为 follow-up | §3.1 时窗规则;plan 诚实边界 + follow-up |
| Q3 | 采用 D1:在 `transitions.mjs` **一处**把 `expire` 对「channel=release 且已过保留期」的 entry 开放给 `customer-release` capability,配测试;不等每小时 cleanup | §1.1 |
| Q4 | `auto-update on|off|status` 进 v1 | §3.5 |
| Q5 | 客户端用推断标签 `withdrawn_observed`;`/v2/manifest` 状态字段留 follow-up | §3.3 |

---

## 1. 服务端 / 流水线机制核实

### 1.1 capability 表与 expire 守卫(D1 的精确落点)

- `applyTransition` 把 `status` 变化分类为 op:`active→quarantined` → `{type:"quarantine", ver}`;`→expired` → `{type:"expire", ver, fromStatus}`(`packages/payload-endpoint/src/transitions.mjs:82-95`)。**expire op 目前不带 `channel`**。
- 期限守卫在服务端时钟上(`transitions.mjs:281-300`):expire 被拒的三种情况 = 仍是某指针 latest / 无 lifecycle 钟(`retentionSince`/`quarantinedAt` 为 null)/ 窗口未满(`now - clock < RETENTION_WINDOW_MS[channel]`)。**这一守卫对任何 capability 都生效**,所以放开 capability 不会让 `customer-release` 提前 expire 任何东西。
- `capabilityAllows`(`transitions.mjs:306-335`):`expire|tombstone` → 仅 `ops-admin|cleanup`;`quarantine` → `RELEASE_CAPABILITY`;`pointer` → `POINTER_CAPABILITY[channel]`。
- **D1 改动(一处)**:① 分类时给 expire op 加 `channel: nu.channel`;② `case "expire"` 增加分支 `capability === RELEASE_CAPABILITY && op.channel === "release"`。`tombstone` 不放开。测试:customer-release token 对已过期 release entry expire → 200;对未过期 → 422(守卫);对 beta entry → 403;对 tombstone → 403。
- re-pin 守卫(`transitions.mjs:256-265`):非 latest 的 entry 若 `retentionSince + window <= now` 则拒绝重新成为 latest(`re-pin refused — retention deadline passed`)。**这与 expire 守卫用同一不等式**,所以「不能 re-pin」⇔「可以 expire」,两者互斥且覆盖全部 active 非 latest release entry。这是 withdraw 三情况能在同一 CAS 内确定收口的数学基础。

### 1.2 C-1b 与 paused

`validator.mjs:266-285`:`latest===null` 时若存在 `channel===expected ∧ status==="active"` 的 entry 即 C-1b 违规。因此 withdraw 写 `latest=null` 前,同一 CAS 必须让**所有** release entry 的 status 都非 active:被撤版 → quarantined;其余 active(必然是已过期的,否则会被选为 fallback)→ expired。若存在「仍在保留期但不是 fallback」的 active entry,说明 fallback 派生有 bug,mutate 抛错零写。

### 1.3 withdraw mutate 的三情况(D1 定稿;v2 按 Codex R1#1/#7 修订)

`casUpdate(mutate)`(`scripts/release/lib/endpoint-client.mjs:73-107`):每次重试重读 manifest 并重跑 `mutate(copy, current)`;返回 `false` = 幂等零写;抛错 = fail-closed;最多 8 次。**fallback 派生必须在 mutate 内做**,这样并发漂移后会重判。

**服务端时间是唯一权威**(R1#1):re-pin / expire 守卫都用 endpoint 注入的 `now()`(`transitions.mjs:256-265,281-300`),runner 的 `Date.now()` 与之可能相差任意值(CI 机器、拨钟测试壳)。因此:
- `GET /admin/manifest` 增加响应头 `x-fw-server-time: <canonical ISO>`(取自 handler 的 `requestStartedAt`,`handler.mjs:136,267-278`;只在 admin 路由,customer wire 不变)。
- `readManifest({requireServerTime})`:头存在则严格解析(`isIso`)返回 `serverNowMs`;**只有 `requireServerTime:true` 时缺失/非法才抛错**(R2#7:`endpoint-client.mjs` 被 release / promote / cleanup 共用,不能让整个控制面锁步);`casUpdate(mutate, describe, {requireServerTime, timeGuardRetries})` 把选项透传,mutate 签名扩为 `mutate(copy, current, {serverNowMs})`。withdraw 是唯一 `requireServerTime:true` 的调用方;其它调用方行为不变。现有 fixture/proxy(`endpoint-client-etag.test.mjs:49-65,90-116` 的无头响应;`payload-release-pipeline.test.sh:546-557,793-798` 只转发 ETag/content-type 的 proxy)保持可用,C2 同时让 proxy 透传该头以便 W4 走真链。
- **GET→POST 时间边界**(R2#1):GET 时刻在 deadline−ε、POST 在 deadline 后且无 412 时,服务端在 POST 内用新的 `now()` 拒绝 re-pin(422 `re-pin refused — retention deadline passed`)或拒绝 expire(422 `expire refused — retention window not elapsed`,反向偏差)。`casUpdate` 对这两条**时间守卫 422**(按 violations 逐字匹配)在 `timeGuardRetries`(withdraw 取 3)内重读(拿新 `serverNowMs`)→ 重跑 mutate → 重 POST;其它 422 仍立即抛错。显式 fallback 的 mutate 遇到 fallback 落出 C 会自己抛错(exact-fail),不进入重试。W3j:无 412、GET 后 POST 前拨钟跨线 → 第二次派生选 paused/expired,终态确定。

```
输入: --withdraw <ver> [--fallback <ver>] [--allow-pause]
      (--fallback 与 --allow-pause 互斥 → 用法错误;都不给 = auto)
mutate(m, cur, {serverNowMs}):
  e = m.versions[ver];不存在 → 抛错
  ── 终态重放判定先于 active 校验(R1#7:goal-idempotency) ──
  若 e.status === "quarantined":
     显式 fallback: latest === fallback → return false(idempotent);否则抛错(exact binding,与现有 W2 同)
     auto / allow-pause: return false,结果报告 outcome="idempotent" 与当前 latest(可为 null);不推断原调用形状
  ── 首次撤版 ──
  e.channel==="release" ∧ e.status==="active" ∧ latest===ver 否则抛错(与现有校验同)
  C = { v : channel=release ∧ status=active ∧ v≠ver ∧ (retentionSince===null ∨ retentionSince+28d > serverNowMs) }
  X = { v : channel=release ∧ status=active ∧ v≠ver ∧ v∉C }   // 服务端视角已过期、不可 re-pin 者
  显式 fallback: fallback ∉ C → 抛错「not re-pinnable (expired or not an active release)」零写
  auto: fallback = argmax_{v∈C}(retentionSince, publishedAt)(最近离开指针者;并列取发布晚者);C 为空 → fallback=null
  若 fallback 非 null:
     e.status="quarantined"; latest=fallback; return true      // X 不动,留给 cleanup
  若 fallback 为 null:
     未给 --allow-pause → 抛错「no re-pinnable previous-good; rerun with --allow-pause」零写
     e.status="quarantined"; latest=null; ∀v∈X: status="expired"; return true
```
- 输出 `{action:"withdraw", withdrawn, fallback:<ver>|null, latest:<ver>|null, outcome:"withdrawn"|"paused"|"idempotent", expired:[…]}`。
- 服务端对 `X` 的 expire 与对 fallback 的 re-pin 仍过守卫(§1.1):GET 与 POST 之间跨过 deadline 时,守卫 422 触发上面的有界重派生;重试耗尽仍 422 → 抛错零写(fail-closed,不会写坏)。
- workflow 输入:`fallback-version` 改为可选(空 = auto);新增 `allow-pause`(boolean,默认 false)。Guards:withdraw 时 `fallback-version` 非空则必须匹配 `CLEAN_SEMVER_RE` 且 ≠ withdraw;`allow-pause=true` 与非空 `fallback-version` 并存 → 拒;非 withdraw 动作 `allow-pause` 必须为 false。**S13 锁定输入集**(`scripts/__tests__/release-workflows-structure.test.sh:332-336`)需同步加 `allow-pause`。
- 现有 W2/W2d(`payload-promote-controls.test.mjs:339-420`)继续成立(显式 fallback 语义不变;唯一变化是「过期 fallback」错误文案)。新增 W3a(auto 选最近离开指针者)、W3b(过期者不入选 → paused + expired 列表)、W3c(首版即坏 → paused)、W3d(无 allow-pause 零写)、W3e(并发漂移重判)、W3f(auto 重放 idempotent 报当前 latest)、W3g(paused 重放 idempotent)、W3h(runner 时钟 ±30 天不改变结果)、W3i(412 重试期间服务端拨钟跨 deadline → 第二次 mutate 改选 paused)、W3j(无 412、GET 后 POST 前拨钟跨线 → 时间守卫 422 → 重派生 → paused/expired 终态;重试耗尽 → 零写非零退出)。harness:`startEndpoint(seed)` + `invoke(endpoint, args)` + `rawManifest(bucket)`;过期场景用 `startEndpoint` 的可注入时钟(controls 测试自建 handler,`makeDeps({clock})`)而非改本机时间。

### 1.4 客户 wire、503 与客户端映射改动点

- 服务端 `/manifest`:401 → 503 `not activated`(无 manifest)→ 503 `download unavailable`(manifest 非法)→ 503 `no-release-available`(paused)/`not activated`(never-activated)→ 200(`handler.mjs:151-175`)。所有客户响应 `Cache-Control: private, no-store`。
- 客户端 `fetchManifest`(`packages/onboard-shell/lib/endpoint.mjs:42-43`)把非 2xx 非 401/403 一律 `EndpointError("network")`。改动:503 时读 body,`{"error":"no-release-available"}` → kind `paused`;`not activated` → kind `notActivated`;其它 503/5xx → 仍 `network`(服务端故障,重试建议正确)。`messageFor`(`lib/onboard.mjs:29-37`)增两条文案。
- `downloadPayload` 404 → `network`(`endpoint.mjs:103`)。`install <ver>` 先查 `versions[]` 命中再下载,不撞 404;若命中后仍 404(竞态:刚被撤)→ 映射为 `notAvailable`。
- wire 冻结(`CONTRACT.md:250`):本 issue 零 wire 改动。

### 1.5 key 签发对 paused 的前置检查

`scripts/release/license-key.mjs:81-94` + `handler.mjs:583-593`:paused 时拒发新 key(409)。已持 key 的新客户机首装会拿到 503 `no-release-available` → 本 issue 让其变成诚实可重试文案(PRD §8.2-2「新安装收到诚实可重试错误」)。

---

## 2. 客户侧机制核实

### 2.1 安装 / 翻转 / 重启 / 回滚复用点

| 复用 | 出处 | 注意 |
|---|---|---|
| `installVersion(cfg, ver, tarball)` | `lib/install.mjs:95-130` | 失败时 `rmSync(prefix)` **删整个版本目录**。若目标目录已存在(降级回本地仍在的 previous-good),直接重装失败会毁掉回滚槽 ⇒ 规则:目录存在且 `verifyPkgRoot` 通过 → **复用不下载**;存在但不通过 → 先删再装 |
| `flipCurrent` / `atomicSymlink` | `install.mjs:68-82,136-139` | 原样复用 |
| `restartServices(pkgRoot)` | `lib/update.mjs:22-33` → `scripts/packaged/restart-packaged-services.sh` | 90s `/health` 门;U3/Q2 测试用夹具脚本 exit 1 注入失败(`onboard-shell-rotation.test.sh:44-50,89`) |
| 回滚块 | `update.mjs:101-152` | 抽成 `applyVersion(cfg, {ver, pkgRoot, fromPkgRoot})` 供 update / rollback / install<ver> 共用;语义不变(残留清理 + 翻回 + 重启;无旧版则删 `current`) |
| `verifyPkgRoot` | `install.mjs:51-62` | previous-good 派生时重验目录 |
| `stripKeyFromEnv` | `lib/key.mjs:137-141` | 所有新命令 spawn 子进程前调用 |

### 2.2 锁(单飞;v5 按 Codex R1#6 / R2#4 / R3#3 / R4 新 HIGH 修订)

**结论**:文件系统 rename/mkdir 协议在 POSIX 上没有「比较并删除」,任何 stale 回收 + 用户态 fence 都是 check→use(R4 新 HIGH 成立)。v5 改用**内核维持的独占锁**,不再有 stale、回收、fencing 三个概念。

**darwin(v1 唯一客户平台)= `open(2)` 的 `O_EXLOCK`(flock 语义)**,本机实测(node v25.6.1,`scratchpad/lockprobe.mjs`):
- Node 未导出 `fs.constants.O_EXLOCK`;darwin 数值 `0x20`(`<sys/fcntl.h>`),`fs.openSync(lockPath, O_RDWR|O_CREAT|0x20|O_NONBLOCK, 0o644)` 原样传给 `open(2)`。
- 已被其它进程持有 → `EAGAIN`(立即返回,不阻塞)→ 退出码 75。
- 持有者正常退出、`process.exit`、**SIGKILL** 都由内核自动释放;不存在 dead-pid stale 态。
- 锁 fd 是 CLOEXEC(libuv 默认):npm / bash restart seam / handoff 子进程不继承,子进程内再 open 同文件仍 `EAGAIN`。
- 唯一风险:锁文件被 unlink 后,新开者创建新 inode 并成功取锁。对策:锁文件 `<stateDir>/update.lock` **永不删除**;取锁后 `fstat(fd).ino === stat(lockPath).ino` 不等 → 释放重试一次,仍不等 → 75。**诚实措辞**(R5 follow-up):该比对只覆盖本次 open→stat 之间的替换,检测不到比对之后的 unlink;安全性前提是持锁期间无人 unlink,文档写明「更新进行中不要删除 update.lock」。
- 持有:整个命令期间保持 fd 打开;`runOnboard` 在 handoff(exec Buddy 引导)**之前**释放(handoff 不改 current;不让 Buddy 会话期间阻塞定时器)。
- 释放 = `closeSync(fd)`;进程异常也由内核兜底。
- 不需要 owner.json、token、pid 检查、`ps` 检视、宽限期、rename 回收、`assertOwned()`。

**非 darwin(linux;v1 非客户平台,systemd 路径只渲染不验机)**:mkdir 锁 `update.lock.d/owner.json{pid,created}`,**不自动回收**:pid 存活 → 75;pid 死亡 → 75 并打印「上次更新异常退出,请删除 update.lock.d 后重试」(人工命令)/ 日志一行(unattended)。没有回收就没有 ABA;代价是 linux 上崩溃后自动更新停摆直到人工处理——诚实边界。

- 拿不到锁:退出码 **75**;**只向 `<stateDir>/logs/auto-update.log` 追加一行**,绝不写 `update-ledger.json`。
- 纳入同一锁的命令(统一前置 `mutatorPreflight`,plan §3.0):无参 `install`(`runOnboard`)、`license set`(自己先 preflight,把锁上下文传给续跑的 `runOnboard`)、`update`、`rollback`、`install <ver>`、`auto-update on`。
- 测试(darwin):真实双进程竞争(一个 75 一个成功);持有者 SIGKILL 后下一进程立即取锁;子进程不继承 fd(child `fstat(fd)` EBADF)且子进程再 open 同文件 EAGAIN;unlink 后 inode 不等 → 拒绝;锁失败不写账本。非 darwin:pid 活 → 75;pid 死 → 75 + 文案,目录不动。CI(ubuntu)只能跑非 darwin 分支;darwin 分支由本机套件与 QA 节点在 macOS 上跑(`ci.yml` 的 macOS job 若存在则登记,否则记为 QA 手动证据)。

### 2.3 supervisor / bootstrap / packaged 清单

- timer spec 字段:`{name, kind:"timer", exec, intervalSeconds?|schedule[{hour,minute}]?, stdout?}`;darwin 渲染 `StartCalendarInterval`(schedule)或 `StartInterval`(`scripts/lib/supervisor.sh:195-247`),linux `OnCalendar`/`OnUnitActiveSec`(`:110-123`,二选一,interval 优先)。**两平台都支持 `schedule[]`**,本设计只用 `schedule`,不用 interval。
- `exec` 按空白切词(`:206-209`)→ wrapper 路径不得含空格;`$HOME` 含空格的机器不支持(记边界;bootstrap 已有同限制)。
- label `com.flywheel.<name>`(`:169`);名字定为 **`auto-update`** → `com.flywheel.auto-update`,与 founder 机 `com.flywheel.updater` 不撞。
- 动词只有 `start|stop|restart|status|is_loaded|trigger`(`:270-275,297-322`),**无 uninstall**;darwin `stop` = `launchctl bootout`,但 plist 仍在 `~/Library/LaunchAgents`,下次登录会自动重载。⇒ `auto-update off` = 写 marker `<stateDir>/auto-update.off` + `supervisor_stop auto-update timer`;wrapper 与 `--unattended` 都先看 marker(双保险);`on` = 删 marker + 重装 spec + `trigger` 一次。
- `bootstrap-services.sh`:`emit_specs()`(`:114-134`)加 `auto-update` spec;`install_bin()`(`:94-112`)加 `packaged/flywheel-auto-update.sh` 到 `<stateDir>/bin`;新增 `--only <name>` 过滤(只装匹配的 spec,跳过 host.json / Lead 物化),供薄壳在成功 update/install 后调用 `bootstrap-services.sh --only auto-update`(旧 payload 无此 flag → `die unknown arg` → 薄壳记 `timerInstall:"unsupported-payload"`,不算失败)。
- packaged 文件清单 `scripts/package-onboard.sh:125-145`(`PO_SCRIPT_FILES`)需加 `packaged/flywheel-auto-update.sh`;packaged 结构测试(`packaged-seams.test.sh` 等)可能锁文件集,实现时同步。
- `restart-packaged-services.sh` 只重启 `bridge` + `lead-*`,**不碰 timer**(`:47-56`);更新不需要重装 timer,只在 spec 内容变化时(schedule 改)由 `auto-update on` / config 变更重装。

### 2.4 薄壳固定副本(A1;v2 按 Codex R1#10 修订)

- `@flywheel-ai/onboard` 零 `dependencies`(`packages/onboard-shell/package.json`),`files=[bin,lib,README.md]`。自身包目录 = `path.resolve(fileURLToPath(import.meta.url), "../..")`,`shellVer` 读自身 `package.json`。
- crash-safe 拷贝:`cpSync` 到同目录唯一临时目录 `shell/versions/.tmp-<ver>-<pid>-<ms>` → 校验(`package.json` 版本一致、`bin/flywheel-onboard.js` 存在、`lib/*.mjs` 集合与源目录一致)→ `rename` 为 `shell/versions/<ver>`(已存在目标先校验:通过则跳过;不通过则 rename 到 `.trash-…` 后替换)→ `atomicSymlink` 切 `shell/current` → 清理陈旧 `.tmp-*`/`.trash-*`。保留最近 2 个版本目录。**触发时机**(R2#6):每次人工 `install`/`update` 结束时**无论结果**(updated / up_to_date / held / paused)都刷新(同版本已存在且校验通过则跳过);`auto-update on` 在装 timer 之前先刷新并验证 `shell/current/bin/flywheel-onboard.js` 存在可读,否则不装 timer、marker 保留。
- wrapper `flywheel-auto-update.sh`:扩 PATH(与 `flywheel-bridge-wrapper.sh:54` 同串)→ marker 检查 → `command -v node` 失败则写日志退出 0 → `exec node "$STATE/shell/current/bin/flywheel-onboard.js" update --unattended >> "$STATE/logs/auto-update.log" 2>&1`。packaged 路径**不装** log-janitor(`bootstrap-services.sh` 的 `emit_specs` 只有 bridge / daily-standup / lead-*;`grep janitor scripts/packaged/` 零命中)→ wrapper 自行把日志截断到 256KB(保留尾部)。

### 2.5 时序模型(Q1/Q2 折入)

- 配置文件 `<stateDir>/auto-update.json`(0644,可缺省):`{ "schemaVersion":1, "checkEveryHours":6, "applyHour":3, "applyGraceHours":2 }`。校验:`checkEveryHours ∈ {1,2,3,4,6,8,12,24}`(整除 24,保证每天有一个 tick 落在 applyHour),`applyHour ∈ [0,23]`,`applyGraceHours ∈ [1,6]`。非法 → 忽略文件用默认并在 `status` 里报「配置无效已用默认」。
- spec `schedule` = 从 `applyHour` 起每 `checkEveryHours` 一个整点:默认 `[03:00, 09:00, 15:00, 21:00]`。
- 每次 tick:拿锁 → 读 ledger → `GET /manifest` → 判定:
  1. paused → `outcome=paused`,零动作;
  2. `latest === current` → `up_to_date`(并清理 `pendingVersion`);
  3. `latest ∈ holds`(且 hold 未到可重试条件)→ `held`;
  4. **current ∉ versions[]**(被撤/已过期不可见)→ 记 `holds[current]=withdrawn_observed`,**立即应用**(止血优先于时窗;PRD §8.2「阻止再升」+「触发客户 rollback」);
  5. 否则为普通升级:本地小时 ∈ `[applyHour, applyHour+applyGraceHours)` → 应用;否则 `deferred`,记 `pendingVersion=latest, nextApplyAt`。
- 人工 `update`(非 `--unattended`)忽略时窗(客户主动)。
- launchd `StartCalendarInterval` 在睡眠期间错过的触发会在唤醒时合并触发一次;若唤醒时刻已出 grace 窗,则记 `deferred` 到次日。写入诚实边界。

### 2.6 本地账本 `update-ledger.json`(B1 定稿;v2 按 Codex R1#2/#3/#4 修订)

```json
{
  "schemaVersion": 1,
  "knownGood": [ {"ver":"1.54.0","at":"…","origin":"outgoing"}, {"ver":"1.55.0","at":"…","origin":"health"} ],
  "holds": { "1.56.0": {"reason":"health_failed","at":"…","attempts":1,"lastAttemptId":"<applying.startedAt>"} },
  "pendingVersion": "1.57.0",
  "applying": { "operation":"update|rollback|install_version", "ver":"1.57.0", "fromVer":"1.55.0", "fromPkgRoot":"…", "targetCreated":true, "phase":"installing|flipped|recovering", "holdOutgoingReason":"manual_rollback"|null, "clearHoldOnVer":"1.57.0"|null, "startedAt":"…", "trigger":"timer|manual" },
  "lastRun": {"at":"…","trigger":"timer|manual","outcome":"…","latest":"1.57.0","detail":"…"},
  "runs": [ /* 最近 30 条 lastRun 形状 */ ]
}
```
- 0644、tmp+rename、永不含 key。
- **三态读取**(R1#2):`missing`(文件不存在 → 初始化为空账本)/ `valid` / `corrupt`(JSON 解析失败、`schemaVersion≠1`、字段形状不符)。`corrupt` 时:保留原文件不动;`status` 报「更新记录损坏,请把这条信息发给我们」;**所有会改 current 的命令**——无参 `install`(含 `installedComplete` 快路径与 `license set` 续跑)/ `update`(含 unattended)/ `rollback` / `install <ver>`——在**任何网络请求、下载、flip、restart、handoff 之前**退出 1(fail-closed),不猜测结算(R2#5)。
- 写失败:`--unattended` 与人工命令一律算 error 且不进入 apply(账本是 hold 与 `applying` 的唯一真相)。
- `knownGood` 有界 10 条,两种来源:`health`(本进程 health gate 通过)与 `outgoing`(R1#4:一次成功 apply 时,离开的 `fromVer` 若非 null 且不在 holds,先以 `outgoing` 追加——它刚才正在运行,是可回退证据)。首装 `runOnboard` 无 health gate,不写 knownGood;首次成功 update A→B 后 knownGood=[A(outgoing), B(health)],A 目录保留,`rollback` 有目标。存量机(无账本)同理。
- previous-good 派生 = `knownGood` 逆序第一个满足 `ver ≠ current ∧ versions/<ver> 存在 ∧ verifyPkgRoot 通过 ∧ ver ∉ holds` 的;rollback 仍经 restart/health 复验。
- `applying` 带 `phase` 与 `targetCreated`(R1#3/#5);`phase="flipped"` 在 **flip 之前**持久化为意图(R2#2);**成功意图也在最初写入**:`operation`、`holdOutgoingReason`、`clearHoldOnVer`(R3#1),结算时只从这条耐久记录调用 `commitApplySuccess`,字段非法/未知 operation → 视为 corrupt(fail-closed)。结算按 current 实际指向分支(plan §3.3)。
- hold 语义:

| reason | 写入时机 | 何时不再阻止 |
|---|---|---|
| `health_failed` | 新版 restart/health 失败(update / install<ver> / rollback 目标);**在开始翻回之前先持久化**(R1#3);`attempts` 递增绑定 `applying.startedAt` 作为 attempt id(`lastAttemptId`),同一 attempt 的结算重放**不再递增**(R4#1) | `attempts < 2` 且距上次 ≥ 1h → 允许再试一次;≥2 → 直到指针换版或显式 `install <ver>` |
| `manual_rollback` | `rollback` 的 `applyVersion` 成功事务**同一原子写**中(`applying.holdOutgoingReason="manual_rollback"`,R2#3/R3#1),不是事后第二次写 | 指针换版或显式 `install X` |
| `withdrawn_observed` | tick 发现 current 不可见 | 永不需要清(clean semver 不复用;expired 不可 re-pin) |

- 目录修剪:**只在成功 apply 的账本 commit 之后**运行;`versions/` 保留 current + previous-good(派生值);其余删除;账本 corrupt 或派生失败 → 不修剪。

### 2.7 CLI 面(Q4 折入)

| 命令 | 行为 | 退出码 |
|---|---|---|
| `update [--unattended]` | 现有语义 + 锁 + 账本 + 时窗(仅 unattended)+ hold + 不可见推断 + 修剪 + 刷新壳副本 + `bootstrap --only auto-update`(仅非 unattended 成功后) | 0 成功/无事;1 失败;75 锁 |
| `rollback` | 目标 = previous-good;无目标 → 诚实文案退出 1;应用(翻 + 重启 + 90s 门);失败翻回原版并重启,报 degraded 语义;成功记 `holds[from]=manual_rollback` | 0/1/75 |
| `install <ver>` | 校验 `isSafeVersion`;取 manifest;`ver ∉ versions[]` → 文案「该版本不可安装(已撤回或已超出保留期)」退 1;本地目录可复用则不下载;应用;成功清 `holds[ver]`,记 knownGood | 0/1/75 |
| `auto-update status` | 打印:开关状态、下次检查时刻(从 schedule 算)、`lastRun`、`pendingVersion`、holds 摘要、current/previous-good | 0 |
| `auto-update on|off` | marker + supervisor 动作(经 `current` payload 的 `bootstrap-services.sh --only auto-update` / `supervisor_stop`) | 0/1 |
| 无参 / `license set` | 不变 | — |

`MSG` 新增:`paused`、`notActivated`、`versionNotAvailable`、`rollbackNone`、`rollbackDone`、`rollbackFailedRestored`、`heldSkip`、`deferred`、`autoUpdateOn/Off/Status*`。全部中文平话,不带路径。

---

## 3. 测试基座核实

| 需要 | 已有 | 用法 |
|---|---|---|
| 真端点 + 持久桶 | `packages/payload-endpoint/src/serve-node.mjs`(FsBucket,stream) | `customer-e2e-acceptance.test.sh:79-96` 的 `start_server` |
| 可拨钟的真 handler | `packages/payload-endpoint/__tests__/serve.mjs` admin 模式(`FW_TEST_*_TOKEN`,`SERVE_SEED_MANIFEST`,`SERVE_SEED_KEY`,`POST /__test__/clock {iso}`) | 「previous-good 已过期」场景 |
| 真发布脚本 | `payload-release.mjs` / `payload-promote.mjs prepare|commit|withdraw` / `license-key.mjs issue` | E2E 已用 |
| 可控失败的 payload | fake packer(`customer-e2e-acceptance.test.sh:52-78`)产出 `restart-packaged-services.sh`;改为读 `$FLYWHEEL_STATE_DIR/fail-restart.<ver>` marker 决定 exit 1 | 失败即时回滚场景 |
| 第二个 release | fixture repo 再提交一次(bump `doc/VERSION` → v9.9.10)→ 新 beta → prepare/commit | 「有 previous-good」场景 |
| 薄壳夹具 | `onboard-shell-rotation.test.sh` 的 `mk_payload <ver> <healthy>` | 单元级 rollback / install<ver> / hold |
| CI 挂点 | `ci.yml:809-816`(薄壳套件)与 `:1464`(全链 E2E);`payload-distribution` job 跑 `scripts/__tests__/*.test.mjs` 与 controls | 新套件登记处 |
| 结构锁 | S13 输入集(`release-workflows-structure.test.sh:332-336`);consumers-lint `SCAN_ROOTS` 不含 `packages/onboard-shell`(`consumers-lint.test.mjs:8-11`) | 加 `allow-pause`;薄壳不写 channel 字面量,不必扩 lint |

三情况 + quarantine 客户端验收映射(全部真端点 + 真脚本 + npm-pack 装壳):

| PRD 情况 | 场景 | 断言 |
|---|---|---|
| 有 previous-good | 9.9.9 → 9.9.10 commit;客户 tick 升到 9.9.10;withdraw 9.9.10(auto)→ 指针回 9.9.9;客户 tick:current 不可见 → 立即降回 9.9.9(本地目录复用,零下载)且 `holds["9.9.10"].reason=withdrawn_observed`;再 tick `held/up_to_date`,不再升 | 目录、symlink、ledger、服务端 manifest |
| previous-good 已过期 | serve.mjs 拨钟 +30d 后 withdraw 9.9.10 → `outcome=paused`,9.9.9 `expired`,`latest=null`;客户 tick → `paused`,current 不变;新客户机首装 → 文案「发布方暂停了更新…」退 1,目录干净 | 同上 + 503 body |
| 首个 release 就坏 | 只 commit 9.9.9;客户 update(fail-restart marker)→ `degraded`,`holds["9.9.9"]=health_failed`,`current` 不悬空;withdraw 9.9.9 `--allow-pause` → paused | 同上 |
| 更新成功 / 失败即时回滚 | 9.9.9 健康 → 9.9.10 fail marker → 翻回 9.9.9 并重启,`holds["9.9.10"].attempts=1`;第二 tick 再试(attempts=2)仍败 → 硬 hold;第三 tick `held` 零动作 | ledger attempts、restart 调用计数(marker 计数文件) |

---

## 4. 风险与未决(进 plan 风险表)

1. **launchd 睡眠合并**:错过的 03:00 触发在唤醒时合并触发,若已出 grace 窗则顺延一天;客户机长期夜间关机的话,普通升级最长顺延到其开机的第一个窗内 tick。文档明写。
2. **时窗 + 6h 间隔的错配**:`checkEveryHours` 必须整除 24 且 schedule 从 `applyHour` 起算,否则可能没有 tick 落在窗内;配置校验强制。
3. **壳副本陈旧**:timer 永远跑本地副本;壳只在人工 `npx` 时刷新。薄壳变更极少(§7.3-4),接受;`status` 显示副本版本。
4. **`installVersion` 复用已有目录**:必须先 `verifyPkgRoot` 再复用;不能重装进已有 prefix(失败会删槽)。
5. **wire 无理由字段**:`withdrawn_observed` 与「28 天没开机后 supersede 版过期」同形;行为一致(换到 latest),只是标签不区分。已在 Q5 裁定。
6. **Bridge 空闲判定缺失**(Lead Q2 条件②):v1 已知缺口,follow-up 议题「auto-update 前探 Bridge 在飞 session 数」。
7. **`$HOME` 含空格**:supervisor `exec` 切词限制,与既有 bootstrap 相同边界。
8. **D1 放开 expire**:仅 release channel 且服务端守卫已过期;beta expire 仍归 ops-admin/cleanup。需 Codex 关注 capability 表变更。
9. **打包闭包三处强制同步**(Codex R1#9):新 payload 脚本要进 `scripts/package-onboard-files.allow`(`:80-82` 附近)且在 `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md` 有处置行(`package-onboard.test.sh:419-434` X1 断言);薄壳新 `lib/*.mjs` 要进 `onboard-shell-publish-gate.test.sh:57-89` 的精确文件集,否则 G2 红。
