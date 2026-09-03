# FLY-2269 visual-capture 浏览器清理 — 探索
Issue: FLY-2269 (https://linear.app/geoforge3d/issue/FLY-2269/发布链泄漏-visual-capture-与-publish-report-同形的-chrome-页泄漏proofshot-start)
日期: 2026-09-02
基于: 无

## 1. 问题边界

本单修两个相连的发布链问题：

1. `flywheel-comm visual-capture` 仅在 `proofshot start` 成功返回后才把
   `proofShotStarted` 置为 true。若 start 在已经打开 Chrome page 后因
   recording 冲突等原因失败，finally 会跳过整个 stop/close 清理；正常路径的
   `proofshot stop` 也不能证明 page 已回收。结果与 FLY-2215 修复前的
   `publish-report` 同形：连续调用会累积 page 与 renderer。
2. FLY-2215 引入的 `defaultRunAgentBrowser()` 没有 `execFileSync.timeout`。
   `record stop` 最多调用两次，一次子进程卡住就可能等待约两分钟，整个降级路径
   可额外拖长约 3.5 分钟；它替代的 ProofShot stopRecording 原来有 15 秒上限。

范围限定在 visual-capture 的本轮浏览器所有权清理、共享的 agent-browser
子进程超时策略及对应测试。不改 reaper、ProofShot/agent-browser 版本、公共 CLI
参数、Bridge、runner 生命周期或配置旋钮。

## 2. 当前链路与可达失败

当前 UI/3D 两条路径共用以下状态机：

```text
lock → port/server → proofshot start
  → screenshot/open...
  → proofshot stop
  → discover/write manifest/notify
finally:
  only if start succeeded and normal stop was not attempted → proofshot stop
```

`proofShotStarted` 在 start 返回后才更新，因此 start 抛错时 finally 只有 server 与
lock 清理。`proofShotStopAttempted` 又让正常路径 stop 抛错后不再尝试其他 Chrome
清理。两个 `runProofShot(["stop"])` 都把页面回收委托给 ProofShot 1.3.x；
FLY-2215 的生产与真机证据已经证明其内部 browser close 会吞错，调用方看不到
泄漏。

此外，ProofShot 1.3.x 的 `stop --no-close` 不能作为共享浏览器安全边界：Commander
把 negated flag 映射到 `options.close=false`，stop 实现读取的却是
`options.noClose`。因此 visual-capture 不能靠该参数同时获得 ProofShot bundle 与
保留共享 browser，必须像 FLY-2215 最终实现一样直接控制 agent-browser。

## 3. 所有权模型

沿用已上线的 “open what you close” 规则：

- start 前用 `agent-browser session list --json` 判断目标 session（
  `AGENT_BROWSER_SESSION`，缺省为 `default`）是否已存在。
- 已存在/未知 session 视为共享：start 前记录可信 tab-id baseline，start 尝试后再
  list，只有集合差中的稳定 `t<N>` id 才可逐个关闭；baseline 不可信就 warning 并
  跳过 tab close。
- session 明确不存在则本次 browser 归当前调用所有；cleanup 直接
  `agent-browser close` 回收整棵树，失败后只对集合差中已识别的 tab id 做
  best-effort fallback。
- 无论 start 返回还是抛错，都尝试 post-state 识别与 recording cleanup；
  `record stop` 失败重试一次。
- session/tab probe、record stop、tab close、browser close 任一失败都只 warning，
  后续清理继续；绝不猜 active tab，绝不关闭 baseline 中的外来 tab。

## 4. agent-browser 有界调用

`publish-report` 与 visual-capture 会共享一个内部 runner，所有
`execFileSync("agent-browser", ...)` 调用统一使用 15 秒常量 timeout。该值恢复
ProofShot 原 stopRecording 的上界，不暴露 env/CLI/config 旋钮；JSON 与非 JSON
调用必须使用同一上限。超时以普通异常进入既有 warning/fallback 语义。

## 5. ProofShot artifact 边界

直接 `agent-browser record stop` 会保存本次 WebM 与既有 screenshot，但不会执行
ProofShot `stopCommand()` 的 SUMMARY/viewer/error bundle 收尾。调用 `proofshot stop`
又可能关闭共享 browser，违反本单最重要的所有权约束。因此计划优先保证不泄漏、
不误关外来页，并让 visual-capture 从已经落盘的 PNG/WebM 生成 manifest；不把
不安全的 ProofShot stop 留在任一路径。

R1 进一步核出当前 visual-capture 的 start/exec session 已经分裂：只有 start 收到
`--output`，exec 从 cwd 读取默认 `proofshot-artifacts`，因此真实 PNG 不在现有 discovery
根中。R2/R3 又证明不能简单把 start cwd 改为 outputDir：UI 的 `--run` 会从该空目录启动
dev server，并稳定失败。最终边界是 start 保持项目 cwd、传绝对 session-root output；
exec 在带最小 local config 的 outputDir cwd 解析到同一 root，再递归发现；零 PNG 必须
fail-loud，不能返回空 manifest。

同时需要只删除本次新建的
`{outputDir}/proofshot-artifacts/.session.json`，避免相同 outputDir 的下一轮被旧
ProofShot state 拦住；若 start 前该文件已经存在，则不把它认作本轮资产。
若设计评审认为 SUMMARY/viewer 是不可退化合同，应在实现前给出独立的安全 finalize
方案，而不是重新启用会关闭共享 browser 的 stop。

## 6. 明确假设

1. Flywheel 的机器级 ProofShot lock 覆盖 preflight、start、capture 与 cleanup，
   所以集合差不会混入另一条 Flywheel capture。它不约束直接 agent-browser 用户；
   post-list 必须紧邻 start，把可能误归属外来新 tab 的窗口压缩到 start 调用本身。
2. agent-browser 0.27.1 的 tab id 在 session 内稳定且不复用，格式为 `t<N>`；只把
   这种 id 传给 close。
3. session list 的 JSON 契约是 `{data:{sessions:string[]}}`，tab list 是
   `{data:{tabs:Array<{tabId,url}>}}`；解析漂移必须 fail safe。
4. `agent-browser record stop` 对本轮 recording 的恢复语义与 FLY-2215 已验证路径相同；
   shared/unknown browser 的 start 若失败，则本轮没有证明建立 recording，不能 stop
   可能属于外部调用方的录制。
5. 真机 page/renderer A/B 属于后续独立 QA；本实现节点提供可执行单测、built bytes
   和明确台架口径，不用 mock 冒充真机验收。

## 7. 验收口径

- 单测证明 start 抛错后仍执行 record-stop 与本轮所有权清理。
- shared session：baseline 外来 tab 存活，只关闭 post-minus-pre 的稳定 tab ids，
  baseline/识别失败时零 close。
- owned session：整树 close；整树失败时只 fallback 关闭已识别的新 tab。
- record stop 最多两次；第一次失败不阻断第二次与 page/browser cleanup。
- publish-report 与 visual-capture 的真实 agent-browser runner 均带 15 秒 timeout。
- start 保持项目 cwd、exec 使用 outputDir cwd但解析到同一 session root；nested PNG 被
  发现且零 PNG fail-loud。
- focused suite、flywheel-comm 全包及规定的全仓 gates 通过。
- 独立 QA 在同台架对 BEFORE/AFTER 各连续 N 次（含一次注入失败），证明 tab 与
  renderer 不随 N 增长、外来 tab 存活、下一轮 start 成功。
