# FLY-1062 收尾圈(PR3 托管+key / PR4 发布 CI/CD) — 实施计划

Issue: FLY-1062 (https://linear.app/geoforge3d/issue/FLY-1062/build-buddy-onboarding-分发层-客户-npm-install-安装包零仓库访问替代-curlgit-clone)
日期: 2026-07-11
基于: pr3-pr4-research.md

> **方向(brainstorm gate 已过,Tadashi 批)**:本圈 = FLY-1062 收尾——PR3(= FLY-1098 B2:R2 托管 + 验 key 薄端点 + key 生命周期)+ PR4(= B1:发布流水线 + B0 版本断言);FLY-1143 留 B3-B6;上游合同 = FLY-1098 PRD 逐条对齐;PR2 客户端视图合同 byte-stable。
> **红线(Tadashi gate 回复原话级)**:真 npm publish 与 promote-to-customer-release 是**不可逆公网动作 = founder gate**(§3);secret/黑话/byte-compat 红线逐字继承前两圈。
> **形态更新(Annie 2026-07-11 直令,取代旧 fallback 形态;Codex design CRITICAL 已修正)**:发布**完全自动化、不依赖 Annie 本机**——但两把应用层 token **分处两个信任域**:beta-publish 在 GitHub CI(beta 每 6h 全自动无门),**customer-release 只在常驻 Bridge、绝不进 CI**(Codex 证明「两把 token 同处一个 CI」可组合绕过 Worker 推任意 payload 给客户)。**stable promote + shell npm publish 都 = Flywheel approve gate**(她一条 Discord approve → **broker** 核内存 founder-approval 登记(非 DB-backed verify-approval)+ 结构化单次消费 → 执行,审计留痕;两条对外发布完全对称)。**两把对外发布 token 只在 FLY-245 broker 父进程内存、永不落盘/不进 CI/不进子进程**(同 UID 0600 文件不是 boundary,Codex R3)。GitHub CI 只持 beta-publish(内部 beta)。Cloudflare API token 仍 founder custody(底线一)。**落地拆两 PR**:本 PR = 机器件 + beta/promote-prepare CI;broker 硬化 = 1062 底下下一个 PR(1062 不关单直到它落地;真发布在此前不发生)。详见重写的 §3。
> **一处基底替换(Codex R1 已认可)**:gate 消息的「Workers KV 名单」细化为 R2 per-key 对象(同「服务端名单」形态;强一致 → 吊销即时)。
> **Codex 三轮全采纳**:R1(7 项)= capability 分权 / admin wire contract / payload 可见集取物 / promote 两段式 / 零破坏性 lifecycle 规则 / npm 首发 bootstrap / P5 顺序+CI 合同。R2(5 项)= Cloudflare 主凭据移出 repo secrets(GitHub 私仓 required reviewers 需 Enterprise,fallback 覆盖每次 shell publish)/ durable 候选 + expired 状态机 + CAS 先行清理 / releaseId 幂等协议 + lineage 下沉 validator / 空态 = pre-activation 运维态 / research 就地修正。R3(3 项)= ①发布操作账本 releaseOps 并进 manifest 单对象(预约/候选/提交/放弃全走同一 etag CAS,candidates/ 对象取消)②retention 钟改 pointer-tenure 字段 retentionSince(fallback re-pin 清零重计)③research 旧合同就地 superseded。R4(3 阻塞+1 一致性)= **①DELETE 竞态封闭:两步删除**——先 manifest CAS 把 objectKey 记入 `tombstones`(validator 从此拒绝任何新引用、PUT 拒复活;与并发 prepare 由同一 etag 串行化)→ 才做 R2 delete(R2 delete 无条件参数、并发 last-writer-wins,故裸 guard+delete 不够)**②上传前先耐久占位**——tuple 在 `reserved` 态就登记进 releaseOps、PUT payload 必须挂已登记 claim,upload+readback 过了才转 `prepared`(崩溃孤儿 100% 可从 manifest 发现);`reserved→abandoned` 补进状态机 **③生命周期时间戳全部 server-owned**(handler 注入时钟生成 retentionSince/quarantinedAt/publishedAt/createdAt,客户端提交值一律拒/覆盖,窗口判定用同一服务端钟)**④research 两处旧口径就地改**。R5(2 阻塞+1 一致性)= tombstone 两层终态规则(已发布版可删)/ PUT post-check + 全量 sweep(物理对象=最终收敛,客户面零竞态)/ 摘要全量同步。**R6 = APPROVED**(1 条非阻塞精化已折入:post-check 按 exact objectKey 查任一 live claim)。

---

## 0. 一句话方案 + B0 合同(v1 子集,先锁死)

一个 **Cloudflare Worker 薄端点**做唯一可信收口(客户读 + 发布写 + 运维清理都经它),背后一个**私有 R2 bucket**;**除 payload/key 对象外,一切发布状态(指针、版本、操作账本)都在 `manifest.json` 单对象里,一次 etag CAS = 一个可串行化事务**;发布 = 三条手动 `workflow_dispatch` workflow(promote 拆 prepare/commit,commit 段 + 薄壳 publish 走 founder gate);客户面 = PR2 薄壳零逻辑改动,只填真 `DEFAULT_ENDPOINT` + 解除 `private:true`。

### B0-1 · bucket 布局

`payloads/<ver>/<sha256>.tgz`(immutable,存在即拒重写)· `manifest.json`(**唯一 commit point + 唯一发布状态真相**,含 releaseOps 账本)· `keys/<sha256(key)>.json`(per-key 名单)。**本圈零破坏性 bucket lifecycle 规则**(R2 lifecycle 只按对象年龄+prefix——research §4-8);retention 走 B0-10。

### B0-2 · manifest.json(schema)

```json
{ "schemaVersion": 1,
  "channels": { "internal-beta": {"latest": "1.56.0-beta.3"},
                "customer-release": {"latest": "1.55.0"} },
  "versions": { "<semver>": {
      "sha256": "...", "key": "payloads/<ver>/<sha256>.tgz", "size": 123,
      "publishedAt": "...", "channel": "beta|release",
      "status": "active|quarantined|expired",
      "sourceCommit": "<40-hex>", "releaseId": "<稳定操作 id>",
      "derivedFromBeta": "<beta semver|null>",
      "retentionSince": "<iso|null>", "quarantinedAt": "<iso|null>" } },
  "releaseOps": { "<releaseId>": {
      "kind": "beta|release", "state": "reserved|prepared|committed|abandoned",
      "ver": "<pinned semver>", "betaVersion": "<beta semver|null>",
      "sourceCommit": "<40-hex|null>", "sha256": "<hex|null>",
      "objectKey": "<payloads/...|null>", "createdAt": "..." } },
  "releaseLedger": { "<base X.Y.Z>": {"nextBetaN": 4} },
  "tombstones": ["payloads/<ver>/<sha256>.tgz"] }
```

**validator 关系不变量(端点写路径强制,每次写全量校验;全部在同一文档内 = 机器可查、原子成立)**:
1. 每个 channel `latest` 指向存在、`status=active`、channel 匹配的 entry;**唯一空态例外:`latest: null` 仅当该 channel 尚无任何 entry**(两 channel 各自适用)。
2. `key` = `payloads/<ver>/<sha256>.tgz`(派生,不许自由串)。
3. version entry 核心字段一旦写入不可变更;生命周期字段(`status`/`retentionSince`/`quarantinedAt`)**只能作为受控迁移 diff 的一部分变更**(B0-6/B0-10):status 单向 active→quarantined→expired 或 active→expired;`retentionSince` 仅随指针迁移写(见 5);`quarantinedAt` null→值一次性。**所有生命周期时间戳(retentionSince/quarantinedAt/publishedAt/createdAt)= server-owned**:由 handler 用注入时钟在已验证 diff 上生成/覆盖,客户端提交的时间值一律不采信(回填旧时间/未来时间被拒或被服务端值覆盖);到期窗口判定用同一服务端钟(Codex R4#3)。
4. `releaseLedger.nextBetaN` 单调递增(允许空洞)。
5. **pointer-tenure(Codex R3#2)**:是任一 channel `latest` 的 entry 必须 `retentionSince: null`(= current/pinned,永不过期);不是任何 latest 且 `status=active` 的 entry 必须 `retentionSince` 非空。指针迁移的同一次 CAS 里:新 latest 清零 retentionSince(含 withdraw fallback **re-pin**),旧 latest 盖 `retentionSince=now`。
6. **lineage**:`channel=release` entry 必须 `derivedFromBeta` 存在于 versions、base 一致、`sourceCommit` 逐字相等;commit 时端点核对目标对象存在且元数据(size/sha 自定义元数据)与 entry 一致。
7. **releaseOps 关系不变量(Codex R3#1/R4#2)**:versions 内 releaseId 唯一且必须对应 `releaseOps[id].state=committed`;反向,`state=committed` 的 op 必须有对应 versions entry(同一文档内互指);state 单向 `reserved→prepared→committed|abandoned` **且 `reserved→abandoned` 合法**(上传前失败/搁浅预约的退出路径);tuple(sourceCommit/sha256/objectKey)在 **reserved 态登记**(upload 之前,R4#2),prepared 仅在 upload+readback 验过后由对应脚本触发迁移;abandoned 的 op 不得被任何 versions entry 引用。
8. **objectKey 耐久占位 + tombstone(Codex R4#1/2 + R5#1 两层重述)**:`PUT /admin/payload/<ver>/<sha>` 必须存在 `state ∈ {reserved, prepared}` 且 objectKey 逐字匹配的 releaseOps claim(每个 staging 对象都能从 manifest 发现,孤儿零盲区)。tombstone 两层规则:**① tombstoned key 允许保留的引用 = 历史终态引用**——expired version entry、abandoned op、以及「对应 version 已 expired」的 committed op(历史审计字段不擦除;不变量 7 的 entry↔op 互指因此与删除不冲突);**② tombstone 之后禁止一切新引用 diff**——active/quarantined version 与 reserved/prepared op 引用 tombstoned key 一律拒,PUT 不得复活。`tombstones` 为**唯一集合语义**(重复追加非法;追加已存在项 = 幂等成功),单调只增。tombstone 追加与新引用登记同走 manifest etag CAS → 串行化,「guard 通过后被并发 prepare 复用」结构性不可能。
9. 时间与钟:见 3(server-owned);`releaseOps[].createdAt` 同样服务端生成。

### B0-3 · 版本派生(FLY-1098 §6.1)

`doc/VERSION` 只存 base;beta = `X.Y.Z-beta.N`(N 由 B0-9 预约分配);clean = `X.Y.Z`;打包/CI 断言 = 「payload semver 是当前 base 的合法派生」。**clean semver 永不复用**。

### B0-4 · entitlement 视图 + 取物规则(端点内纯函数)

- 视图(输出 = PR2 客户端合同逐字):`internal` → latest=internal-beta、versions=全部 `status=active`;`customer` → latest=customer-release、versions=仅 `channel=release ∧ status=active`(retentionSince 已盖但仍 active 的旧 release 保持可见 = `flywheel install <旧版>` 保留窗口)。
- **payload 取物经可见集(Codex R1#3)**:`GET /payload/<ver>` 先算该 entitlement 可见集,不在集合(未知/quarantined/expired/错 channel/customer 请求 beta)→ **逐字节同形 404**;在集合 → 按 entry 的 exact object key 流式回传。绝不按 URL 拼路径。
- **空态 = pre-activation 运维态(Codex R2#4)**:任一 channel `latest: null` 时该 entitlement **不得签发/交付 key**(签发前置检查 + P5「先 publish 指针再发 key」);此态 `/manifest` 返回 503——**如实声明:PR2 客户端对非 2xx 显示既有网络类诚实话术,503 body 到不了客户眼前**;这是运维不该让客户撞到的状态。客户可见的 `no-release` 映射需放宽 byte-stable 范围,本圈 out。internal/customer 两侧空态响应都进合同测试。

### B0-5 · key 对象

`{customerId, entitlement: "customer"|"internal", revoked: false, createdAt, note}`;对象名 = sha256(key) hex;明文 key 只在签发瞬间存在。key 造型 = `fwk_` + ≥32 hex。

### B0-6 · 发布面 capability 分权(端点按 manifest diff 校验状态迁移)

三类互不相通的 capability token(Worker secret 各存 hash,constant-time 比较)。**一切 manifest 变更(含 releaseOps)都经 `POST /admin/manifest` 单对象 CAS**,端点把 diff 归类后按下表放行:

| capability | 允许的 diff | 谁持有 |
|---|---|---|
| `beta-publish` | 上传 payload 对象(须挂 claim,不变量 8);releaseOps:beta 预约(reserved+ledger 递增)、reserved 态 tuple 登记、release 候选登记(reserved)、reserved→prepared(upload 验过)、**kind=beta 的 reserved/prepared→abandoned**;versions:新增 `channel=beta` entry(+其 op→committed);指针:推进 `internal-beta.latest`(含 retentionSince 迁移) | GitHub repo secret(beta workflow、promote-prepare) |
| `customer-release` | versions:新增 `channel=release` entry(+其 op→committed);指针:切 `customer-release.latest`(含 re-pin 清零/盖章 retentionSince);`status→quarantined`;releaseOps:**kind=release 的 reserved/prepared→abandoned** | **只在 founder 手里**(§3) |
| `ops-admin` | `keys/` 增/改;`status→expired`(端点强制:非任一 latest + retentionSince/quarantinedAt 满窗口,服务端钟);**tombstone 追加**(前提:该 key 仅被终态记录引用——expired entry、abandoned op、对应 version 已 expired 的 committed op);`DELETE` payload 对象(前提:key 已在 tombstones);releaseOps:任意 kind 的 reserved/prepared→abandoned | 运营侧(Tadashi/runbook;不进任何 workflow) |

**结构性断言(验收矩阵)**:beta/ops 凭据尝试 customer promote → 拒且 manifest byte-unchanged;ops 凭据 expire 仍是 latest 的版本 → 拒;**任何非-founder workflow 零 Cloudflare control-plane 凭据引用**(静态断言,§3)。

### B0-7 · admin wire contract

| 路由 | capability | 语义 |
|---|---|---|
| `GET /admin/manifest` | 任一 | raw manifest(含 releaseOps)+ quoted ETag——发布脚本读状态的唯一入口 |
| `POST /admin/manifest` | 按 diff 归类 B0-6 | body=`{baseEtag, manifest}`;validator 全量不变量 + capability diff + etag CAS;首创 conditional create(If-None-Match `*` 语义,初始 = 双 channel null + 空表);冲突 412 |
| `PUT /admin/payload/<ver>/<sha256>` | beta-publish 或 customer-release | **必须存在匹配的 reserved/prepared claim**(不变量 8)且 key 不在 tombstones;已存在 → 409;R2 `put({sha256, onlyIf})` 存储侧校验流(不整体 buffer)。**post-check(R5#2 + R6 非阻塞精化)**:put 完成后重读 manifest,**按 exact objectKey 判断是否仍存在任一 reserved/prepared live claim**(不绑定 pre-check 命中的那个 releaseId——abandoned key 可被新 releaseId 接管,此时对象须为新 claim 保留);无任一 live claim 或 key 已 tombstoned → 立即删除刚写对象 + 返回冲突(封闭「claim 检查通过后被 abandon+tombstone+DELETE 超车,慢 PUT 最后落地复活对象」的窗口) |
| `GET /admin/payload/<ver>/<sha256>` | 同上 | streaming readback,唯一对象身份(发布客户端流式 hash 复验) |
| `DELETE /admin/payload/<ver>/<sha256>` | ops-admin | **两步删除(Codex R4#1;R2 delete 无条件参数,并发 last-writer-wins)**:前提 = 该 key 已在 `tombstones`(追加 tombstone 的 manifest CAS 才是真正的 guard;从此 validator 拒绝一切新引用)。**诚实合同(R5#2):客户可见面零竞态(tombstoned key 不可能进任何视图),物理对象则是最终收敛**——在途 PUT 复活窗口由 PUT post-check + tombstone 全量 sweep 收敛(B0-10-5),不承诺单次 DELETE 返回即物理绝对不存在 |
| `PUT /admin/key/<sha256>` · `POST /admin/key/<sha256>/revoke` | ops-admin | 签发/吊销;轮换 = 先签新再吊旧(脚本编排) |

### B0-8 · 写不变量(FLY-1098 §7.3)

payload 上传 = 不存在才写 + 存储侧 sha 校验 + 下载路径流式复验;manifest 更新 = 单对象 etag CAS(冲突 fail-closed:重读→按 B0-9 幂等判定→重试或停);发布单飞 = Actions concurrency group + CAS 双保险;薄壳只在壳代码变更时独立发布;**promote 审批后零构建**;**状态先行、删对象殿后**(B0-10)。

### B0-9 · 发布操作幂等协议(releaseId;单对象、零 saga,Codex R3#1)

**releaseId = 每次发布操作的首个输入**(CI 默认 `gh-run-<run_id>`;本地重试显式复用同一 id)。所有状态都在 manifest.releaseOps,每步 = 一次 `POST /admin/manifest` CAS:

1. **预约(beta 线)**:diff = 新增 `releaseOps[id] {kind: beta, state: reserved, ver: base-beta.N}` + ledger N 递增——**同一 CAS**,不存在「ledger 已加而预约丢失」;幂等:id 已存在 → 返回既有记录(**同 releaseId 永远拿同 pinned ver**),不再分配。release 线(promote-prepare)起步 = 新增 `{kind: release, state: reserved, ver, betaVersion, sourceCommit}`。
2. **占位登记(上传之前,Codex R4#2)**:本地构建得出 sha 后、**PUT 之前**,reserved 态补齐 tuple(sha256/objectKey/sourceCommit)——此后这个 staging 对象**永远可从 manifest 发现**(崩溃孤儿零盲区);幂等:已登记且 tuple 逐字同 → 成功;不同 → fail-closed。
3. **上传+验证 → prepared**:`PUT /admin/payload`(挂 claim,409 容忍)+ readback 流式复验 → CAS `reserved→prepared`。「上传完成但响应丢失」重跑 = PUT 409 容忍 + readback + 幂等迁移。
4. **提交**:diff = versions 新增 entry(带 releaseId)+ 指针切换(+retentionSince 迁移,服务端盖章)+ `releaseOps[id]→committed`——**同一 CAS 原子成立**(不变量 7 互指)。幂等:op 已 committed 且 tuple 同 → 成功返回(覆盖「CAS 成功但响应丢失后重跑」);tuple 不同 → fail-closed。commit 硬门 = 对象 HEAD/sha 与 entry 一致。
5. **放弃**:reserved/prepared→abandoned(单 CAS;与并发 commit 由 etag 串行化——输家 412 重读,committed 后 abandon 被拒、abandoned 后 commit 被拒;**无中间态、无恢复协议**)。上传前失败/搁浅预约由此退出,对象(若已传)走 B0-10 清理。
6. ledger 空洞可能(预约后弃)且无害;单调性由不变量 4 保住。

### B0-10 · retention/清理协议(pointer-tenure 钟;orphan 可留,dangling 绝不)

1. **钟 = `retentionSince`**(B0-2 不变量 5):离开 latest 的 CAS 盖章;成为 latest(含 withdraw fallback **re-pin**)的 CAS 清零——re-pin 期间不可 expire,再次离开 current 从零重计(FLY-1098 §8.2「重新标为 current/pinned」+ §9 语义;验收场景:release A→B→withdraw B fallback A→C,A 在 fallback 期免死、C 上位后 A 重新计满 28 天)。quarantine 钟 = `quarantinedAt`。
2. 到期判定(beta 14 天 / release 28 天)由 `payload-cleanup.mjs`(dry-run 默认)提出,**端点二次强制**(B0-6 ops-admin 行)。
3. **顺序铁律(三步,Codex R4#1/R5#1)**:① `status→expired`(manifest CAS,退出一切视图)→ ② **tombstone CAS**(前提 = 该 key 仅被终态记录引用,见 B0-6;从此任何新引用/PUT 复活被拒——与并发 prepare 同对象 etag 串行化)→ ③ R2 `DELETE`(失败留可重跑 orphan)。**绝不反序产生 dangling**。
4. abandoned op 的对象:同走 ②③。**注**:tombstone 只在真要删对象时才打——abandoned 候选的 objectKey 在被 tombstone 之前可被新 releaseId 重新引用(promote 同 base 重试不被死锁)。
5. **tombstone 全量 sweep(R5#2)**:`payload-cleanup.mjs` 每次运行对 tombstones **全集**重放 DELETE(不只本次新追加项)——PUT post-check 崩溃/慢 PUT 复活留下的 tombstoned orphan 由耐久 tombstone 收敛;物理对象合同 = 最终收敛(客户可见面始终零竞态)。
6. 定时自动化归 FLY-1143;本圈 runbook 人工触发。

```mermaid
flowchart LR
  subgraph cust["客户机(PR2 已 ship,零改)"]
    SH["@flywheel/onboard 薄壳"]
  end
  subgraph cf["Cloudflare(PR3)"]
    WK["Worker 薄端点<br/>客户读(经可见集)· manifest 单对象 CAS<br/>(capability diff + releaseOps 幂等)· 清理 guard"]
    R2[("私有 R2 bucket<br/>payloads/ · manifest.json(含 releaseOps) · keys/")]
  end
  subgraph gh["GitHub Actions(PR4,全手动)"]
    W1["payload-beta-release(无门)<br/>beta-publish token"]
    W2p["promote·prepare(无门)<br/>build clean+等价证明+登记 claim→上传"]
    W2c["promote·commit 🔒founder<br/>复验 sha → 单 CAS"]
    W3["shell-publish 🔒founder<br/>npm OIDC(首发另走 bootstrap)"]
  end
  SH -->|Bearer fwk_key| WK --> R2
  W1 & W2p & W2c -->|capability token(app 级)| WK
  W3 -.-> NPM["公共 npm(只有薄壳)"]
  NPM -.-> SH
```

**为什么写路径全走 Worker(含清理),不走 S3 API/wrangler 直写**:① 单一可信写收口——validator 不变量、capability diff、CAS、幂等判定、immutable、存储侧 sha、expire/delete guard 全在同一段代码,hermetic 测试与生产逐字同码;② 发布/运维脚本零新依赖(node 内置 fetch);③ **vendor control-plane 凭据因此完全不进 repo secrets**(§3)。已知边界:Workers 免费档请求体 100MB,payload 几十 MB 留余量(实测 §5);超限 fallback = presigned PUT(follow-up)。

## 1. 里程碑

### PR3 · payload 端点 + key 生命周期 + 清理协议(= B2)

**范围**:
1. **新包 `packages/payload-endpoint/`**(独立,零 flywheel-* 依赖):`src/handler.mjs` 纯函数 `handleRequest(request, {bucket, secrets, now})`(注入时钟 → 生命周期时间戳 server-owned,B0-2 不变量 3/9)——客户面(`GET /manifest`、`GET /payload/<ver>`;缺/错/吊销 key 一律 401 同形;错误体简短诚实、零内部路径、零 key/hash 回显)+ 发布/运维面(B0-6/7/9/10 全部)。R2/secrets 注入,node 直测零 wrangler。`wrangler.toml` + 部署 runbook(v1 手动 `wrangler deploy`,用 founder custody 的 Cloudflare token 执行,§3;wrangler 不进生产依赖)。
2. **key 生命周期件**:`scripts/release/license-key.mjs`(issue/revoke/rotate;经 ops-admin 路由;issue 前置检查目标 entitlement 的 channel latest 非 null;签发打印明文一次即弃);`scan_for_secrets` 补 `fwk_[0-9a-f]{32,}` pattern。
3. **清理件**:`scripts/release/payload-cleanup.mjs`(B0-10;dry-run 默认;expire→tombstone→delete 三步 + tombstone 全量 sweep;runbook 化)。
4. **合同一致性锁**:PR2 stub 与真 handler 同 fixtures 同断言集;PR2 六套件端点换真 handler(node http 壳 in-process)再跑全绿。

**验收(hermetic,RED 起点=「valid customer key 拿到 customer-release 视图」)**:
- auth 矩阵:无 header/乱 key/已吊销/customer/internal → 401·401·401·customer 视图·internal 视图;吊销写入后下一请求即拒。
- 视图+取物负例:beta/quarantined/expired/未知版本对 customer 的 `/payload` → **逐字节同形 404**;in-集合按 entry.key 取物且 sha 一致;流式不整体 buffer(stub 可观测)。
- 发布面 capability 矩阵:beta token 干 customer 事 / ops token 碰指针 / 错 token → 拒且 manifest byte-unchanged;PUT payload 重复 409;CAS 旧 etag 412;validator 全不变量正反例(dangling latest / entry 变更 / ledger 回退 / key 自由串 / lineage 缺失或不匹配 / **entry↔op 互指破坏(active entry + 非 committed op;committed op + 无 entry)** / **latest 而 retentionSince 非空** 全拒)。
- 幂等协议(B0-9):同 releaseId 重复预约 → 同 pinned ver(预约与 ledger 同 CAS:412 重读后不重复分配);**占位登记后、上传前崩溃 → 对象未传而 claim 可见,重跑续走**;**上传完成响应丢失 → PUT 409 容忍 + readback + 幂等转 prepared**;**commit 成功后响应丢失重跑 → 幂等成功、零第二个 beta**;同 id 不同 tuple fail-closed;**commit vs abandon 并发 → CAS 串行化,输家重读后被 validator 拒**;**reserved abandon**(上传前退出)合法;状态机单向;**无 claim 的 PUT 被拒**(每个 staging 对象必然可从 manifest 发现)。
- 时间权威(B0-2-3/9,Codex R4#3):客户端提交 backdated/future retentionSince/quarantinedAt → 被拒或被服务端值覆盖;re-pin 清零、再次 supersede 由服务端重盖章;expire 窗口判定用注入时钟(测试可拨钟)。
- 清理协议(B0-10):expire 仍为 latest → 拒;expire 后视图立即不含;**tombstone 正例:expired version + 其 committed op → 允许 tombstone(已发布版本可删)**;**三类 live 引用负例:active version / quarantined version / reserved·prepared op → tombstone 拒**;tombstone 重复追加 = 幂等成功(集合语义);**带 barrier 的竞态测试:guard 读过 → 并发 prepare 引用同 key → tombstone CAS 412 重读后放弃**(反向:tombstone 先落 → prepare 引用被 validator 拒);**PUT 复活 tombstoned key → 拒**;**在途 PUT 复活窗口(R5#2):PUT claim 检查通过 → abandon → tombstone → DELETE → PUT 最后完成 → 断言对象被 post-check 或下一次 sweep 删除且从未进入任何视图**;**claim 接管正例(R6):A 的 PUT 在途 → A abandoned → B 以新 releaseId 认领同 key → A 的 PUT 完成 → post-check 见 B 的 live claim,对象为 B 保留,B readback/prepared 成功**;tombstone 成功 + R2 DELETE 失败 → sweep 重跑收敛零 dangling;**shared-object:两个 releaseId 先后引用同 `<ver>/<sha>`(前者 abandoned)→ 合法(重试不死锁),tombstone 后新引用被拒**;**re-pin 场景:A→B→withdraw fallback A→C,A 在 fallback 期 expire 被拒、C 上位后 retentionSince 重新起算(服务端盖章)**。
- 空态:两 channel null 例外过 validator;internal/customer 空态各返 503;key issue 对空态 entitlement 拒。
- 安全:key/sha256(key)/三类 token 不出现在任何日志行与错误体(注入断言)。
- 合同一致性:六套件对真 handler 全绿。

**可拆点:独立成单(PR3)。与 PR4 可并行写(共享 §0 合同)。**

### PR4 · 发布流水线 + B0 断言接 CI(= B1)

**范围**:
1. **打包器版本注入(additive + sentinel)**:`PO_RELEASE_VERSION`——缺省 = 现状逐字(reverse-compat sentinel);注入时 stamp package.json/哨兵,`po_gate` 改验「= base 或 base-beta.N 派生」。
2. **`scripts/release/payload-release.mjs`**(beta 线):输入 releaseId → 预约拿 pinned ver(B0-9-1)→ 打包(注入 ver)→ 4 门 → **占位登记 tuple(B0-9-2,上传之前)** → `PUT /admin/payload/<ver>/<sha>`(挂 claim)→ readback 流式复验 → 转 prepared(B0-9-3)→ 提交(B0-9-4:entry+internal-beta 指针+op committed 单 CAS)。失败零半成品;重跑幂等全走 B0-9。
3. **promote 两段式**:
   - **prepare(无门,beta-publish token)**:输入 = releaseId + **唯一 beta 版本号**;`sourceCommit` 从 manifest entry 派生(不许操作者另填);checkout 该 commit → 打 clean 版 → 4 门 → **等价证明**(clean 树 vs beta payload 树规范化 diff,剥版本戳后逐字节等价;**不成立 = fail-closed 回 design review,绝不降级放行**)→ **登记 release 候选(reserved,全 tuple,上传之前)** → 上传(挂 claim)+ 复验 → 转 prepared(B0-9-3)。
   - **commit(founder gate = Flywheel approve gate → broker `publish-release`;customer-release token 只在 broker 内存,不在 CI/子进程/磁盘)**:Annie 一条 Discord approve → broker **核内存 founder-approval 登记(非 DB-backed verify-approval;校验未消费 + 绑定 releaseId+sha256 逐字匹配)**过则执行(非 GitHub workflow、非直读 token 的 Bridge 脚本):`GET /admin/manifest` 读 op → `GET /admin/payload/<ver>/<sha>` 复验 → 提交(release entry lineage + 切 customer-release + retentionSince 迁移 + op committed,单 CAS;幂等按 B0-9-3)→ 原子标记 approval consumed → **写 audit log**(releaseId/ver/sha/approver-questionId/时间戳)。**gate 后零构建**——她批的就是候选 tuple 的 `releasePayloadSha256`(FLY-1098 §6.2 (i))。被 veto/放弃 → abandon(B0-9-4)→ B0-10 清理。**(broker 接线 = 1062 下一个 PR;本 PR 的 `payload-promote.mjs commit` 脚本逻辑已 sound,只是尚未由 broker 触发。)**
   - **withdraw 模式**(customer-release token):`--withdraw <ver> --fallback <ver>`(fallback 必须 active+release 过 validator;quarantined+quarantinedAt + 指针回指 + fallback re-pin 清零 retentionSince);「无 previous-good」自动态归 B5。
4. **两条 GitHub workflow + 两条 Bridge 动作(自动化形态;`concurrency: payload-release`;workflow 全 `dispatch` 限 main + main-only guard)**:
   - GitHub CI(只持 `FW_BETA_PUBLISH_TOKEN`,内部 beta blast radius):
     - `payload-beta-release.yml`(**`schedule` 每 6h + dispatch,无门**;deterministic releaseId + sourceCommit dedup 见 §2)
     - `payload-promote.yml`——**只保留 prepare job**(无门,beta-publish token,build + 等价证明 + stage 候选);**无 commit job**。
   - Broker 发布动作(**= 1062 底下下一个 PR**;token 只在 broker 父进程内存、approve-gate + 结构化单次消费 + audit):
     - **promote-commit**:approve → broker `publish-release`(broker 核内存 founder-approval 登记,过则用内存 customer-release token 跑 `payload-promote.mjs commit` 逻辑)+ audit log。
     - **shell npm publish**:prepare(pack+sha stage)→ approve → broker `publish-shell`(用内存 GAT publish staged 物)+ audit log。
   - **`shell-publish.yml` 删除**(不再是 CI workflow——npm 发布是 broker 动作)。
   - **本 PR(#558)workflow = beta-auto + promote-prepare 两条**(GitHub CI 只持 beta-publish);broker/两条发布动作在下一个 PR。
   - **workflow 静态断言**:任何 workflow **零 customer-release token 引用 + 零 npm token/OIDC id-token 引用**(对外发布都不在 CI 的硬证据)+ 零 Cloudflare 凭据引用 + 全 workflow main-only dispatch guard + promote workflow 无 commit job + 无 `shell-publish.yml`(secret/结构名单 lint)。
5. **薄壳解锁三件**:去 `private: true` → `publishConfig: {access: "public"}`;publish-gate 测试同步(「private 锁」→「发布形态」断言,白名单逐字保留);`DEFAULT_ENDPOINT` 填真 URL(部署后)。壳版本 bump 显式进 PR。(`repository.url` 非必需——B 形态用 GAT publish 不走 OIDC trusted publishing;将来迁回 OIDC 时再补,见 §3 hardening note。)
6. **npm token = GAT**:npm **granular access token,write on `@flywheel/onboard` 唯一包**(GAT 无 publish-only 权限);**只进 broker 父进程内存**(broker PR 落地时供给),`npm publish` 由 broker 执行、子进程拿不到。**无「Annie 本机」步骤、无 CI token、不落盘**;轮换手册进 key 服务 runbook。
7. **runbook 新章**:发 beta / promote(两段+审批物=候选 tuple)/ withdraw / retention 清理 / key 签发·吊销·轮换(含空态前置检查)/ 端点部署(founder token)/ 三 token custody 与轮换 / 断案手册(412 重读幂等 / 409 / 401 / 503 空态 / orphan 重跑);红线 = 禁裸 dashboard 编辑 bucket 对象。

**验收(hermetic;端点用 PR3 真 handler in-process,真 vendor 留 P5/首发)**:
- 版本注入双侧(缺省逐字 sentinel;注入合法/非法)。
- beta 线:全链绿;中断注入(预约后挂 / 上传后 commit 前挂 / **commit 后响应丢失**)重跑幂等、零第二 beta、零半成品。
- promote:非唯一/不存在 beta 拒;prepare 候选 tuple 与上传物一致;commit 收到被换 sha → 复验失败拒;**commit 路径含任何构建步 = 测试 fail**(结构断言);等价证明正反例(篡改一文件 → 红;失败 = fail-closed 无降级出口);withdraw 后 customer 视图无该版、latest=fallback、fallback retentionSince 清零。
- workflow 结构断言(自动化形态,Codex CRITICAL + R2 修正版):**任何 workflow 零 customer-release token 引用 + 零 npm token / OIDC `id-token` 引用**(两条对外发布都不在 CI 的硬证据)+ **promote workflow 无 commit job**(只有 prepare)+ **无 `shell-publish.yml`**(npm 发布是 Bridge 动作);beta 含 `schedule`(每 6h)+ dispatch;全 workflow main-only dispatch guard;无门 workflow 不引用 Cloudflare secret 名;concurrency 存在;promote sourceCommit 从 manifest 派生(非 operator 输入)。
- Broker 发布动作(promote-commit + shell-publish;= broker PR)断言:approve gate → broker **核内存 founder-approval 登记(非 DB-backed;未消费 + 绑定 (action,releaseId,sha256) 逐字匹配)→ 原子标记 consumed → 发**;shell 发布前 broker **对 staged tarball rehash 断言 == 批准 sha256**;零构建(promote-commit);token 只在 broker 内存;写 audit log(releaseId/ver/sha/approver-questionId/时间戳)。
- beta dedup:HEAD sourceCommit 已有 committed beta 时 scheduled 运行 skip(不刷新 beta.N);dispatch 强制发。
- 薄壳 publish gate 更新后全绿且 pack 白名单逐字不变;`repository.url` 已补(OIDC 前置)。

**可拆点:独立成单(PR4)。**

### P5 · 真机 QA 段(独立 QA;顺序 = Codex R1#7 修正版)

① Annie 清单落地 → 真 R2/Worker 部署(founder token)+ conditional-create 初始化 manifest + **先 publish beta/release 指针**、再签发真 key(internal+customer;空态前置检查真机验)。② **broker 上线**(customer-release + npm GAT 进 broker 内存)+ 薄壳首发。③ 发布圈真跑:beta 上传(含同 releaseId 重跑幂等真机验)→ promote prepare → **approve gate → broker publish-release**(founder 一条 approve 真机验)→ shell prepare → **approve gate → broker publish-shell** 发一个壳小版本。**硬约束:此段在 broker PR 落地后才做**。④ 干净 VM(linux/WSL2)+ macOS:`npx @flywheel/onboard` 全链 → Buddy 起步 → Bridge/Lead 在线;网络 trace:零私仓 URL、key 只在 Authorization header。⑤ `flywheel update` 拉新 clean 版;withdraw 走一遍(客户视图即时回退 + fallback re-pin);**下载中断注入 → 零残留 + 重新完整请求成功**(resumable download 明确 out)。⑥ R2 CAS 冲突真机(双并发写一方 412)+ 大 tarball 流式真传 + capability 越权真机拒 + expire→tombstone→delete 三步真机走一遍(含 sweep 重放)。⑦ 错 key/吊销 key 真机话术。

## 2. 测试策略(TDD)

- idiom 沿用两圈:hermetic + fixture;handler 纯函数 node 直测;PR2 六套件复用为合同回归。
- RED 起点:PR3 =「valid customer key → customer 视图」;PR4 =「PO_RELEASE_VERSION 注入后 gate 按派生断言放行」。
- **自动化形态新增断言**:beta sourceCommit dedup(scheduled 运行:HEAD 已有 committed beta → skip;dispatch 强制)· workflow 结构门(**任何 workflow 零 customer-release token 引用** / shell 零长期 npm token / 全 workflow main-only dispatch guard / promote sourceCommit manifest 派生 / **promote workflow 无 commit job**)· promote-commit 脚本零构建 + 写 audit log(releaseId/ver/sha/approver/时间戳)· preflight 门(OIDC 就绪:npm/Node 版本 + `repository.url` + endpoint 非占位 + registry 版本未用)。
- 贯穿断言:reverse-compat sentinel(打包器缺省路径;`ci.yml` 既有 job/step 逐字不变,只追加一个隔离 payload-endpoint job)· secret 注入测试(fwk_ pattern;key/token 零泄漏)· 黑话 lint(新客户可见话术 = 零新增面)· **顺序结构断言**(cleanup 脚本必须 expire→tombstone→delete 且含全量 sweep;PUT 路径必须含 post-check——防后续编辑把旧两步清理/upload-before-claim 复活)。

## 3. 发布授权机械落点(**自动化形态**;Annie 2026-07-11 直令:发布全自动、不依赖她本机 / 不本机跑命令 / 不交互式 2FA)

> **形态变更(取代旧 fallback 形态)**:旧设计把 founder gate 落在「Annie 本机跑命令 + 每次 shell publish 本地 2FA」。Annie 明确否决——她要发布**完全自动化**,并顾虑「电脑一关就发不了」。新设计:发布凭据全部 server-side(CI secret / OIDC),**founder gate = 一个触发动作**(她在 GitHub UI 点 Run workflow,或 Flywheel approve gate 触发 dispatch),不是本地命令。

> **Codex design review CRITICAL(已修正)**:初版把 customer-release token 放 GitHub CI environment secret + dispatch gate。Codex 证明**不安全**:同一 CI 也持 beta-publish token,**两把合起来能走 Worker 合法路径把任意 payload 推给客户**——beta-publish 上传攻击者字节当某 beta(自设 sourceCommit)+ commit;customer-release 建 lineage 自洽的 release entry 指向它、上传、切 customer 指针。**等价证明只在 workflow 里、不在 Worker 里**,被攻陷 CI 直接跳过。所以「Cloudflare token 不进 CI 就封顶 blast radius」在**两把应用层 token 同处一个 CI**时不成立;私仓非 Enterprise 下 environment 分离也没用(改过的 branch workflow 能引用任一 environment 取 secret)。**修正 = customer-release token 彻底移出 GitHub CI**(下)。

### 底线(结构性,不变)
- **底线一:Cloudflare API token(R2 直写 / Worker deploy)= vendor control-plane 凭据,绝不进 repo secrets / 任何 workflow**。custody = founder(bootstrap 首把 token 需浏览器登录一次,之后 wrangler/API)。发布路径只允许打 Worker admin API(workflow 静态断言 + runbook 红线)。
- **底线二:三类 capability token 分权 + 跨信任域隔离**(beta-publish / customer-release / ops-admin,Worker 只存 sha256):**两把应用层 token 绝不同处一个信任域**——beta-publish 在 GitHub CI(blast radius = 内部 beta 通道),customer-release 只在**常驻 Bridge/Flywheel runtime**,受 approve gate 保护。被攻陷的 GitHub CI 只持 beta-publish → **结构上碰不到 customer 面**(这是修正后的真正安全支点,取代旧「底线一封顶」的错误论证)。

### 三条发布路径的授权形态

| 路径 | 触发 | 凭据(server-side,分信任域) | founder gate |
|---|---|---|---|
| **beta payload** | `schedule` 每 6h + `workflow_dispatch`——**全自动无门** | `FW_BETA_PUBLISH_TOKEN`(**GitHub CI** secret,app 级) | 无(Annie 直令:beta 每 6h 直接发)。**幂等 dedup**:HEAD 的 sourceCommit 已有 committed beta → skip(main 空闲不刷 beta.N;并发下判定稳,concurrency 串行 + 提交前重查) |
| **promote prepare** | `workflow_dispatch`(main)——**无门** | `FW_BETA_PUBLISH_TOKEN`(GitHub CI) | 无(不碰 customer 面,只 build + 等价证明 + stage 候选) |
| **promote commit(stable)** | **Flywheel approve gate**:Annie 一条 Discord approve → **broker `publish-release`**(broker 核内存 founder-approval 登记 + 结构化单次消费) | `FW_CUSTOMER_RELEASE_TOKEN`(**只在 broker 父进程内存,永不落盘、不进 CI/子进程**) | **有 = approve gate**。**gate 后零构建**——她批的就是候选 tuple 的 sha256;**审计**:releaseId/ver/sha/approver/时间戳 |
| **shell npm publish** | **Flywheel approve gate**(同机制)→ prepare(pack+sha)→ **broker `publish-shell`**(用 staged 物) | npm **GAT**(write on `@flywheel/onboard` 唯一包)**只在 broker 内存,不在 CI** | **有 = approve gate**(与 payload 完全对称);内容 = public 薄壳(无核心代码);低频(仅 installer/bin 变更) |

### 修正后的安全论证(customer-release 移出 CI)
- **两把应用层 token 分处两个信任域**:beta-publish 在 GitHub CI,customer-release 在 Bridge。任一单域被攻陷都拿不齐「上传任意 beta + 切 customer 指针」的两把钥匙 → **Codex 的组合绕过结构性消失**。
- **customer-release 授权 = Flywheel approve gate**(Annie 0ff26bc6 ① 原话『founder gate 改为...我们的 approve gate』+ 16665ddf『stable promote 保留她批准』):她一条 Discord approve → broker 核内存 founder-approval 登记(非 DB-backed verify-approval)过 → broker 用**内存里**的 customer-release token 跑 `payload-promote.mjs commit` 逻辑。**全自动(broker 做)+ 她只批一条消息 + 不依赖她电脑**,三条原话全满足。
- **token 落点 = broker 父进程内存,永不落盘/不入 CI/不入子进程**;供给/轮换写进 key 服务 runbook(§7)。**promote 动作 audit log**:谁批(approve questionId)、何时、promote 到哪个 sha。
- **Cloudflare API token 仍 founder custody**(底线一,不变);它管的是 control plane(R2 直写 / Worker deploy),与应用层 capability token 正交。

### 授权绑定 + token 隔离 + 定时幂等(Codex design R2+R3 blocker 修正 = 硬化目标设计)

- **① 授权 = FLY-245 broker,token 绝不落盘**(Codex R3#1 核心):**同 UID 的 0600 文件不是 trust boundary**——runner/lead 与 Bridge 同一 UID 同一台机,能直接 cat 那个文件绕过 approve gate。真隔离**复用 FLY-245 unix-socket broker**:两把对外发布 token(customer-release capability + npm GAT)**只在 broker 父进程内存**(Bridge boot 时、任何 runner spawn 之前启动),**永不落盘、永不进任何子进程内存**。broker 经 unix socket 只暴露**两个动作**(`publish-release` / `publish-shell`),caller 传 releaseId + 绑定 artifact;broker **核对自己内存里的 founder-approval 登记**、只在过了且未消费时用内存里的 token 执行。子进程**永远拿不到 token**,只能请求动作。(= FLY-245 gateway 已有模式,非新发明。)
- **①b co-resident runner 闭合:approval ingress 只认可信来源,不走 DB-backed verify-approval**(Codex R4+R5:同 UID runner 能连 broker socket、也能往 **runner-可写的 CommDB/SQLite 塞假 approval**——所以 broker **绝不能依赖现有 DB-backed `flywheel-comm verify-approval`**)。闭合:broker 维护**自己的内存 approval 登记**,**只从可信 founder-event 入口填**(Annie Discord approve → Bridge 父进程事件流 → broker 内存),**绝不读任何 runner 可写的 DB/文件**。因此 caller 身份不重要——同 UID runner 可以「请求」某动作,但 broker 只对**存在匹配 (action,releaseId,sha256) founder approval 且未消费**的请求执行;runner **伪造不出**一个 founder 没批过的 approval,只能触发**已被 founder 批准的确切 tuple**(= 本就该发生的动作,无害;单次消费防重放)。
- **①c restart / provisioning 权威(Codex R6#2)**:memory-only token/approval 在 Bridge/broker **重启后即失**——由此**不会**落盘留 runner 可读的明文。重新供给权威 = **founder/operator 的 broker 启动动作**把两把 token 注入 broker 内存(从 OS keychain / operator 当场输入 / boot 时用不在 runner 可读处的密钥解密),**绝不明文落盘**;pending approval 是 ephemeral(重启后重新 approve 即可——对外发布本就 founder-gated + 低频,可接受)。**beta 自动线(GitHub CI)不受 broker 重启影响**;只有两条 founder-gated 发布在重启后需重新供给 token,而它们本就要一条 founder approve,不构成额外负担。
- **② 结构化单次消费 + crash-safe(consume-after-success)**(Codex R2#1 + R3#2 + R4/R5/R6):approve gate 问题体带 **(action-type, releaseId, artifact-sha256)**。**顺序统一(唯一权威表述,其它处引用此条)**:broker ① 校验**未消费 + 三元组逐字匹配** → ② 执行幂等发布 → ③ **确认成功后才原子标记 consumed**(不 consume-before,避免先标后崩溃永久丢一次合法发布;崩溃落在 ②③ 之间靠幂等收口)。**digest 算法统一(Codex R6#1)**:approval 绑的 `artifact-sha256` = tarball 的 **sha256**;发布/复验一律用 **同一 sha256**——**shell 发布前 broker 对 staged tarball 重算 sha256 断言 == 批准值**(runner 换文件→不符→拒);**npm publish 撞 409 不当然成功——broker 从 registry 下载该版本 tarball、重算 sha256 比对 == 批准值**(**不信 npm `dist.shasum`(sha1)/`dist.integrity`(sha512),一律本地重算 sha256**);payload commit 幂等由 B0-9 收口。绝无「手持裸 token 即发」——broker 是唯一执行点,无 approval 不动。
- **③ shell prepare/stage + broker 侧重验内容(approve 绑定确切 tarball)**(Codex R3#3 + R5):shell 也走**两段式**,与 payload 对称——**prepare**:`npm pack` 出确切 tarball → 记 sha256 → stage;**approve 绑定这个 staged sha256**;**broker publish 用 staged 物**(不重新 pack)。**关键:内容 gate(白名单=bin/lib/README/package.json、零 secret、零私仓 URL)由 broker 在 publish 前对 staged tarball 重跑**(Codex R5:prepare 段的内容 gate 在 compromised runner 域,不可信;信任域是 broker),rehash + 重验内容双通过才发。registry 前置(该版本未用 / endpoint 非占位)亦在 broker 跑。
- **④ npm GAT 真作用域**(Codex R3#4 事实更正):npm GAT **没有 publish-only 权限**,最细 = 「选定包的 read/write」(write = publish + 改 dist-tag / deprecate)。故 GAT = **write on `@flywheel/onboard` 唯一一个包**;残余(该单包上还能 deprecate / 改 dist-tag)由 approve gate + audit + 单包作用域 + broker-唯一-执行 收口。
- **⑤ 定时 beta 崩溃重试幂等**(Codex R2#4):**scheduled beta 用确定性 releaseId = `beta-<HEAD sourceCommit>`**(非 gh-run-<run_id>)。任一定时 fire / 崩溃重试对同一 commit 复用同 releaseId → B0-9 幂等完全收敛(reserve 返回既有 op、零第二 beta.N;reserve 后 commit 前崩溃是**续跑**)。dedup(「该 sourceCommit 已有 committed beta → skip」)是快路径,确定性 releaseId 是 reserved-未-committed 崩溃窗口的正确性兜底。manual dispatch 可显式 releaseId 强发。beta workflow **pre-activation guard**:`FW_ENDPOINT` 未配时 no-op(P5 前定时 fire 不产噪、不失败)。

### 落地拆两个 PR(Lead 裁决:不新开 issue,broker 留 1062 底下当下一个 PR;1062 不关单直到 broker 落地)

| 落点 | 内容 | 为何可分 |
|---|---|---|
| **PR #558(本 PR,机器件)** | endpoint(纯函数)+ release/ops scripts + packaging + PR2 合同锁 + **beta-auto CI workflow(schedule+dedup+pre-activation guard)+ promote-prepare workflow**(GitHub CI 只持 beta-publish)+ 结构 lint(**删 shell-publish.yml、删 promote commit job、零 customer-release/npm token 在任何 workflow**) | 142 测试已 sound;**不发布任何真东西**(无真 token/endpoint,真发布在 P5);beta/promote-prepare 都不碰 customer 面 |
| **下一个 PR(1062 底下,broker 硬化)** | FLY-245 broker(两 token 内存隔离 + 两动作 vend)+ approve-gate 集成(broker 核内存 founder-approval 登记 + 结构化单次消费)+ **promote-commit / shell-publish 两条 Bridge 发布动作** + shell prepare/stage + GAT 供给 | 这是「真发布路径」的硬化;gate 的正是 P5 真发布 |

**硬约束(Lead ④)**:**真发布(P5 真机段)在 broker PR 落地前不许发生**——无 descope、无假 done;安全模型该到基建层就到,只是分两 PR。

### 薄壳发布 = Bridge 动作 + approve gate(Lead 拍 B;Codex R2#3 founder-exclusive)

> **为何 B(Lead 撤回「保留 OIDC」)**:本仓 repo-write ≈ 全体 runner/agent(全员可写),(A) OIDC 在非 Enterprise 下**非 founder-exclusive** = 任何一个 runner 都能对外发 npm 薄壳,正是我们挂着的「full-capability agent 结构性 merge 保护」缺口翻版,不可接受。B 代价可控:薄壳发布本就低频(仅 installer/bin 变更),她一条 approve 不违背自动化直令(她否的是「在她机器上跑命令」,不是「点一下批准」)。

- **与 payload 路径完全对称、复用同一机制(broker + 两段式 + 结构化单次 approval,不做两套)**:shell 也 **prepare(npm pack → staged tarball + sha256)→ approve 绑定该 sha256(结构化单次消费)→ broker `publish-shell` 用 staged 物**;GAT 只在 broker 内存,`npm publish` 由 broker 执行,子进程拿不到 token(见上「授权绑定 + token 隔离」①②③)。
- **GAT 真作用域(Codex R3#4)**:npm GAT 无 publish-only 权限,最细 = **write on `@flywheel/onboard` 唯一一个包**(write = publish + dist-tag/deprecate);残余由 approve gate + audit + 单包 + broker-唯一-执行 收口。轮换手册进 key 服务 runbook(§7)。
- **preflight**(endpoint 非占位 / registry 版本未用 / 内容 gate)在 prepare 段跑;发布前 registry 断言该版本不存在。
- **hardening note(留档)**:将来本仓 **Enterprise / org 化**后,shell publish 可**迁回 OIDC trusted publishing**(无长期 token)+ environment required-reviewers 做硬门,把这把 broker-内存 GAT 退役。届时 = 配 trusted publisher + 删 GAT + 改回 CI workflow 的一次性动作。
- ship 门(:cool:/verify-approval)照旧管 PR 合并;发布授权源独立(FLY-1098 §2.3)。

## 4. 字节兼容 / 风险

**生产零变化承诺**:Annie fleet 不装包不受影响;`ci.yml` 既有 job/step 逐字不变(只追加隔离 job)、`ship-on-comment.yml` 不改;打包器缺省路径逐字;薄壳唯一行为面变化 = DEFAULT_ENDPOINT 常量与 package.json 发布元数据(hermetic 套件全程锁)。**不需要 Bridge 重启。**

| # | 风险 | 缓解 |
|---|---|---|
| 1 | founder gate 被绕 | §3 底线一/二 + capability diff + workflow 静态断言 + main-only dispatch guard + 越权负例矩阵 |
| 1b | **Codex CRITICAL:两把应用层 token 同处一个 CI → 组合绕过 Worker 推任意 payload 给客户**(已修正) | customer-release token **移出 GitHub CI**(只在 broker 内存,approve gate 保护);两 token 分处两信任域;被攻陷 CI 只持 beta-publish(blast radius = 内部 beta);workflow 静态断言「零 customer-release 引用」 |
| 1c | **shell npm publish 在 CI 非 founder-exclusive**(Codex R2#3;本仓 repo-write ≈ 全体 runner)| shell publish 改 **broker 动作 + approve gate**(Lead 拍 B);GAT(write on @flywheel/onboard 唯一包)只在 broker 内存不进 CI;prepare/stage + approve 绑 tarball sha256 + broker rehash + 单次消费;将来 Enterprise 迁回 OIDC(hardening note) |
| 1d | **同 UID 子进程读到对外发布 token**(Codex R3#1) | token **只在 broker 父进程内存、永不落盘**(FLY-245 模式);子进程经 socket 只能请求动作、拿不到 token;broker 唯一执行点 + 内存 founder-approval 登记(结构化单次消费)+ audit;GAT 单包作用域 |
| 2 | capability token 泄漏 | 三类分权(beta 泄漏切不动客户指针);轮换 runbook;Worker 只存 hash |
| 3 | Worker/R2 单点 | 薄壳诚实话术已 ship;健康探针 runbook;付费升级路径留档 |
| 4 | 等价证明实测不成立 | fail-closed:promote 停,回 design review(上游 §6.2 二居其一,皆无不得发);npm pack mtime 规范化实测(§5)前置降低概率 |
| 5 | 清理误删/复活 | 端点强制 expire 条件 + tombstone 终态前提(两层规则,B0-2-8)+ PUT post-check + 全量 sweep + dry-run 默认 + expire→tombstone→delete 铁律 |
| 6 | manifest 单对象膨胀(releaseOps/tombstones 累积) | 量级极小(每发布一条/每删一条);旧 op 与 tombstone 的归档压缩策略随 FLY-1143 自动化一并做,v1 不清理(诚实登记;tombstone 单调只增是删除安全的前提) |

## 5. 实现期核验清单(防散落)

1. R2 `put({onlyIf})` etag CAS + `sha256` 存储侧校验 + 强一致——真 bucket 各验一次。
2. **GitHub 计划 = 非 Enterprise(已确认)→ 自动化形态(Codex CRITICAL+R3 修正版)**:两把对外发布 token(customer-release + npm GAT)**移出 GitHub CI,只在 broker 父进程内存**;stable promote + shell publish = Flywheel approve gate(broker 核内存 founder-approval 登记 + 单次消费)。GitHub CI 只持 beta-publish(内部 beta blast radius)。workflow 静态断言「零 customer-release/npm token 引用 / promote 无 commit job / 无 shell-publish.yml」。
3. npm 发布 = broker 动作 + approve gate(Lead 拍 B):GAT(write on @flywheel/onboard 唯一包)只在 broker 内存;broker 发布前 rehash + **内容 gate 权威版在 broker 重跑**(prepare 段快反馈)+ registry 前置(版本未用 / endpoint 非占位);干净账户先验发布指引。beta `schedule` 每 6h + **deterministic releaseId=beta-<sourceCommit>** + dedup + pre-activation guard。将来 Enterprise 化迁回 OIDC(hardening note)。
4. Workers 免费档请求体 100MB vs 真 payload 体积——打包真量一次。
5. `@flywheel` scope 归属 → 定名后全局 grep 包名引用。
6. workers.dev URL vs 自有域——Annie 拍;DEFAULT_ENDPOINT 一次定妥。
7. 等价证明:npm pack 时间戳/树规范化实测;PR2 六套件切真 handler 的接线。
8. releaseId 传递:gh run id 在 rerun 时的稳定性核验(rerun 复用同 run id;attempt 变化不影响)。

## 6. Annie 动作清单(自动化形态;**发布本身零她本机动作**——她只做一次性凭据/账号 bootstrap + 后续「点 Run」触发)

| # | 动作 | 何时 | 说明 |
|---|---|---|---|
| 1 | **Cloudflare**(账号已存在 = 她的,登录邮箱 xrliannie.b@gmail.com):Runner 用 Claude-in-Chrome 替她 bootstrap 首把 API token(需密码/2FA/不可逆确认时才叫她)→ 之后建 R2 bucket / 部署 Worker / 发后续 token 全走 API。硬边界:不碰 custom-map-studio Pages + memoscaped.com routing | implement 前半 / R2 段 | API token = vendor control-plane,custody = founder(§3 底线一) |
| 2 | **npm**:@flywheel scope 已核验可用(定名 @flywheel/onboard);账号开 2FA;**建一把 GAT(write on `@flywheel/onboard` 唯一包)交 broker**(broker PR 落地时供给,只进 broker 内存、非 CI、非她本机)。之后每次壳发布 = 她一条 Discord approve → broker 发 | broker PR / 首发 | 一次性配置;之后发布 = 她一条批准 |
| 3 | **founder gate = Flywheel approve gate**:promote-commit + shell publish 都由她**一条 Discord approve** → broker 核内存 founder-approval 登记过则发。两把 token 只在 **broker 父进程内存**(不在 CI、不落盘、不进子进程)。beta 每 6h 全自动无需她 | 每次 stable/shell 发布 | 「真发布必经她」= 一条批准消息,不依赖她的电脑;审计留痕 |
| 4 | **首客户 key**:跑一条签发命令(可她点或 Runner 代跑),明文 key 经她手交客户 | P5/首客户时 | 系统只存 hash;空态前置检查先拦没发过版的 entitlement |

> 按 founder-facing 家规:此清单由 Lead 汇总成一张卡一次问 Annie;所有指引先在干净账户验证过再交她(FLY-1023 教训)。**旧清单第 0 项(GitHub 计划确认)已解**:非 Enterprise 确认 → 两把对外发布 token 移出 CI、进 broker 内存 + approve gate,不依赖 GitHub environment 的任何 enforce。

---

## 附录 · 与 FLY-1098 PRD 的合同对照(review 用速查)

| PRD 条款 | 本 plan 落点 |
|---|---|
| §6.1 版本单一真相 = base 派生 | §B0-3 + PR4-1 |
| §6.2 两身份 + 窗口前预构建 + veto 绑最终 artifact | promote 两段式 + releaseOps 耐久候选(B0-9):founder 批的就是候选 tuple 的 releasePayloadSha256,gate 后零构建;自动否决窗口 = B4(out) |
| §7.2 通道真相 | §B0-2/4 + PR3 视图/取物 + PR4-4/6 OIDC(gate 形态感知) |
| §7.3 七条发布不变量 | 1/2→§B0-8;3(releaseId 幂等+单飞)→§B0-9 单对象协议;4→shell-publish 独立;5→PR2 已 ship;6→§B0-3;7(staging 清理)→releaseOps abandon + B0-10(expire→tombstone→delete + sweep) |
| §8.2 central quarantine + re-pin | v1 落 withdraw 原语(显式 fallback + **re-pin 清零 retentionSince**);三情况全自动 = B5(out) |
| §9 保留期/lifecycle | pointer-tenure 钟(retentionSince/quarantinedAt)+ expire→tombstone→delete 协议(B0-10);不下 bucket lifecycle 规则;自动化归 FLY-1143 |
| §14 激活序 | PR3‖PR4 并行写,P5 联合 E2E 后才对客户启用;B3-B6 = FLY-1143 |
