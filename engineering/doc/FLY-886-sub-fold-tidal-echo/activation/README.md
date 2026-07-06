# FLY-886 Activation Bundle — Sub → tidal-echo fold (founder-morning runbook)

Issue: FLY-886 (https://linear.app/geoforge3d/issue/FLY-886)
日期: 2026-07-05
基于: ../plan.md（§4 激活序列 / §5 FLY-876 契约 / §6 QA / §7 回滚）

> ⚠️ **不要今晚跑任何东西。** 全部脚本 dry-run 默认，`--activate` 才执行。
> 激活 = founder 在场的早上窗口，founder 先 merge 两个 PR。Runner 不自 apply、不自 merge、不自重启 Bridge（Lead 指令 9a711f84 硬边界）。

## 交付的两个 PR（founder 早上 merge）

| PR | repo | 内容 |
|---|---|---|
| flywheel #454 | xrliAnnie/flywheel | 设计文档 + 本 activation bundle（脚本 park，不动 runtime） |
| tidal-echo #22 | xrliAnnie/tidal-echo | `.flywheel/config.yaml`（`sub-content` agent）+ sub executor 副本 + Asha identity 副本（root `.lead/sub-lead/`）|

## 激活顺序（不可换 —— plan §4 research §3：Bridge/Asha 必须同窗口对齐，否则 identity 分裂）

```
founder merge 两个 PR
  → 0. cd ~/Dev/tidal-echo && git pull --ff-only        # sub/ 树 + root identity/config 落地
  → 1. drain check（无 active/awaiting sub session；避开 cron 1:00/3:07）
  → 2. ../apply/fold-projects.sh --activate              # projects.json 折（sub→tidal-echo；无 --activate = dry-run）
  → 3. ./transform-asha-manifest.sh --activate           # 新 manifest（projectDir=root）
  → 4/5. ./swap-asha-launchd.sh --activate               # 下线 sub-sub-lead + 归档旧 manifest + 上线 tidal-echo-sub-lead
  → (FLY-876) ./repoint-876-plists.sh --activate          # 6 plist re-point
  → (FLY-876) ./repoint-876-cron-content.sh --activate    # 2 tick + growth-improve 项目引用 sweep（在 ~/Dev/tidal-echo checkout，876 review+commit 为 tidal-echo PR）
  → 6. 批量 Bridge 重启（Annie 纪律；与 team-lead 对齐当批）
  → 7. §6 QA 实证（下）
```

前置门（缺任一 → 停，不强推）：
- `git pull --ff-only` 必须真 ff（gate Q2）；divergence → 停下上报。
- `test -f ~/Dev/tidal-echo/.lead/sub-lead/identity.md`（plan §3.3；缺 = 新 daemon fail-fast crash-loop）。
- `apply/fold-projects.sh` 自带 loadProjects schema 门（失败自动原子还原）。

## 脚本清单（本目录 + apply/）

| 脚本 | 归属 | 作用 | 验证（已跑，dry-run） |
|---|---|---|---|
| `../apply/fold-projects.sh` | FLY-886 | projects.json 折（**dry-run 默认**，`--activate` 才写：单锁临界区 + 原子 swap/rollback + loadProjects 门） | `bash -n` ✅；默认 dry-run（asserts PASS + diff）真文件未动 ✅ |
| `transform-asha-manifest.sh` | FLY-886 | Asha manifest 定向变换（projectDir=root，保 workspace/token/model，去 pid） | dry-run 产出正确 manifest ✅ |
| `swap-asha-launchd.sh` | FLY-886 | uninstall sub-sub-lead + 归档旧 manifest + install tidal-echo-sub-lead | dry-run 打印精确 bootout/archive/install ✅ |
| `repoint-876-plists.sh` | FLY-876 | 6 plist ProgramArguments `~/Dev/sub/...` → `~/Dev/tidal-echo/sub/...` + 重载 | dry-run EDIT×6 ✅ |
| `repoint-876-cron-content.sh` | FLY-876 | **全活跃调用面** sweep（Codex R1 HIGH-2）：2 tick + growth-improve-tick + **growth_dr.py + growth_policy.py + growth/config.json + dryrun_growth_wired.py**（PROJECT/`--project`/projectName/`"project"`/REPORT_CHANNEL/REPO_DEFAULT_CHANNEL/channel_id），前后 protected-token（`sub-lead`/`sub-create`/`sub_create`）计数断言 + grep-zero | dry-run diff 精确、protected tokens 不变（BEFORE==AFTER）、grep-zero PASS ✅ |

**归属说明**：`repoint-876-*` 两脚本按 plan §5/§9 归 **FLY-876**（cron/plist + `~/Dev/sub` 处置）。这里 prep 成脚本让早上激活 turnkey；**有意不烘进 FLY-886 的 tidal-echo PR #22**（保 #22 scope 干净 + 不与 876 自己的 PR 冲突）。`repoint-876-cron-content.sh` 在 `~/Dev/tidal-echo` checkout 改文件后由 876 review + commit 成 tidal-echo PR。
**已知 prose 项（876 顺手清，非阻塞）**：tick 脚本里 `REPORT_CHANNEL=` 上方注释仍写 “#sub generalChannel”，改 ID 后该注释语义过时（1517… 是 #tidal-echo-core）；BRIEF 文本里 “#sub channel $REPORT_CHANNEL” 同理。功能值已对，注释/prose 由 876 清。

## §6 QA 终态实证（激活后必跑，实证非自报 —— gate 批复要求）

1. Asha 在线为 tidal-echo content lead：绿点 + #sub（1511267947551653918）回话；`flywheel-daemon.sh status` 有 `tidal-echo-sub-lead`、无 `sub-sub-lead`。
2. 残留 grep-zero：`projects.json` 无 `"projectName": "sub"`；manifests/ 与 LaunchAgents/ 无 active `sub-sub-lead`。
3. 派一个真 `Sub` label issue → 路由 Asha → runner 起在 `~/Dev/tidal-echo` worktree → Blueprint 选 `sub-content`（prompt 里 agent_file=`.flywheel/agents/content/sub-content-executor.md`）→ 协议在场（style-lint / audio_preview 门），**不是** Ariel 的 generic executor。
4. dispatcher 顺序：构造 `Sub`+`content` 双 label → 选 `sub-content`（YAML 顺序保障；本 runner 已用真 ConfigLoader.load 证 agents 顺序 sub-content→content）。
5. identity 门：pull 后 `test -f ~/Dev/tidal-echo/.lead/sub-lead/identity.md`；`tidal-echo-sub-lead` daemon 启动日志无 “Agent source not found”。
6. Asha 顶层发帖路由：带 issue token 的顶层更新发 #tidal-echo-core（1517041708855197908）→ reply-guard 放行；发 #sub 会被 `channel-top-level` 拒（identity 已语义 sweep 说明）。
7. Triton / Ariel 不受影响（各频道 spot-check）。
8. 记忆延续：Asha 读回折前 mem0 记忆（bucket 按 leadId `sub-lead`，应无损）；session 按新 key fresh start（有意，plan §4）。
9. 夜报链路（876 完成后）：下次 nightly 真产出投递 #tidal-echo-core，reply-guard 放行。
10. 边界：`Sub`+`Tidal-Echo` 双 label → runs-route 判 `multiple` 拒（既有语义，记录非回归）。

## 回滚（plan §7；runner 不自决，founder/Lead 决定）

逐级按激活步骤反向：projects.json 从 `$PJ.bak-fly886-*` 原子还原（走 config lock）→ `rm` 新 manifest → 还原旧 manifest + `flywheel-daemon.sh install sub-sub-lead` → `uninstall tidal-echo-sub-lead` → Bridge 再重启一次 → 876 联动逐项还原（plist 路径 / PROJECT / REPORT_CHANNEL 指回 sub）→ tidal-echo PR revert（identity revert 须与 launchd 回滚同做）。
