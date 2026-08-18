# FLY-1830 审计发现 — launchd 服务静默丢失

**Issue**: FLY-1830 — [infra·P1] 自动切号从未真正运行
**URL**: https://linear.app/studio/issue/FLY-1830
**Date**: 2026-08-17
**基于**: 本机实测(launchctl / ~/.flywheel 状态文件 / ~/Library/LaunchAgents)

## ⏳ 会过期的结论(续接前先逐条重核)

**最要紧的一条:第 1 节引用的证据文件已经在被覆盖。** quota-monitor 2026-08-17 11:27 被重新装回并开始跑,
`quota-monitor-state.json` / `quota-monitor.health.json` / pidfile **正在被活进程改写** ——
本文里 8-1→8-6 那组数值是**当时的抄录**,现在去读这几个文件只会看到新一代的值,不是反驳。

| 会过期的结论 | as-of | 重核命令 |
| -- | -- | -- |
| quota-monitor 已回 domain 且在跑(pid 12836) | 08-17 11:31 | `launchctl print gui/501/com.flywheel.quota-monitor \| grep -E 'state \|pid '` |
| 剩余 3 个非-Lead daemon 仍在 domain 外 | 08-17 11:47 | 见下方枚举命令 |
| enabled 的非-Lead 集合 = 6 且无「该 disable 却 enabled」的例外 | 08-17 | `for f in ~/Library/LaunchAgents/com.flywheel.*.plist; do b=$(basename "$f" .plist); case "$b" in com.flywheel.lead.*) continue;; esac; launchctl print gui/501/"$b" >/dev/null 2>&1 && echo "LOADED $b" \|\| echo "MISSING $b"; done` |
| 五个凭证快照全部过期 / 台账 lastObservedAt 分布 | 08-17 11:20 | 读 `~/.flywheel/claude-profiles/*/.credentials.json` 的 `expiresAt` 与 `~/.flywheel/claude-accounts.json` 的 `lastObservedAt`(daemon 复活后会开始刷新) |
| updater 的复活归 FLY-1671 认领 | 08-17 | 查 FLY-1671 状态;`plan.md:140` 用 `git log -S "updater job 本身必须先复活"` 重定位 |
| `test-restart-services.sh` 的 7 条失败是既有项 | main `e54ece67b` | `git stash push -u && bash scripts/test-restart-services.sh; git stash pop` 取变更前基线再比 |
| 切换规则 = 5h≥90% 或 周窗≥100%(`quota-monitor.ts:227-233`) | 08-17 | 行号会漂;用 `git log -S "triggerScope" -- packages/teamlead/src/account-heal/quota-monitor.ts` 重定位 |

**不会过期的**:8-1 10:45→8-6 00:17 那段运行史与「被 bootout 而非 disable」的判定(历史事实,证据已抄录在下);
「谁在 8-6 卸的不可追」(日志保留期只会更短,不会变得可追);Lead 族必须整族排除的理由(FLY-398 形态)。

## 现状游标

- [x] onboard
- [x] 审计:launchd 实际状态 vs 盘上 plist(30 个 plist 逐个比对)
- [x] 审计:quota-monitor 运行史(state / health.json / crash 计数)
- [x] 审计:安装链(scripts/setup-quota-monitor.sh)是否会留下"写了 plist 但没 load"
- [x] 审计:仓库内有无 bootout quota-monitor 的代码路径
- [x] 结论:**issue 的中心论断被证伪**(不是"从没 bootstrap")
- [x] 纠正 + 范围决策问题发给 Tadashi(非阻塞 ask 62c3346f)
- [x] Tadashi 裁定:收敛非检测;清单权威 = launchd 原生 enabled 位;Lead 族整族排除
- [x] 实现 + 测试 + 证据(见下)
- [x] PR #866

## 已确证的事实(带证据)

