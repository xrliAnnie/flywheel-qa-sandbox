# FLY-3131 在飞空位自动补单 — 调研
Issue: FLY-3131 (https://linear.app/geoforge3d/issue/FLY-3131/epic在飞空位自动补单-按-fly-3103-prd-做开工前先和-annie-过设计)
日期: 2026-10-01
基于: exploration.md

> 标注规则:**[官方]** = 官方文档 / 官方设计文档 / 上游源码,链接可点;**[推断]** = 我根据资料推出来的,不是原文。
> 方法说明:founder 要的是「deep research」。本轮由 3 个并行调研子代理做网页检索 + 打开原文核对(没有走 ChatGPT Deep Research,
> 因为那条路要人在电脑前配对浏览器);关键几条(Linear 支持的 webhook 类型 / 重试、Cloudflare Queues 拉取 / 价格、Kubernetes 调度队列)
> 我又亲自打开原文核了一遍。Linear MCP 401,没在真 workspace 上实测。

## 1. 第 3 题:成熟派单系统怎么做(8 个)

问题本身:我们是「Linear 里 Epic → 单子(有挡住关系 = DAG)」+「每个 Lead 最多 12 个在飞位子」+「空出位子按固定顺序取下一张」。
第 3 题问的是:**待派队列要不要存成一份持久的、随变化更新的队列,还是需要时当场算**。

| 系统 | (a) 什么时候算「能跑的任务」 | (b) 怎么限并发 | (c) 队列存不存、谁是真相 | (d) 漏事件 / 崩溃怎么补 |
|---|---|---|---|---|
| **Kubernetes 调度器**(最像我们) | 有新 Pod 就进 activeQ;排不上的停在 unschedulable,**集群发生相关事件时才挪回去重试**;QueueingHint 让插件判断「这个事件能不能帮上忙」,帮不上就跳过 [官方](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md) [官方 KEP-4247](https://github.com/kubernetes/enhancements/blob/master/keps/sig-scheduling/4247-queueinghint/README.md) | 节点资源(过滤阶段);activeQ 按优先级排 [官方](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/) | 内存里增量维护的优先队列(activeQ / backoffQ / unschedulable)[官方源码](https://github.com/kubernetes/kubernetes/blob/master/pkg/scheduler/backend/queue/scheduling_queue.go);真相 = API Server 里「还没分配节点的 Pod」;队列**不落盘**,重启从真相重建 [推断] | 每 30 秒把在 unschedulable 待够久的挪回 activeQ;最长 5 分钟必重试 [官方](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md);KEP 明说事件漏了 Pod 会卡住,所以要定时兜底;控制器原则「按状态(level)驱动,不按边沿(edge)驱动」[官方](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-api-machinery/controllers.md) |
| **Apache Airflow** | 调度循环:每轮建 DagRun → 检查可调度的 TaskInstance → 在池子容量内入队;有活就立刻下一轮,闲时睡 1 秒 [官方](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html);2.x 还有「任务结束顺手调度下游」的 mini scheduler(`schedule_after_task_execution`)[官方配置](https://raw.githubusercontent.com/apache/airflow/v2-10-stable/airflow/config_templates/config.yml) | `parallelism`、`max_active_tasks_per_dag`、pools;「关键区」用 `SELECT … FOR UPDATE` 锁池子行防超卖;「只有排队的比空位多时优先级才起作用」[官方](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html) | **不存单独的队列**:元数据库是唯一真相,「队列」只是一列状态 `scheduled → queued → running` [官方](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html);每轮从库里重新算 | 每 300 秒找回孤儿任务、清心跳超时的「僵尸」[官方配置](https://raw.githubusercontent.com/apache/airflow/v2-10-stable/airflow/config_templates/config.yml);循环本身就是按状态兜底 [推断] |
| **Temporal** | 完全事件驱动:活动完成 → History 服务追加事件,同一个数据库事务里写一条「转发任务」,再推给 Matching 入队(事务 outbox 模式)[官方](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md) | worker 的槽位:「有空槽 worker 才去拉」[官方](https://docs.temporal.io/develop/worker-performance) | **任务队列持久化** [官方](https://docs.temporal.io/task-queue);但真相是工作流历史,队列是派生的,且**和状态变化同一事务写入**——这是它敢持久化的前提 [推断] | ack 位点定期存盘,重载时重放未确认任务,至少一次 [官方](https://github.com/temporalio/temporal/blob/main/docs/architecture/history-service.md) |
| **Argo Workflows** | informer 监听 Workflow / Pod 变化 → 把整个工作流放回队列 → 对整张 DAG 重新跑一遍判定 [官方](https://argo-workflows.readthedocs.io/en/latest/architecture/) | 控制器 / 命名空间 / 模板级 `parallelism`、信号量 / 互斥锁;排队者按优先级再按创建时间,「只有队头能拿锁」[官方](https://argo-workflows.readthedocs.io/en/latest/parallelism/) [官方](https://argo-workflows.readthedocs.io/en/latest/synchronization/) | 真相 = Workflow 对象;信号量持有 / 等待者在内存,启动时从各工作流状态重建 [官方源码](https://github.com/argoproj/argo-workflows/blob/main/workflow/sync/sync_manager.go) | 每 20 分钟把所有未完成的工作流重排一遍(`workflowResyncPeriod`)[官方源码](https://github.com/argoproj/argo-workflows/blob/main/workflow/controller/controller.go) |
| **Prefect** | worker 每 15 秒轮询一次(预取 10 秒)[官方](https://docs.prefect.io/v3/concepts/workers) | work pool / work queue 并发上限,队列优先级瀑布;按标签限并发,没空位就「30 秒后再试」[官方](https://docs.prefect.io/v3/concepts/work-pools) [官方](https://docs.prefect.io/v3/concepts/tag-based-concurrency-limits) | 不存就绪队列:运行记录在 API 库里是 `Scheduled` 状态,**worker 拉的那一刻**用查询算出能跑的;work queue 是带优先级的过滤器,不是存储 [官方 + 推断] | 3 次心跳没了算离线;并发槽是有租期的(默认 5 分钟),持有者崩了槽自动还 [官方](https://docs.prefect.io/v3/concepts/global-concurrency-limits) |
| **GitHub Actions** | `needs:` 让作业等前置作业成功 [官方](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs);runner 用 50 秒长轮询拉活 [官方](https://docs.github.com/en/enterprise-server@3.13/actions/concepts/runners/communicating-with-self-hosted-runners) | `concurrency:` 组;可选排队最多 100 个,FIFO 但「不保证」[官方](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) | 托管服务,内部没公开;状态在服务端 [推断] | 没公开 |
| **Buildkite** | agent 轮询拉活 [官方](https://buildkite.com/docs/agent/v3);`depends_on` 的步骤「依赖完成后立刻跑」[官方](https://buildkite.com/docs/pipelines/configure/dependencies) | 步骤级 `concurrency` + `concurrency_group`;等着的作业处于 `limited` 状态;空出一个位子时,`ordered` 按时间放下一个,`eager` 按优先级挑最高的 [官方](https://buildkite.com/docs/pipelines/configure/workflows/controlling-concurrency) | 作业状态在服务端;**空出位子那一刻**放行下一个 `limited` 作业 [官方];内部机制没公开 [推断] | 没公开 |
| **Dagster** | `QueuedRunCoordinator` 把运行写成 `QUEUED`,守护进程每 5 秒出队一次 [官方](https://docs.dagster.io/guides/operate/managing-concurrency) | `max_concurrent_runs`、标签限额、pools、优先级 | 持久状态列 + 轮询出队,和 Airflow 同型 [推断] | 循环本身兜底 [推断] |

(另:Celery / Sidekiq 是没有 DAG 概念的消息队列,「能不能跑」由投递者决定,不适合类比,略。)

### 1.1 共同模式(这是第 3 题的答案依据)

1. **真相永远是持久状态,队列只是从它派生的缓存。** Airflow / Prefect / Dagster 是库里的状态列;Kubernetes / Argo 是 API 对象;
   Temporal 是工作流历史。内存队列(Kubernetes、Argo 信号量)重启就扔掉、从真相重建。唯一落盘的队列(Temporal)是和状态变化**同一个事务**写的。
   **没有一家是「另外维护一张就绪表,指望它和真相一直同步」**。[推断,依据上表各条官方出处]
2. **事件驱动求快 + 定时按状态兜底求稳。** 每家都对事件即时反应(任务完成、Pod 删除、空出位子),也都有一个不看事件、把全部重查一遍的定时器
   (K8s 30 秒 / 5 分钟、Argo 20 分钟、Airflow 循环 + 300 秒、Prefect 15 秒、Dagster 5 秒)。K8s 的设计文档直接承认:只靠事件,漏一个就卡住。
3. **派单在「有空位」那一刻、在锁里做。** Airflow 锁池子行、Argo 只放队头、Buildkite 的 `limited` 状态、Temporal「有空槽才去拉」。
   Airflow 文档原话的意思:**只有等着的比空位多时,排序才有意义**——位子满的时候算排序是白算。
4. **占位要有「还活着」的信号**(心跳 / 租期),否则崩掉的持有者会永远占着位子。
5. **算的过程中来了新变化不能丢**(K8s 对「正在调度的 Pod」记下期间到达的事件)。

### 1.2 对我们第 3 题的含义 [推断]

- 我们的规模:几百张单、1 个(以后几个)Lead。在本地 SQLite 上「挑出能开始的单并排序」是一条查询,毫秒级。
- 第一版的 A「存一张有序待派表,增量维护」= 自己造一份要和 Linear 同步的就绪表——正是上面第 1 条没人这么做的那种:
  漏一个事件,表里就错一张单,而且不会自己好。它省下的只是一次毫秒级查询。
- 第一版的 B「不存,每次现算」如果是**每次去 Linear 现拉**,就是今天 ready.v1 的样子:20 秒截止、43/200 超时、1.5MB 超限——不能要。
- 成熟系统的做法是第三种:**把 Linear 的事实增量同步到本地(像 K8s 的 informer 缓存),空出位子时在本地当场算、取第一张**。
  持久化的是「Linear 的副本」和「我们自己的派单记录(提醒了谁、什么时候、有没有回应)」,不是「排好序的队列」。
- 这和 PRD 第 3 节第 2 条的本意一致:「输入一变只增量更新」——增量更新的是副本;「有空位直接取队头,不全量重排」——
  取队头 = 在副本上一条带 `ORDER BY … LIMIT 1` 的查询,没有去 Linear 全量拉、也没有「每小时把 100 张重排一遍」。
  但字面上 PRD 写的是「持久队列」,这里换成「持久副本 + 当场算」,**要 Annie 确认这样理解可以**(设计页第 3 题)。

## 2. 触发时机:什么时候算「下一张派谁」

founder 的两个候选,加上第一版写的轮询,共三种,以及组合:

| 方案 | 做法 | 好处 | 坏处 | 成熟系统里谁这么做 |
|---|---|---|---|---|
| ⓪ 定时轮询重算 | 每 N 分钟拉 Linear + 重算一遍能开始的单 | 最简单;天然兜底 | 位子满时白算;最多晚 N 分钟 | Prefect 15s、Dagster 5s、Airflow 循环(它们的「算」都很便宜)[官方] |
| ① 有空位时当场算 | 只在「空出位子」或「有空位且有变化」时算 | 不白算;算出来的就是那一刻最新的 | 只靠它的话,位子空着但当时没单可派时,要有别的事件来叫醒 | Buildkite 空位放行、Temporal 有空槽才拉、Airflow「排队多于空位才排序」[官方] |
| ② Linear 一变就重算 | 每个变化都重算整张 DAG | 队列永远是新的 | 位子满时绝大多数重算白做;变化频繁时浪费;依赖 Linear 推送齐全(实际不齐,见 §3.1) | Argo(每个事件重跑整个工作流的判定)[官方] |
| **组合(推荐)** | **变化只更新本地副本(不排序);空出位子、或「有空位时副本变了」才当场算;再加低频对账兜底** | 位子满时零排序开销;有空位时延迟 = 事件延迟;漏事件由对账补 | 多一个对账定时器 | **Kubernetes 调度器同型**:事件只把「可能帮得上」的挪回队列(QueueingHint),定时 flush 兜底 [官方] |

她记得的「真正要干活时当场算」:Airflow 有一点(只有排队多于空位时优先级才起作用),Prefect / Buildkite / Temporal 更典型
(worker 有空才拉,拉的那一刻算)。[推断:她的印象方向对,但 Airflow 本身是「循环不停地算」,不是只在要干活时算]

## 3. 怎么拿到 Linear 的变化

### 3.1 Linear 自带 webhook [官方](https://linear.app/developers/webhooks)

- **支持的类型**(原文):Issues、Issue attachments、Issue comments、Issue labels、Comment reactions、Projects、Project updates、
  Documents、Initiatives、Initiative Updates、Cycles、Customers、Customer Requests、Users。
- **不支持依赖关系(blocks / blocked by)**:列表里没有 IssueRelation;SDK schema 的 webhook payload 联合类型里也没有,Issue 的 payload 里没有 relations 字段
  [官方 schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)。加 / 删依赖会不会顺带触发两端 Issue 的 update——**文档未写明**。
  ⇒ **依赖变化必须靠轮询 / 对账拿到**。[推断]
- **能拿到的**:单子的状态、优先级、完成、父单(`parentId`)变化都是 Issue `update`,`updatedFrom` 带旧值 [官方];
  改父单是否一定带 `updatedFrom.parentId`——文档没有例子,要实测。
- **签名**:`Linear-Signature` = 用 webhook 密钥对**原始 body**做 HMAC-SHA256;`webhookTimestamp`(毫秒)应在 1 分钟内,防重放 [官方]。
  (我们仓里旧的 `linear-event-transport` 是对重新序列化的 JSON 验签,不合规,不能复用。)
- **请求头**:`Linear-Delivery`(每次投递一个 UUID,可用来去重)、`Linear-Event`、`Linear-Signature`、`Linear-Timestamp` [官方]。
- **重试**:5 秒内没回 200 就算失败,最多重试 3 次:1 分钟、1 小时、6 小时后 [官方]。一直不通**可能被 Linear 停用,要手动重开**(阈值文档未写明)。
- **范围**:全部公开 team,或单个 team;只有 workspace 管理员(或带 admin 权限的 OAuth 应用)能建 [官方]。
- **顺序**:文档未写明,按「不保证顺序」处理;重试的旧投递可能晚好几个小时到 [推断]。
- **发送 IP**:Linear 公布了 15 个出口 IP,可做白名单 [官方](https://linear.app/docs/security)。

### 3.2 轮询(对账)的成本 [官方](https://linear.app/developers/rate-limiting)

- 个人 API key:每小时 2,500 次请求、300 万复杂度点;按 `issues(filter: {updatedAt: {gt: T}})` 拉「T 之后改过的单」[官方](https://linear.app/developers/filtering)。
- 每 5 分钟一次 = 每小时 12 次,远低于上限 [推断]。改依赖是否刷新 `updatedAt`——**文档未写明**;安全做法是对账时把「进行中 Epic 下所有单的依赖」重拉一遍(几百张单,便宜)[推断]。

### 3.3 用 Cloudflare 收 webhook 再转给本机

本机今天没有公网入口(Bridge 只听回环)。三种做法:

| 做法 | 怎么走 | 本机关机 / 断网时 | 要什么 | 出处 |
|---|---|---|---|---|
| **A. Worker + Queues(拉取)** | Linear → Cloudflare Worker(`*.workers.dev`)验签、立刻回 200 → 写进 Cloudflare Queue → Bridge 每 30–60 秒调拉取接口取一批、处理完 ack | 消息在队列里存着:免费版固定 24 小时,付费版默认 4 天、最多 14 天;Linear 总能立刻拿到 200,webhook 不会被停用 | Cloudflare 账号;一个只能读写这个队列的 API token 放本机;**不要域名、不开本机端口** | 拉取接口 `POST …/queues/{id}/messages/pull` 与 `/ack`,一批默认 5 最多 100,可见超时默认 30 秒最多 12 小时,没 ack 自动回队 [官方](https://developers.cloudflare.com/queues/configuration/pull-consumers/);免费版含 Queues,每天 1 万次操作(一条消息约写 / 读 / 删 3 次)[官方](https://developers.cloudflare.com/queues/platform/pricing/);至少一次投递、不保证顺序 [官方](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) |
| B. Cloudflare Tunnel | 本机跑 `cloudflared`,只往外连;Linear 直接打到本机接收口 | 只靠 Linear 自己那 3 次重试(最晚 6 小时),再久就丢,webhook 还可能被停用 | **自己的域名挂在 Cloudflare 上**(正式隧道必须);临时隧道每次换地址、只供测试 | [官方](https://developers.cloudflare.com/tunnel/setup/) [官方](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) |
| C. Worker + D1 / Durable Object 事件日志 | Worker 把事件写成带序号的行,本机按「上次读到第几号」来取 | 想存多久存多久 | 游标、鉴权、清理都要自己写 | [官方](https://developers.cloudflare.com/workers/platform/pricing/) |

- 和 FLY-3102 的关系:F2(远程控制台)在「Cloudflare 隧道(要买域名)/ Tailscale」间还没定;**做法 A 不依赖这个决定**(不要域名),做法 B 要等它。
  「用哪个 Cloudflare 账号」是 FLY-3102 的共同前提,本单也用得上。[推断]
- Workers 免费版每天 10 万次请求、每次 10 毫秒 CPU,验一次签足够 [官方](https://developers.cloudflare.com/workers/platform/pricing/)。

### 3.4 漏事件怎么补(业界通行做法)[推断]

1. **webhook 只当「某张单变了」的提醒**:收到后按单号回 Linear 重新拿这张单的最新状态(状态、优先级、父单、子单、依赖),不信 payload 本身——这样乱序、迟到的重试都无害。
2. **按 `Linear-Delivery` 去重**;副本里只接受比已存 `updatedAt` 更新的数据。
3. **定时对账**:每 10–15 分钟拉「水位线减几分钟重叠」之后改过的单 + 重拉进行中 Epic 树的依赖;每天一次全量。水位线只在写库成功后前移。
4. **长时间一条 webhook 都没收到要告警**——否则「被 Linear 悄悄停用」和「最近没人改」看起来一模一样。

## 4. 第 1 题:补单计算放在哪个后台线程

背景:FLY-3147 已设计(design review 第 3 轮 APPROVED)、未写代码:Bridge 里一个常驻 `worker_threads` 巡检线程 + 任务目录 + 主线程唯一锁中介 +
effect port(线程要发消息 / 动 runner 时请主线程代做)+ supervisor 重启 + 每组开关 + 熔断。依赖 FLY-3146(QA 中)。

- **A(founder 第一版已选)**:补单 = 3147 任务目录里的一组任务(Linear 同步、对账、算下一张、提醒 / 再提醒),跑在 3147 那一个线程里。
- **B**:补单先自己起一个线程(自己的 supervisor、自己的数据库连接),3147 以后复用或合并。

两张图和逐条 pros / cons 在 plan.md §3 与设计页。依据:Node `worker_threads` 每个线程是独立的 V8 isolate、独立事件循环,
线程间只能传可序列化消息 [官方](https://nodejs.org/api/worker_threads.html);better-sqlite3 官方示例是每个线程自己开连接(文档没明说能否跨线程共享,按「每线程一个连接」处理)[官方](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md) + [推断]。

一个诚实的补充 [推断]:按本页推荐的「本地副本 + 当场算」,真正吃 CPU 的只有「解析 Linear 返回的大 JSON」和对账;
补单单次计算是毫秒级。所以线程的价值主要是**隔离**(Linear 慢 / 出错不连累主线程),而不是算力。这让「等 3147」(A)的代价更小:
3147 落地前,补单的事件链路可以先在主线程跑(和 3147 设计里「每组开关默认主线程」一致),3147 落地后切开关搬进去。
