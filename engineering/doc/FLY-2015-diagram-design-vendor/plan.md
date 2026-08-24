# FLY-2015 diagram-design 入库 — 实施计划
Issue: FLY-2015 (https://linear.app/geoforge3d/issue/FLY-2015/vendor-diagram-design-%E8%BF%9B-skill-%E5%BA%93-annie-%E5%B7%B2%E8%AE%A4%E5%8F%AF%E8%A7%82%E6%84%9F%E5%B8%A6%E5%9B%9B%E6%9D%A1%E5%AE%9E%E6%B5%8B%E9%99%90%E5%88%B6)
日期: 2026-08-23
基于: research.md

## 1. 范围

一段式完成两个最小改动面:

1. `xrliAnnie/flywheel-skills`: vendor exact upstream skill，保留许可证/第三方归属，在入口最前加入 provenance、四条实测限制和唯一 QA E2E。
2. `xrliAnnie/flywheel`: 在实际会画架构图或交付 HTML 的 agent role 中分配 `diagram-design`；同时改 frontmatter 与正文 skill map / 使用路由，因为这些 role 明写 frontmatter 只是说明性字段，实际行为合同在正文。一并提交本单 doc-flow，并在最后一个 commit 加 `CLAUDE.md` milestone 行。本单不取新版本号：无 Flywheel runtime/package 产物变更。

不安装生产 skill，不建 `flywheel` profile，不选中文字体，不改 `publish-report` CSP，不改 HTML 模板，不接 Obsidian，不部署/重启/merge。当前 `com.flywheel.skills-update` 有 disabled override 且未加载（FLY-1814 决策账本仍为 `pending`），所以两个 PR 合入也不代表已分发；本单不擅自恢复该 founder-gated job，只把后续手动 sync 与验证步骤交给受权 operator。

## 2. 实施顺序（TDD）

### 2.1 Flywheel 角色合同 RED

新增 `scripts/__tests__/fly2015-diagram-design-roles.test.sh`，先断言以下文件的 `skills:` 列表包含 `diagram-design`:

- `.flywheel/agents/engineering/engineer-executor.md`
- `.flywheel/agents/engineering/designer-executor.md`
- `.flywheel/agents/engineering/designer-executor.bare.md`
- `.flywheel/agents/engineering/designer-executor.matt.md`
- `.flywheel/agents/engineering/product-designer-executor.md`
- `.flywheel/agents/engineering/prototype-executor.md`
- `.flywheel/agents/engineering/pm-executor.md`

由于 role 正文明确声明 frontmatter 只是说明性字段，同一测试还必须断言可执行路由:

- `engineer`: 架构/流程图或独立 HTML 图解时显式调用 `diagram-design`；
- 三份 `designer` variant: 同时修改 Step 2 路由散文与 skill map；把需要编辑观感的 flows / relationships / architecture 路由给 `diagram-design`，保留 `mermaid` 作为简单 source-first 图的选项；`dataviz` 只承担数值编码是主体的 chart / dashboard / data-dense 可视化，`diagram-design` 承担解释结构/行为的 editorial diagram；
- `product-designer`: doc/spec 需要架构、流程或关系图时路由给 `diagram-design`；
- `prototype`: 原型验证需要独立 HTML 架构/流程图时路由给 `diagram-design`；
- `pm`: founder explainer 需要架构/流程/关系图时路由给 `diagram-design`。

测试必须先因缺少分配和正文路由而 RED；随后 role 实现面只编辑上述七份文件变 GREEN。测试还断言 QA role 不被默认分配，避免把独立验收职责混成日常产出职责。新 shell test 必须加入 `.github/workflows/ci.yml` 的明示枚举，并跟随现有 CI 结构合同测试。

### 2.2 flywheel-skills vendor 合同 RED

在干净 clone 的 FLY-2015 分支中先给 `scripts/skill-guard.sh` 加 additive fixture，要求:

- `skills/generic/diagram-design/SKILL.md` 存在且 name 与目录一致；
- `SKILL.md` 第一行必须是 opening `---`，provenance comment 必须放在 closing `---` 之后；
- provenance exact pin = `648c2a597839301e06df1e7434a08bde9f42eed3`、upstream path、MIT；
- 收窄后的 description 保留 architecture / flow / standalone HTML 发现语义，不用泛化 chart / dashboard 触发词与 `dataviz` 争抢数值可视化；
- `LICENSE` 与 `THIRD_PARTY_LICENSES.md` 随 skill 分发；
- 四条限制分别有独立 anchor；
- FLY-2004 手画观感与安装后自动生成 E2E 明写，不能被「已经验稳定」措辞替代。
- 另有一条安全审查补充 anchor（不冒充 FLY-2004 的第五条实测限制）：原厂 motion controller 没有 `__CSP_NONCE__`，无自带 CSP 的动画图经 `publish-report` 后脚本被拦、只保留 `noscript` 静态终态；不得加自带 CSP meta 绕开保护性注入。

先运行 guard，确认 fixture 因目录不存在而 RED。

### 2.3 机械 vendor + 最小本地覆盖

从 exact detached upstream checkout 机械复制 `skills/diagram-design/`，排除运行测试生成的 `__pycache__`；把 root `LICENSE` 与 `THIRD_PARTY_LICENSES.md` 放进 skill 目录。

只允许三类本地改动:

1. frontmatter `description` 收窄到 flywheel-skills 的 350-character discovery 预算；保留 architecture / flow / sequence / state / data / process / org / timeline / standalone HTML/SVG 语义，刻意不放泛化 chart / dashboard 触发词，避免与 `dataviz` 自动路由冲突；
2. 紧跟 frontmatter closing `---` 之后的 provenance comment（repo、commit、upstream path、license、原始 `SKILL.md` SHA-256、本地修改清单）；
3. 紧接 provenance 的 FLY-2015 operational limits 段，逐条写四限制、QA E2E 与单独标记为本次代码审查所得的 motion/CSP 补充。

其余上游 `SKILL.md` body、53 references、149 assets、3 scripts 保持 exact bytes。用 path-by-path diff 证明除上述文件/新增许可证外没有漂移。

### 2.4 角色与 README 说明

`flywheel-skills/README.md` 新增一条 vendor inventory，写 exact pin、update policy、七个 Flywheel role、四限制摘要、motion/CSP 审查补充和 linked primary Flywheel PR。README 是治理索引；真正角色分配以 Flywheel agent 正文的 skill map / 使用路由为行为合同，frontmatter 与之保持一致。

## 3. 验证

### 3.1 Target skill repo

- `scripts/skill-guard.sh`
- Skill Creator: `quick_validate.py skills/generic/diagram-design`
- `python3 -m py_compile skills/generic/diagram-design/scripts/*.py`
- `self_check.py` 跑 shipped static template 与 animated example
- 运行 vendored `mermaid_extract.py` / `drawio_extract.py` 的 happy-path 与恶意/超限用例
- 比较 upstream/vendored tree，确认本地漂移仅为声明过的 header/description/LICENSE placement

### 3.2 Flywheel repo

- 新角色合同 shell test
- 与 agent prompt/role registry 相关的定向 tests
- `pnpm lint`
- `pnpm -r build`
- `pnpm test:packages:run`
- 新 `scripts/__tests__/*.test.sh`

若宿主全量门撞到既有 GUI/容量边界，保留原始 aggregate 结果并隔离复跑，不伪报整门全绿。

## 4. Review、PR 与 QA handoff

1. plan 先走 request-driven design review；CHANGES 则修 plan 后开新 gate。
2. 两仓实现分别原子提交；实现完成后对最终 exact HEAD 走 request-driven code review，CHANGES 则修复并开新 gate。
3. 两仓各开 PR，互相链接；**Flywheel PR 是 primary DAG PR，flywheel-skills PR 是 companion**。primary PR 正文必须逐字写出 companion PR 链接与 exact head SHA；code review 与 QA 都必须真读该 SHA 的 skills 仓内容并把结论绑定到它，不能只 review primary diff。
4. Ship 顺序固定为 **companion skills PR 先、primary role-allocation PR 后**，避免 role frontmatter 指向尚不存在的 skill。两仓都受 2026-08-23 22:30 PT 前 merge freeze 约束；本 implement 节点只备到 ready，不 merge。
5. PR body 与 Lead report 都把独立 QA 唯一不可省 E2E 写成显式步骤:
   - 先用 `gh repo clone` 把 companion repo 拉到临时 source 目录，fetch companion PR head，`git checkout --detach <exact-head-sha>`，并要求 `git rev-parse HEAD` 与 primary PR 所 pin SHA 逐字相等；不使用不受支持的 `xrliAnnie/flywheel-skills#<commit-sha>`（`skills@1.5.10` 对该 owner 会把 fragment 当 `git clone --branch`）；
   - 在另一个新建的临时 git repo 内，用 `npx -y skills@1.5.10 add <absolute-local-source-path> --skill diagram-design --agent claude-code codex -y --copy` 做 project-scoped 安装（绝不带 `-g`）；QA 前后比较生产 `~/.agents/.skill-lock.json`、`~/.agents/skills/diagram-design` 与全局 `~/.claude/skills/diagram-design` / `~/.codex/skills/diagram-design` 快照，证明零变化；
   - 先用不点名 `diagram-design` 的自然请求「把 FLY-2004 同一题材画成一张正文为中文的自包含架构 HTML」，记录收窄 description 后是否自动发现并调用该 skill；这是观察项，未发现就在 QA 报告/安装限制中如实写明，不为了自动发现反向放宽 description，也不提前终止下一步质量对比；
   - 随后按 role 正文合同显式调用 `diagram-design`，让它自动生成同题图，再与 Annie 已认可的手画 B 臂并排比较观感、中文 fallback、托管 CSP 下字体结果；这才是硬 PASS/FAIL；
   - 如果输出有 motion，另验 `publish-report` 下的 controller nonce；未带 `__CSP_NONCE__` 就必须如实记为托管后静态退化，不声称动画可用；
   - 诚实给 PASS/FAIL，不把「生成了文件」当「同一水平」。
6. 两个 PR 合入不会自动分发。受权 operator 在后续部署窗手动运行 `~/.flywheel/bin/skills-sync.sh`，然后核对 `~/.agents/.skill-lock.json` managed set 含 `diagram-design`，且 `~/.claude/skills/diagram-design` / `~/.codex/skills/diagram-design` 都指向 canonical 安装。本单不恢复 `com.flywheel.skills-update`，不把这一次手动操作冒充成自动收敛。

## 5. 回滚

- skill 不喜欢或 E2E 不达标: revert flywheel-skills PR，并 revert primary role-allocation PR。鉴于 scheduled sync 当前 disabled，不承诺≤1 天自动收敛；受权 operator 在 revert 合入后手跑 `~/.flywheel/bin/skills-sync.sh`，核对 lockfile managed set 与三个全局目录已移除 `diagram-design`。
- 角色分配有误: revert primary Flywheel PR；没有 runtime data migration、配置迁移或部署状态。
- upstream 升级不在本单: 另开 PR，重审 exact new commit，绝不静默跟 `main`。

## 6. 验收矩阵

| 要求 | 完成证据 |
|---|---|
| 安全审查 | `research.md` + exact pin + 三脚本/asset 实跑；code review |
| 提交进 flywheel-skills | target repo skill tree、green guard、target PR |
| 按角色分配 | 七份 agent frontmatter + 正文 skill 路由 + RED→GREEN 合同 test + primary PR |
| 四限制随单带走 | installed `SKILL.md` 顶部 operational limits + guard fixture + README |
| 自动生成稳定性不冒充已验 | implement 不装生产；QA handoff 明确同题自动 E2E |
| FLY-464 不重蹈 | 无 Obsidian、无新 runtime dependency、原生 Agent Skill |
| 可逆 | 两仓 pure-file revert；无部署/重启/DB mutation |
| 分发语义诚实 | PR 只 vendor/分配；scheduled sync disabled 明写；后续手动 sync + lockfile/链接核对 |
| 项目账本 | `CLAUDE.md` milestone 作最后 commit；显式不取新版本号 |