1. **quota-monitor 真的跑过**,不是"从没 bootstrap":
   - `~/.flywheel/quota-monitor.health.json` → `pid 1738`,`processStartTime "Sat Aug 1 10:45:06 2026"`,`completedAt 1786000946058`(= 2026-08-06 00:22:26 PDT)
   - `~/.flywheel/quota-monitor-state.json` → `lastPollAt 1786000648680`(= 2026-08-06 00:17:28 PDT),mtime Aug 6 00:22
   - 本机 boot time = Aug 1 10:41:39;daemon 起于 boot 后 3.5 分钟 = 登录时 launchd 自动 load 的形态
   ⇒ 它从 8-1 跑到 8-6,**共约 4 天 14 小时**,然后停了。

2. **它是被 bootout 掉的,不是被 disable**:
   - `launchctl print gui/501/com.flywheel.quota-monitor` → Could not find service
   - `launchctl print-disabled gui/501` → `"com.flywheel.quota-monitor" => enabled`
   ⇒ 覆盖库里仍是 enabled,只是不在 domain 里 = 有人执行过 bootout/unload。

3. **不是安装脚本干的**:`~/Library/LaunchAgents/com.flywheel.quota-monitor.plist` mtime = **Jul 15 23:06**。
   `setup-quota-monitor.sh` 每次 enable 都会 `mv` 新渲染的 plist(会刷新 mtime),
   所以自 7-15 起该脚本没再成功跑过 ⇒ 8-6 的 bootout 来自该脚本之外。
   仓库内(生产 checkout)也 grep 不到任何 bootout quota-monitor 的代码路径。

4. **谁在 8-6 00:22 执行的 bootout,已不可从日志追回**:
   `log show --start 2026-08-06` 返回空,unified log 保留期够不到(最老 Persist tracev3 = Aug 17)。
   不猜。

5. **范围比 issue 说的大**:盘上 30 个 `com.flywheel.*.plist` 逐个比对,
   **enabled 但没 load 的有 4 个**:`quota-monitor`、`updater`、`bridge-liveness-probe`、`daily-standup`。
   (另有 growth-* / skills-update / sub-* / token-usage-daily 共 7 个是 **显式 disabled**,不加载是对的;
   `lead.growth-mufasa-lead` / `lead.flywheel-codex-infra-bot-lead` 不走 launchd 是既定形态 — Mufasa 按
   CLAUDE.md FLY-398 走 TUI launcher,**误 bootstrap 会造成 double-listen**。)
   14 个 Lead plist 全部 loaded ✓ —— 因为 Lead 那一族有 fleet/restart 收敛,非-Lead 这一族没有。

6. **台账陈旧与 daemon 死亡时间对得上**:`claude-accounts.json` 各账号 `lastObservedAt`
   = shopping 8-1 / personal 8-11 / school 8-12 / personal1 8-13 / business 8-15,
   全部无固定节奏(daemon 死后只剩零散的其他写入路径)。ledger 里 `authExpired` 全 false,
   所以 founder 体感的"凭证过期"是**切换当场才发现**,台账里没有这个信息。

7. **另外 3 个失联 label 都是活功能,不是退役件**:
   `scripts/bridge-liveness-probe.sh`(被 `packages/teamlead/src/LeadAlertNotifier.ts` 引用)、
   `scripts/daily-standup.sh`(被 provision / setup / package-onboard 多处引用)都还在仓库里活着。
   其中 **updater 的复活已由 FLY-1671 认领** —— `engineering/doc/FLY-1671-manual-restart-trigger/plan.md:140`
   明写「前置 = 生产 updater 已按仓库版 plist 重装 + bootstrap …… updater job 本身必须先复活」。
   FLY-1830 不该重复这一件。

8. **updater 失联的下游影响已经可见**:`~/.flywheel/self-ship-pending.d` 空且 mtime 停在 **8-5 17:01**
   —— 也就是自 8-5 起没有任何 self-ship marker 走过这条队列。
   而 `~/.flywheel/deployed-sha` = 生产 HEAD = origin/main = `e54ece67b`,Bridge buildSha 也是它,
   ⇒ 部署仍在发生,只是**绕开了 updater 走人工路径**(护栏文案里的「紧急兜底」)。

