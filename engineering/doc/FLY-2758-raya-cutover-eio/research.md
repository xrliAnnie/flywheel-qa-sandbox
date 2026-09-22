# FLY-2758 Raya 割接 bootstrap EIO — 调研
Issue: FLY-2758 (https://linear.app/geoforge3d/issue/FLY-2758/raya上线阻塞-09-19-0009-班车割接失败-cutover-failed15-项-preflight-全-pass但)
日期: 2026-09-22
基于: exploration.md

## 涉及代码

| 文件 | 角色 | 关键点 |
| --- | --- | --- |
| `scripts/lib/supervisor.sh` `_sup_darwin_install` (L178–244) | 渲染 plist 并 bootout→bootstrap | 只有 `FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1` 时走真实 darwin 安装；bootout 后零等待直接 bootstrap |
| `scripts/flywheel-lead.sh` `install_lead` (L800–824) | public `install` 动词 | preflight → 拼 spec → `supervisor_install` → plist 形状校验；`load_supervisor` 优先 `~/.flywheel/bin/lib/supervisor.sh`（生产机**不存在**），回退 `${FLYWHEEL_DIR}/scripts/lib/supervisor.sh` |
| `scripts/flywheel-lead.sh` `verify_lead` | `--stage live` | `#7` 要求 `launchctl print` 恰好一个 `state = running` + 一个 pid；`#8` inbox socket |
| `scripts/lib/updater-raya-deploy.sh` `raya_standard_cutover` (L510–593) | P2–P7 状态机 | P4b 两臂：preexisting = `verify live → install → 持久化 lead_restart_installed_at → wait_live(30×2s)`；fresh = `preflight → install → verify installed` |
| 同上 `raya_fail` (L1246) | 失败终态 | 写 failed 回执 + severe 告警 + 释放锁；无恢复 |
| 同上 `raya_write_standard_receipt` (L728) | v2 回执 | key 集合被 `raya_receipt_keys_valid` 冻结；`state` 参数支持 `deployed/current/rolled_back/failed` |
| `scripts/update-flywheel.sh` `raya_alert_dispatch` (L114) | 告警映射 | severe→`deploy_failed`(mention founder)、warning→`deploy_degraded`；正文自由 |
| 同上 `updater_observation_record_raya` (L254) | 班车观测 | `state` 非枚举值时按 `detail ∈ {source-prepare-failed,cutover-failed,proof-invalid,finalize-failed}` 归类为 failed；`cutover-failed` 已在 `scripts/lib/shuttle-reasons.json` 注册 |
| `scripts/lib/lead-restart-lifecycle.sh` `lead_restart_wait_quiescent` / `lead_restart_launchd_probe` | restart 路径的正确做法 | `launchctl print` 报 `could not find service|no such process` = unloaded；再要求旧 pid 死；30×1s |

## launchd 行为（Layer 1，已被本仓 restart 路径实证）

* `launchctl bootout gui/<uid>/<label>` 对运行中的服务：发 SIGTERM，超过 `ExitTimeOut`（默认 20s）发 SIGKILL，随后才把 label 从 domain 摘除。命令本身可以在服务退出前返回。
* 在 label 仍在 domain（teardown 中或仍 loaded）时 `launchctl bootstrap` 同一 label：返回 `5: Input/output error`（macOS 13+ 上常见形态；旧版本是 `37: Operation already in progress`）。两种情况的正确处理一致：**等 label 消失再 bootstrap，失败有界重试**。
* `launchctl print` 在 label 不存在时 stderr 是 `Could not find service "<label>" in domain for user gui: <uid>`，rc≠0；本仓 `lead_restart_launchd_probe` 已用 `could not find service|no such process` 作为 unloaded 判据，复用同一字符串集。

## 现有测试夹具与影响面（`git grep` 结果）

| 夹具 | 现状 | 本单影响 |
| --- | --- | --- |
| `scripts/__tests__/supervisor.test.sh` | S1–S7；darwin 只测 lifecycle 动词分发，**没有** `_sup_darwin_install` 用例 | 新增 S8–S10：等待 label 消失后才 bootstrap、label 不消失也有界、bootstrap 持续失败有界重试 |
| `scripts/__tests__/flywheel-lead.test.sh` | L695 桩 `launchctl` 一律 rc0 无输出；L901 桩 `print` 恒 `state = running pid = 4101`；四处 `install`（L724/736/791/1076） | 桩对 `print` 恒 rc0 会被新逻辑判为「仍 loaded」→ 等满预算。改桩：记录 `bootout` 后对该 label 的 `print` 回 `Could not find service` rc1，直到下一次 `bootstrap`。L791 断言 preflight 失败零 launchctl 调用，不受影响 |
| `scripts/__tests__/updater-raya-deploy.test.sh` | preexisting 臂三组夹具（L985–1110）用 `raya_standard_lead` 函数桩记录调用序列 | 新增 install 失败三态（live 仍在 / 恢复成功 / 恢复失败）与 fresh 臂 install 失败；`updater_raya_pass` 级断言回执 `outcome` 与告警正文 |
| `scripts/__tests__/fly2264-verify-native-cutover.test.sh` L338 | 桩只允许 `print` | 不调用 install，排除 |
| `scripts/__tests__/flywheel-lead-packaging.test.sh`、`codex-home-launch-fence.test.sh`、`converge-*.test.sh`、`fly1446-*`、`fly1577-*`、`fly1663-bridge-launchd.test.sh` | 引用 supervisor.sh 仅为打包/收敛清单或 bridge spec | 不走 `_sup_darwin_install` 的 bootout→bootstrap，排除；跑一遍 `fly1663-bridge-launchd` 与 packaging 做阴性对照 |
| CI | `ci.yml` L552 `flywheel-lead.test.sh`、L580 `updater-raya-deploy.test.sh`；`supervisor.test.sh` 需确认所在 shard | 不改 shard 布局 |

## 设计选项

### 选项 A（采用）：supervisor 层等待 + 重试，raya 层失败恢复

* `_sup_darwin_install`：bootout 前读旧 pid；bootout 后轮询「label 不在 domain 且旧 pid 已退出」，默认 40×1s（大于 20s ExitTimeOut）；超预算记 warning 仍进入 bootstrap（bootstrap 自身是最终裁决）；bootstrap 默认 5 次、间隔 2s，rc 与 stderr 原样透出。
* `raya_standard_cutover` P4b：install 失败 → `raya_recover_standard_lead_after_install_failure`：若 `verify live` 仍过 → `not_needed`；否则再 `install` 一次并 `wait_live(30×2s)` → `restored` / `not_restored`。
* `raya_fail`：按恢复结果写回执 `state=rolled_back`（restored）或 `failed`，告警正文明确写「已恢复，Raya 仍可对话」或「**未恢复，Raya 离线**」。`RAYA_DEPLOY_DETAIL` 保持注册过的 `cutover-failed`，观测分类不变。

优点：根因与恢复解耦；所有 Lead 的 install 受益；回执 schema 与 shuttle 观测 key 零改动。缺点：install 最坏多等 ~50s，在班车 60s live 等待量级内。

### 选项 B：P4b 改用 `launchctl kickstart -k`（原地重启）代替 install

避开 bootout/bootstrap，但 launchd 不重读 plist，plist 变更（carrier/manifest 路径）时失效；且不修其他 Lead 的 install。否决。

### 选项 C：仅在 raya 层 install 前先 `stop` 再等

只修 Raya 一处，supervisor 的竞争仍在（下一个走 install 的 Lead 会撞同样的 EIO）。否决。

## 风险与边界

* `flywheel-lead.test.sh` 桩若不改，新逻辑会把恒 rc0 的 `print` 当 loaded，四次 install 各等满预算；测试内用 `FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_INTERVAL=0` 之类的环境覆盖只解决时长不解决语义，所以改桩为状态化（bootout 后 absent）。环境覆盖只接受非负整数并有默认值，不接受路径类覆盖。
* 恢复用的 `install` 会再跑一次 preflight（秒级、只读）与 plist 重写（内容确定性相同）；这是现有 public 动词，不新造 bootstrap 旁路。
* 生产部署面：生产机 `~/.flywheel/bin/lib/supervisor.sh` 不存在，`flywheel-lead.sh` 回退到 `${FLYWHEEL_DIR}/scripts/lib/supervisor.sh`，合并进 main 后由 updater 拉取即生效；`~/.flywheel/bin/flywheel-lead.sh` 由 converge-bin 收敛（当前与仓库一致，实测 `diff -q` SAME）。
* 本节点不运行班车、不 bootstrap 生产 label、不改账本、不写生产回执。
