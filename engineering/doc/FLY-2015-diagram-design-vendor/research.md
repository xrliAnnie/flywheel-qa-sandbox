# FLY-2015 diagram-design 入库 — 调研
Issue: FLY-2015 (https://linear.app/geoforge3d/issue/FLY-2015/vendor-diagram-design-%E8%BF%9B-skill-%E5%BA%93-annie-%E5%B7%B2%E8%AE%A4%E5%8F%AF%E8%A7%82%E6%84%9F%E5%B8%A6%E5%9B%9B%E6%9D%A1%E5%AE%9E%E6%B5%8B%E9%99%90%E5%88%B6)
日期: 2026-08-23
基于: exploration.md

## 1. Provenance 已钉死

| 项 | 证据 |
|---|---|
| 上游 | `https://github.com/cathrynlavery/diagram-design` |
| commit | `648c2a597839301e06df1e7434a08bde9f42eed3` |
| GitHub verification | `verified: true`, reason `valid`, verified at `2026-08-21T22:26:24Z` |
| plugin version | `.codex-plugin/plugin.json` 与 `.claude-plugin/plugin.json` 都是 `2.6.5` |
| skill metadata | 上游 `SKILL.md` 保留较粗的 `metadata.version: "2.6"`；provenance 以 plugin manifest 的 v2.6.5 为准 |
| skill tree object | `bb5fb9ffaa5ab3b7ef7e18478958d914ed0a61ee` |
| `SKILL.md` SHA-256 | `553191201faf2e61a9b3cc24f01b688de172f67b3f9da69b544f194252fcacee` |
| license | MIT，copyright 2025 Cathryn Lavery |

上游没有 tag/release；其 `SECURITY.md` 也明确只维护最新 `main`，不把旧 commit 当长期支持版本。因此本地必须把 exact commit 写进 provenance；任何更新都重新 vendor、重新审脚本与许可证，不能把日常 sync 误当 upstream 自动升级。

## 2. 被 vendor 的精确边界

只复制上游 `skills/diagram-design/`（git tree 中 206 个文件，约 3.0 MiB）和许可证材料，不复制上游仓库级命令、prompt、CI、开发脚本或 plugin manifest。

| 子树 | 数量/体积 | 用途 |
|---|---:|---|
| `SKILL.md` | 39,535 bytes | skill 入口与路由 |
| `references/` | 53 files / 564,881 bytes | 按图类型/模式加载；最大 `primitive-icons.md` 106,768 bytes |
| `assets/` | 149 files | 自包含模板、示例与 icon catalog |
| `scripts/` | 3 Python files / 96,651 bytes | draw.io/Mermaid 解析与输出自检 |

目录内无 symlink、无 executable bit、无二进制可执行物。Python 均只用标准库；生成 HTML 无 build step。vendor 目录内另放上游 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`，因为 icon catalog 还包含 Tabler Icons（MIT）、Simple Icons（CC0）、log-z/logos（MIT）、Devicon（MIT）及两份 one-off icon provenance。

## 3. `SKILL.md` 安全审查

逐行读完 582 行。核心行为是选择图类型/语义模式、按需读 reference、写一份 self-contained HTML + inline SVG/CSS，并在导入时调用本地解析脚本。没有 credential、secret、系统配置、git、package install、shell bootstrap、远程部署、消息发送或破坏性动作指令。

需要本地覆盖的两点:

1. 上游首次使用会在默认 style guide 时暂停让用户选 branding。FLY-2015 不预设 `flywheel` profile；这是 Annie 明确要求等自动真跑后再选三款中文字体。因此先允许原厂默认，但必须显式披露字体回退。
2. 上游写「除 Google Fonts 外无外部依赖」，但 Flywheel 托管路径会拦该 stylesheet，且字体没有 CJK glyph。本地限制段必须先于上游正文出现，避免 agent 只读到乐观结论。

## 4. 三个分发脚本的安全审查

### `drawio_extract.py`

- 只读调用者指定的本地 draw.io/XML/PNG/SVG；可选 `--out` 只写调用者显式给出的路径。
- 不 import/调用 subprocess、shell、network、browser、credential 或 dynamic execution。
- 输入上限 32 MiB，解压后 XML 上限 64 MiB；zlib 逐块有界，压缩炸弹 fail-close。
- 解析前拒绝 `DOCTYPE` 与 `ENTITY`，避免外部实体/实体膨胀；ElementTree 只解析本地字符串。
- HTML label 只去 tag/unescape 后作为 inert text/Markdown 输出；不执行链接或标签。
- 风险边界: `--out` 没有仓库 containment，故 agent 只能把它用于用户授权的目标文件；这不是隐式写入。

### `mermaid_extract.py`

- 文件上限 4 MiB、节点 2,000、边 5,000；仅支持四类 grammar，其他类型明确 exit 2。
- 不 render Mermaid、不执行 JS/URL/directive/label；`click` 与 style directive 只计数后丢弃。
- label 经过 HTML/Markdown 清理后以 inert Markdown/JSON 输出；无 eval、subprocess、network 或 credential access。
- 可选 `--out` 同样只写调用者显式路径。

### `self_check.py`

- 只读本地 HTML 与随 skill 分发的 canonical motion template。
- 拒绝 iframe/object/embed/base、所有 `on*` executable attribute、`srcdoc`、任意额外 script、远程 image/reference、非 image `data:` URL。
- 唯一允许的远程 stylesheet 是 exact HTTPS `fonts.googleapis.com/css2`；动画 JS 必须与 template 中 canonical controller 逐字一致。
- canonical controller 只处理 query/state/DOM/timer/reduced-motion；无 fetch/XHR/WebSocket/storage/cookie/window-open。
- 这条 allowlist 证明没有额外联网面，但不证明 Google Fonts 在 `publish-report` CSP 下可用；四限制仍是更高层运行事实。

### 托管 motion 补充（不计入 FLY-2004 四条实测限制）

代码审查另发现一条托管兼容性边界：原厂 `template-motion.html` 的 canonical `<script data-diagram-controls>` 没有 `__CSP_NONCE__`。`report-registry` 对无自带 CSP 的报告注入的默认 CSP 没有 `script-src`；只有 exact nonce placeholder 才会获得带 nonce 的 `script-src`。因此原厂动画图直接经 `publish-report` 后 controller 被拦，只剩 `<noscript>` 的完整静态终态。这不是第五条 FLY-2004 实测结论，而是本次代码审查新增的披露；本 vendor 单不改模板或 CSP，只禁止把托管后动画冒充为可用，也禁止通过自带 CSP meta 绕过保护性注入。

## 5. Assets 与外部面

149 个 asset 主要是静态 HTML/SVG。活动网络加载只有 Google Fonts stylesheet；`icons.html` 有指向 Tabler/Simple Icons 的普通 attribution 链接，需用户点击才导航。Gallery `index.html` 的 JS 只切换同目录 iframe；三份 animated example 与 `template-motion.html` 共享 canonical controller。扫描未发现 `fetch`、XHR、WebSocket、EventSource、cookie、local/session storage 或远程 script。

## 6. 实跑证据

在 exact commit 上通过:

- `python3 scripts/test-self-check.py`
- `python3 scripts/test-verify-drawio-import.py`
- `python3 scripts/verify-mermaid-import.py`
- `python3 -m py_compile skills/diagram-design/scripts/*.py`

覆盖包含: executable attribute、remote image、伪造字体 host、`javascript:`/`data:text/html`、iframe、任意 script、修改后的 controller、第二 script、隐藏 motion item、缺 noscript、资源上限、恶意 Mermaid label 与所有明确 exit-2 路径。

## 7. FLY-2004 的四条实测限制（本单的 runtime contract）

1. **观感认可 ≠ 自动生成稳定。** B 臂是 runner 照 39.5 KiB 规范手画；本单交给 QA 的唯一不可省 E2E 是安装后让 skill 自动画同题图，再与手画版比较。
2. **三款原厂字体没有中文字形。** 无 CSP 且 faces 真加载时，`任务说明全文` 在 Instrument Serif / Geist / Geist Mono 下都与各自 generic control 同宽（240px）。中文正文必回落到系统 CJK 字体；本单不替 Annie 选替代字体。
3. **托管 CSP 拦 Google Fonts。** 无自带 CSP 的卡经 `publish-report` 会被注入 `default-src 'none'; style-src 'unsafe-inline'; img-src data:;`，所以 stylesheet 被拦；自带 CSP 的报告保留自己的，不能说成无条件。
4. **移动靶。** 2026-08-23 GitHub API 为 25,838 stars；owner 贡献最多但已有多位 contributor。治理风险仍是主要维护权集中 + 快速变化，pin 只把漂移变成显式升级成本。

## 8. FLY-464 对照

FLY-464 当天 cancel 的问题是把绘图能力绑到团队不用的 Obsidian。本次 vendor 的是原生 Agent Skill 目录，安装器原样扇出到 Claude Code/Codex，输出仍是普通 HTML/SVG，不增加 Obsidian 或新的 runtime dependency。

## 9. 当前分发现实

2026-08-23 现场核对显示 `com.flywheel.skills-update` 在 `launchctl print-disabled gui/501` 中为 `disabled`，且该 service 没有加载；`~/.flywheel/logs/skills-sync.log` 最后一次成功是 2026-07-29。仓库账本也把它列为 external unit，FLY-1814 auxiliary decision 仍是 `pending`，恢复入口受 founder gate 管理。所以本单的两个 PR 只证明「远程仓已 vendor + role 已分配」，不证明「生产全机已安装」。本单不恢复该 job；后续受权 operator 需手跑 `~/.flywheel/bin/skills-sync.sh`，并核对 lockfile managed set 与 Claude/Codex 链接。回滚也同样需手动 sync，不能承诺「≤1 天自动收敛」。

## 10. 结论

可 vendor，风险可接受且可逆。前提不是先解决四条限制，而是把它们放进安装后每次相关调用都能读到的位置，并把首个自动生成 E2E 留给独立 QA。最小实现是 pinned byte copy + provenance/limits header + role frontmatter 与正文调用路由 + 合同测试；不需要新同步器、profile 系统、字体包或 CSP 例外。生产分发是之后的受权手动运维步骤，不在本 implement 节点内。

## 11. 实施与终检记录

companion 仓 `flywheel-skills` 已把 exact upstream subtree 放在 `skills/generic/diagram-design/`；除本地 frontmatter/provenance/limits header、根许可证副本外，上游 skill body 与其余子树逐字节一致。`scripts/skill-guard.sh` 对 exact commit/tree/SHA、许可证、四个限制 anchor、独立 QA anchor 与 motion CSP 披露 fail-close；本地 `SKILL.md` description 收窄到 architecture/flow/editorial diagram，避免与 quantitative chart/dashboard 路由重叠。

主仓把 `diagram-design` 分配给 engineer、designer 三个 variant、product-designer、prototype、PM，并在正文明确使用边界；QA 故意不分配，以保持首个自动生成 E2E 的独立性。`scripts/__tests__/fly2015-diagram-design-roles.test.sh` 以 20 条合同锁住 frontmatter、正文路由、dataviz/Mermaid 分界、缺失 skill fallback 与 QA 独立性，且已纳入 CI shell suite 清单。PM 的 `⧗` 如实表示当前未安装，但路由 guard 不绑定该暂态部署标记。

终检结果:

- `pnpm lint`: 0 error，7 条既有 warning；
- `pnpm -r build`: 22 个 workspace build 通过（首次发现隔离 worktree 缺依赖后，仅执行 `pnpm install --frozen-lockfile`，lockfile 未变化）；
- `pnpm test:packages:run`: canonical aggregate 的唯一失败在未改动的 `packages/claude-runner`，3 个固定 5s/15s 用例超时，850 tests 通过；相关 package 与本分支无 diff；
- 降并发复跑把此前 load-sensitive `config` 用例洗绿；未改动的 `flywheel-comm` 真实 Git 用例在整包 1,616 项负载下固定 5s 超时一次，单独复跑 2/2 通过（慢例 1.734s）；
- 本单 shell 合同 20/20、CI shell census 213/213、CI structure、PM role 62/62、skill variant 32/32 与 shellcheck 全绿；
- companion `skill-guard.sh`、skill validator、Python compile、静态/动画 self-check、上游 self-check/draw.io/Mermaid 全套测试、exact tree/body/license 比对全部通过。

这些验证只证明安全 vendor、角色路由与静态合同，不替代 FLY-2015 的首个安装后自动生成 E2E；后者仍是独立 QA 的硬验收。