9. **founder 那句「每次切都说凭证过期」有了对得上的机制**(注意:是机制吻合,不是已证明):
   `~/.flywheel/claude-profiles/<账号>/.credentials.json` 是**快照**,五个账号的 `expiresAt` **全部已过期**:
   shopping 7-31(快照 mtime 7-30 19:32)/ school 8-12(8-12 17:55)/ personal1 8-13(8-13 12:03)/
   personal 8-15(8-15 00:33)/ business 8-15(8-15 00:35)。
   快照 mtime 与台账 `lastObservedAt` **逐个精确对上**(business 快照 8-15 00:35 ↔ lastObservedAt
   2026-08-15T07:35Z = PDT 8-15 00:35)⇒ **是 daemon 在维持这些快照的新鲜度**,它死了以后就没人刷了。

   **但不能就此断言「凭证真的不能用了」**:accessToken 过期是常态,只要 refreshToken 还有效,
   客户端换上去就会自动续。refreshToken 到底还灵不灵,**从磁盘证不出来** —— 要真发一次 refresh 才知道,
   而 refresh 会轮换掉 Annie 的 refreshToken(不可逆的账号侧动作),不在 Runner 权限内,我没做。
   本机 macOS 上活跃凭证走 Keychain(`~/.claude/.credentials.json` 不存在),池里这些是复制件。

10. **顺带校准 founder 的口径**:她说的「用到 90/95% 就自动切」和实际建成的规则有出入。
    `quota-monitor.ts:227-233` 的 `triggerScope`:**5 小时窗 ≥ 90%**(`trigger5hPct`,当前 config 就是 90)
    **或 周窗 ≥ 100%** 才触发切换。周窗没有 90/95 这一档 —— 也就是说 school 现在 7d=83% 这种,
    即便 daemon 活着也**不会**触发切换。这是既定设计,不是 bug,但她的预期需要被对齐(或者改 config)。

## 修法口径(待 Lead 拍板)

- issue 建议的「自检枚举 + 缺失告警」= 探针形状,和 Annie 2026-08-05 三连定案冲突
  (`feedback_fix_structure_not_add_detector`:先问能不能让它无从发生,检测是退而求其次)。
- 建议改为**收敛**而非**检测**:让已有的全量重启路径顺手把非-Lead daemon 集合装回去
  (幂等的「不在就装回去」),不加新 timer / 新 flag / 新 daemon,与 Lead 那一族现成做法同型。
- **不能自己拍的边界**:「盘上有 plist 且 enabled」≠「应该在跑」。
  `lead.growth-mufasa-lead` 就是反例(enabled 在盘上,按 FLY-398 走 TUI launcher,
  误装回去会 double-listen)。所以要么显式清单,要么只收敛写死的这几个 label —— 归 Lead 定。
- **止血那一步不在 Runner 权限内**:重新装载命令被 FLY-913 护栏按 P1 拦,
  且账号救援属 Codex Infra Bot 域(founder-only-authority R3)。
  (附注:护栏是按 Bash 命令文本匹配的 —— 第一版给 Lead 的消息里原文引了那条命令,
  连发消息都被拦下,改措辞后才发出。这是护栏的误报面,不是本单要修的东西。)

## 修法(Tadashi 2026-08-17 裁定后实现)

**形状 = 收敛,不是检测。** 已有的全量重启波次(`scripts/restart-services.sh`)顺手把
非-Lead daemon 集合装回去,零新 timer / 零新 flag / 零新 daemon —— 与 Bridge / Lead /
cmux watcher 已有的做法同型。issue 原本建议的「自检 + 缺失告警」按 Annie 2026-08-05 口径否掉。

**清单权威 = launchd 自己的 enabled 位**(Tadashi 定;我提的「显式清单」和「写死 4 个 label」都被否)。
收敛谓词:非-Lead 的 `com.flywheel.*.plist` 在盘 **AND** 覆盖库里没被 disable **AND** 不在 domain
→ 幂等装回。不在覆盖库里 = enabled(launchd 自己的默认,不是我们的假设)。
不建 side roster(有「每处要记得注册」的漏点),不写死 label(会烂)。

