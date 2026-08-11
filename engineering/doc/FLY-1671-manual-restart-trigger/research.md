# FLY-1671 独立重启器手动触发入口 — 调研

Issue: FLY-1671 (https://linear.app/geoforge3d/issue/FLY-1671/fix-给既有的独立重启器comflywheelupdater-fly-270加一个手动触发入口)
日期: 2026-08-11
基于: exploration.md

以下全部事实取自当前分支代码逐行核对(file:line 可点开验证),不是转述。

## 1. 队列与 marker 机制(`scripts/lib/self-ship-queue.sh`)

- marker schema(`ssq_enqueue`,line 68-104):`{targetSha, prNumber, issueIdentifier, schemaVersion:2, attempts:0, nextAttemptAt, lastErrorClass:null, createdAt}`。jq 构造,tmp 文件写在 watched dir **外**再原子 `ln`(no-clobber)进 `~/.flywheel/self-ship-pending.d/<sha>.<nonce>.json`
- 校验(`ssq_marker_is_valid`,line 116-130):`*.json` + JSON 可解析 + **targetSha 必须 40-hex** + attempts/nextAttemptAt/createdAt 必须整数。不满足 → `ssq_sweep_invalid` 直接 quarantine 到 blocked dir
  - ⇒ **无 targetSha 的「新 marker 类型」走不通**,会被当 corrupt 清走(exploration 方案 B 的拒绝依据)
- satisfied 判据(`ssq_is_satisfied`,line 180-187):`git merge-base --is-ancestor <target> <deployed>` —— target 是 deployed 的 ancestor-or-equal 即满足。**已部署的 SHA 作 target 天然立即可 ack**(但 ack 发生在 deploy 之后,见 §2)
- 失败退避:transient 退避重试(30s 起、翻倍、封顶 30min);deterministic 累计 5 次 → `ssq_block` 移出 watched dir + severe_alert(update-flywheel.sh line 200-205)
- singleton lock(line 308-341):mkdir mutex + owner PID/identity;活着的 updater 绝不被夺锁

## 2. updater 主循环(`scripts/update-flywheel.sh`)

- 主循环(`update_main`,line 224-262):`ssq_sweep_invalid` → `pending==0 ? fallback_sweep+break : due==0 ? sleep : process_due_markers`
- **承重事实 A**(`process_due_markers`,line 148-150):`"$SELF_SHIP_DEPLOY_CMD"` **先无条件执行**,然后才逐 marker 判 satisfied/ack。⇒ 有 due marker 就必然跑一次完整 deploy(= 全量重启),与是否有新代码无关
- `default_deploy`(line 91-109):clean-checkout preflight → `git fetch` → discord-pointer 守卫 → `git pull --ff-only` → **`FLYWHEEL_RESTART_FOREGROUND=1 restart-services.sh`**(无 `--reason` 参数 → 播报默认 `reason=manual`,与 Lead 手跑不可区分 —— 见 §7 改进点)
- **承重事实 B**(`fallback_sweep`,line 210-221):只在 `head != remote || deployed != head` 时 deploy,否则 `nothing to do`。⇒ 裸 kickstart updater 不能当手动重启入口(exploration 方案 C 的拒绝依据)
- rescan 循环:`ssq_sleep_until_due` 封顶 60s(`SELF_SHIP_RESCAN_INTERVAL`),新 enqueue 的 marker 最迟 60s 内被在跑实例接住;不在跑则 QueueDirectories 直接拉起
- 部署事件上报(`report_deployment`,line 124-146):ack 前 best-effort 调 `flywheel-comm report-deployed`,marker 的 `issueIdentifier` 会进事件归因 —— 手动 marker 填 `manual-restart` 即可在 Bridge 部署账本里留痕

## 3. 重启执行体(`scripts/restart-services.sh`)

- **承重事实 C**(line 921-922):`DEPLOYED_SHA == CURRENT_HEAD` → `"Already built at ...; skipping build, continuing full restart."` —— 纯重启完整走通,只跳过 build
- 重启对象(line 1016-1018):`restart_bridge=true; restart_all_leads=true`(FLY-1434:唯一 scope 是全舰)+ cmux watcher。**`com.flywheel.updater` 不在其中** ⇒ updater 发起时发起者天然在集合外
- self-detach(line 785-793):`FLYWHEEL_RESTART_FOREGROUND=1` 时跳过(updater 路径即如此,同步跑完、退出码可判)
- `RESTART_REASON` 默认 `manual`(line 748),`--reason` 可覆盖(line 766)
- 完成播报(line 2089-2104):`rn_render_completion_message` 15 个位置参数;渲染失败有 fallback 文案 + meta_alert。Lead 计数来自波次统计(`skipped:N failed:N total:N` stdout 合同,line 1704)
- Lead 波次(line 1656-1697):候选三源清单(manifest + loaded plist + legacy process),分类 restart/skip-test/manifestless/config-drift。**没有任何「发起者豁免」显式代码** —— 豁免是隐性的:body 收养发生在下游 supervisor 里(§5)

## 4. 既有入队入口(`scripts/self-ship-restart.sh`)

- 接口:`--target-sha <40hex> [--pr n] [--issue X] [--dry-run]`
- 顺序与 fail-close:**先**验 updater loaded(`launchctl print`,line 80-83,rc 69)→ enqueue(line 87-91)→ kickstart 无 `-k` nudge(line 93-102,失败 rc 69 且不许假报成功)。⇒ 新入口委托它即可全额继承 fail-close
- 测试 seam:`SELF_SHIP_RESTART_SOURCED=1`(sourceable)、`SELF_SHIP_LAUNCHCTL`(launchctl 注入)、`SELF_SHIP_UPDATER_LABEL`;queue lib 侧 `SELF_SHIP_PENDING_DIR` 等全目录可 env 覆盖、`SELF_SHIP_NOW` 可钉时间
- 既有测试:`scripts/__tests__/self-ship-restart.test.sh`、`self-ship-queue.test.sh`(hermetic,已覆盖 enqueue/ack/backoff/lock)

## 5. body provenance 的权威写者(`packages/teamlead/scripts/claude-lead.sh`)

supervisor 已在进程内区分 body 来源,`LEAD_BODY_PROVENANCE` 三个终定点:
- line 1900:`_lead_try_adopt_body` 成功 → `adopted`(store-authorized 接管既有 body)
- line 1922:`_lead_bound_body_ready` 兜底 → `adopted`
- line 2657:窗口新建成功 → `launched`
- line 3305:graceful teardown 只对 `launched` body 有权限 —— 变量语义已是行为分支依据,**但目前不落盘**,restart-services.sh 波次后无从读取

⇒ 报告口径修正的最小数据通道:supervisor 在 provenance 终定后 best-effort 写一个 breadcrumb 文件(权威写者原则,避免在 restart-services.sh 里重造 body 身份传感器 —— 那正是 FLY-1634 删掉的东西)

## 6. 完成播报渲染器(`scripts/lib/restart-notify.sh`)

- `rn_render_completion_message`(line 110 起):15 个位置参数,含 watcher_state/detail;成功判定(✅ 首行)= leads clean + bridge ok + watcher healthy —— **body 新旧不参与判定**(FLY-1634 边界,保持不动)
- 既有测试:`restart-services-notify.test.sh`、`restart-notify-routine.test.sh`、`qa-fly1081-notify-identity.test.sh` —— 渲染合同有测试保护,加参数需同步扩测试

## 7. 播报区分度缺口(acceptance 需要)

`default_deploy` 不传 `--reason` ⇒ updater 发起的重启播报 `reason=manual`,与 Lead 手跑**不可区分**。验收要求「确认由 updater 发起」,加一个静态 `--reason updater` 即可区分(一行改动;self-ship / manual marker / calendar fallback 三种 updater 路径统一显示 `updater`,per-marker 归因不做 —— 一次 deploy 可满足多个 marker,无法唯一归因,marker 文件与部署事件已留痕)

## 8. 文档/纪律触点

- `doc/engineer/implementation/restart-guard.md`:现文案「唯一受控入口是 `scripts/restart-services.sh`」(line 50)—— 需改为「统一重启默认入口 = 手动触发脚本(enqueue 给 updater);`restart-services.sh` 直跑降级为紧急兜底」
- `doc/engineer/implementation/bridge-ship-discipline.md`:ship 纪律文档,加统一重启条目
- `spin.md` Step 3.4 / `orchestrator.md` B2(Runner self-ship 流程):**不变**(本单不动 Runner 路径)
- plist(`scripts/com.flywheel.updater.plist`)指向主仓固定路径 ⇒ **merge + 主仓 pull 即生效,无需重装 plist、无需重启任何服务**

## 9. 风险面小结

| 风险 | 判定 |
| -- | -- |
| queue lib / marker schema 改动 | 零(方案 A 复用现形状) |
| updater 主循环改动 | 仅 default_deploy 加 `--reason updater`(一行) |
| restart-services.sh 成功判定改动 | 零(观测行不进判定) |
| 并发(enqueue 时 updater 在跑) | 已有 singleton lock + ≤60s rescan 覆盖 |
| updater 未安装/禁用 | self-ship-restart.sh fail-close rc 69 全继承 |
| origin/main 领先本地时手动重启 | 语义即「收敛部署 + 重启」,文档写明 |
