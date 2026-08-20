# FLY-1905 CI 去 apt 化 + 剩余安装加固 — 独立 QA 报告

Issue: FLY-1905 (https://linear.app/geoforge3d/issue/FLY-1905/ci根因-apt-装包步骤今日两波全仓卡死-调查为何会挂-去-apt-化疑我们侧可修dpkg-锁竞争无超时重试装了本已预装的包)
日期: 2026-08-19
基于: 同文件夹 plan.md(v4.1)

## 0. 判决

**PASS** — 被验 head `bcff11a7e94140ad251f05b1084e32055de92b50`(= PR #897 head = origin/flywheel-FLY-1905,非 draft)。

QA 不复述实现者的自述结论,以下每一条都由本 QA 独立重跑 / 独立取证得到。

## 1. Discord 面声明(529 N-to-N 判定)

**本改动无 Discord surface —— 免 529 N-to-N,不是跳过。**

diff 只触及:`.github/workflows/ci.yml`、`scripts/ci-apt-install.sh`(新)、
`scripts/__tests__/ci-apt-install.test.sh`(新)、4 个 CI guard 文件、doc、CLAUDE.md 里程碑行。
零 packages 生产源码改动(唯一 packages 侧改动是 guard 测试文件 `fly-889-ci-workflow-timeout-guard.test.ts`)。
不涉及 send / relay / render / founder 交互 / roundtable / 跨-Lead 协调任何一项。

替代验证面:**真实 GitHub Actions runner 上的真机 CI 跑**(§2)+ 本机 bash 3.2 真跑 hermetic 套件(§3)
+ 变异检验(§4)+ 故障窗原始日志独立取证(§5)。

## 2. 真机自证(plan §5 硬验收)— PASS

exact-head CI run **32317772748**(headSha = bcff11a7e…,11 jobs 全 success)。
本 QA 直接从 GitHub API 拉每个 job 的原始日志取证(注:`gh run view --job <id> --log` 在本机
静默返回空且 rc=0 —— 仪器失效,改用 `gh api /repos/.../actions/jobs/<id>/logs` 才拿到真日志;
"没看到 helper 行"一度是假阴性)。

| job | 角色 | helper 结论 | fallback 行 |
|---|---|---|---|
| 96295639883 Unit (light) | 5 unit shard | `phase=complete status=ok apt_calls=0` | 0 |
| 96295639920 Unit (heavy) | ↑ | `apt_calls=0` | 0 |
| 96295639060 Unit (teamlead 2/3) | ↑ | `apt_calls=0` | 0 |
| 96295661082 Unit (teamlead 1/3) | ↑ | `apt_calls=0` | 0 |
| 96295665675 Unit (teamlead 3/3) | ↑ | `apt_calls=0` | 0 |
| 96295666835 Script Tests 1/2 | script shard | `phase=fast-install packages=ripgrep status=ok` | **0** |
| 96295639737 Script Tests 2/2 | script shard | `phase=fast-install packages=ripgrep status=ok` | **0** |

plan §5 的硬条款「两个 script shard 必须见 fast-install 成功 且 零 fallback」**成立**
→ 「烘焙索引可直装」不再是假设,是真机事实。

真机探针实测值(同时独立复核 research §6 的预装 ground truth):
`tmux 3.4 ≥3.2` · `lsof 4.95 ≥4.93` · `sqlite3 3.45 ≥3.37` 全部预装;`ripgrep` **binary-missing** → 唯一真装的包。

**步骤耗时前后对照(真实数据,不是估算)**

| | apt/依赖步骤耗时 | 每次 CI 的 `apt-get update` 次数 |
|---|---|---|
| 改前(main 健康 run 32325009513 / 32317350485) | 7 步合计 **81s / 85s** | **7** |
| 改后(PR head run 32317772748) | 5×**0s** + 2×**4s** = **8s** | **0** |

时间只省 ~75 runner-秒/run(小);**真正的交付是暴露面**:7 次「对 4 个 azure 源全量 update」→ 0 次,
剩 2 次单包安装且带外部硬闸。这与 §5 的事故账(一天烧 ≈187 runner-分钟)才是同一个量级。

新增测试 step `Test — FLY-1905 CI apt-install helper` 在 script-tests-2 真跑,25s success
(与 ci.yml 的 FLY-1870 秒数记账 `1905=25` 一致)。

## 3. Hermetic 套件本机真跑(macOS `/bin/bash` 3.2.57)— 14/14 PASS

```
ci-apt-install.test: 14 passed, 0 failed        (~35s)
```
`bash -n` 语法检查:helper + suite 均过。`shellcheck -S style scripts/ci-apt-install.sh`:**零告警**。
所有 `((...))` 用法都带 `|| ...` 守卫 —— 无 `set -e` 下的静默自杀路径。

**真工具(非 stub)阳性对照**:在本机用真 tmux 3.5a / sqlite3 3.51.0 / ripgrep 15.1.0 直接跑 helper,
版本解析全部正确(`3.5a`→3.5 的字母后缀形态、sqlite3 首段日期串形态都吃下了),
输出 `apt_calls=0` rc=0 —— 解析器不是只在 stub 版式上成立。

## 4. 变异检验(证明测试与 guard 不是空过绿)

**先证尺子**:M0 把 sandbox helper 改成开头 `exit 7` → 18 项断言变红 ⇒ 套件确实在测 sandbox 副本,
而不是仓内那份(否则后续所有变异结果作废)。

### 4.1 helper 变异 7/7 全被抓

| 变异 | 结果 |
|---|---|
| M1 去掉 `--reinstall` | T2 / T9 / T10 红(Codex R1-1 的恢复链断裂被抓) |
| M2 去掉 `-o Acquire::https::Timeout=15` | T2 红(逐字键断言生效,不是宽松子串) |
| M3 去掉外部 `timeout(1)` 包裹 | T3 红,**rc=124 = 被 harness 的独立真 GNU timeout 杀掉** ⇒ 反自挂 watchdog(Codex R1-2)真的在工作 |
| M4 终探针恒真 | T7 / T11 / T14 红 |
| M5 放开 `--timeout-secs 0` | T13 红(`unsafe argv reached privileged path`) |
| M6 跳过 fast-verify(只信 apt 返回码) | T7 / T12 红 |
| M7 快路里加回 `apt-get update` | T2 / T3 / T5 / T8 红 |

### 4.2 CI guard 变异 10/10 全被抓(在 `git archive HEAD` 出的干净沙箱树上做,仓内文件零改动)

| 变异 | 被哪个 guard 抓 |
|---|---|
| G1 script-tests 换回裸 `apt-get update && install` | ci-structure:`must have exactly one ci-apt-install helper step, got 0` |
| G2 删 helper step 的 `timeout-minutes` | ci-structure:`timeout-minutes must be in 1..8` |
| G3 helper 参数里去掉 ripgrep | ci-structure:`helper step must ensure ripgrep` |
| G4 删掉 unit-tests 的 helper step | ci-structure:`unit-tests must have exactly one ci-apt-install helper step` |
| G5 删掉新测试 step | ci-structure:`script-tests-2 test inventory/order drifted` |
| G6 另加一个裸 `apt-get install jq` step(helper 仍在) | ci-structure:`step run text must not contain bare apt-get` |
| G7 helper 参数顺序改写(旧空过绿陷阱) | `wiring.test.mjs` 红(`assert.ok(dependencyStep >= 0)` 修复生效 —— 改前这里会静默绿) |
| G8 unit helper 参数顺序改写 | `test-worktree-removal-contract.test.sh` 红 |
| G9 另加裸 apt-get step | `fly-889-ci-workflow-timeout-guard.test.ts` 红 |
| G10 删 helper step timeout-minutes | 同上,红 |

其余 guard 本机基线全绿:worktree-removal-contract 7/7、shell-suite-enumeration(192 suites 全分类)、
cycle-time wiring 2/2、fly-889 guard 4/4。

## 5. 事故根因独立取证(不采信实现者转述)

本 QA 自己从 GitHub API 重拉了故障窗的原始 job 日志:

| job | 最后一行输出 | 被杀 | 静默时长 |
|---|---|---|---|
| 96011956097(窗1 script-2) | `08:54:28.17 Ign:23 http://azure.archive.ubuntu.com/ubuntu …` | `09:12:14.73 The operation was canceled` | **17m46s** |
| 96154300233(窗2 script-1) | `17:05:19.21 Ign:12 http://azure.archive.ubuntu.com/ubuntu …` | `17:23:19.81 The operation was canceled` | **18m00s** |

两份日志里 `Waiting for cache lock` 出现次数 = **0**(同一 grep 能命中 azure 行 ⇒ 尺子有效)。
⇒ **假说①(dpkg 锁竞争)在这两窗不成立**;卡点全在 `apt-get update` 抓 azure 镜像的网络阶段。
plan/research 把 `DPkg::Lock::Timeout=60` 如实标为「防御项、非本次病因」,口径正确。

受害面独立复核(需按 attempt 查,因为 4 个 run 事后都被人工重跑、latest-attempt 视图已变绿):
- run 32229676761:1 job cancelled 15.3min
- run 32234626320:**7 job 全 cancelled**(5×15.3 + 2×20.4 min)
- run 32277981897 attempt 1:2 job cancelled(20.3 + 15.3)
- run 32229506396 attempt 1:1 job cancelled(20.3)

合计 11 个卡死 job ≈ **188 runner-分钟**,与 research 的「11 job / ≈187 分钟」吻合(且是下界 —— 32229506396
共 6 次 attempt,不止一次撞到窗口)。

## 6. 产品可用性视角(谁在用、这条流对不对)

- **用户 A:被 CI 挡住的工程 Runner / Lead。** 改前:镜像抖动 = 7 个 job 各自静默烧满 15–20 分钟、
  必须人工重跑。改后:5/7 job 完全不碰网络(实测 0s),2/7 走单包直装(实测 4s);
  真出故障时最坏 ~6.5 分钟具名失败(hermetic T3/T4 证)。**流是对的。**
- **用户 B:付 runner 分钟的 Annie。** 上面的前后对照就是账。
- **verify-then-skip 而不是 assume-and-skip**(Annie 的原始质疑「万一装了但版本不对呢」):
  真机日志逐包打印了实测版本与下界,**每一次跳过安装都带验证记录**;
  变异 M4/M6 证明去掉验证会立刻变红。这条产品语义是真的,不是文档措辞。

## 7. 诚实边界(没测的、为什么、风险、何时补)

1. **fallback 路径(换镜像 → update → install)从未在真 GitHub runner 上跑过。** 只有 hermetic
   stub(T5/T8/T11/T12)覆盖。原因:无法让 azure 镜像按需故障。风险:真故障窗到来时 fallback
   首次上真机;失败模式是「~6.5 分钟具名失败」而非挂死(外部 timeout 已由 T3 的真 GNU timeout 证),
   所以风险是「可能救不回来」,不是「又挂 20 分钟」。补测时机:下一次真实镜像故障窗的日志即天然验收。
2. **`--reinstall` 只在「包缺失」形态上过了真机**(ripgrep binary-missing → fast-install ok)。
   「包在但坏 / 版本低」触发的 `--reinstall` 只有 stub 覆盖(T9/T10)。
3. **helper 未设 `DEBIAN_FRONTEND=noninteractive` / dpkg conffile 选项。** `--reinstall` 理论上会
   放大 conffile 提示面;真发生时被外部 `timeout` 兜成有界失败而不是挂死。列为 LOW advisory,
   不阻塞(见 §8)。
4. **版本下界表的 rationale 是「Ubuntu 22.04 LTS 基线」而非逐 suite 用法考古。** 下界过低只会退回
   现状(工具老 → 后面的 suite 自己红),不会产生新的失败模式;不构成回归。
5. **未跑本机全量 `pnpm test:packages:run`** —— 记忆规矩:全量 vitest 会压垮本机生产 Bridge。
   全仓门以 exact-head CI run 32317772748 的 Quick Gate(build + typecheck + lint)+ 11 job 全绿为准,
   那比本机跑更可信。

## 8. 转报 Lead 的 advisory(不阻塞 PASS)

- **LOW-1**:`scripts/ci-apt-install.sh` 未设 `DEBIAN_FRONTEND=noninteractive`(及
  `-o Dpkg::Options::=--force-confold`)。当前由 `timeout` 兜底成有界失败,建议后续补上以减少
  `--reinstall` 的 conffile 提示面。
- **LOW-2**:`flywheel-comm stage set` 的合法值里没有 `qa`,但 `progress --phase` 的权威映射
  (`packages/config/src/progress-schema.ts` QA_STAGES)是认 `qa` 的 —— QA 节点无法把 stage 置成
  与 `--phase qa` 相容的值(只能停在 `test`⇒phase=implement)。属 CLI 一致性小坑,与本单无关。

## 9. QA 方法与工具失效记录

- `gh run view --job <id> --log` 在本机对本 run **静默返回空且 rc=0**;若照此判读会得出
  「helper 没有输出」的假阴性。改用 `gh api /repos/.../actions/jobs/<id>/logs` 后拿到完整日志。
  凡本报告引用的 CI 日志,均出自后者。
- 所有变异检验都在 `git archive HEAD` 生成的独立沙箱树(以及 helper 的独立副本)上做,
  **仓内工作树零改动**(`git status --porcelain` 在 QA 全程只出现本 QA 自己的文档/进度提交)。

## 10. Founder ship-report(已发布,待 Lead 代投)

- hosted URL: https://fw-reports-a53de2.vercel.app/r/423d61e2a5d532b556683aeac2d30c15/
- 发布方式:`flywheel-comm publish-report --publish-only`(FLY-1719:runner 无投递权限,
  正路 = 出 URL 交 Lead 投进 `[FLY-1905]` issue thread)。`delivered:false` 是该路径的预期值,不是失败。
- 交付前实测(playwright,本机 + hosted 两处):
  - 页面高度 **5949px**(founder HTML ≤6000px 硬线)· 宽视口零横向溢出;
  - 3 张 Mermaid 图已用 `mmdc` 预渲染为 inline SVG(模板样板图与 529 GIF 占位图两个已知陷阱**都已替换**);
  - 7 个逐区 comment 框 + localStorage 持久化 + 分区导出:hosted 真 CSP 下实测可用,零 console/page error;
  - **一键复制的失败路径实测**:clipboard 被拒时状态文案如实提示「浏览器不允许自动复制…请按 ⌘C」,
    且导出文本框内容完整(不会出现「显示已复制但粘出空白」)。
- 已知 advisory(模板级,非本报告引入):窄视口(390px)下 hosted 页 scrollWidth 408 > 390,
  有 18px 横向溢出;**原始模板同条件是 479**,本报告更轻。已转报 Lead,不阻塞。