**Lead 族整族排除。** `com.flywheel.lead.*` 由 Lead 波次 / fleet 工具拥有,且其中
`growth-mufasa-lead` 按 FLY-398 是「盘上 enabled 但由 TUI launcher 驱动」—— 装回去会造出第二个监听者。
整族排除(而不是特判某个 label)让这个隐患**结构上够不着**。

### 交付物

| 文件 | 作用 |
| -- | -- |
| `scripts/lib/converge-nonlead-daemons.sh` | 新增。source-only 收敛库,Bash 3.2 兼容 |
| `scripts/restart-services.sh` | 在 `deployed-sha` 推进之后调用(位置有原因,见下方 R2 第 4 条);degraded 走已有 tail warning |
| `scripts/__tests__/converge-nonlead-daemons.test.sh` | 新增。**最终 24 条**契约(经三轮 review 从 12 条长起来) |
| `scripts/test-restart-services.sh` | 补 fixture 闭包(hermetic 假仓要复制新库) |
| `.github/workflows/ci.yml` + `ci-structure.test.sh` | 新套件进必过门,并 pin 住命令集防漂移 |

### 证据

1. **首轮 12/12 通过**(下面 review 各轮的最终数是 24/24),且做了**变异测试**证明不是空过绿 —— 逐个改坏生产库,套件逐个变红:
   去掉 Lead 族排除 → 红;去掉 bootstrap 后的复读(只信 launchctl 退出码)→ 红;
   覆盖库读不到时 fail-open → 7 条红;忽略 disabled 集合 → 红。还原后 diff 为空、12/12 绿。
   wiring 断言也有反向对照(把调用点挪走 → 红)。
2. **真机 dry-run**(只读:`print` / `print-disabled` 走真 launchctl,唯一的变更调用换成记录器,
   什么都没装、什么都没卸):`enabled=6 already_loaded=3`,拟收敛 3 个
   = bridge-liveness-probe / daily-standup / updater,**Lead 族一个都没出现**。
   (dry-run 里 state=degraded 是刻意的:记录器故意不让 label 落地,正好把「bootstrap 返回 0 不算数,
   要复读 domain 才算」这条路径真跑了一遍。)
3. **调用点确实执行**:hermetic `test-restart-services.sh` 跑完整 `restart-services.sh` 后,
   录到的 launchctl 序列末尾出现 `print-disabled gui/501` → `print .../com.flywheel.bridge`
   → `print .../com.flywheel.cmux-watcher`,零 bootstrap —— 两个都已在 domain,幂等空跑,顺序也对
   (在 cmux watcher 的 bootout/bootstrap 之后)。
4. **零回归,有变更前基线**:`test-restart-services.sh` 在**本分支**与 **stash 掉改动的干净树**上
   跑出**同样的 126 passed / 7 failed**,7 条失败名字逐条相同(FLY-1434 ×3 / FLY-1680 ×2 / FLY-1603 ×2),
   均为宿主既有项。`restart-cmux-watcher.test.sh` 14/14。`ci-structure` PASS。
   `ci-shell-suite-enumeration` PASS(187 套件全分类)。
   `pnpm lint` 0 error(8 条既有 warning,全在我没碰的 TS 文件里)。
   **未跑 `pnpm -r build`**:本单零 TS/JS 改动(只有 .sh / .yml),构建面不受影响。
5. **shellcheck**:新库只剩 SC2034(source-only 库导出全局变量),与同族的
   `scripts/lib/restart-cmux-watcher.sh` **同一条既有基线**,故未加抑制指令。

### Codex code review R1 抓到的三条(全部认下并修)

1. **HIGH — Lead 排除只看文件名,但 launchd 认的是 plist 内部的 `Label`。**
   一个叫 `com.flywheel.rogue.plist`、内部写 `Label = com.flywheel.lead.growth-mufasa-lead` 的文件
   能绕过按文件名的排除,被装起来 = 第二个 Mufasa 监听者。Codex 复现了。**这条是真的。**
   修法:新增 `nonlead_daemon_plist_label`(macOS 走 `plutil`,无 plutil 时走可移植 XML 扫描),
   **内部 Label 成为唯一身份** —— Lead 排除、domain 查询、bootstrap 后复读全用它;
   读不出 Label 就跳过并报告(绝不退回用文件名猜);Label 不在 `com.flywheel.` 命名空间也拒绝。
