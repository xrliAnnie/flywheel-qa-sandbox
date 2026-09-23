# FLY-2766 Codex 升级前置兼容 — 实施计划
Issue: FLY-2766 (https://linear.app/geoforge3d/issue/FLY-2766/模型跟随最新-codex-模型别名化工作流模板-implement-节点与-cli-默认模型不再写死版本号gpt-56-sol-gpt-6)
日期: 2026-09-22
基于: research.md

## 目标与完成定义

本 PR 解除 Codex 0.156.0 的 TUI 与 native-skill admission 升级阻塞，并准备但不提前激活
GPT-6 Sol：

1. runner `resume --remote` 不携带 sandbox / approval permission override；daemon 仍以
   workspace-write + never + bounded roots + network 启动；
2. runner TUI command shape 在 0.153.2 与 0.156.0 都可运行，并与已上线的 Lead TUI 命令一致；
3. capability-bundle-v2 通过 version-keyed exact baselines 接受审计过的 0.153.2+旧树、
   0.154.0/0.156.0+新树组合；0.156.0 是目标，未知或错配状态仍 fail-closed；
4. registry 接受 exact `gpt-6-sol`，但 `codex` 默认仍为 `gpt-5.6-sol`；
5. runbook 明确 merge/deploy → isolated QA → 四 home 升级 → review-lane smoke → CLI default
   → 两张 active template revision → fresh-run smoke 的顺序与回滚；
6. implement 阶段不操作全局 CLI/config、生产模板/Lead、在飞 run、Raya、Bridge，不派 QA，
   不 merge/deploy。

FLY-2769 的产品线指针与自动跟随升级不在本单实现。

## 已确认 public seams

- runner remote argv：`buildRunnerTuiCommand(spec)` 与 `ensureRunnerTuiWindow(spec, deps)`；
- app-server 权限：`CodexTmuxAdapter` 注入的 runtime options；
- native admission：version resolver、`verifyNativeSkillBaseline()`、
  `preparePinnedNativeSkillHome()`、capability manifest 与 read-only host canary；
- 模型允许/显示：registry lookup / selection / catalog、`modelDisplayName()` / phase label。

真机双版本 TUI、0.156.0 Lead cold start、review companion 和 fresh-run dispatch 属于 QA/Lead
验收；单测只覆盖可执行合同，不伪造 production activation。

## TDD 任务

### T1 — Remote TUI 权限单一权威：RED → GREEN

先改 `packages/claude-runner/test/codex-runner-tui-window.test.ts`：

- 命令仍含 exact CODEX_HOME、execution/state coordinates、`resume --remote`、socket、`-C`、thread；
- 命令不含 `-s` / `--sandbox` 或 `approval_policy`；
- 注入 tmux 的 `new-window` command 同样不含 permission override。

确认当前实现因旧 override 见 RED 后，最小删除
`packages/claude-runner/src/codex-runner-tui-window.ts` 的两项 client permission argv；不改重试、
window identity、liveness、环境清洗或 `-C`。再运行 helper tests 与已有 adapter daemon-policy test，
证明 daemon 的 workspace-write / never / roots / network 不变。

### T2 — Version-keyed native skill pins：RED → GREEN

先扩 native-skill/home/runtime-factory tests：

- exact 0.153.2 + 旧树、0.154.0 + 新树、0.156.0 + 新树分别通过；
- 0.153.2 + 新树、0.154.0/0.156.0 + 旧树、未知版本、额外/缺失/篡改文件全部
  `baseline_drift`；
- `preparePinnedNativeSkillHome()` 按实际 binary version 选择 baseline，不能从 runtime home 学习；
- capability manifest 记录本次实际选中的 version/origin/sources，不总写 target constant；
- exported target baseline 为 0.156.0，旧两条仅为显式 transition/rollback pins。

再以机械、可复核的 SHA-256 清单生成两组 resource digests：0.153.2 旧树，以及逐字相同的
0.154.0/0.156.0 新树。三个 origin 固定为
`$(cd ~/.codex-259-qa/packages && pwd -P)/native-skill-baselines/<version>/skills/.system`；当前主机
的 canonical packages 根是 `/Users/xiaorongli/.codex-242/packages`，而
`~/.codex-259-qa/packages` 是指向它的软链。active/companion home 会被 CLI 刷新，禁止作为
origin。最小运行时代码提供 exact-version resolver；受信 baseline 配置允许经过这层目录软链，
但在读树和比较前必须统一解析到 realpath，随后每个子目录/文件仍 fail-closed 拒绝软链与漂移。
native-home 与 runtime manifest 共用 exact-version 选择；不接受 semver range，不自动写 baseline。

更新 `scripts/qa-fly-2519-native-skills-canary.mjs` 并新增独立 origin canary 及测试，锁定两种
no-argument 输入形状：home mode 接受绝对、realpath、位于 `$HOME` 下的既定 Codex home，版本
只从该 home 的 `packages/standalone/current/codex` 读取；origin mode 接受 exact version，并只允许
resolver 返回的 committed `origin.root`，版本来自 path 的 `<version>` segment 且必须与输入一致。
两者都不启动模型、不读 auth、不修改文件，并输出 version、selected origin、六个 source digest、
`modelStarted=false`、`productionMutated=false`。

### T3 — GPT-6 Sol exact registry 前置：RED → GREEN

在 config tests 先加：

- `MODEL_IDS` 暴露 stable exact `gpt-6-sol`；
- entry 精确为 `surfaces=[runner, workflow]`、无 alias、runner 只允许 `xhigh`、workflow 允许
  standard role efforts、lead/cron/dispatch 不可选；
- workflow catalog 列出它，`codex` 仍解析到 5.6，`astra` 仍解析到 6 Astra；
- 未注册 future Sol id fail-closed；`modelDisplayName(gpt-6-sol) = GPT-6 Sol`，Astra 现状不改。

确认 RED 后，最小修改 `model-builtins.ts` 与 `model-tiers.ts`。不改 `CODEX_STANDARD`、seed、
workflow migration 或 bindings。PR/runbook 明示 entry 部署后即暴露于 catalog/writer；cutover 前
冻结 model/template 编辑，不把流程约束伪装成技术 fence。

### T4 — 直接相关回归与消费者盘点

- 以每个 changed file 的完整路径、文件名、父目录执行 `git grep -lF`；保留直接消费者测试，
  在验证记录逐条说明排除项。
- changed TypeScript 对各 owning package 运行 `vitest related <files> --run`，每批至多 6 个路径。
- 执行 runner TUI liveness/shell safety、config registry/display/phase label、teamlead native
  baseline/home/runtime-factory/canary 直接测试。
- 若 related 暴露 exhaustive consumer，只作本合同需要的最小更新，不清理旁支硬编码。

### T5 — 不可颠倒的 cutover / rollback runbook

milestone 与 PR body 写清下列外部步骤；implement 节点不执行。QA 先于隔离环境复演同一物化与
canary 流程并通过；这份 receipt 不能代替 Lead 对真实 origin 路径的操作：

1. QA 通过后、发 founder ship 卡前，Lead 必须对真实路径执行下面两段命令；两段都成功前不得
   请求 ship approval。保持现有 binary/config/template，不重启生产 Lead。第一段是纯 shell 加
   已安装 Codex binary，不读取本 PR 代码：已有 version 目录绝不覆盖，新目录先在同一父目录
   staging，去掉写位后再 rename；第二次执行只报告 `already materialized`。

   ```bash
   (
     set -euo pipefail
     old_home=/Users/xiaorongli/.codex-259-qa
     new_home=/Users/xiaorongli/.codex-raya
     baseline_root="$(cd "$old_home/packages" && pwd -P)/native-skill-baselines"
     codex_0156=/Users/xiaorongli/.codex-259-qa/packages/standalone/releases/0.156.0-aarch64-apple-darwin/codex
     work_dir="$(mktemp -d /tmp/fly2766-native-origin.XXXXXX)"
     stage_dir=
     cleanup() {
       rm -rf -- "$work_dir"
       if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
         chmod -R u+w "$stage_dir"
         rm -rf -- "$stage_dir"
       fi
     }
     trap cleanup EXIT

     [[ "$(readlink "$old_home/packages/standalone/current")" == */0.153.2-* ]]
     [[ "$(readlink "$new_home/packages/standalone/current")" == */0.154.0-* ]]
     mkdir -p "$work_dir/codex-0156"
     [[ "$(CODEX_HOME="$work_dir/codex-0156" "$codex_0156" --version 2>/dev/null)" == "codex-cli 0.156.0" ]]
     CODEX_HOME="$work_dir/codex-0156" "$codex_0156" app-server \
       </dev/null >"$work_dir/app-server.stdout" 2>"$work_dir/app-server.stderr"

     materialize() {
       local version="$1" source="$2" target="$baseline_root/$1"
       if [[ -d "$target/skills/.system" ]]; then
         printf 'already materialized: %s\n' "$target"
         return 0
       fi
       [[ ! -e "$target" ]]
       stage_dir="$(mktemp -d "$baseline_root/.${version}.XXXXXX")"
       mkdir -p "$stage_dir/skills/.system"
       cp -R "$source"/. "$stage_dir/skills/.system/"
       chmod -R a-w "$stage_dir"
       mv "$stage_dir" "$target"
       stage_dir=
       printf 'materialized: %s\n' "$target"
     }

     mkdir -p "$baseline_root"
     materialize 0.153.2 "$old_home/skills/.system"
     materialize 0.154.0 "$new_home/skills/.system"
     materialize 0.156.0 "$work_dir/codex-0156/skills/.system"
   )
   ```

   物化段不依赖本 PR；独立校验段依赖本 PR 新增的 version resolver 与 origin canary，因此 Lead
   必须从已复审的 PR worktree、在 exact reviewed HEAD 执行下面命令，不得从尚未包含本 PR 的
   current main 执行。三行 JSON 都必须是 `status=passed`，且 `selectedOrigin` 带对应 exact
   version；canary 会把完整 file/source digest 与本 PR 登记值逐项比较。任何写位、缺失文件、
   额外文件或 digest 不一致都失败：

   ```bash
   (
     set -euo pipefail
     repo_root="$(git rev-parse --show-toplevel)"
     cd "$repo_root"
     pnpm --filter "flywheel-teamlead..." build
     baseline_root="$(cd /Users/xiaorongli/.codex-259-qa/packages && pwd -P)/native-skill-baselines"
     for version in 0.153.2 0.154.0 0.156.0; do
       if find "$baseline_root/$version" -perm -0200 -print -quit | grep -q .; then
         printf 'mutable origin rejected: %s\n' "$version" >&2
         exit 1
       fi
       FLYWHEEL_NATIVE_SKILL_BASELINE_VERSION="$version" \
         node scripts/qa-fly-2766-native-origin-canary.mjs
     done
   )
   ```

   校验输出的 `selectedOrigin` 必须位于该 canonical `baseline_root`，不能回显含
   `.codex-259-qa/packages` 软链段的逻辑路径；三版在生产真实路径全部 `status=passed` 才满足
   QA 判据。两段命令均成功后才允许发 ship 卡。漏做会让部署后的 capability-bundle-v2 在首次 cold start
   解析到不存在的 committed origin，runtime 抛出 `native_skill_home_unverified`，operator canary
   输出 `native_skill_baseline_unverified`；新 runner/Lead 无法启动，并同时失去
   0.153.2/0.154.0 的安全 rollback 路径。任何 CLI 都不得把 active skills 写入这些 origin 路径；
   校验失败时禁止发 ship 卡，禁止用现有 home 静默回退。
2. Founder 按卡批准后合入，下一趟班车可正常部署；origin 此时已经存在，不再有 post-merge
   时间窗口，也不需要 disable/bootout updater。仍保持现有 binary/config/template，不重启生产
   Lead；冻结 model/template 编辑直到第 8 步完成。
3. 复核合入前 QA 隔离证据：分别用 0.153.2、0.156.0 新起 runner，证明 founder TUI 存活与
   daemon 权限；用复制自受信配置但不含真实凭据的 QA home 做 0.156.0 capability-bundle-v2
   cold-start / close，验证新 baseline 与 Lead TUI。缺少 exact-head receipt 就停止；禁止为补证而
   重启三个生产 Lead。
4. 对共享 `~/.codex-259-qa` 与 `~/.codex-raya`、`~/.codex-mufasa`、
   `~/.codex-infra-bot` 分别保存 current symlink target、config 与 `skills/.system` 的可恢复备份；
   同时备份全局/shopping config，以及 implement/eng_design companion home 的 config 与 skills。
   验证 0.156.0 versioned release 与新 native tree 的 committed digest。不能用 `codex update`。
5. 为四个 home 安装同一审计过的 0.156.0 release/native tree，原子切 `current` symlink，逐个运行
   `codex --version` + read-only native canary 回读；任一失败立即停止并回滚已切 homes。
6. 用 0.156.0 验证 runner `resume --remote`；再各跑一个 design-review 与 code-review companion
   smoke，覆盖 `eng_design` / `implement` homes 的 `codex exec` 路径。此时仍不改默认模型。
7. 把全局、shopping profile、implement 与 eng_design Codex home 默认改为 `gpt-6-sol`；
   Raya `gpt-6-astra` 不动。逐文件回读并跑一次 companion smoke。
8. 经正式 snapshot/stage/apply 或 template publish API，给 active `tpl_code` 与
   `tpl_simple_code` 各追加 revision，只改 implement model，保留 vendor/effort/其他节点；
   `tpl_eng_heavy` 不动。回读 latest active revisions，implement 中 `gpt-5.6-sol` 为 0。
9. 派一张全新 Codex 实现单，核 dispatch log=`gpt-6-sol`、pane 首屏模型、founder window 存活。

模板 publication 会影响未 `dispatchPinned` 的开放 run 后续节点，因为 launch 时读取
`live_template`；“snapshot bytes 不改”不代表 effective dispatch 隔离。因此第 8 步绝不能提前。

回滚反向执行：先发布两张 active templates 回上一 exact model，再恢复所有 CLI/companion configs，
再逐 home 恢复 native tree 与已记录的 `current` symlink；最后分别跑 version/native canary 与
0.153.2/0.154.0 兼容 smoke。已 launch runner 不重写；生产 Lead 是否重启仍由 Lead 单独授权。

Lead-owned follow-up（本单不执行；按 Lead 明确决定不另开单）：四个 Codex home 全部确认切到
0.156.0 并稳定一周后，删除 0.153.2 与 0.154.0 两条 transition/rollback pin。milestone 与 PR
body 必须原样记录这个暂时扩大的 admission window 和 Lead owner；删除前继续 exact fail-closed。

## 本地验证

1. T1/T2/T3 分片保留精确 RED 与 GREEN 输出。
2. direct Vitest：runner helper + adapter policy、config registry/display/phase、teamlead native
   baseline/home/runtime-factory/canary。
3. changed TypeScript 的 owning-package `vitest related`。
4. `pnpm lint`。
5. `pnpm --filter "flywheel-claude-runner..." build`、
   `pnpm --filter "flywheel-config..." build`、`pnpm --filter "flywheel-teamlead..." build`。
6. exports/API/types 改动触及 dependents，运行 `pnpm --filter "...<pkg>" typecheck`。

focused checks、aggregate build、review、PR CI 与 QA exact-head/真机证据分开陈述；不为普通或
review revision head 请求 full CI，`CI Scope OK` 不称为 full-suite 证据。

## 提交、复审与交接

1. 先提交批准后的 docs，再按 T1、T2、T3 分小提交并更新 `progress.md`。
2. `stage set code_review`，注册 `review_code` + `request-review`；blocking finding 在新 head
   修复并重新请求。
3. push feature branch、开 PR；不 merge、不 dispatch QA、不请求 ship approval。
4. `engineering/doc/milestones/FLY-2766.md` 作为 literal last commit，记录代码头、review、focused
   checks、PR 和未执行的 production cutover / smoke。
5. 用 `ask --report` 回执 `[lead-instruction 4c6a1307-bb10-4cf0-8faa-cbe3d4e6fd35]`，再执行
   `complete --route needs_review --pr <NUMBER>` 并 park。

## 风险控制

- client override 删除不削弱 daemon 权限：adapter test 强制保持 server-side policy。
- native upgrade 不放宽：每个版本绑定完整树，manifest 记录实际选择，未知/错配状态 fail-closed。
- 新 model entry 不提前切 default；暴露窗口靠有界冻结与逐 home 回读控制，未声称存在技术 fence。
- live template 会影响开放 run 后续未 pin 节点，故 binary/config 全绿是 publication 的硬前置。
- production template 只走 immutable revision API；不直接改 DB、不碰 retired heavy、不重写 old run。
