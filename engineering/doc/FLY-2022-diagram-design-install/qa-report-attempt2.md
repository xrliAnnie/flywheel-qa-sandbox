# FLY-2022 diagram-design 项目安装 — 独立 QA 报告（attempt 2，rebase 后 exact head）

Issue: FLY-2022 (https://linear.app/geoforge3d/issue/FLY-2022/vendor-diagram-design-安装进-flywheel-项目项目域安装-默认配置-真图验证)
日期: 2026-08-25
基于: qa-evidence-2/（本轮自己跑出来的证据）

## 0. 结论

**QA PASS** —— 四条验收全部独立复核通过。附 1 条**归因边界**（第 5 节，必须读）、3 条 advisory，
以及 1 条**会挡 ship 的环境阻塞**（第 9 节：`CI OK` 因账户计费被 GitHub 拒绝启动，与本次改动无关）。

被测 head：`e48fe5ac1216ab422f5567c21e20f93e8cc309b0`
= 本地 HEAD = `origin/flywheel-FLY-2022` = PR #940 `headRefOid`（开跑前与写报告前各核一次）。
PR #940 `OPEN` / `isDraft=false` / `MERGEABLE`；exact head 的 CI **11/11 全 SUCCESS**（含 `CI OK`）。

**关于 verdict head**：本报告与证据自身也是一个 commit，所以 verdict 绑定的 head 会比上面这个
`e48fe5ac1` 多一层 docs-only 提交（见第 9 节，含逐字证明「产品面未变」与该 head 上的 CI 终态）。

### 为什么会有第二份 QA 报告

分支上已有的 `qa-report.md` 声明被测 head 是 `380079e253dd…`。那个 commit **不是当前 HEAD 的祖先**
（`git merge-base --is-ancestor 380079e2… HEAD` → 否）：分支在那份报告写完之后被 rebase 到了含
FLY-2014 `#939` 的 main 上，全部 FLY-2022 commit 换了 SHA。所以那份报告的 head 行对现在要 ship 的
commit 已经失效，本轮从头重验。

**实质没有变**：`.claude/skills/diagram-design` 的 tree object 与 `.diagram-design` 的字节在新旧两个
head 上完全相同（下面第 1、2 节是我自己在当前 head 上重新量的，不是引用旧报告）。

## 1. 验收 ① — SKILL.md sha256 与库版本一致（PASS，独立取字节）

安装物的 guard 只把安装物和**测试脚本里写死的常量**比，证明不了那个常量等于库里的字节。我另起一份
upstream clone 直接取：

```
git clone https://github.com/xrliAnnie/flywheel-skills.git  <scratchpad>/fws-qa2
git -C <scratch> show 82737e5d…:skills/generic/diagram-design/SKILL.md | shasum -a 256
  → 0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971
shasum -a 256 .claude/skills/diagram-design/SKILL.md
  → 0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971        ✅ 相同
```

**比单文件强一档**：git tree object 由「内容 + 文件名 + mode」唯一决定，两边 tree 相等 ⇒ 整棵 208
文件子树逐字节相同。

```
git -C <scratch> ls-tree 82737e5d… skills/generic/diagram-design
  → 040000 tree 8fe791a61ab857ae7994f90681cbd5db1ac5ee4b
git rev-parse 'HEAD:.claude/skills/diagram-design'
  → 8fe791a61ab857ae7994f90681cbd5db1ac5ee4b                                ✅ 相同
```

**再强一档 —— 「库版本」不只是 PR 头，是库现在的 main**：

```
gh pr view 18 --repo xrliAnnie/flywheel-skills
  → headRefOid 82737e5d…  state MERGED  mergedAt 2026-08-24T17:22:32Z  mergeCommit 5c2cf224…
git -C <scratch> rev-parse origin/main            → 5c2cf224…（= 该 merge commit，即库当前 main 头）
git -C <scratch> ls-tree origin/main skills/generic/diagram-design
  → 040000 tree 8fe791a6…                                                   ✅ 相同
```

⇒ 安装物 == PR #18 exact head == flywheel-skills 当前 `main`。三方一致，不是我们自己挑的 SHA。

配套：

- `git ls-files .claude/skills` = 208，其中**不在** `.claude/skills/diagram-design/` 下的 = **0**；
- 磁盘 `find -type f` 也是 208；`git status --porcelain` 全干净 ⇒ 磁盘 == HEAD；
- **没有 `-g`**：`~/.claude/skills`、`~/.agents/skills`、`~/.codex/skills` 三处 diagram-design 计数均为
  **0**，`~/.claude/plugins` 下 `find -name diagram-design` 无命中，repo 内也无重复副本。
  ⇒ 全机唯一来源就是这次的项目安装。第 3 节「skill 被触发」的归因因此成立
  ——真机 transcript 里 skill base directory 逐字打的就是
  `/Users/xiaorongli/Dev/flywheel-FLY-2022/.claude/skills/diagram-design`。

安装 guard 本身：本机 `bash scripts/__tests__/fly2022-diagram-design-install.test.sh` → **8 passed, 0 failed**；
CI 侧同一脚本在 `Script Tests 2/2` 的 `Test — FLY-2022 diagram-design project install` step
`completed/success`，日志逐字为 `[FLY-2022] 8 passed, 0 failed`（不是「步骤存在」，是真跑过）。

## 2. 验收 ② — 默认配置在（PASS）

```
od -c .diagram-design
  0000000  p r o f i l e :   d e f a u l t \n      ⇒ 恰好 17 字节，无多余空白
git ls-files .diagram-design                       ⇒ tracked
```

机制出处（我自己读的安装物原文，不是转述实现者）：

- `SKILL.md` §0：「A valid marker whose profile exists selects that file directly and skips this gate;
  `profile: default` also skips it.」
- `references/profiles.md:80`：「For `profile: default`, ensure `default.md` exists, run the structural
  check, and use it directly. **Skip the first-run gate.**」

⇒ `profile: default` 是这份 skill 明确定义的合法值，不是我们发明的写法。

## 3. 验收 ③ — 真图生成成功且不卡配色提问（PASS，真机 E2E）

**请求是「裸」的**：不点 skill 名、不提 `.diagram-design`、不写「不要问配色」、不给字体/无障碍/画幅
要求。逐字见 `qa-evidence-2/request-natural.md`（sha256 `ce4a66e6…`）。这就是无人值守时的真实用法。

跑法：`claude -p --output-format stream-json --verbose`，cwd = 本 worktree，
Claude Code **2.1.243**，脚本 `qa-evidence-2/run-generation.mjs`。

| 观测 | 结果 |
|---|---|
| exit code | **0**，无 signal、无 timeout；`result.terminal_reason=completed`、`is_error=false` |
| 是否触发 skill | **是** —— transcript L18 `tool_use Skill{skill:"diagram-design"}`，且 L22 的 skill base directory 指向**项目内**路径 |
| 是否执行了 §0 gate 流程 | **是** —— L54 `cat .../.diagram-design`，L58 回读到 `profile: default` |
| **assistant 自己写出来的配色/品牌提问** | **0 条** |
| 产物 | `qa-evidence-2/generated-natural.html`，17,622 B，sha256 `6c6d02fb…` |
| 自包含 | `<script>` 0 个；唯一 `http` 命中是 SVG 的 `xmlns` 命名空间，不是网络请求 |
| 无障碍 | `role="img"` + `aria-labelledby` 均在 |
| 中文字体回退 | 模型自补 `PingFang SC` / `Hiragino Sans GB` / `Noto Sans SC`（sans）与 `Songti SC` / `STSong`（serif） |
| 宿主副作用 | `changedPaths=[]` —— 项目 skill、`.diagram-design`、`~/.diagram-design`、三处全局 skill 目录**全部零变化**；`~/.diagram-design` 至今不存在 |

### 3.1 我先修好了自己的探测器（否则这一格是假绿）

第一版探测器扫整条 transcript 的 JSON，报出 1 条「配色提问」。查下去是**假阳性**：skill body 本身就
逐字引用了 §0 的门禁话术（`atomic-tangerine`、`Do you want to customize…`），而 Claude Code 把 skill
body 作为 user-role 结果注入 —— 只要 skill 一加载，裸 grep 必然命中。

改成双通道（`qa-evidence-2/analyze.mjs`）：**判定只看 assistant 自己写的 text block**（只有它才可能是
真的在问操作者），同时把裸命中行号也照报，不把差别藏起来。

探测器自带阳性/阴性对照，随每次跑一起记进 evidence：

```
selfTest: {firesOnGateText: true, silentOnBenignText: true, pos: 1, neg: 0}
```

⇒ 「0 条 assistant 提问」不是因为正则坏了。

### 3.2 第一次跑撞了 429，如实留档

第一次（00:32Z）跑到一半被 `api_error_status: 429 · You've hit your session limit` 打断，
exit=1、没出图。那是环境额度，不是产品行为；证据原样保留在
`qa-evidence-2/transcript-run1-quota429.jsonl` / `generation-evidence-run1-quota429.json`。
额度恢复后重跑，即上表。**上表的 PASS 只出自重跑那一次**，没有把两次拼在一起说。

## 4. 验收 ④ — 与 FLY-2015 认可档对比不掉档（PASS）

同题对照（这正是 `SKILL.md` FLY-2015-LIMIT-1 要求的「首次装后 QA 必须画同一题、与认可的手画 B 臂并排
判」）：`qa-evidence-2/comparison-vs-fly2004.png`（receipt 记了两侧输入 sha256）。

> 合成方式的一次自纠：第一版按等宽**正方形**格子排，把 2.7:1 的横图和 1:1 的竖图放进同一个方框，横图
> 被 letterbox 压成一条，看起来「掉档」——那是我的合成器造出来的假象。已改为**共同宽度、各自保持原始
> 比例**堆叠，旧图已删。

并排判读：

- **同一套设计语言**：旧路弱化（灰底 + 虚线）、新路是视觉主线、橙色只做焦点、正交圆角连线、底部 LEGEND
  行、留白充足 —— 与认可档一致。
- **信息量更足**：本轮图多出 `SRC/CMD/FILE/SH/RUN` 角色徽章、每条边的动作标签，以及认可档没画的
  「按路径读回全文」虚线回边。节点 8 个（3 + 5），在 ≤9 的合理区间。
- **中文可读性**：真浏览器里节点正文走 PingFang SC，清晰、无重叠、无截断；标题走 Songti SC，锐利。

判定：**不掉档**。画幅从竖版换成横版是自然请求没有限定画幅的结果，不是质量下降。

### 4.1 真浏览器复核（不是只看栅格图）

生成侧自己的 PNG 是 Sharp/libvips 栅格（Fontconfig 回退），字体解析与浏览器不同，所以我另外用
**Claude-in-Chrome** 在真 Chrome 里打开页面截图复核。`file://` 被拦（已知限制），改为
`python3 -m http.server 127.0.0.1:8791` 本地起服务后 `http://127.0.0.1:8791/…` 打开，看完即停服务、
关标签。截图存 `qa-evidence-2/chrome-screenshot-natural.jpg`。真浏览器里 CJK 渲染确认可读，与栅格图
结构一致。

### 4.2 self_check 我自己跑了，而且先证明它会变红

生成侧自己声称「self_check 通过」。我不采信声称，自己跑安装物里的脚本：

```
python3 .claude/skills/diagram-design/scripts/self_check.py …/generated-natural.html
  → OK   (rc=0)
```

再证明这把尺子不是恒绿的 —— 把产物复制一份到 scratch、只删掉第一处 `role="img"`：

```
  → FAIL  - svg 1 needs role=img   (rc=1)
```

⇒ 上面那个 `OK` 是有内容的，不是空过绿。（突变只在 scratch 副本上做，仓库内产物未被改动。）

## 5. 归因边界（HONEST BOUNDARY —— 本报告最重要的一条）

**「没问配色」这个观测，我的实验证不出是 `.diagram-design` 造成的。**

我跑了阴性对照（`qa-evidence-2/run-negative-control.mjs`、`negative-control-evidence.json`）：把同一份
208 文件 skill 原样复制到一个 scratch 项目，**不放 `.diagram-design`**，`references/style-guide.md`
确认仍是原厂默认值（`#f5f5f5` / `#2d3142` / `#eb6c36`、无 profile header）—— 按 §0 这正是「必须触发
门禁」的条件。喂同一段自然请求：

```
NEGCTL exit=0  marker=false  skill=true  assistantGateHits=0  html=true
```

**没有 marker，它照样没问，照样出图。** transcript 里它确实执行了门禁流程（`Glob .diagram-design` →
`No files found`），然后直接开画。

- 所以：**四条验收都不依赖这条因果**（② 只要求配置在且合法，③ 只要求真机不卡住），PASS 不受影响。
- 但**不能**说「`.diagram-design` 挡住了配色提问」——本轮没有任何一次让门禁真的响过。
- 最可能的解释：两臂都是 headless `-p`，模型知道没有人可答，于是自行按默认继续。而 Flywheel runner
  实跑的是**交互式 tmux TUI**，那条路径本轮**没有跑过**，门禁要防的风险因此**没有被复现**。
- marker 的价值目前是**规范背书**（§0 与 `profiles.md:80` 白纸黑字）**加**「不把结果押在模型自觉上」，
  而不是本轮实测过的保护。真要证明它，需要一次交互式 TUI 的对照跑；我没做，代价与收益请 Lead/Annie 判。

## 5.1 依赖前置已满足

issue 写明要等 FLY-2015 双 PR merge 后才能装。核过：

- `flywheel-skills#18` → `MERGED` @ 2026-08-24T17:22:32Z（第 1 节已用它的 tree 对账）；
- `flywheel#937` → `MERGED` @ 2026-08-24T17:15:20Z，merge commit `533adc64…`，
  `git merge-base --is-ancestor 533adc64… origin/main` → 是；`origin/main` 上
  `scripts/__tests__/fly2015-diagram-design-roles.test.sh` 存在。

⇒ 装的确实是「库里已合入的那一版」，不是抢跑。

## 6. Discord surface

本单**没有 Discord surface**，不适用 529 房 N-to-N：分支相对 `origin/main` 的非文档改动只有
`.diagram-design`（新增）、`.github/workflows/ci.yml`（+6 行，加一个 shell 测试 step）、
`CLAUDE.md`（+1 行里程碑）、`scripts/__tests__/`（新 guard + 结构清单登记），以及 208 个 skill 文件。
零 send / relay / render / founder 交互 / roundtable / 跨 Lead 协调代码。
按上述真机 E2E（真 Claude Code 会话 + 真 Chrome）验证。

## 7. Advisory（不阻塞 ship）

1. **CJK 说明文字是「伪斜体」。** 生成图底部的中文编注走 `Songti SC` + italic，Songti 没有真斜体，
   浏览器做合成倾斜（截图放大可见），中文排印上偏弱。这是上游默认样式的 caption 约定带来的，不是安装
   缺陷。建议：Annie 定 CJK 字体方案时（本单已按 issue 明确**不锁字体**）顺手决定中文正文是否禁用
   faux-italic。
2. **橙色焦点被稀释了一点。** 认可档把橙色只留给「最终结果」；本轮图除了焦点节点 `临时文件` 之外，
   失败终点 `ERR / command too long` 也上了橙。仍在 style-guide「1–2 处」的额度内、观感不差，但与认可
   档的强调重心略有不同。属观感偏好，交 Annie 看真图时一并裁。
3. **分支里 `qa-report.md` 的 head 行已失效。** 它写的 `380079e2…` 不是当前 HEAD 的祖先（rebase 前的
   commit）。我**没有原地改**那份已交付的报告（避免动别人的证据），差异记在本报告第 0 节。若要合并两份
   报告口径，由 Lead 决定。

## 8. 我复核了什么、没复核什么

**自己重跑/重量的**：upstream clone 取字节与 tree object、库 main 的 tree、PR #18 与 #937 状态、
本地 208 文件 census、全局/插件目录零命中、`.diagram-design` 的 `od -c`、SKILL.md 与 profiles.md 的
门禁原文、install guard 本机 8/8、CI 该 step 的真实日志行、真机自然请求 E2E（含探测器自对照）、
阴性对照、真 Chrome 渲染、`self_check.py` 及其突变对照、同题并排比对。

**没有做的**：

- **交互式 TUI 下的门禁对照**（见第 5 节）—— 本轮唯一未闭合的行为面。
- **未逐字节审计 208 个文件的内容安全性**。理由：内容安全审查是 FLY-2015 的交付物；本单的安全属性靠
  「与已过审的库 exact tree 相等」传递，而这一点我独立证明了。
- **未在别的项目里验证安装流程可复用**（本单范围只有 flywheel 项目域）。
- **未跑全仓 package 测试套件**：本分支不含 `packages/` 生产代码改动（`packages/flywheel-comm` 的 diff
  来自 rebase 带进来的已 merge FLY-2014 `#939`，不属本单）；exact head 的 CI 11/11 已覆盖。

## 9. verdict head 的 CI —— `CI OK` 红，但**不是**这次改动红

> 放在证据清单前面，因为它会挡 ship，而且一眼看过去像是我们把 CI 弄红了。

三个 head 的账，如实摆开：

| head | 是什么 | 真实作业 | `CI OK` |
|---|---|---|---|
| `e48fe5ac1` | 实现者最后一个 commit（第 1–4 节验的就是它的产品面） | 10/10 success | **success** |
| `d96c72372` | 上面 + 本报告与证据（docs-only） | **10/10 success** | **failure —— 但这个 job 从未被启动** |
| verdict head | 上面 + 本节（docs-only） | 需在计费恢复后重跑 | 同上 |

`CI OK` 是聚合闸（`needs: [classify, quick-gate, unit-tests, script-tests, script-tests-2,
payload-distribution]`），它的判据是「上面这些全 success」。而它们**确实全 success**。

它 1 秒就 failure、没有任何 step、log blob 404。取 check-run annotation 才看到原文：

```
gh api repos/xrliAnnie/flywheel/check-runs/97680633946/annotations
  → failure: The job was not started because recent account payments have failed
            or your spending limit needs to be increased. Please check the
            'Billing & plans' section in your settings
```

⇒ **GitHub Actions 因账户计费/额度上限拒绝启动这个 job**，不是我们的代码、不是聚合逻辑、也不是本分支
的问题。同一份聚合闸在 `e48fe5ac1`（00:23Z）上是绿的；这条计费墙是 04:05:11Z 才第一次出现在我们
run 上。

**这不是本单的 QA FAIL**：被测改动的四条验收全过，10 个真实作业全绿。但它是 **ship 的环境阻塞** ——
FLY-1861 的 ship 路径要等被批准 head 上的 `CI OK`，计费不恢复就永远等不到绿。

范围（只读观察，未做任何 mutation）：

```
gh api 'repos/xrliAnnie/flywheel/actions/runs?per_page=8&status=completed'
32805135534  flywheel-FLY-2026  CI-OK=success                  (03:25Z，墙之前)
32806543466  flywheel-FLY-2022  CI-OK=failure  <billing 原文>   (04:05Z，本单)
```

04:04Z / 03:55Z 还在飞的两条 run 当时未出结果，**可能撞同一堵墙 —— 这是推测，我没有等它们落地**。

处置边界：修计费是 founder 的账户动作，我不碰、也不建议由 agent 代办；我只把原文和 job id 交出来。
计费恢复后对 verdict head 重跑一次 CI 即可，无需改任何代码。

## 10. 证据清单（`qa-evidence-2/`）

| 文件 | 是什么 |
|---|---|
| `request-natural.md` | 裸自然请求逐字原文 |
| `run-generation.mjs` | 生成侧 runner（快照 + 守卫 + 证据落盘） |
| `analyze.mjs` | 双通道门禁探测器，含阳性/阴性自对照 |
| `transcript-natural.jsonl` / `generation-evidence-natural.json` | 通过那一轮的完整 transcript 与结论 |
| `transcript-run1-quota429.jsonl` / `generation-evidence-run1-quota429.json` | 被 429 打断那一轮，原样留档 |
| `generated-natural.html` / `.svg` / `.png` | 本轮产物与栅格 |
| `chrome-screenshot-natural.jpg` | 真 Chrome 渲染截图 |
| `run-negative-control.mjs` / `negative-control-evidence.json` / `negative-control-generated.html` | 无 marker 阴性对照 |
| `compose-comparison.mjs` / `comparison-vs-fly2004.png` / `comparison-receipt.json` | 与 FLY-2004 认可档同题并排 |