2. **MEDIUM — `print-disabled` 退出码为 0 但输出畸形/含未知值时被当成 enabled**,违反 fail-closed。
   修法:严格解析 —— 必须有 `disabled services = {` 框架,框内每条必须逐字匹配
   `"label" => enabled|disabled`,出现任何认不出的条目就 fail-closed(什么都不收敛)。
3. **MEDIUM — 任何 `launchctl print` 非零都被当成「服务不在」**,探测错误也会触发 bootstrap。
   修法:三态 `loaded|missing|error` —— 只有 launchd 逐字的 `Could not find service` 算「不在」,
   其余错误一律不 bootstrap,记为 failed 并报告。

**新增 6 条契约测试全部先 RED 后 GREEN**(HIGH 那条 RED 时的原话就是
`✗ double-listen hazard reachable: bootstrapped com.flywheel.lead.growth-mufasa-lead`),
套件 12→**18**。**再做 5 个新变异**(Lead 检查退回文件名 / Label 读不出退回文件名 /
去掉命名空间闸 / 任何非零探测当缺席 / 宽松解析覆盖库)**逐个变红**,还原后 diff 为空、18/18 绿。

**双实现交叉验证**:对本机全部 30 个 flywheel plist,`plutil` 路径与 awk 回退路径提取的 Label
**30/30 完全一致**;并做了阳性对照(把 `awk` 打断 → 回退路径返回 unreadable、plutil 路径不受影响),
证明这不是「两次都走了同一条路」的空对照。

**修完后重跑真机 dry-run 结论不变**:`enabled=6 already_loaded=3`,拟收敛仍是同样 3 个,
零 Lead 族、零 unreadable Label、零 foreign label —— 说明现网每个 plist 的内部 Label 都规范。

**顺带修了 hermetic fixture 的失真**:harness 的 launchctl shim 原本不实现 `print-disabled`
(空输出),严格解析下会 fail-closed;`com.flywheel.cmux-watcher.plist` 桩也是没有 `Label` 的
`<plist/>`。两处都改成逐字模拟真 launchd 形状,让 hermetic 跑真解析路径而不是失败路径。

### Codex code review R2 抓到的 4 MEDIUM + 1 LOW(四条照修,一条部分采纳)

1. **awk 回退在命中同行 `Label` 后仍从行首扫描**,会取到 Label 之前的 `<string>`。
   补的对照测试把诱饵设成**合法且非-Lead** 的 `com.flywheel.decoy`(不然会被 token 校验挡住而假绿),
   RED 时原话:`✗ fallback took the wrong <string>: bootstrapped com.flywheel.lead.growth-mufasa-lead`。
   修法:命中后只扫 `<key>Label</key>` **之后**的子串。真机 30 个 plist 上 plutil↔awk 仍 30/30 一致,
   且次行式 `<string>` 也照样解析。
2. **严格解析没校验右花括号闭合,且会跳过任何含 `}` 的行** —— 截断的清单会被当完整的,
   `"label" => disabled } junk` 会被静默丢掉(disabled 变 enabled)。
   修法:显式要求闭合行存在;只跳过**恰好**是框架行或空行的行,其余一律必须逐字解析,否则 fail-closed。
3. **`missing` 只做子串匹配**,别的服务的 not-found 文本会被当成我们这个服务不在。
   修法:必须逐字包含 `Could not find service "<我们问的 label>"`。
   **部分采纳**:Codex 还要求绑 rc=113,我没绑,并在代码里写明理由 ——
   绑 rc 的失败方向更坏(某个 macOS 版本改了 rc ⇒ 收敛在全网静默失效,正是本单要治的病),
   而误判 missing 的代价上限只是多一次被 launchd 拒绝的 bootstrap(重复 label 起不来,不会 double-listen)。
