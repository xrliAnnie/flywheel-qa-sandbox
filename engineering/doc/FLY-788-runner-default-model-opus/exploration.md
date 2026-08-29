# FLY-788 项目默认 Runner 模型 Fable → Opus — 探索

Issue: FLY-788 (https://linear.app/geoforge3d/issue/FLY-788/stabilityconfig-项目默认-runner-模型-fable-opus-避免自动-spawnauto-qa-等误继承-fable)
日期: 2026-07-02
基于: 无

## 问题（Annie 2026-07-02）

`.flywheel/config.yaml` 的 `roles.runner.model` 当前是 `claude-fable-5`（FLY-728 引入,给不走难度分拣的 Flywheel 任务一个"强模型兜底"）。

但任何**不走 Lead per-issue 分拣**的自动 spawn 也会继承这个默认。典型例子是 FLY-579 的 auto-QA:代码评审通过后 Bridge 自动建一个 `QA·FLY-XX` Linear issue 并直接触发 dispatch,这个 issue 没有 vendor/model label,也没有难度分拣器写入的 `dispatchModel` 参数——于是精确落进 `resolveRoleAdapter` 的 project-config 层,拿到 `claude-fable-5`。Annie:"一下起 5 个 QA 全 Fable、30 分钟就烧完。"

Annie 的要求:"我们有 model-routing 逻辑,为什么还继承 Fable?你现在起码把默认转 Opus。"

## 现状审计（代码事实）

### 1. `.flywheel/config.yaml`（唯一需要改的配置源）

```yaml
roles:
  runner:
    backend: claude-tmux
    model: claude-fable-5
```

这是 `RoleAdapterResolver` 真正读的"project 默认"层(`run-infra.ts` 把 `flywheel-config?.roles` 传进 `resolveRoleAdapter` 的 `projectRoles` 参数)。`runners.available.claude.model: sonnet` 是历史遗留字段,**不会**被 resolver 读取(config.yaml 自己的注释已写明)。

### 2. `packages/teamlead/src/bridge/role-adapter-resolver.ts` — `resolveRoleAdapter`(纯函数,不用改)

解析顺序(代码 + 注释确认,FLY-728 Part C 引入):

```
1. issue label(vendor/model label,仅 runner 角色)
2. dispatchModel(/api/runs/start 的 model 参数 —— Lead 难度分拣器的输出通道)
3. projectRoles.runner.model(.flywheel/config.yaml 的 roles.runner 块 —— 本 issue 要改的层)
4. 账户默认(不传 --model,由 Claude Code CLI 自身默认决定)
```

关键:只要 `role === "runner"` 且第 1、2 层都没有命中(无 label、无 dispatchModel),第 3 层(project config)只要 `backend` 存在就会被采用,`model` 字段跟着一起生效——**根本走不到第 4 层账户默认**。这正是 auto-QA 的路径。

### 3. auto-QA 走的正是"无 label + 无 dispatchModel"这条路

`packages/teamlead/src/bridge/auto-qa-effects.ts` 通过 `createIssue` 建一个新的 `QA·FLY-XX` Linear issue,再触发正常的 dispatch 管线(`Blueprint.ts` / `run-dispatcher.ts`)。这是一次**系统自动触发**的 spawn,不经过 Lead 的难度分拣判断,所以:
- 没有 issue label 提供 vendor/model override(除非母 issue 恰好带了显式 model label,常规情况下没有)
- 没有 `dispatchModel` 参数(那是 `/api/runs/start` 的 Lead 专属输入通道)

于是精确落进第 3 层——project config——继承 `claude-fable-5`。

### 4. 模型 id 命名确认(brainstorm gate 上 Tadashi 定案)

`packages/config/src/model-tiers.ts` 和 `packages/teamlead/src/bridge/fleet-capabilities.ts` 两处交叉确认:
- Fable 5 显式 id:`claude-fable-5`
- Opus 4.8(账户默认窗口 ~200K):显式 id `claude-opus-4-8`,**或**完全不传 `--model`(CLI 自身默认落到账户默认,fleet-capabilities.ts 注释里也叫它"Opus 4.8")
- Opus 4.8(1M 窗口变体,FLY-360 引入):显式 id `claude-opus-4-8[1m]`

issue 原文括注写的字面值是不带 `[1m]` 的 plain `claude-opus-4-8`;brainstorm gate 上 Tadashi 明确定案改用 `claude-opus-4-8[1m]`("标准 Opus id"),本 issue 按 Lead 定案采用这个值——这是当前 flywheel 队列里 Opus 4.8 fleet 标准配置(`fleet-capabilities.ts` 的 `CLAUDE_TIER_OPTIONS` 里 "Opus 4.8 (1M)" 这个显式 id 就是 FLY-360 之后的标准做法,FLY-728/FLY-241 的 medium tier 同样用这个 id),不是本 issue 单独新引入 1M 窗口决策。

### 5. 生效机制审计(gate 上 Tadashi 要求必答的关键调研)

`.flywheel/config.yaml` 的 `roles` 块只在 Bridge **启动时**读一次:

- `packages/teamlead/src/bridge/run-infra.ts` 的 `setupRunInfrastructure()` 用同步 `readFileSync` + `ConfigLoader` 读取每个 project 的 `.flywheel/config.yaml`,把 `flywheelConfig?.roles` 存进 `rolesConfig` 局部变量,再整体塞进 `projectRuntimes.set(project.projectName, {..., rolesConfig, ...})`——`projectRuntimes` 是一个在函数作用域里创建、返回后长期持有在内存里的 `Map`。
- `setupRunInfrastructure()` 只在 `packages/teamlead/src/bridge/plugin.ts` 的 `startBridge()` 里被调用**一次**(Bridge 进程启动时),没有第二个调用点。
- 实际 dispatch 路径(`run-dispatcher.ts:341` / `:630`)读的是 `runtime.rolesConfig`——即 `projectRuntimes` 里缓存的对象,不是重新读文件。
- 全仓搜索确认 `.flywheel/config.yaml` 这个读取路径**没有**任何 watcher / SIGHUP handler / reload endpoint(`chokidar` watch 存在于 `packages/edge-worker/src/ConfigManager.ts`,但那是 EdgeWorker 自己的仓库路由配置,和 `setupRunInfrastructure` 读的 `.flywheel/config.yaml` 是完全不同的文件/子系统,两者没有连线)。

**结论:该配置是 Bridge 启动时缓存,不是每次 dispatch 现读。仅仅 `git pull` 更新主 checkout、不重启 Bridge 进程,不会让正在跑的 Bridge 捡到新的 `roles.runner.model` 值——必须等下一次 Bridge 重启才生效。**

### 5. `resolveRoleAdapter` 是纯函数,不含任何硬编码 tier——不用碰代码

`role-adapter-resolver.test.ts` 里所有测试都是手造 `projectRoles` fixture(例如 `projectRoles: { runner: { backend: "claude-tmux", model: "claude-fable-5" } }`),不读真实 `.flywheel/config.yaml`,不受本次改动影响。

`fly707-enablement.test.ts` 会加载真实 `.flywheel/config.yaml`(`CONFIG_PATH = resolve(REPO_ROOT, ".flywheel/config.yaml")`),但只断言 `cfg.qa?.auto` / `cfg.doc_flow?.enabled` 等字段,不断言 `cfg.roles?.runner?.model`,也不受影响。

`run-dispatcher-backend.test.ts` 里出现的 `claude-fable-5` 是测试自建的示例 fixture(`makeDispatcher({runner: {backend: "claude-tmux", model: "claude-fable-5"}})`),不是读真实文件,同样不受影响。

## 结论

**唯一需要改的生产代码 = `.flywheel/config.yaml` 一行**(`model: claude-fable-5` → `model: claude-opus-4-8[1m]`),外加同一文件里已经过时的 FLY-728 注释(现在写着"Default...to Fable 5"要更新成解释为何转 Opus + 指向 FLY-788)。`resolveRoleAdapter` 逻辑本身不需要改动——它本来就是通用的、按配置驱动的。测试套件在 codex design review 后追加了一处小改动:给 `fly707-enablement.test.ts`(已经加载真实 config.yaml 的测试)补两条断言,把这个默认值钉住,见 research.md §3。

**生效时机**:这行配置是 Bridge 启动时一次性缓存的,merge 后需要一次 Bridge 重启才会让新 dispatch 拿到 Opus(见上文第 5 节)。本 issue 的 Runner 不负责重启/ship——按 Tadashi 在 brainstorm gate 上的明确指示,PR 说明里写清这个结论,重启时机由 Tadashi/Annie 决定。

配合 FLY-782(auto-QA 默认 Sonnet,是"QA 那条线"的正解)一起,把"意外继承 Fable"的两条路径(project-default 兜底 + auto-QA 专属默认)都堵上。本 issue 只负责前者。
