# FLY-788 项目默认 Runner 模型 Fable → Opus — 调研

Issue: FLY-788 (https://linear.app/geoforge3d/issue/FLY-788/stabilityconfig-项目默认-runner-模型-fable-opus-避免自动-spawnauto-qa-等误继承-fable)
日期: 2026-07-02
基于: exploration.md

## 调研范围

确认改动的精确落点、模型 id 字面值该写什么、以及回归验证怎么做到"无需新增测试也能证明行为符合预期"。

## 1. 精确落点

| 文件 | 改动 |
|------|------|
| `.flywheel/config.yaml` | `roles.runner.model`: `claude-fable-5` → `claude-opus-4-8[1m]`,并更新其上方的 FLY-728 注释 |
| `packages/teamlead/src/bridge/__tests__/fly707-enablement.test.ts` | 追加断言,钉住这个新默认值(见 §3,codex design review round 1 要求) |

生产落点没有第二处。`resolveRoleAdapter`、`ConfigLoader`、`run-infra.ts` 都是通用的、按配置驱动的代码,不含任何硬编码的 "claude-fable-5" 字符串(用 `grep -rn "claude-fable-5"` 核实过,production 代码里唯二命中的是 `ConfigLoader.ts` 里一句注释示例、和 `model-tiers.ts`/`fleet-capabilities.ts` 里的 tier 定义表——这两处是**通用的模型 id 词表**,不是"project 默认",FLY-788 不碰)。

## 2. 模型 id 字面值该写什么

三个候选,逐一核实:

1. **`claude-opus-4-8`**(plain,账户默认窗口 ~200K)——issue 原文括注写的就是这个。`fleet-capabilities.ts` 注释确认这就是"Opus 4.8"对应的显式 id。
2. **`claude-opus-4-8[1m]`**——`model-tiers.ts` 的 `medium` tier、`fleet-capabilities.ts` 的 `CLAUDE_TIER_OPTIONS`("Opus 4.8 (1M)")都用这个,这是 FLY-360 之后 flywheel fleet 里 Opus 4.8 的标准显式 id。
3. **完全删掉 `model:` 字段**,让它落到 CLI 自身账户默认——`resolveRoleAdapter` 的代码路径里,只要 `projectRoles.runner.backend` 存在(它确实存在,`backend: claude-tmux`),就会命中 project-config 层并把 `backend` 定下来,而 `model` 是否设置互不影响 `backend` 是否命中(参见 `role-adapter-resolver.ts:190-195`)。也就是说即使删掉 `model:` 字段,依然会在这一层被"锁定",`resolved.model` 就是 `undefined`,不会传 `--model` 给 CLI,由 Claude Code CLI 自己的账户默认决定模型。这条路径技术上也能达到"不再是 Fable"的效果,但**依赖 CLI 自身默认(隐式、非本仓库可验证、未来 CLI 版本行为可能变)**,且不满足 issue 明确写出的字面值要求。

**采用方案 2**:显式写 `claude-opus-4-8[1m]`。issue 原文括注写的是不带后缀的 `claude-opus-4-8`,但 brainstorm gate 上 Tadashi 明确定案改用 `claude-opus-4-8[1m]`("标准 Opus id")——因为这是当前 flywheel fleet 里 Opus 4.8 的实际标准显式 id(FLY-360 之后 `fleet-capabilities.ts`/`model-tiers.ts` 的 medium tier 都是这个值),和 fleet 其余地方保持一致,不引入第二套"Opus"命名。本 doc 按 Lead 定案更新,不再采用方案 1。

## 3. 回归验证怎么做(codex design review round 1 后定案)

FLY-788 的验收标准是"3. 回归:无 model 参数 dispatch → Opus"。这句话里的"无 model 参数"指的是 `/api/runs/start` 的 `model` dispatch 参数(即 `dispatchModel`,难度分拣器的输出通道)——不是泛指"不传任何东西"。对应到 `resolveRoleAdapter` 的分层,就是"第 1、2 层都没命中,落到第 3 层 project config"这条路径,而这条路径的行为完全由**纯函数 + 传入的 `projectRoles` 参数**决定,不依赖任何隐藏状态。

现有 `role-adapter-resolver.test.ts` 里已经有一个直接覆盖这条路径的用例(`describe("resolveRoleAdapter — project config layer")` → `it("project roles beat global env", ...)`,以及 dispatch-model describe 块里的 `it("no dispatchModel → falls through to project/default (byte-compat)", ...)`)、`run-dispatcher-backend.test.ts` 也有对应用例(`it("[FLY-241] claude-tmux project roles model override → runnerModel, ...")`)——但这些测试传入的都是**手造的** `projectRoles`/`runtime` fixture,不是读真实 `.flywheel/config.yaml`,只能证明 resolver 机制本身没坏,**不能**证明这个仓库真实的默认值确实是 Opus 而不是 Fable。

真正跑真实配置文件的是 `fly707-enablement.test.ts`(`CONFIG_PATH = resolve(REPO_ROOT, ".flywheel/config.yaml")`),但改动前它只断言 `qa.auto`/`doc_flow`,没有断言 `roles.runner.model`。

**最初方案(brainstorm gate 时)是"不新增测试,只跑现有回归 + 一次性脚本手动核实"**——codex design review round 1 指出这个方案的漏洞:如果实现时手滑漏改了 `.flywheel/config.yaml`(依然是 `claude-fable-5`),现有测试全部照样通过,一次性脚本的验证结果又不会留在仓库里,PR 合并后没有任何自动化防线能抓出"意外还是 Fable"这个精确是本 issue 要修的 bug。这个反馈是对的,采纳。

**定案验证路径(给真实配置值加一道持久防线,不新开测试文件、只在已有的"验真实 config.yaml"测试里加断言)**:
1. 扩展 `fly707-enablement.test.ts`(它已经加载真实 `.flywheel/config.yaml`,和该文件"验证 canonical config 里的运营开关"这个既有定位完全一致),新增断言:
   - `cfg.roles?.runner?.backend === "claude-tmux"`
   - `cfg.roles?.runner?.model === "claude-opus-4-8[1m]"`
   - `resolveRoleAdapter({ role: "runner", projectRoles: cfg.roles, env: {} }).model === "claude-opus-4-8[1m]"`(直接复现 issue 验收项 3 的"无 label + 无 dispatchModel → Opus"场景,用真实配置值 + 真实 resolver,不是手造 fixture)
2. `pnpm --filter flywheel-teamlead test -- fly707-enablement role-adapter-resolver run-dispatcher-backend` — 上面的新断言 + 现有 project-config 层用例全绿。
3. `pnpm lint`(全仓 biome)+ 相关 package 的 `pnpm build`(确认 YAML 改动不影响任何 TS 编译产物,预期为 no-op)。

这不是"新增一个只重复断言配置字面值的测试文件"(那确实是无意义的重复防线),而是往一个**本来就承担"钉住这个仓库的真实运营开关"职责**的既有文件里加几行断言——`fly707-enablement.test.ts` 本身的存在理由(见其文件头注释)就是"FLY-579/FLY-205 这类构建完成但没打开的开关"的回归卫兵,这次的 `roles.runner.model` 是同一类"配置改了但没人拦得住被悄悄改回去"的风险,加进同一个文件是一致的做法。

## 4. 生效机制(brainstorm gate 上 Tadashi 要求必答的关键调研)

`packages/teamlead/src/bridge/run-infra.ts` 的 `setupRunInfrastructure()` 用同步 `readFileSync` 读 `.flywheel/config.yaml`,把 `roles` 块存进 `rolesConfig` 局部变量,再整体塞进一个在函数作用域创建、返回后长期持有在内存里的 `Map`(`projectRuntimes`)。`setupRunInfrastructure()` 只在 `plugin.ts` 的 `startBridge()` 里被调用一次(Bridge 进程启动时),没有第二个调用点;实际 dispatch 路径(`run-dispatcher.ts:341`/`:630`)读的是缓存好的 `runtime.rolesConfig`,不是重新读文件。全仓搜索确认这条读取路径没有任何 watcher / SIGHUP handler / reload endpoint(`packages/edge-worker/src/ConfigManager.ts` 里的 `chokidar` watch 是 EdgeWorker 自己的仓库路由配置,和这里读的 `.flywheel/config.yaml` 是不同文件/不同子系统,没有连线)。

**结论:配置是 Bridge 启动时一次性缓存,不是每次 dispatch 现读。merge 后仅 `git pull` 更新主 checkout、不重启 Bridge 进程,不会让正在跑的 Bridge 拿到新的 `roles.runner.model` 值——必须等下一次 Bridge 重启才生效。**这个结论要写进 PR 描述,重启时机/tier 由 Tadashi/Annie 决定,不是本 issue Runner 的职责。
