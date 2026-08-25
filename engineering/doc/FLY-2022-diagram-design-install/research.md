# FLY-2022 diagram-design 项目安装 — 调研
Issue: FLY-2022 (https://linear.app/geoforge3d/issue/FLY-2022/vendor-diagram-design-%E5%AE%89%E8%A3%85%E8%BF%9B-flywheel-%E9%A1%B9%E7%9B%AE%E9%A1%B9%E7%9B%AE%E5%9F%9F%E5%AE%89%E8%A3%85-%E9%BB%98%E8%AE%A4%E9%85%8D%E7%BD%AE-%E7%9C%9F%E5%9B%BE%E9%AA%8C%E8%AF%81)
日期: 2026-08-24
基于: exploration.md

## 1. 依赖与来源状态

两项依赖都已满足：

| 对象 | 当前权威状态 | 本单使用的 pin |
|---|---|---|
| Flywheel PR #937 | merged；当前 `origin/main` commit `533adc64f` | 当前 worktree base |
| `flywheel-skills` PR #18 | merged at `2026-08-24T17:22:32Z`；guard SUCCESS | PR exact head `82737e5d2756950642e278f1aabf3dd384356f47` |
| companion merge commit | `5c2cf224bb653b9c7a7bcc4cef9c337eda12222b` | 只证明已 merge，不作为安装 source |
| upstream source | `cathrynlavery/diagram-design` v2.6.5 | provenance commit `648c2a597839301e06df1e7434a08bde9f42eed3` |

远端 GitHub tree API 在 exact companion head 上量得：`skills/generic/diagram-design/` tree object = `8fe791a61ab857ae7994f90681cbd5db1ac5ee4b`，共 208 个 blob、4 个子目录（206 个上游文件 + skill-local `LICENSE` / `THIRD_PARTY_LICENSES.md`）。vendored `SKILL.md` SHA-256 = `0d4f3cce282b128887a4ce1c4ad140b7c3fd1dafe4b5be606a68593284592971`。这不同于 provenance 中的原厂 `SKILL.md` SHA，因为 companion 合法增加了 frontmatter/provenance/FLY-2015 limits header。

第一次 GitHub raw 探针因 zsh 把未引用的 `?ref=` 当 glob 而得到空输入哈希；该结果已明确作废。以上数值来自引用 endpoint 后的复测。

## 2. FLY-2015 project-scope 安装复现

在 `/private/tmp/fly2022-install-probe.wz8BxR` 做了隔离复现：

1. `gh repo clone xrliAnnie/flywheel-skills <temp>/source`；
2. `git checkout --detach 82737e5d…` 并逐字核 `rev-parse HEAD`；
3. 新建空 git repo；
4. 用任务专属 npm cache 运行：

```bash
npm_config_cache=<temp>/npm-cache npx -y skills@1.5.10 add \
  <absolute-exact-source> \
  --skill diagram-design --agent claude-code codex -y --copy
```

宿主默认 npm cache 有既存 root-owned 文件，首次 npx 在下载前以 `EPERM` 退出；没有写目标项目或用户级 skill。改用任务专属 cache 后同一命令成功。没有修改宿主 cache 权限。

## 3. 安装器真实落盘形态

`skills@1.5.10` 实际生成：

| 路径 | 结果 |
|---|---|
| `.agents/skills/diagram-design/` | 208 files，完整 copy |
| `.claude/skills/diagram-design/` | 208 files，完整 copy |
| `.codex/skills/diagram-design/` | 不生成 |
| `skills-lock.json` | 生成，source 是临时 clone 的绝对路径 |

两份 project copy 经 `diff -qr` 逐字一致，两个 `SKILL.md` SHA 都是 `0d4f3c…`。安装前后，用户级 `~/.agents/.skill-lock.json` SHA 保持 `4784f02a…`，且 `~/.agents/skills/diagram-design`、`~/.claude/skills/diagram-design`、`~/.codex/skills/diagram-design` 始终不存在，证明没带 `-g` 的命令没有污染全局。

本单不应提交 `.agents` 重复 copy 和 `skills-lock.json`：前者把同一 3 MiB 字节重复一遍却不在 issue 指定落点；后者写死一次性 `/private/tmp` source，合并后不可复现。采用 exact temp 安装产物中的 `.claude/skills/diagram-design/` 这一份，保留安装器产生的完整 208-file byte copy，并用 source tree object + `SKILL.md` SHA 双重证明来源。

## 4. Git ignore 边界

当前 shared git dir 的 `info/exclude` 明确忽略 `.claude/skills/`，用于保护每个 issue 动态注入的 `linear-issue-context`、`flywheel-escalation` 等文件。这不是“不允许提交项目 skill”的产品规则，而是 `SkillInjector` 的 session hygiene。实现时只能：

- 精确 force-add `.claude/skills/diagram-design/`；
- 绝不 `git add -f .claude/skills/` 整棵；
- 用 `git ls-files .claude/skills/diagram-design` 证明只有该具名 skill 成为 tracked；
- 用 `git status --ignored`/path-specific checks 确认其他注入 skill 仍未入 index。

## 5. 默认 profile 的真实语义

installed `SKILL.md` 的 first-time gate 明写：有效 `.diagram-design` marker 且 `profile: default` 会跳过 branding 问答。`references/profiles.md` 的 marker grammar 是整个文件只能有一行 `profile: <slug>`（允许最终 newline），`default` 是保留 built-in slug。

同一 reference 还建议首次使用时确保 `~/.diagram-design/profiles/default.md` 存在；现场该用户级文件不存在。本单只获权做 project-scope install/default config，不能为了一个 marker 偷写全局 profile library。真图 prompt 会明确禁止用户级/全局写入，并使用 project-installed shipped `style-guide.md` 的 built-in default。结果记录必须区分：

- 硬验收：没有品牌配色提问，生成继续完成；
- 安全验收：`~/.diagram-design/profiles/default.md` 前后仍不存在；
- 若模型拒绝在不建全局 default snapshot 时生成，则这是 FLY-2015 vendor 合同与本单 project-only scope 的真实冲突，不能静默扩权。

## 6. FLY-2004 对比锚点

权威锚点是：

`/Users/xiaorongli/Dev/flywheel-FLY-2004/product/doc/FLY-2004-diagram-design-eval/assets/arm-b-diagram-design-stock.png`

它表达同一条“超长 Linear issue description 如何安全进入 tmux runner”的旧/新路径：旧路径直接把全文塞进启动命令，约 16 KiB 后失败；新路径先写仅本机可读临时文件，启动命令只带 3–5 KiB 路径/脚本，再在窗口内读回，最后任务原文逐字一致。视觉特征：浅暖纸色、单一橙色焦点、灰色虚线旧路、黑色实线新路、清晰的层级和大块留白、底部水平 legend、中文在 1600px 输出中可读。

本单会把该 PNG 复制为 evidence reference（保留原路径与 SHA 记录），与新生成图并排保存，避免 reviewer 依赖另一个未合入 worktree 才能判断。

## 7. 生成合同

自然请求不出现 `diagram-design` 名称，题材与 FLY-2004 相同，并要求：中文正文、自包含 HTML、静态架构/数据流表达、PNG 预览、禁止任何用户级/全局写入。生成 session 应由项目根启动，让 Claude Code 能从 `.claude/skills/diagram-design/` 自主发现；外层命令记录退出码、输出文件和 stdout 中是否出现 branding question。

按 skill 说明，本图选择：

- visual type：Architecture；行为模式没有完全匹配项，故直接选 type，不硬套 semantic pattern；
- variant：minimal light；
- size：`social-square` / 1080×1080 viewBox，与 FLY-2004 正方形锚点可比；
- detail：balanced，≤9 个主要 node；
- audience：mixed；
- static，无 motion；
- CJK name/body fallback 至少含 `PingFang SC` / `Hiragino Sans GB` / `Noto Sans CJK SC` / `Microsoft YaHei` / sans-serif，mono 技术标签使用对应 CJK mono/system fallback；实际 `getComputedStyle` 结果另记，不把一次 fallback 锁成正式方案。

生成后硬门：installed `self_check.py`、无 diagonal connector/overlap/label-mask 明显违规的视觉检查、浏览器 `document.fonts.ready`、中文文本抽样、PNG screenshot、与 B 臂并排人工比较。只生成文件不构成 PASS。

## 8. 测试与证据设计

新增 `scripts/__tests__/fly2022-diagram-design-install.test.sh`，先 RED 后 GREEN，至少锁住：

- root marker bytes 精确等于 `profile: default\n`；
- tracked project skill file count = 208；
- installed `SKILL.md` SHA = `0d4f3c…`；
- tracked subtree tree object = `8fe791…`（clean CI/commit 上），并检查 `LICENSE`、`THIRD_PARTY_LICENSES.md`、3 scripts、53 references、149 assets 的 census；
- installed provenance upstream pin = `648c2a…`，四条 FLY-2015 limits 和 QA E2E anchor 仍在；
- `.agents/skills/diagram-design`、`.codex/skills/diagram-design`、`skills-lock.json` 未被本单 tracked；
- 其他动态 `.claude/skills/*` 没被误收。

测试加入 `.github/workflows/ci.yml` 明示 shell suite 与 `ci-structure` census。真图 evidence 另由 `generation-evidence.md`/浏览器截图证明，因为模型自动发现与观感不能靠静态 shell 断言替代。

## 9. 结论

可以实施，且不需要改 Flywheel runtime。最小正确形态是：exact companion head 的单份 208-file `.claude` copy + 一行 project marker + fail-close 安装合同 + 一次显式权威调用和一次真实自然请求生成/浏览器截图/同题视觉比较。全局安装、全局 profile、重复 `.agents` copy、临时 path lock、字体定案、CSP 与 motion 都不属于本单。

## 10. Design review R1 补充调研

R1 指出，仅凭自然 prompt 产图不能证明 installed skill 真被调用。QA 因此拆成两场同题 E2E：第一场显式要求模型 use installed skill，用 `--output-format stream-json --verbose` 保留 `Skill(diagram-design)` tool event 作为权威安装后调用证据；第二场才是不点名自然请求，独立记录 discovery 成败。两者不能互相冒充。R2 后续证明 slash prefix 在 `--print` 下不是可靠 signal，故最终显式场不用 `/diagram-design` 写法。

`profile: default` 还有一处 vendor 文档张力：primary `SKILL.md` §0 说有效 root marker 直接跳过 first-time gate，`profiles.md` 则建议确保用户级 default snapshot 存在。本单按 issue 明确指定的 §0 路径执行，并用用户级 profile 前后不存在的正向断言守住权限边界；若模型仍要求写全局或拒绝生成，必须以 vendor contract conflict 走 Lead question gate，不能临时创建全局文件。

Playwright 不在 Flywheel `package.json`、lockfile、`node_modules` 或本机 Claude plugin cache。现场存在可执行 Google Chrome `151.0.7922.172`，路径 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。最终截图改用该浏览器的 headless CLI + 临时 profile + virtual-time budget，记录 version/PNG hash/dimensions；另用 Chrome 自带 CDP + Node 22 global `WebSocket` 取得 computed fallback 与 geometry，不新增 Playwright，也不把 computed CSS 第一项误称为 OS 最终选中的物理 glyph face。

新安装合同属于 `script-tests-2`：紧跟同域 FLY-2015 role-routing step。该 shard 注释记录最近实测 11m36s，17min tripwire 前约余 5m24s；测试是纯 hash/census，focused 实测若超过 30s 则在接线前重构。合同使用 exact positive set（`.claude/skills` tracked paths 必须正好是目标 208 条），避免“没有其他动态 skill”这种空集合断言；并在生成前后重核 subtree，防止 profile customization 意外修改 tracked `references/style-guide.md`。

## 11. Design review R2 instrument 实测

Claude Code 2.1.241 的 `--allowedTools` 与 `--disallowedTools` 都是 variadic option。把 positional prompt 放在尾部会被 option 吞掉，reviewer 三次复现均 RC=1、零 model turn；prompt 改走 stdin 则 RC=0。最终 Node harness 必须把 prompt 交给 child stdin，argv 只放 flags。

slash prefix 也不是可用调用证据：reviewer 以 `/mermaid` 在 `--print` 模式实测 RC=0 但零 `Skill` event。随后在本 worktree 做正控，prompt 从 stdin 输入 “Explicitly use the installed mermaid skill”，只允许 `Skill`，结果 RC=0 且 JSONL 明确出现 `tool_use.name=Skill`、`input.skill=mermaid` 与 `Launching skill: mermaid`。显式 diagram-design 场采用这条已证实的自然语言显式调用，不用 slash prefix；仍以 exact `Skill(diagram-design)` event 为硬门。

Bash permission 同样先测 instrument：规则 `Bash(echo probe:*)` 能让模型实际执行 `echo probe ok`，RC=0。因此 self-check 规则固定为 `Bash(python3 .claude/skills/diagram-design/scripts/self_check.py:*)`，不用未经证明的空格星号写法。

`Write` 无路径约束，allow-list 不能声称预防 global write；本 Runner 的外层 filesystem sandbox 已对 Claude hook 的 `~/.claude/session-env` 写入返回 EPERM，但最终保证仍是用户级 diagram paths/lock/profile 的前后 fingerprint + 变化即 FAIL/Lead gate。浏览器侧则可以在不安装 Playwright 的前提下使用 Chrome DevTools websocket + Node 22 global `WebSocket` 取 computed font stack、bounding boxes、overflow 和异常；这比只看 PNG 更能支撑首次真图后的字体决策，但仍不能把 computed CSS family 第一项冒充为实际 glyph face。
