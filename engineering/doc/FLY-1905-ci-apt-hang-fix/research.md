# FLY-1905 CI apt 卡死两窗取证 — 调研

Issue: FLY-1905 (https://linear.app/geoforge3d/issue/FLY-1905/ci根因-apt-装包步骤今日两波全仓卡死-调查为何会挂-去-apt-化疑我们侧可修dpkg-锁竞争无超时重试装了本已预装的包)
日期: 2026-08-19
基于: 同文件夹 exploration.md

## 0. 结论保质期(先看这张表)

| 结论 | 会过期吗 | as-of | 重核命令 |
|---|---|---|---|
| tmux/lsof/sqlite3 在 ubuntu-latest 预装、仅 ripgrep 需装 | **会**(随 runner image 演进 / ubuntu-latest 迁移大版本) | image provisioner 20260729.566, ubuntu-24.04 (noble), 2026-08-19 | 看任一最近成功 CI run 的 apt step 输出里的 `already the newest version` 行;或 helper 探针的实跑结果 |
| azure.archive.ubuntu.com 两个故障窗的时刻与形态 | 不会(历史事实) | 2026-08-19 | `gh api /repos/xrliAnnie/flywheel/actions/jobs/<id>/logs` |
| ci.yml 三处 apt 步骤/7 遍每 run | **会**(本单实施后即失效) | commit 0742c4248 | `grep -n apt-get .github/workflows/ci.yml` |
| apt 在该故障形态下 14–18 分钟零输出、不自行退出 | 不会(实测记录) | 2026-08-19 | 本文 §4 引用的原始日志 |

## 1. 取证方法

- `gh run list --workflow ci.yml --created 2026-08-19` 圈定当日 run;
- `gh run view <run> --json jobs` 定位非 success 的 job 与 step 起止时间;
- `gh api /repos/xrliAnnie/flywheel/actions/jobs/<job>/logs` 下载原始逐行日志(带时间戳),读卡死 step 的最后输出行;
- 用同日**成功** run 的同一 step 输出作为预装清单的 ground truth(比 runner-images readme 可靠:它就是这台 image 上 apt 的真实决策)。

## 2. 两个故障窗与受害面

Annie 报的时间(太平洋时间 01:30–02:20 / 09:20–09:45)对应 UTC 实测:

**窗 1 ≈ 08:44–09:12 UTC**,**窗 2 ≈ 16:49–17:23 UTC**(第二窗恢复时刻:17:24 的健康 run 里 azure 源已秒回)。

| run | 分支 | 卡死 job 数 | 明细 |
|---|---|---|---|
| 32229676761(窗1) | flywheel-FLY-1869 | 1 | Unit teamlead 2/3:install step 08:44:27 起卡,15 分钟 job 上限杀 |
| 32234626320(窗1) | flywheel-FLY-1859 | **7(全部)** | 5 个 unit shard(08:52:19–27 起卡,15min 杀)+ 2 个 script shard(08:53:44/49 起卡,20min 杀) |
| 32277981897(窗2) | flywheel-FLY-1869 | 2 | Unit light(16:49:27 起卡)+ Script Tests 2/2(16:50:30 起卡) |
| 32229506396(窗2) | flywheel-FLY-1877 | 1 | Script Tests 1/2:17:04:40 起卡,20min 杀 |

合计:**11 个 job 被 timeout 杀死,≈187 runner-minutes 纯烧**(6×15min + 4×20min + 零头),4 个 run 全部需要人工重跑(重跑又是一次全量 CI)。

## 3. 卡点铁证:卡在 `apt-get update` 抓 azure.archive.ubuntu.com,不是 dpkg 锁

以窗 1 的 Script Tests 2/2(job 96011956097)为例,原始日志逐行:

```
08:53:49.528  ##[group]Run sudo apt-get update && sudo apt-get install -y tmux lsof sqlite3 ripgrep
08:53:49.675  Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist [144 B]
08:53:49.706  Get:6 https://packages.microsoft.com/repos/azure-cli noble InRelease [3564 B]     ← MS 源秒回
08:53:50.062  Get:13 https://dl.google.com/linux/chrome-stable/deb stable/main amd64 Packages  ← Google 源秒回
08:54:19.985  Ign:2 http://azure.archive.ubuntu.com/ubuntu noble InRelease                     ← 30 秒后开始 Ign
08:54:20.986  Ign:3 http://azure.archive.ubuntu.com/ubuntu noble-updates InRelease
...(对 noble/noble-updates/noble-backports/noble-security 的 InRelease 与
    Packages/Translation/Components 索引反复 Ign,共 26 行)...
08:54:28.172  Ign:23 http://azure.archive.ubuntu.com/ubuntu noble-updates/multiverse amd64 Components
              ——— 此后零输出 17 分 46 秒 ———
09:12:14.727  ##[error]The operation was canceled.   (job 20 分钟上限)
```

三个独立卡死 job 的同一形态:

| job | step 开始 | 最后输出(全是 azure Ign 行) | 被杀 | 静默时长 |
|---|---|---|---|---|
| 96011956097(script-2,窗1) | 08:53:49 | 08:54:28 | 09:12:14 | **17m46s** |
| 96011956220(unit shard,窗1) | 08:52:23 | 08:53:01 | 09:07:13 | **14m12s** |
| 96154300233(script-1,窗2) | 17:04:40 | 17:05:19 | 17:23:19 | **18m00s** |

判定:
- **假说②成立**:卡点全部在 `apt-get update` 对 `http://azure.archive.ubuntu.com/ubuntu`(Azure 内部 Ubuntu 镜像)的抓取;同一 step 里 Microsoft / Google 的源毫秒级返回 → 不是 VM 网络整体故障,是该镜像端点的故障窗。
- **假说①不成立(本次)**:apt 输出停在网络抓取阶段(Get/Ign),从未进入 dpkg 阶段;日志里没有任何 `Waiting for cache lock` 迹象。dpkg 锁竞争不是这两窗的根因(防御性的 `DPkg::Lock::Timeout` 仍值得加,但要如实定位为防御,不是本次病因)。

## 4. 跨 VM 同步性 + image 版本对照 → 定性为外部镜像故障窗

- 窗 1 的 run 32234626320:**7 个 job = 7 台独立 VM,同一分钟内全部卡死**在同一端点。若是单机 dpkg 锁/单机网络问题,不可能跨 7 台 VM 同步;时间相关的跨机同发指向共享外部依赖(azure archive 镜像)。
- 三个取证 run(窗1卡死 / 窗2卡死 / 窗2恢复后 10 分钟的健康 run 32281227377)的 runner image **完全相同**(provisioner 20260729.566, commit cf7153fe)→ 排除 image 回归;同一 image 在 17:24 对同一端点 `Hit: ... noble InRelease` 秒回 → 端点恢复了,故障是时间窗性质。
- 外部佐证:azure.archive.ubuntu.com 抖动/挂死是 actions/runner-images 多年反复的已知问题类(#675、#6894、#7048、#12949 等),官方 workaround 一直是「换 archive.ubuntu.com / 加超时重试」,并无根治承诺 → **必须假设它还会再发生**。

## 5. 关键机制事实:apt 自身的超时没有救场,不能作为唯一防线

实测:三个 job 在最后一行 `Ign` 之后 **14–18 分钟零输出、零自行退出**,直到被 job `timeout-minutes` 外杀。apt 并非没有超时机制(http 抓取有默认 timeout,`Ign` 行本身就是它在重试),但在「mirrorlist(`file:/etc/apt/apt-mirrors.txt`)+ 端点半死不活」这种真实故障形态下,它的内部重试/等待组合表现为**实际上的无限挂**。内部具体是重试循环还是连接假活,日志无法分辨,也不需要分辨——对策必须对两者都有效:

1. **外部 `timeout(1)` 硬闸包住每条 apt 命令**(不信任 apt 的内部超时);
2. **step 级 `timeout-minutes`** 作为第二道外闸(错误落在具名 step,不再烧到 job 上限);
3. `Acquire::Retries` / `Acquire::http::Timeout` / `DPkg::Lock::Timeout` 作为 apt 内参数尽力收紧(有益但不作为保证)。

## 6. 预装 ground truth:比 issue 假设更彻底

同日健康 run 32281227377(同一 image)Script Tests 1/2 的 apt step 真实输出:

```
tmux is already the newest version (3.4-1ubuntu0.1).
lsof is already the newest version (4.95.0-1build3).
sqlite3 is already the newest version (3.45.1-1ubuntu2.7).
The following NEW packages will be installed:
  ripgrep
0 upgraded, 1 newly installed ... Need to get 1551 kB of archives.
```

- issue 猜「真正缺的可能只有 tmux」——实际 **tmux 也预装了**(3.4);tmux、lsof、sqlite3 全部预装。
- **唯一真需要安装的是 ripgrep**(14.1.0-1,1.5MB,noble/universe)。ci.yml:202 的注释「ripgrep is NOT preinstalled」仍然正确;但它旁边的 tmux/lsof/sqlite3 已随 image 演进变为预装,注释与步骤没有跟上。
- 推论:**unit-tests 的 apt 步骤(×5 shard)是 100% 无用功**——lsof、tmux 都预装,却为此每次跑一遍全量 `apt-get update`(网络暴露面最大的操作)。两个 script shard 也只为一个 1.5MB 的包各跑一遍全量 update。
- ripgrep 在 noble 系列无 -updates/-security 顶替版本(仍是发布版 14.1.0-1)→ 用 image 烘焙的本地 apt 索引直接 `install`(跳过 update)404 风险极低;万一 404,fallback 一次 update 即可。

## 7. 回答 Annie 的问题:「是我们这里有什么问题吗?」

**触发在外部,放大在我们侧。**

- 触发者:azure.archive.ubuntu.com 当日两个故障窗(GitHub/Azure 侧,已知反复病,不可控)。
- 放大者(我们侧,三条,全部可修):
  1. **不需要装的包也在装**:7 遍 apt 里 5 遍(unit shards)完全无用,另外 2 遍中 3/4 的包无用;
  2. **每遍都跑全量 `apt-get update`**:把最脆弱的操作(抓 4 个 azure 源索引)执行了 7 次,而真实需求只是下载 1 个 1.5MB 的 deb;
  3. **零超时/零重试/零 fail-fast**:唯一止损是 15/20 分钟的 job 上限,故一次镜像抖动 = 11 个 job × 满额烧完 + 全部人工重跑。

## 8. 风险与边界

- 修复后,若镜像故障窗恰好覆盖 fallback(连 archive.ubuntu.com 也不可用),ripgrep 装不上,script shard 仍会失败——但是在 **~2–6 分钟内、具名 step 上、带清晰错误信息**地失败,而不是 20 分钟静默烧完。「镜像全网死时 CI 仍绿」不在本单目标内(那需要 vendor 化 rg 或去 rg 依赖,见 exploration.md 选项 D/F)。
- 预装清单是会过期的事实(§0):设计必须让「预装假设失效」表现为可自愈(探针发现缺失 → 走加固安装路径),而不是 CI 无解释变红。

## 9. 下一步

→ plan.md:helper 合同、ci.yml 三处替换、ci-structure guard 翻转(从「必须有 apt-get update」翻成「禁止裸 apt-get update」)、hermetic 验收(注入挂死/锁占用模拟)。