4. **updater 的 `QueueDirectories`**:队列非空时 bootstrap 会**立刻**拉起 updater,
   它在拿 restart lock 之前就 `git fetch/pull`,可能和本次部署并发改同一个 checkout。
   **这条是我先前漏判的**(我只查了 `RunAtLoad`,没查 QueueDirectories 在 load 时也会触发)。
   修法:把收敛整体**挪到 `deployed-sha` 推进之后** —— 此时 build 已完、SHA 已是最新,
   被唤醒的 updater 要么无事可做,要么按正常方式经 restart lock 排队。不加特判、不加 label 名单。
5. **LOW — 按文件名的 Lead 预筛与「声明 Label 是唯一身份」自相矛盾**:Lead 形文件名若声明非-Lead label
   会被静默漏掉。修法:**删掉文件名预筛**,两个方向都只认声明的 Label。

套件 18→**23**,五条新契约先 RED 后 GREEN;再做 3 个新变异(awk 退回全行扫描 / 去掉闭合校验 /
not-found 解绑 label)逐个变红。R3 又补了「Label key 在行尾」一条 → **最终 24 条**,`bash -e` 下同样 24/24。

### Codex code review R3 + 已知残留竞争(✅ Lead 已按更正后的触发集重新确认:接受 + 记账)

R3 剩两条,一条我修了,一条经 Lead 裁定接受:

1. **修了 —— `<key>Label</key>` 恰好在行尾时,空后缀会回退去重扫整行**,前面 key 的 `<string>` 又回到台面。
   直接前后对照(同一份 plist):旧逻辑返回 `com.flywheel.decoy`(会被收敛),
   新逻辑返回真正的 `com.flywheel.lead.growth-mufasa-lead`(随后被排除)。
   空后缀现在一律顺延到下一行,绝不重扫当前行。30 个真 plist 的 plutil↔awk 仍 30/30 一致。
2. **Codex 接受了我对 rc 绑定的反驳**(原话:精确目标 Label 的 not-found 诊断已提供身份信息,
   绑定数值退出码只会增加 OS 版本耦合)。

#### ⚠️ 已知过渡窗口 —— 每天 **00:00 / 12:00** 前后部署撞到 FLY-1743 告警,请先照这条认

> **决策状态**:Tadashi 2026-08-17 **两次**拍板。第一次基于我给的风险分析,而那份分析
> **后来被证伪**(我写成「三条件必须同时成立」,漏了独立的 calendar 唤醒源 —— Codex R4 抓到)。
> 我没有拿旧批准往下走:把更正后的完整触发集重新报给他,他**独立复核后维持 A**
> (原话要点:两条结构性理由不受影响且才是决定性的 —— 稳态下 calendar 每天两次本来就会拉起 updater,
> git 阶段不拿锁的竞争在正常在线态天天存在;新事实反而**进一步否掉 B**,因为按队列非空跳过盖不住
> calendar 路径,要盖就得再养第二段机制)。

`com.flywheel.updater` 的 plist 带 `QueueDirectories`。launchd 在 **load 时**如果那个队列非空会立刻拉起它,
而 `scripts/update-flywheel.sh` 的 `default_deploy` 是**先** `git fetch` + `git pull --ff-only`,
**之后**才调 `restart-services.sh`(锁在那里面)—— 即被唤醒的 updater 的 git 阶段不受 restart lock 保护。

触发条件(**已按 Codex R4 更正 —— 我最初写成「三条必须同时成立」是错的**,漏了一个独立唤醒源):

