# FLY-1830 — QA 证据包

**Issue**: FLY-1830 — [infra·P1] 自动切号从未真正运行
**URL**: https://linear.app/studio/issue/FLY-1830
**Date**: 2026-08-17
**基于**: PR #866(head 随文档提交前进,以 PR 最新 head 为准);本机只读实测

---

## ⚠️ 先读这一条:可验面的边界

本 PR 交付的是**能力**(全量重启波次会把掉出 launchd domain 的非-Lead daemon 幂等装回去)。
**真正的收敛全量生效要等下一班重启车** —— 也就是本 PR 合入并部署之后。
所以 QA 在合入前**验不到**「4 个 label 全回 domain」这个终态,请按「已部署前提下的可验面」验,
下面第 1~4 节就是那个可验面。第 5 节是**部署后**才验得到的项。

## ⚠️ 再读这一条:daemon 在轮询 ≠ 自动切号可用

`quota-monitor` 已于 2026-08-17 11:27 被拉回(**不是本 PR 干的**,是 Lead 走 `setup-quota-monitor.sh`
这条 sanctioned 路径拉的)。它确实活着、确实在轮询 —— 但**自动切号仍然不工作**,原因是另一件事。
细节见第 6 节。**不要把「health 文件在走动」当成功能可用的证据。**

---

## 1. 契约测试(hermetic,不碰真机)

```
bash scripts/__tests__/converge-nonlead-daemons.test.sh      # 期望 24 passed, 0 failed
bash -e scripts/__tests__/converge-nonlead-daemons.test.sh   # 期望 rc=0
```

24 条契约覆盖:FLY-1830 本体形态、覆盖库缺项=enabled、幂等空跑、disabled 不动、Lead 族整族排除、
覆盖库读不到→fail-closed、bootstrap 返回 0 但没落地=失败、单点失败不中断扫描、
内部 Label 为唯一身份(含「Lead 标签藏在非-Lead 文件名后」「非-Lead 服务在 Lead 形文件名里」两个方向)、
外域 Label 拒绝、Label 读不出→跳过并报告、awk 回退的两个边界、覆盖库截断/尾随垃圾→fail-closed、
探测错误≠缺席、备份/staged/symlink 兄弟文件不算 daemon、空目录=healthy 空跑、调用点顺序与告警接线。

**反空过绿**:11 个独立变异逐个把套件变红(见 `findings.md` 的证据小节)。QA 若要自证尺子:
随便挑一个变异改坏 `scripts/lib/converge-nonlead-daemons.sh` 再跑,应当变红;还原后应当回到 24/24 且 diff 为空。

## 2. 只读真机 dry-run(不装不卸,零副作用)

用真 `launchctl print` / `print-disabled`,唯一的变更调用换成记录器:

```
enabled=6 already_loaded=3 converged=0 failed=3
WOULD CONVERGE: com.flywheel.bridge-liveness-probe
WOULD CONVERGE: com.flywheel.daily-standup
WOULD CONVERGE: com.flywheel.updater
```

要点:**零 Lead 族 label 出现**;`state=degraded` 是记录器**故意**不让 label 落地造成的,
正好把「bootstrap 返回 0 不算数、必须复读 domain」这条路径真跑了一遍,不是真故障。

盘面自查(只读,任何人可复现):

```
for f in ~/Library/LaunchAgents/com.flywheel.*.plist; do
  b=$(basename "$f" .plist)
  case "$b" in com.flywheel.lead.*) continue;; esac
  launchctl print gui/501/"$b" >/dev/null 2>&1 && echo "LOADED  $b" || echo "MISSING $b"
done
```

## 3. 调用点确实执行(不是只接了线)

跑完整 `scripts/test-restart-services.sh` 后,录到的 launchctl 序列里应出现
`print-disabled gui/501` 紧跟着逐 label 的 `print`,且零 bootstrap(hermetic 环境里两个 label 都已在 domain,
幂等空跑),顺序在 cmux watcher 的 bootout/bootstrap **之后**、`deployed-sha` 推进**之后**。

## 4. 零回归(带变更前基线)

```
bash scripts/test-restart-services.sh          # 126 passed / 7 failed
git stash push -u && bash scripts/test-restart-services.sh; git stash pop   # 同样 126 / 7,7 条同名
```

7 条既有失败:FLY-1434 ×3、FLY-1680 ×2、FLY-1603 ×2 —— 宿主既有项,与本单无关。
其余:`restart-cmux-watcher` 14/14、`ci-structure` PASS、`ci-shell-suite-enumeration` PASS、
`pnpm lint` 0 error(8 条既有 warning,全在未触碰的 TS 里)。
**未跑 `pnpm -r build`**:本单零 TS/JS 改动(只有 .sh / .yml),构建面不受影响。

## 5. 部署后才验得到的项

