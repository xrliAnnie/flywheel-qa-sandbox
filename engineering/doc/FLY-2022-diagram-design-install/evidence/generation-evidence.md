# FLY-2022 diagram-design 项目安装 — 真图证据
Issue: FLY-2022 (https://linear.app/geoforge3d/issue/FLY-2022/vendor-diagram-design-%E5%AE%89%E8%A3%85%E8%BF%9B-flywheel-%E9%A1%B9%E7%9B%AE%E9%A1%B9%E7%9B%AE%E5%9F%9F%E5%AE%89%E8%A3%85-%E9%BB%98%E8%AE%A4%E9%85%8D%E7%BD%AE-%E7%9C%9F%E5%9B%BE%E9%AA%8C%E8%AF%81)
日期: 2026-08-24
基于: ../plan.md

## 1. 结论

四项 issue 验收全部满足：

1. project install 的 `SKILL.md` SHA-256 = `0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971`，tracked subtree = `8fe791a61ab857ae7994f90681cbd5db1ac5ee4b`，208 files；
2. root `.diagram-design` 精确为 `profile: default\n`；
3. 权威显式调用与不点名自然请求都生成成功，两个 JSONL 都出现真实 `Skill(diagram-design)` event，且没有品牌/配色提问；
4. 两张图的中文清楚可读，和 FLY-2004 认可 B 臂同题并排后，信息层级、留白、连线、配色与完成度均不掉档。

中文字体方案没有在本单锁定。HTML 显式声明 `PingFang SC` / `Hiragino Sans GB` / `Noto Sans CJK SC` / `Microsoft YaHei` fallback；本机 Sharp/libvips 栅格链的 Fontconfig 首个 CJK-capable candidate 是 `Hiragino Sans GB`，实际 PNG 没有乱码、截断或重叠。这个观察值保留给 Annie 看真图后再决定正式方案。

## 2. TDD 与安装合同

| 阶段 | 结果 |
|---|---|
| RED | skill/config 尚未落地：`1 passed, 7 failed`，缺 marker、tracked set、SKILL、tree、census、license、anchors |
| GREEN | `8 passed, 0 failed`，实际 wall `0.11s` |
| CI structure | PASS；shell census `214 = 162 CI + 52 manual-only` |
| FLY-2015 role routing | `20 passed, 0 failed` |
| parser/self-check | 三个 Python parser compile；shipped architecture example `OK` |

安装实现 commit：`0c54af2bd`。vendor copy 保留 exact bytes，包括其原有 CRLF；本仓 config/test/CI 的 whitespace check 单独通过，没有格式化 vendor subtree。

## 3. 双 E2E 结果

### 3.1 权威显式调用

- prompt：`explicit-request.md`，经 stdin 输入 Claude Code 2.1.241；
- transcript：`explicit-transcript.jsonl`；
- `Skill(diagram-design)`：line 15；
- exit：0，timeout=false；
- branding questions：0；
- HTML：`explicit-generated.html`，15,166 bytes，SHA-256 `8dc9d201467ab85dd346be447ba605077a9d0864b85615260edb07d59366aea1`；
- installed `self_check.py`：OK；
- PNG：2160×2160，SHA-256 `78c79193f461dea32bd29c1f9c3924894208aef14b1e8742924c8745b49a3b11`。

### 3.2 不点名自然请求

- prompt：`natural-request.md`，全文不出现 skill 名，经 stdin 输入；
- transcript：`natural-transcript.jsonl`；
- 自动 discovery：真实 `Skill(diagram-design)` event at line 17；
- exit：0，timeout=false；
- branding questions：0；
- HTML：`natural-generated.html`，14,066 bytes，SHA-256 `38ed89cc165b68bbecd764bd602bb7f5081ba6297d9bd98220f6b46708032789`；
- installed `self_check.py`：OK；
- PNG：2160×2160，SHA-256 `41a2a660d2934dbb3f9f9ee7db2bb45b74fe72a3b969ff2f0e3a355ce5b0bd91`。

两个 harness guard 都是：project skill unchanged=true、project config unchanged=true、changed user paths=[]。`~/.agents/.skill-lock.json` 文件 SHA 仍为 `4784f02a55c0a48e046f61f4ec4a6a9ab43a7b5df072310f3d8b4577a49159da`；三个用户级 skill 路径与 `~/.diagram-design/profiles/default.md` 前后均不存在。

## 4. 栅格与字体证据边界

设计审查 R3 已独立证明 Chrome 151 + CDP + Node global `WebSocket` 能取得 computed style、geometry 与 `CSS.getPlatformFontsForNode` physical face；review probe 的中文 physical face 是 PingFang SC。但当前 Runner 的 process sandbox 对实际 capture 有两条可复现限制：Google Chrome headless abort exit 134，QuickLook `qlmanage` 以 `sandbox initialization failed` exit 255。没有关闭 sandbox、没有安装 Playwright/系统包。

本单改用 repo lock 已有的 `sharp 0.34.5` / `libvips 8.17.3` 从同一个 inline SVG 栅格化；density 144 得到 2160×2160 PNG。`explicit-render-receipt.json` 与 `natural-render-receipt.json` 保存 HTML/SVG/PNG hash、CJK text node census 和 Fontconfig candidate list。这里如实声称的是：

- 生成 HTML 的声明 stack 正确；
- 本机栅格链的首个 CJK-capable candidate 是 `Hiragino Sans GB`；
- 原尺寸 PNG 中中文实际可读；
- 不把 Fontconfig candidate 冒充成浏览器对这两张图的 physical glyph face。

失败的 2880×2880 density probe 没有覆盖权威产物，完整移到 `/private/tmp/fly2022-render-failed-2880/`；最终 receipt/PNG 都是 2160×2160。

## 5. FLY-2004 同题视觉比较

权威 reference：`reference-fly2004-arm-b.png`，机械复制自 FLY-2004，SHA-256 `e3da05048a6af3cefc611b154416af4114223adfda4ae825e27e5839d3b6b715`，1680×1680。`comparison.html` 与 `comparison.png` 把 reference、显式图、自然图同等尺寸并排；比较 PNG receipt SHA-256 = `0c0c9184801a5add22665d65f79af2bcc764a501e60a05d26d1f00f496164c6c`。

| 维度 | 显式调用 | 不点名自然触发 | Verdict |
|---|---|---|---|
| 信息层级 | 单一 Linear source 明确分叉；旧路/新路/逐字一致终点一眼可找 | 以 16 KiB 水平边界组织故事，旧路被挡、新路穿过并落入 Runner window | PASS |
| 布局/留白 | 两列 zone、7 个 node；线缆稀疏，标题与 legend 独立 | 左右不对称但平衡；5 个主要 node + 一个失败终点，大片留白 | PASS |
| 配色 | default 暖白 + ink/muted；橙色只给 file 与最终 agent | default 暖白；橙色只给 file 与最终 Claude | PASS |
| 连线 | 正交圆角；command 与 file-content 用实/虚区分 | 正交圆角；16 KiB boundary 和回读虚线语义清楚 | PASS |
| 中文 | 原尺寸 sans/mono 清楚；无乱码、截断、重叠 | 原尺寸标题/正文/技术标签清楚；无乱码、截断、重叠 | PASS |
| 完成度 | 比 reference 信息更完整，仍保持 4/10 density | 与 reference 一样克制，同时补足安全/阈值语义 | PASS，不掉档 |

原尺寸视觉检查通过。显式图最终 agent node 轻微跨出右侧 zone 下边界，是“结果突破管线容器”的可读强调，不与 legend 或其他 node 重叠；自然图则把最终 Claude 完整收在 Runner window 内。两张都不是 Mermaid 默认皮或卡片堆叠，均达到可直接交付档，其中自然图最接近 issue 要求的无人值守真实使用路径。

## 6. 运行规则

tracked installed copy 是生产 source，不是 profile working scratch。后续要定制时只写 `~/.diagram-design/profiles/`，绝不直接编辑 tracked `.claude/skills/diagram-design/references/style-guide.md`；否则未提交的 dirty working tree 会让 restart preflight fail-close。这个规则还会进入 `CLAUDE.md` milestone 与 PR body。

## 7. 全仓验证

2026-08-24 rebase 到 `origin/main` `d01bee2b7` 后的 exact code/evidence tree
验证结果；本轮之后只整理本节验证文字，没有再改产品、测试或真图产物：

| Gate | 结果 |
|---|---|
| `pnpm lint` | PASS；2,594 files，0 error，8 条既有 warning |
| `pnpm -r build` | PASS；22 workspace projects，exit 0 |
| package matrix（不含 `claude-runner`） | PASS；21/21 packages，exit 0；其中 `teamlead` 为 725 files / 9,515 passed / 6 skipped |
| `claude-runner` controlled split | PASS；主套件 31/31 files、876 passed / 2 skipped，exit 0；real-tmux exact file 1/1，exit 0 |
| FLY-2022 install guard | `8 passed, 0 failed` |
| CI structure / shell census | PASS；`214 = 162 CI + 52 manual-only`，另有 3 个 generalized Node suite |
| FLY-2015 role contract | `20 passed, 0 failed` |
| vendor compile / self-check | 3 个 Python scripts compile；shipped/explicit/natural HTML 均 `OK` |

最终 matrix 使用两项与 CI/测试文件自身语义一致的宿主隔离：

1. `core` 的真实 Terminal.app 测试会在 managed sandbox 被 Apple Events 拒绝；按测试文件注明的 Linux/CI 语义仅对该轮隐藏 `osascript`，结果 `219 passed, 3 skipped`。
2. 用户 npm cache 有既有 root-owned 文件；所有 package tests 使用任务专属 `/private/tmp/fly2022-npm-cache-rebase`，没有修改或借用用户 cache。

`claude-runner` 的 real-tmux exact file 单独运行，避免此前在全包并发下出现的
Vitest worker RPC timeout 掩盖断言结果；本轮主套件与 real-tmux 两个进程都以 0
退出。综上，PR-owned install/config/CI/evidence 路径与 exact-head full package
matrix 全绿，没有把宿主权限或 cache 污染伪装成产品通过。