1. `com.flywheel.updater` 当时不在 launchd domain 里(= 本单要修的状态,收敛后即消失),**并且**
2. 收敛后、本轮 wave 退出前,updater 被唤醒 —— **两条独立路径任一条即可**:
   - a. `~/.flywheel/self-ship-pending.d` 在 load 那一刻**非空**(空则 `QueueDirectories` 根本不触发;
        本单实现时是 0 个),**或**
   - b. 撞上 plist 里独立配置的 `StartCalendarInterval` —— **每天 00:00 与 12:00**
        (`scripts/com.flywheel.updater.plist:33-43`)。例如 11:59 收敛完成、队列是空的,12:00 照样会拉起它。
        (**未验证的一点**:launchd 会不会在 load 时立刻补跑一个**已经错过**的 calendar 间隔,
        我没有验 —— 验它必须真把 job 装进 domain,那不在本节点权限内。所以按「可能会」对待。)
   **并且**
3. `origin/main` 在本次部署期间**前进了**(否则 `--ff-only` 是空操作)。

**症状**:updater 在本轮 wave 退出前把 HEAD 挪走 → FLY-1743 的 EXIT 一致性检查发现
`HEAD != deployed-sha` → **severe 告警 + 非零退出**。这就是这个窗口的兜底,是设计内的 fail-loud,不是新故障。

**「接受而不加护」的理由**(两条结构性理由不受更正影响,受影响的只是「窗口有多窄」的量级):收敛已挪到 `deployed-sha` 推进之后,构建期竞争已消除;
剩下的是一次性过渡窗口,且 updater 一旦回到 domain,这段代码以后再也不碰它(稳态零动作);
更关键的是 —— **updater 正常在线时这段 git 阶段不拿锁的竞争本来就存在**,本单只是把系统从
「updater 不存在」恢复成常态,不是引入新险。为这么窄的窗口在收敛器里长期养一段
「谁都记不住为什么存在」的逻辑,正是「无场景不加护」要挡的形状,故否掉了按 QueueDirectories 跳过的方案;更正后的事实**加强**了这个否决(见上)。

**真正的 bug 与归属**:`update-flywheel.sh` 应该在 git 阶段之前就拿 restart lock。
这条**归 FLY-1671**(Tadashi 已记账),本单不动那边代码。

### 一次性盘面归真(Tadashi 要求)

当前 enabled 的非-Lead 集合共 **6 个**,逐个确认「确实应该跑」:

| label | 该跑吗 | 依据 |
| -- | -- | -- |
| `bridge` | ✅ 在跑 | 核心服务 |
| `cmux-watcher` | ✅ 在跑 | 核心服务,重启波次已管 |
| `quota-monitor` | ✅ | 自动切号唯一执行者 |
| `updater` | ✅ | self-ship 部署队列;复活由 FLY-1671 认领 |
| `bridge-liveness-probe` | ✅ | 被 `packages/teamlead/src/LeadAlertNotifier.ts` 引用 |
| `daily-standup` | ✅ | 被 provision / setup / package-onboard 多处引用 |

**没有挖到非-Lead 版的 Mufasa 形例外**,因此不需要 disable 任何一个,盘面状态本来就是真的。
(disabled 的 7 个 —— growth 四个 / skills-update / sub 两个 / token-usage-daily —— 不加载是对的,
收敛谓词按设计不碰它们。)

### 止血进展(不是本节点做的)

实现期间(本机 2026-08-17 11:27)有人在节点外把 quota-monitor 装了回去并把日志路径从 `/tmp`
搬到 `~/.flywheel/logs/`:`launchctl print` 现在 `state = running`(pid 12836),
`lastPollAt` 恢复走动。这是 Tadashi 转报 Annie 的那一步,不是本收敛的功劳 —— 如实记账。
剩下 3 个(updater / bridge-liveness-probe / daily-standup)仍在 domain 外,合入后由下一班重启车收敛。

## Follow-up 交接:见证者分家(机械事实 + 未验证清单)

(Tadashi 2026-08-17 要求记进本单;归 1756 切号族还是新立单由他定。与本单互链:
本单治「服务不在 domain 里」,这条是「服务在跑但被身份闸挡住」,两件事。)

**这一节前后被 Codex 抓错四次**(全称命题、ownership 定性、契约 vs 实际生效……)。
第五次之后我不再往上层推结论,**只留验过的机械事实 + 一份明确的未验证清单**,判断留给接手的人。

### A. 我自己核过的(附 file:line,可复现)

