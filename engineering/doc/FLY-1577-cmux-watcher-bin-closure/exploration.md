# FLY-1577 cmux watcher 的 bin 硬依赖闭包 — 探索

Issue: FLY-1577 (https://linear.app/geoforge3d/issue/FLY-1577/运维修复-cmux-watcher-的硬依赖不在-bin-收敛清单里-补进-files)
日期: 2026-07-31
基于: 无

## 1. 事故是什么

2026-07-31,founder 问「为什么 cmux 上没有新 issue 的窗口」。cmux 窗口是她看 Runner
在干什么的**唯一界面**,所以「watcher 没起来」等于「她看不见系统在干活」。

挖出来的链条(全部已实测复核,见 research.md):

```
① ~/.flywheel/bin/restart-storm-gate.py 不存在
② flywheel-cmux-autostart 的 fail-closed 启动前置检查拒绝启动 watcher
③ launchd KeepAlive 每 30 秒重试,每次被同一句话拒掉
④ /tmp/flywheel-cmux-watcher.log 滚到 22 MB,全是同一行
⑤ ⇒ cmux watcher 从来没起来过 ⇒ 所有新 issue 都没有窗口
```

②那个 fail-closed 本身是**对的** —— 刹车不在就拒绝启动。本单不碰它。

## 2. 为什么会漏

FLY-954 专门建了一套防 bin drift 的机制:`scripts/converge-flywheel-bin.sh`,
不变量是「安装副本 == repo 源」+ mode 555,三个挂载点(每次 Lead 启动 / 每日
sweep / kickstart 前)。

但它的管理清单只有三个文件:

```bash
FILES="flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh"
```

`restart-storm-gate.py` 不在里面 —— 所以它一旦丢失,converge **不补、不告警、
跑完还报 clean**。事故当天 Lead 跑了一遍 converge,输出确实是 clean,因为它压根
不管这个文件。

## 3. 探索中发现的第二件事(比第一件更严重)

扫描「运行时硬依赖但不在清单里」时发现:autostart 在 fail-closed 分支里本来要发
一条 meta-alert 告诉人「刹车不在」——

```bash
"$SELF_DIR/lib/bounded-run.sh" \
  "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
  "${FLYWHEEL_META_ALERT_BIN:-$SELF_DIR/meta-alert.sh}" \
  restart_storm_gate_unavailable_cmux-watcher \
  "Restart brake unavailable" ... \
  >/dev/null 2>&1 || true
```

`$SELF_DIR/lib/bounded-run.sh` 和 `$SELF_DIR/meta-alert.sh` 在生产 bin 里**都不存在**。
命令不存在 → 输出被 `>/dev/null 2>&1` 吃掉 → 尾巴 `|| true` → 返回 0。**全静音,零投递。**

这改写了事故叙述本身:不是「系统喊了但没被听见」,而是**系统连喊都没喊出去**。
那 22 MB 只是 launchd 把 stderr 重定向进日志文件的产物,不是任何告警通道。

Tadashi 已确认会去更正给 founder 的说法。

## 4. 本单要达成什么

1. `restart-storm-gate.py` 丢失后 converge 能**补回来**,并且**明确报 repaired 而不是 clean**
2. 「报告刹车不在」这条链**真的能把消息送到人眼前** —— 不是静默返回 0
3. 回归测试进 CI,可重复跑

## 5. 边界

不做:改 fail-closed 行为 / 动 watcher 逻辑 / 加 feature flag / 日志轮转。

## 6. 设计原则(本单的意义)

> 「喊了」和「被听见了」是两件事。

这单的机器形态:补一个缺失文件只解决了①;要让下次同类故障**有人知道**,必须
同时保证告警链的每一环也在闭包里。**报告链缺一环 = 整条断。**
