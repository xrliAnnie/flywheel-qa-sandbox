# FLY-2022 diagram-design 项目安装 — 探索
Issue: FLY-2022 (https://linear.app/geoforge3d/issue/FLY-2022/vendor-diagram-design-%E5%AE%89%E8%A3%85%E8%BF%9B-flywheel-%E9%A1%B9%E7%9B%AE%E9%A1%B9%E7%9B%AE%E5%9F%9F%E5%AE%89%E8%A3%85-%E9%BB%98%E8%AE%A4%E9%85%8D%E7%BD%AE-%E7%9C%9F%E5%9B%BE%E9%AA%8C%E8%AF%81)
日期: 2026-08-24
基于: 无

## 要解决的事

FLY-2015 已把 `diagram-design` v2.6.5 安全 vendor 到 `xrliAnnie/flywheel-skills`，并完成 Flywheel 角色分配，但刻意没有做生产或项目安装。FLY-2022 只补最后一段：把同一份已审字节安装到 Flywheel 仓库的 project scope，预置无人值守默认 profile，再让模型用不点名 skill 的中文自然请求生成一张真架构图，与 FLY-2004 获认可的 B 臂对比。

## 当前事实

- Flywheel PR #937 已合并，当前 `origin/main`/worktree HEAD 为 `533adc64f`，包含 FLY-2015 角色合同与过程文档。
- `flywheel-skills` PR #18 已于 2026-08-24 合并；其已审 PR head 是 `82737e5d2756950642e278f1aabf3dd384356f47`，merge commit 是 `5c2cf224bb653b9c7a7bcc4cef9c337eda12222b`。
- FLY-2015 已验证的 project-scope 方式是：从 exact PR head 的干净 source checkout，在目标 repo 内运行 `skills@1.5.10 add <absolute-local-source> --skill diagram-design --agent claude-code codex -y --copy`，绝不使用 `-g`。
- 当前本机历史目录 `/Users/xiaorongli/Dev/flyview-skills` 落后远端且有用户改动；它不是本单可信安装源，也不能被本单更新或清理。
- Flywheel 主仓 `.git/info/exclude` 会忽略整个 `.claude/skills/`，这是运行时 issue skill 注入的既有保护。本单只 force-add 具名的 `.claude/skills/diagram-design/`，不提交同目录下动态注入的其他 skill。
- FLY-2015 QA advisory 已证明根目录缺少 `.diagram-design` 时，第一次生成会停在品牌配色提问。项目根必须预先放 `profile: default`，且真跑必须证明没有出现该提问。

## 明确假设

1. “exact-SHA” 指 FLY-2015 审查和 QA 绑定的 companion PR head `82737e5d…`，而不是以后会继续移动的 `main`。合并状态只证明依赖已满足，不改变安装字节的 pin。
2. “项目域安装”以 issue 明写的 `.claude/skills/diagram-design/` 为最低硬交付；为复现 FLY-2015 的双 agent 安装命令，安装器若同时产出 `.codex/skills/diagram-design/`，需先研究其真实落盘形态，再决定是否纳入提交，不能凭猜测扩 scope。
3. “真图”是模型生成的自包含 HTML/SVG，并保存可复核截图；不是手工复制 FLY-2004 的 SVG，也不是只跑 parser/self-check。
4. “不掉档”以 FLY-2004 的 `arm-b-diagram-design-stock.png` 为视觉锚点，比较信息层级、布局、配色克制、连线可读性、中文清晰度和整体完成度。生成成功本身不等于通过。
5. 本单如实记录模型实际选用的 CJK fallback；不把一次结果升级成全项目字体标准，不改 `publish-report` CSP，也不新建 `flywheel` profile。

## 方案比较

| 方案 | 优点 | 代价/风险 | 结论 |
|---|---|---|---|
| 直接从 `flywheel-skills main` 安装 | 命令最短 | `main` 会漂移，无法证明装的是 FLY-2015 已审字节 | 拒绝 |
| 使用本机 `flyview-skills` checkout | 无需临时 clone | checkout 落后且有用户脏改，来源不可信且不能碰 | 拒绝 |
| exact PR head 临时 clone → project-scoped `skills@1.5.10 --copy` | 与 FLY-2015 QA 同形；可核 commit、tree、SHA；不碰全局 | 需提交大量 vendor 文件并为 git exclude 做精确 force-add | 采用 |
| 只手工复制 `SKILL.md` | 改动小 | 丢失 53 references、149 assets、3 scripts，skill 不完整 | 拒绝 |

## 范围与非范围

本单交付 `.claude/skills/diagram-design/`、根 `.diagram-design`、安装/来源合同测试、生成的真图 HTML/SVG/截图和对比记录。不会使用全局安装，不修改用户级 `~/.agents`/`~/.claude`/`~/.codex`，不恢复 scheduled skill sync，不改字体包、CSP、报告模板、角色分配或 Flywheel runtime。

## 成功判据

- 安装目录来自 exact `82737e5d…`，installed `SKILL.md` SHA-256 与该 commit 的库版本逐字一致。
- 根 `.diagram-design` 精确为 `profile: default`，自然请求生成过程中没有品牌配色问答。
- 模型生成中文正文、自包含 HTML/SVG，并留截图；上游 `self_check.py` 通过。
- 与 FLY-2004 B 臂并排评估不掉档；CJK 字体实际结果可复核，但不在本单锁定未来方案。
- 测试、全仓门、request-driven code review 和 PR 交接完成；不 merge、不部署、不重启。