- 下一班全量重启后,`bridge-liveness-probe` / `daily-standup` / `updater` 三个 label 回到 domain
  (用第 2 节那段枚举命令自查,期望全部 LOADED)。
- 重启日志里出现 `non-Lead daemon convergence: enabled=N already_loaded=M converged=K failed=0`。
- ⚠️ 已知过渡窗口:若重启的收尾段恰好跨过 **00:00 或 12:00**,且 `origin/main` 同期前进,
  可能撞上 FLY-1743 的 EXIT 一致性检查(severe 告警 + 非零退出)。**这是已知并被 Lead 接受的窗口,
  不是新 bug**,来龙去脉见 `findings.md`;真正的修法归 **FLY-1671**。

## 6. 🔴 daemon 已复活但自动切号仍不可用 —— 第二个独立故障,不在本 PR 范围

**观察**(2026-08-17 13:07-13:23 本机只读):

| 项 | 值 |
| -- | -- |
| `launchctl print` | `state = running`,pid 12836,`last exit code = (never exited)` |
| `lastPollAt` | 13:07:19(每 20 分钟一次,准时) |
| **`lastSuccessfulUsageAt`** | **仍停在 8-06 00:17:29** |
| 日志每一条 | `"outcome":"identity_conflict"`,`"panorama":[]`,并发 `machine_account_conflict` |

⇒ 自 8-6 起**一次成功的额度读取都没有**。没有 usage 读数,**5h / weekly 两个阈值就无法被评估**,
且切号本身在第二道闸上也被拒 ⇒ **自动切号依然不工作**。
(精确边界:pane / model-cap detection 发生在这道闸**之前**,所以不能笼统说「任何阈值都不会触发」。)

**根因**(`packages/teamlead/src/account-heal/machine-account.ts` 的 `resolveMachineAccount`,
三个见证者逐个只读核对):

| 见证者 | 值 |
| -- | -- |
| `activeMarker`(`~/.flywheel/claude-profiles/.active`) | `business` |
| `ledgerAccount`(`claude-accounts.json` 的 `activeAccount`) | `business` |
| **显示身份**见证者(`~/.claude.json` 的 `oauthAccount.emailAddress`) | northwestern 邮箱 → 池里唯一匹配 **`school`** |

`identityAccount(school) ≠ activeMarker(business)` ⇒ 落进 `kind: "conflict"` ⇒
`quota-monitor.ts:1312` 在**调用 usage API 之前**就返回,原话「refusing usage attribution or account switch」。
`switch-executor.ts:443` 有第二道同样的闸,所以**即便走到切换那一步也切不动**。

**这是 fail-closed 设计在正确工作,不是 daemon 坏了。**

**已确立的结论就到这里:三个 machine-account 见证者互相不一致 ⇒ 自动切号 fail-closed。**

⚠️ **以下两点我一度写成了结论,是说过头了,已更正为「未验证」**(Codex R8 抓出):
- **不能**据 `~/.claude.json` 断言「这台机器实际登录着 school」—— 那是**显示身份**见证者,
  真正的活跃 token 在 macOS Keychain 里,本节点没有(也不该)去读它。谁是真身份**未验证**。
- 「daemon 死的那 11 天里登录被切过 / 某次切换只完成一半」是**猜测的成因,不是已确立的根因**。没有证据支撑。

措辞精度另一处:说「任何阈值都不会触发」也偏宽 —— pane / model-cap detection 发生在这道闸**之前**,
准确说法是**usage(5h / weekly)阈值无法被评估**,且切号在两道闸上都被拒。

**归属**:账号侧变更属 Codex Infra Bot 域(founder-only-authority R3),且「三个见证者信哪个」
是有后果的判断,不由 Runner 或 QA 代拍 —— 何况**真身份到底是谁本身就还没验证**,更不该替 Annie 猜。
**本节点没有动任何账号状态。**

**重核命令**(只读):

```
tail -6 ~/.flywheel/logs/quota-monitor.log        # outcome 是否仍全是 identity_conflict
cat ~/.flywheel/claude-profiles/.active
python3 -c "import json;print(json.load(open('$HOME/.flywheel/claude-accounts.json'))['activeAccount'])"
python3 -c "import json;print(json.load(open('$HOME/.claude.json')).get('oauthAccount',{}).get('emailAddress'))"
```

**与本 PR 的关系**:两件独立的事。本 PR 治的是「服务不在 domain 里」;这条是「服务在跑但被身份闸挡住」。
本 PR 的收敛能力不因这条而失效,这条也不因本 PR 而好转。

## 7. 会过期的结论

`findings.md` 第一屏有完整的过期表。本文件里最容易过期的:第 6 节的三个见证者取值
(一旦有人修了身份冲突就会变),以及第 5 节「三个 label 仍在 domain 外」(下一班重启车后应变)。
两者都给了上面的重核命令,**别照抄结论,先跑一遍**。
