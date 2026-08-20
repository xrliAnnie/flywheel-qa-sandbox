# FLY-1905 CI apt 装包步骤两波全仓卡死 — 探索

Issue: FLY-1905 (https://linear.app/geoforge3d/issue/FLY-1905/ci根因-apt-装包步骤今日两波全仓卡死-调查为何会挂-去-apt-化疑我们侧可修dpkg-锁竞争无超时重试装了本已预装的包)
日期: 2026-08-19
基于: 无

## 1. 背景与直令

Annie 直令(2026-08-19,FLY-1877 thread):「GitHub 托管 runner 的装包步骤为什么会坏?看起来是我们这里有什么问题,你需要去研究一下。」

实况:今日两个故障窗(她的时间约 01:30–02:20 与 09:20–09:45),多分支多 job 卡死在
`Install tmux/lsof/sqlite3/ripgrep`(`sudo apt-get update && sudo apt-get install -y ...`),
14–20 分钟零输出直至撞 job 的 `timeout-minutes` 上限被杀。

## 2. 问题框定 — 两层问题

把「为什么会坏」拆成两个独立问题,答案不同:

- **触发者(trigger)**:是什么让 apt 在那两个窗口里挂住?
  → 外部因素(镜像源 / VM 状态),我们不可控,但可以取证定性。
- **放大者(amplifier)**:为什么一次 apt 挂住 = 烧满 15–20 分钟 × N 个 job?
  → 我们侧的结构问题,完全可修。这是本 issue 的真正交付面。

「是我们这里有什么问题吗?」的准确回答形态应当是:**触发在外部,放大在我们侧**(待 research 证实)。

## 3. 现状盘点(代码事实)

`.github/workflows/ci.yml` 有 3 处 apt 步骤,每次 CI 共跑 **7 遍**:

| 位置 | job | 每次 CI 跑几遍 | 命令 |
|---|---|---|---|
| ci.yml:147 | unit-tests(5 个 matrix shard) | 5 | `sudo apt-get update && sudo apt-get install -y lsof tmux` |
| ci.yml:210 | script-tests | 1 | `sudo apt-get update && sudo apt-get install -y tmux lsof sqlite3 ripgrep` |
| ci.yml:402 | script-tests-2 | 1 | `sudo apt-get update && sudo apt-get install -y tmux lsof sqlite3 ripgrep` |

特征:
- 每一遍都跑全量 `apt-get update`(拉 4 个 azure archive 源的 InRelease + 索引 —— 网络暴露面最大的一步);
- 零超时、零重试、零 fail-fast:唯一的止损是 job 级 `timeout-minutes`(15 / 20 分钟);
- 注释(FLY-889 时代)声称 ripgrep 非预装 —— 但没有声明 tmux/lsof/sqlite3 的预装状态是否已随 image 演进改变。

其它 workflow(ship-on-comment / payload-*)零 apt 使用,影响面只在 ci.yml。

## 4. 三个工作假说与证伪路径

| # | 假说 | 证伪路径 | 探索结论(research.md 落实证据) |
|---|---|---|---|
| ① | dpkg 锁竞争(unattended-upgrades / cloud-init 持锁,apt 静默等锁) | 看卡死 step 日志:卡点若在 dpkg 阶段(`Waiting for cache lock`)则成立 | **不成立**:两窗全部卡在 `apt-get update` 的网络抓取阶段,输出停在 `Ign: azure.archive...`,根本没走到 dpkg |
| ② | 镜像源 stall 且无超时兜底 | 看卡点是否停在对 azure.archive.ubuntu.com 的抓取;跨 VM 同步性;image 版本对照 | **成立,即根因**:见 research.md §3–§5 |
| ③ | 装了本已预装的包 | 从健康 run 的同一 step 输出读 `already the newest version` 行(镜像 ground truth) | **成立且比预想更狠**:tmux、lsof、sqlite3 全部预装,唯一真需要装的是 ripgrep(见 research.md §6) |

## 5. 修复方向选项与取舍

| 选项 | 内容 | 判断 |
|---|---|---|
| **A. 净删除** | 预装包不再装:unit-tests 的 apt 步骤整个删掉,换 `command -v` fail-closed 探针 | ✅ 采纳。5/7 的 apt 执行直接归零;FLY-1759 的 fail-closed 语义由探针保留 |
| **B. 剩余安装加固** | ripgrep 仍需装:跳过 `apt-get update`(用 image 烘焙 index 直接 install)+ `DPkg::Lock::Timeout` + `Acquire::Retries/Timeout` + 外部 `timeout(1)` 硬闸 + 失败后一次 fallback(换 archive.ubuntu.com 镜像 + update + install) | ✅ 采纳。常态网络面从「4 源全量 update + install」缩到「1 个 1.5MB deb」 |
| **C. step 级 timeout** | apt 步骤加 `timeout-minutes`,早于 job 上限死、错误落在具名 step 上 | ✅ 采纳。双保险外闸(实测 apt 自身超时机制在本次故障形态下没有救场,见 research.md §5) |
| D. 去 ripgrep 依赖 | 把用 `rg` 断言的 shell suite 改写成 `grep -E`(FLY-1773 有先例) | ❌ 本单不做。涉及多个 test suite 的语义改写,scope 远大于 CI 步骤修复;留作后续独立收益 |
| E. 换 runner image / 容器化 | 自带依赖的 container job 或 self-hosted | ❌ 拒绝。为一个 1.5MB 包引入整套镜像维护/拉取面,过度工程 |
| F. 缓存 .deb(actions/cache) | 缓存 ripgrep deb 文件 | ❌ 拒绝。cache 命中率与恢复开销换一个 1.5MB 下载不划算,还多一层失效逻辑 |

**采纳组合:A + B + C**,收敛为一个共享 helper(`scripts/ci-apt-install.sh`)+ ci.yml 三处替换 + guard 翻转(ci-structure 从「必须有 apt-get update」翻成「禁止裸 apt-get update」,防回归)。

## 6. 简单性自检(Annie:修结构,删的比加的多)

- 删:每次 CI 的 7 次 `apt-get update`(全部)、5 个 unit shard 的 install(全部);
- 加:一个小 helper + 一个 hermetic 测试 + step timeout 数字;
- 常态 CI 的 apt 网络调用:7 次 update + 7 次 install → **0 次 update + 2 次单包 install**(且带硬闸)。

## 7. 下一步

→ research.md:两窗 runner 日志完整取证 + 预装 ground truth + 外部佐证。
→ plan.md:实施计划(helper 合同、ci.yml 三处替换、guard 翻转、hermetic 验收)。