| # | 事实 |
| -- | -- |
| A1 | `reconcileActive`(`quota-monitor-runtime.ts:370-383`)先 `resolveMachineAccount`,`kind !== "resolved"` 就 return `invalid_name` ⇒ **只有见证者已经一致时才会走到 `syncActiveAccountInStore`**,这条路修不了分家 |
| A2 | `reconcileTransitionJournal` 挂在 `withAccountsLock` 的 reconcile hook 上(接线 `quota-monitor-runtime.ts:182`);该 wrapper 注释保证「Reconciliation always happens after acquisition and before the caller can read or mutate shared account state」。**journal 存在且 Keychain digest 命中 target 时,它会自动补写 `.active` 与 store** |
| A3 | **本机当前没有 transition journal**:`~/.flywheel/claude-account-transition.json` 不存在(已 `ls` 核) ⇒ A2 这条自动路径此刻是空的 |
| A4 | 两道闸挂同一个 `authority.kind`:`quota-monitor.ts:1312`(拒绝 usage 归因)、`switch-executor.ts:443`(拒绝切换) |
| A5 | 本次告警的**实际发射路径不经 Bridge**:`quota-monitor-cli.ts` → `sendQuotaMonitorAlert`(`quota-monitor-alert.ts:158`)→ `scripts/lead-alert.sh`,而 `lead-alert.sh:718` 是直接 POST `discord.com/api/v10/...` |
| A6 | `kind-contract.ts:197` **静态声明** `machine_account_conflict: { owner: "claude", arc: "human_by_design" }`;同文件 29-32 行定义 `human_by_design` = 「a human decision by design(permissions, billing, re-login, investigation)」 |
| A7 | 检测侧持续命中:每次 poll 都是 `identity_conflict`。**当天至少一次告警确认送达**(同一天同一 signature 去重,所以后续 poll 的 `primary:"sent"` 可能只是读到既有回执,不证明每次都重发) |

### B. Codex 指出、我未独立复核的

- `active-sync` 可由 `flywheel-claude-profile use` / `next` 内部调用,`next` 不要求人指定 profile 名;
  pool rebuild 也能人工对齐三个见证者 ⇒ **出路需要 operator 介入,但不是「唯一一条要人传 `--name` 的命令」**。
- pool rebuild 在 `quota-pool-rebuild.ts:1112` 一带**直接**取同一把锁(即 A2 的保证限于经 wrapper 的取锁)。
- 失败入队、之后由 Bridge drain 的 alert **才有机会**补挂 ticket/Hub lifecycle ——
  仍取决于 `alertHub` 是否启用、attach 是否成功(**best-effort**,不保证)。

### C. 未验证 —— 接手的人要先解决这些,再谈修法

1. **直发成功时到底有没有 ticket materialization?** A5 + A6 合起来只说明:契约里写了 owner/arc,
   但本次这条告警是否真的走进了那套 lifecycle,**没有证据**。
   两种答案指向完全不同的修法(是「契约有意让人处理」,还是「直发路径漏了 ticket」)。
2. **告警发出后为什么没被处理?** 需要看 Discord 侧的送达与阅读情况,我没查。
3. **本次分家具体怎么发生的?** 没有验证(见 `qa-evidence.md` 第 6 节的更正)。
   「半完成的切换会分家」是结构上可能的形状,不是本次的已证根因。
4. **真身份是谁?** 需要能读 Keychain / 真发一次认证的权限,不在本节点权限内。
   **次序不能反**:按未验证的显示身份去改 marker,可能把错的那个定成对的。

### D. 唯一可以现在就说死的一句

**这台机器上,分家状态不会自己好** —— A1 那条路被前提挡住,A2 那条路因 A3 当前是空的。
其余(该不该治、怎么治、算不算缺陷)都依赖 C 里的未验证项。

## 下一步

合入后,下一次全量重启应把剩余 3 个非-Lead daemon 收敛回 domain。
ask id: 62c3346f-f8ca-4a24-ba9f-3d286bb17cb0(scope 裁定)/ ff5436de(凭证快照补充)
