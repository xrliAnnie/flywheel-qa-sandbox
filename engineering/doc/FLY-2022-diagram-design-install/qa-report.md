# FLY-2022 diagram-design 项目安装 — 独立 QA 报告
Issue: FLY-2022 (https://linear.app/geoforge3d/issue/FLY-2022/vendor-diagram-design-%E5%AE%89%E8%A3%85%E8%BF%9B-flywheel-%E9%A1%B9%E7%9B%AE%E9%A1%B9%E7%9B%AE%E5%9F%9F%E5%AE%89%E8%A3%85-%E9%BB%98%E8%AE%A4%E9%85%8D%E7%BD%AE-%E7%9C%9F%E5%9B%BE%E9%AA%8C%E8%AF%81)
日期: 2026-08-24
基于: evidence/generation-evidence.md

## 0. 结论

**QA PASS**（四条验收全部独立复核通过），附 3 条 advisory + 1 条 ship 前置事实。

被测 head：`380079e253dd9e61f0d91421764e851d437422d0`（本地 = `origin/flywheel-FLY-2022` = PR #940 `headRefOid`，开跑前与写本报告前各核一次）。
PR #940 非 draft；exact head 的 CI 11/11 全 SUCCESS（含 `CI OK`）。

本报告的每一条判定都是我自己跑出来的，不是复述实现者的证据；凡是只复核了实现者产物、
没有自己重跑的，第 8 节明确标注。

## 1. 验收 ① — SKILL.md sha256 与库版本一致（独立核验 PASS）

实现者的 guard 只把安装物与**测试脚本里写死的常量**比对，证明不了这个常量等于库里的字节。
我另起一份 upstream clone 直接取字节：

```
git clone https://github.com/xrliAnnie/flywheel-skills.git <scratch>
git -C <scratch> show 82737e5d2756950642e278f1aabf3dd384356f47:skills/generic/diagram-design/SKILL.md | shasum -a 256
  → 0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971
shasum -a 256 .claude/skills/diagram-design/SKILL.md
  → 0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971      ✅ 相同
```

`gh pr view 18 --repo xrliAnnie/flywheel-skills` 确认 `headRefOid = 82737e5d…`、state `MERGED`
（2026-08-24T17:22:32Z），即 issue 指定的 exact head 就是这个 commit，不是我们自己挑的。

**比单文件更强的一条**：git tree object 只由内容 + 文件名 + mode 决定，所以两边 tree 相等
⇒ 整棵 208 文件子树逐字节相同。

```
git -C <scratch> ls-tree 82737e5d… -- skills/generic/ | grep diagram-design
  → 040000 tree 8fe791a61ab857ae7994f90681cbd5db1ac5ee4b   skills/generic/diagram-design
git rev-parse 'HEAD:.claude/skills/diagram-design'
  → 8fe791a61ab857ae7994f90681cbd5db1ac5ee4b                              ✅ 相同
```

配套核验：

- `git ls-files .claude/skills` = 208 条，且**全部**在 `.claude/skills/diagram-design/` 下（0 条例外）；
- 磁盘 208 文件，`git diff HEAD -- .claude/skills/diagram-design` 为空 ⇒ 磁盘 == HEAD；
- 无 tracked `.agents/skills/diagram-design`、`.codex/skills/diagram-design`、`skills-lock.json`；
- **没有 `-g`**：`~/.claude/skills/`、`~/.agents/skills/`、`~/.codex/skills/`、插件 cache 四处均无
  `diagram-design`；`~/.agents/.skill-lock.json` 里 `diagram-design` 命中数 = 0。
  ⇒ 全机唯一来源就是这次的项目安装，第 4 节的触发结论才有归因。

## 2. 验收 ② — 默认配置在（独立核验 PASS）

```
od -c .diagram-design
  0000000  p r o f i l e :   d e f a u l t \n     ⇒ 恰好 17 字节，无多余空白
git ls-files .diagram-design → tracked
```

`SKILL.md` §0 原文："A valid marker whose profile exists selects that file directly and skips this
gate; `profile: default` also skips it." ⇒ 这就是「不卡配色提问」的机制来源，不是靠 prompt 措辞。

## 3. 守卫本身是不是真检查（突变检验 8/8，PASS）

「跑绿了」不等于「它能变红」。我在 scratchpad 里另建一个只含 skill/marker/测试脚本的
沙箱 git 仓（生产 worktree 零改动），先取阳性对照 8 passed/0 failed，再逐个注入突变：

| 突变 | 触发变红的断言 |
|---|---|
| M1 marker 改成 `profile: acme` | marker exact bytes |
| M2 删 1 个 asset | tracked-208 / subtree tree / census |
| M3 SKILL.md 末尾加 1 个换行 | SKILL sha / subtree tree |
| M4 新增 tracked `.claude/skills/other/SKILL.md` | tracked-208（点名了越界路径） |
| M5 抹掉 `FLY-2015-LIMIT-2-CJK-FONT-FALLBACK` anchor | SKILL sha / subtree tree / anchors |
| M6 tracked `skills-lock.json` | forbidden-tracked |
| M7 删 `LICENSE` | tracked-208 / subtree tree / census / license |
| M8 删掉 marker 文件 | marker exact bytes |

8 条断言**每一条**都至少被一个突变打红，reset 后阳性对照回到 8 passed/0 failed。
另：`bash -n` 与 `shellcheck -S error` 均无发现。

实现者 harness 的品牌提问探测器我也单独验了它能不能变红：正则
`/(品牌|配色|brand(?:ing)?|colou?r)[\s\S]{0,240}[?？]/i` 只扫 assistant 文本，对 SKILL.md §0 的
英文 gate 原句 **fires**、对中文「要不要先把品牌配色定一下？」**fires**、对普通完成语 **不 fires**。
是真检查，不是空过绿。

## 4. 验收 ③ — 真图 + 不卡配色（独立复现 E2E，PASS）

### 4.1 为什么必须自己再跑一次

实现者的「自然请求」prompt 里写了第 6 条：「不询问品牌或配色：项目根已有默认配置」。
这句话**本身**就会压住提问，所以那一场证明不了「是 `.diagram-design` 让它不问的」——两条
通路同时开着，不能归因。

我因此换题、换 prompt，**删掉任何关于配色的指示**，也不提 skill 名，其余尽量贴近无人值守：

- prompt：`qa-evidence/qa-independent-request.md`（sha256 `6142de40…cd6fe1`），
  内容是「画一张中文架构图讲 Flywheel 里 Linear issue 怎么变成合库 PR，含 QA FAIL 返工线」，
  全文既没有 `diagram-design`，也没有任何「别问配色 / 用默认风格」的字样；
- harness：`qa-evidence/qa-run-generation.mjs`（我自己写的，非复用实现者脚本），prompt 走 stdin；
- 命令：`claude -p --no-session-persistence --no-chrome --output-format stream-json --verbose
  --permission-mode acceptEdits --allowedTools 'Skill,Read,Write,Edit,Glob,Grep,Bash(python3 …self_check.py:*)'
  --disallowedTools 'WebFetch,WebSearch'`，Claude Code 2.1.241，cwd = 项目根。

### 4.2 结果

| 项 | 观测 |
|---|---|
| exit / signal / timeout | `0` / `null` / `false` |
| `Skill(diagram-design)` event | **有**，transcript line 19，`input.skill = "diagram-design"` |
| 品牌/配色提问（实现者严格探测器复算） | **0**（assistant 文本块共 5 条，无一命中） |
| 品牌/配色提问（我的宽松整事件正则） | 3 条命中，**逐条人工判定全为数据误报**：1 条是 SKILL.md §0 被载入的 skill payload，2 条是读 `template.html` / `style-guide.md` 的 tool_result；无一条是 assistant 在提问 |
| 产物 | `qa-evidence/qa-independent-generated.html`，12,099 bytes，sha256 `ccbd9f50…6e6f96` |
| 安装自检 | `python3 .claude/skills/diagram-design/scripts/self_check.py <该文件>` → `OK` |
| transcript | 383 events，0 parse error，sha256 `52d02ec9…77afd2` |
| 生成前后 project skill / marker | 逐字节不变（fingerprint 前后相同） |
| 生成前后用户级路径 | `changedUserPaths = []`；`~/.diagram-design` **仍不存在**；`~/.agents/.skill-lock.json` 仍为 `4784f02a…159da` |
| 墙钟 | 10m16s（22:19:44Z → 22:30:00Z） |

transcript 里模型的原话依次是：「我来画这张图。这正是 `diagram-design` skill 的用途，先加载它。」
→ 载入 skill → 读 `.diagram-design`（得到 `profile: default`）→ 读 `type-flowchart.md`、
`output-spec.md`、`template.html`、`style-guide.md` → 画 → 跑 self_check → 自查几何并修了一处
legend swatch 对不齐 4px 网格的问题。也就是说它是真的在消费这份项目安装的参考文件，
不是只喊了个 skill 名字。

**这一场是变量隔离过的**：prompt 里没有任何抑制提问的措辞，全机也只有项目这一份
diagram-design，所以「不点名能触发 + 不卡配色」可以归因到本单的安装 + marker。

## 5. 验收 ④ — 与 FLY-2004 认可 B 臂比较（PASS，不掉档）

我在**真 Chrome**（Claude-in-Chrome 扩展驱动，非 headless spawn）里逐张打开（窗口 1280×1400），
全页截图 + 对关键区域再放大到 ~1455px 宽逐节点看，而不是只看实现者提交的 PNG：

| 维度 | FLY-2004 arm B（认可基线，手画） | 显式场（实现者） | 自然场（实现者） | 自然场（本次独立复现） |
|---|---|---|---|---|
| 信息层级 | 修复前/修复后两列，6 节点 | 两列 zone + 分组容器，7 节点 | 16 KiB 水平边界组织，两列 | 三段泳道 + Runner 分区，10 节点 |
| 留白 | 充裕 | 充裕（左列底部略空） | 充裕 | 充裕 |
| 连线 | 正交圆角，实/虚区分 | 正交圆角，实/虚区分 | 正交圆角，实/虚区分 | 正交圆角，返工线虚线橙 |
| 配色 | default 暖白 + 橙色主线 | default 暖白 + 橙色 2 焦点 | default 暖白 + 橙色 2 焦点 | default 暖白 + 橙色 1 焦点 + 返工线 |
| 中文可读 | 粗黑体，清楚 | 黑体标题 + 黑体正文，清楚 | 衬线标题 + 黑体正文，清楚 | 衬线标题 + 黑体正文，清楚 |
| 图例 | 有 | 有 | 有 | 有 |
| 文字重叠/截断 | 无 | 无 | 无 | 无（放大到 1455px 逐节点看过） |

判定：**不掉档**。三张自动生成图与认可基线在同一档，克制度、层级、连线语义、配色纪律一致；
差异主要是自动图信息密度更高（因为 prompt 要求的环节更多），这是题目差异不是质量下滑。
我的独立那张把「独立 QA 是唯一回头路」做成了唯一的橙色虚线返工线，语义抓得准。

**本单新增的一条证据（实现者拿不到的）**：他们诚实披露了 Chrome/QuickLook 被 sandbox 拦，
只能用 `sharp`/libvips 栅格，因此不敢声称浏览器的 physical face。我用 Chrome 扩展补上了这一格：

- 三张 HTML 在真 Chrome 里逐张打开，**与提交的 libvips PNG 无实质差异**：自然场的 H1 两边都是
  中文衬线（模型自己声明了 `--serif-cjk: "Songti SC", …`，是有意设计，不是回落事故），
  显式场两边都是黑体；节点正文两边都是黑体；都没有乱码、截断、重叠。
  （我一度以为 libvips 把标题回落成了黑体，裁剪原 PNG 标题区逐字比对后确认那是我看小图看错了，
  两个渲染器给的是同一族字面。）
- 结论：就这三个文件而言，实现者提交的 PNG **可以代表** founder 在浏览器里会看到的东西；
  渲染器差异的一般性风险仍然存在，只是本次没有观测到。

截图存 `qa-evidence/qa-independent-chrome-screenshot.jpg`（sha256 `e06c96e1…3e02f`）。

## 6. 529 QA Room N-to-N 适用性

**本单不是 Discord-capable，因此不跑 529 房 N-to-N —— 明确说明，不是漏做。**

依据是完整改动面（`git diff --name-only d01bee2b7..HEAD` 去掉 skill 子树与 docs 后**只剩 5 个文件**）：

```
.diagram-design                                   ← 一行 marker
.github/workflows/ci.yml                          ← 只新增一个 shell test step
CLAUDE.md                                         ← milestone 表格一行
scripts/__tests__/ci-structure.test.sh            ← census 加一行
scripts/__tests__/fly2022-diagram-design-install.test.sh  ← 新守卫
```

`packages/` 下**零**运行时改动，没有 send / relay / render（thread title·badge·pinned header·status
line）/ founder 交互 / roundtable / 跨 Lead 协调中的任何一条。改的是数据文件与 CI 接线。

替代验证（都是我自己跑的真东西，不是纸面推理）：安装守卫 8/8 + 8 条突变检验、
FLY-2015 role routing 20/20、`ci-structure` PASS、真 Claude Code 2.1.241 端到端生成一张真图、
真 Chrome 逐张目视、exact head 的 GitHub CI 11/11。

## 7. Advisory（不阻塞 PASS）

**A-1（LOW，本单可不改）— `python3 -m py_compile` 会把本仓自己的守卫打红。**
plan §3.5 把「`python3 -m py_compile` 验三个 parser」写成安装后 smoke。照做之后
`.claude/skills/diagram-design/scripts/__pycache__/` 生成 3 个 `.pyc`，守卫的磁盘 census
（`find … -type f`）从 208 变 211，本地立刻 `[FAIL] installed file census mismatch (total=211 … scripts=6)`。
我实测复现过一次并已清理（现场恢复 208 / 8 passed / git status 干净）。
`__pycache__` 被 gitignore，所以 CI clean checkout 不受影响、也不是 CI 假绿；
但它是「照文档做事就变红」的假红源。建议 census 排除 `__pycache__`（或改数 tracked 文件）。

**A-2（MEDIUM，属于 vendor 合同，不是本单实现缺陷）— 「永不问配色」缺结构性保证。**
`SKILL.md` §0 说 `profile: default` 直接跳门；但 `references/profiles.md` §1 写的是
「For `profile: default`, **ensure `default.md` exists**, run the structural check, and use it directly」，
而同文件「Built-in `default`」一节把 "ensure exists" 定义成「不存在就 `mkdir -p ~/.diagram-design/profiles`
并写 `default.md`」。plan 已识别这条张力并选择按 §0 解释、且约定真撞上就 fail-close 上报。
实测**三场（实现者 2 场 + 我 1 场）全都走 §0、零用户级写入、零提问**，但这是模型行为的经验观测，
不是机制保证：**n=3，没有对照组，不足以支撑「永远不会」**。若哪天真出现停下来问或写
`~/.diagram-design/`，那是 vendor 合同问题，处置口子 plan 已经写好。

**A-3（LOW）— evidence 的视觉判定只有 libvips 一个渲染器背书。** 见 §5。我用真 Chrome 补跑
后**没有**发现差异，所以这不是缺陷，只是证据面窄。建议在 `generation-evidence.md` §4 补一句
指向本报告的浏览器观测，让后来的人知道「PNG 代表浏览器所见」这件事是被实测过一次的，
而不是默认成立的。

## 8. 诚实边界（没测 / 证不了的）

1. **没做 529 房 N-to-N**，理由与替代验证见 §6，判定依据是完整改动面清单，不是印象。
2. **中文字体没有在本单锁定**，也不该锁：这是 issue 明写留给 Annie 看真图后定的。我只多提供了
   一个数据点（真 Chrome 里 H1 走 `Songti SC` 衬线、正文走黑体，两者都清楚）。
   我**没有**用 CDP `CSS.getPlatformFontsForNode` 取 physical face，所以不声称「浏览器用的就是
   Songti SC」，只声称「Chrome 渲染出的是衬线中文且可读」。
3. **`--allowedTools` 在本环境里没有真正约束 Bash**：我的子会话跑了 `ls` / `grep`（不在放行前缀里）
   仍拿到结果。这与 plan 已声明的「allow-list 不等于 global-write prevention」一致；
   我的归因手段是前后 fingerprint（结果为零用户级变化），不是靠 allow-list。
4. **只跑了 1 场我自己的 E2E**（10 分钟/场）。稳定性结论的分母就是 3。
5. **没跑全仓 `pnpm test:packages:run` / `pnpm lint`**：本 PR 零 `packages/` 改动，且 exact head 的
   GitHub CI 11/11 已全 SUCCESS（Quick Gate 含 build+typecheck+lint、Unit 五格、两个 Script Tests
   shard 都过），比我在这台负载机上复跑更有说服力。我只额外跑了改动面直接相关的
   守卫 / role / ci-structure / shellcheck。
6. **没有部署、没有重启、没有 merge、没碰生产**；全程只读 + 一个 127.0.0.1 本地静态服务器
   （用完已停）+ scratchpad 沙箱。

## 9. Ship 前置事实（不是 QA FAIL，但会挡合库）

PR #940 当前 `mergeable = CONFLICTING` / `mergeStateStatus = DIRTY`。
`git merge-tree --write-tree origin/main HEAD` 显示**唯一**冲突文件是 `CLAUDE.md`
（双方都往 milestone 表顶部加行，机械冲突），其余全部干净自动合并。
这是本仓每张单都会撞的常态冲突，不是本改动的缺陷；但它意味着当前 head 无法直接合库，
需要 rebase（rebase 会改 head，届时我这次 verdict 绑定的 head 也随之失效）。
这一步归实现者 / Lead / land 引擎，QA 不自行 rebase。

## 10. 复现命令

```bash
# ① 独立核 SKILL.md 与整棵子树
git clone https://github.com/xrliAnnie/flywheel-skills.git /tmp/fws
git -C /tmp/fws show 82737e5d2756950642e278f1aabf3dd384356f47:skills/generic/diagram-design/SKILL.md | shasum -a 256
shasum -a 256 .claude/skills/diagram-design/SKILL.md
git -C /tmp/fws ls-tree 82737e5d2756950642e278f1aabf3dd384356f47 -- skills/generic/ | grep diagram-design
git rev-parse 'HEAD:.claude/skills/diagram-design'

# ② marker
od -c .diagram-design

# ③ 守卫 + 相邻合同
bash scripts/__tests__/fly2022-diagram-design-install.test.sh
bash scripts/__tests__/fly2015-diagram-design-roles.test.sh
bash scripts/__tests__/ci-structure.test.sh

# ④ 独立自然请求 E2E（约 10 分钟）
node engineering/doc/FLY-2022-diagram-design-install/qa-evidence/qa-run-generation.mjs
python3 .claude/skills/diagram-design/scripts/self_check.py \
  engineering/doc/FLY-2022-diagram-design-install/qa-evidence/qa-independent-generated.html
```
