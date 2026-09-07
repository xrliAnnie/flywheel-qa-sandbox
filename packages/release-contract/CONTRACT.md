# FLY-2387 发布合同 v1 — 版本、channel 与 manifest

Issue: FLY-2387 (https://linear.app/geoforge3d/issue/FLY-2387/1143b0-先锁合同版本channelmanifestprd-1098-6-规范化版本-72-通道单一真相-73-发布不变量)
日期: 2026-09-06
基于: engineering/doc/FLY-2387-release-contract/plan.md

本文件是 FLY-1098 PRD §6、§7.2、§7.3 在代码侧的 v1 合同真相。B1–B5 可以只依赖本包的本文、`index.d.ts`、JSON Schema 与导出函数并行实施。本文只定义合同,不授权、触发或执行任何发布动作。

## 1. 版本与命名

### 1.1 唯一来源与规范化

- base version 的唯一来源是仓库 `doc/VERSION`。
- `normalizeVersionFile(text)` 先移除空白,再移除至多一个前导 `v`,结果必须是 clean `X.Y.Z`;否则抛错并 fail closed。
- `X`、`Y`、`Z` 都匹配 `0|[1-9]\d*`;不允许前导零。
- `doc/VERSION` 不得包含 prerelease 或 build metadata。

### 1.2 payload version

只允许两种形式:

| 身份 | 语法 | 例子 |
|---|---|---|
| clean | `X.Y.Z` | `1.55.0` |
| beta | `X.Y.Z-beta.N`,`N >= 1` 且无前导零 | `1.55.0-beta.2` |

`rc`、`alpha`、四段版本、带 `v`、带 `+metadata`、`beta.0`、`beta.01` 都非法。`parsePayloadVersion` 是解析入口;`baseOf` 对非法输入抛错。`isDerivationOf(base, version)` 当且仅当 version 合法且解析所得 base 逐字相等。

beta 的 `N` 只能由 `manifest.releaseLedger[base].nextBetaN` 在预约 CAS 中分配;调用者不得扫描版本或自行推算。clean semver 不能复用。

`toDisplayLabel(version)` 产生 `v${version}`,只用于 UI、git tag 与通知。`package.json`、manifest、对象 key 和版本目录永远使用无 `v` 的 payload version。

版本测试向量在 `vectors/version-derivation.json`;JavaScript 与 `scripts/package-onboard.sh` 必须通过同一组向量。

## 2. channel 单一真相

payload channel 的唯一真相是 manifest 中恰好两个指针:

| pointer | entry channel | entitlement | 写能力 |
|---|---|---|---|
| `internal-beta` | `beta` | `internal` | `beta-publish` |
| `customer-release` | `release` | `customer` | `customer-release` |

机器映射分别由 `CHANNEL_OF_POINTER`、`ENTITLEMENT_POINTER`、`POINTER_CAPABILITY` 导出。指针值只能是一个 `versions` key 或 `null`。

消费者必须按 entitlement 对应指针读取 `latest`,不得用 `max(versions)` 或排序推断。withdraw 可以让 `customer-release` 回退到 previous-good,因此版本最大值不等于发布真相。

customer 视图只包含 `channel=release && status=active` 的 entry;internal 视图包含 active 的 beta 与 release。对不在 entitlement 可见集中的版本,`GET /payload/<ver>` 统一返回同形 404,不得泄露 beta 或其他不可见版本是否存在。

npm dist-tag 只描述公开薄壳 `@flywheel-ai/onboard`,不表达 payload channel。薄壳版本与 `doc/VERSION` 独立。PRD §7.2 选择不使用 GitHub Release。

## 3. manifest v1

机器可读形状是 `schema/manifest.schema.json`(JSON Schema draft 2020-12)。运行时不依赖 Ajv;`validateManifest(manifest)` 用零依赖 exact-key 检查执行相同形状合同,再断言关系不变量。所有 violation 都以稳定编号 `C-n: path: message` 开头。

根对象恰好包含以下字段:

| 字段 | 合同 |
|---|---|
| `schemaVersion` | 固定为整数 `1` |
| `channels` | 恰好含 `internal-beta`、`customer-release`;每项恰好为 `{latest}` |
| `versions` | payload version → `VersionEntry` 的只增 map |
| `releaseOps` | releaseId → `ReleaseOp` 的持久幂等账本 |
| `releaseLedger` | clean base → `{nextBetaN}` |
| `tombstones` | immutable payload object key 的追加式集合 |

### 3.1 VersionEntry

每个 entry 恰好包含:

| 字段 | 合同 |
|---|---|
| `sha256` | 64 位小写十六进制 artifact hash |
| `key` | 必须等于 `payloadObjectKey(version, sha256)` |
| `size` | 正整数 byte size |
| `publishedAt` | ISO timestamp;server-owned |
| `channel` | `beta | release`,且与 version 语法一致 |
| `status` | `active | quarantined | expired` |
| `sourceCommit` | 40 位小写十六进制 git commit |
| `releaseId` | 非空且跨 `versions` 唯一 |
| `derivedFromBeta` | beta 为 `null`;release 为同 base 的 beta version |
| `retentionSince` | `null` 或 server-owned ISO timestamp |
| `quarantinedAt` | `null` 或 server-owned ISO timestamp;quarantined 时必须非 null |

### 3.2 ReleaseOp

每个 op 恰好包含 `kind,state,ver,betaVersion,sourceCommit,sha256,objectKey,createdAt`。

- `kind=beta` 时 `ver` 是 beta version、`betaVersion=null`。
- `kind=release` 时 `ver` 是 clean version、`betaVersion` 是同 base 的 beta version。
- `state` 只允许 `reserved | prepared | committed | abandoned`。
- `reserved` 可持有未完成 tuple;`sha256` 与 `objectKey` 必须同时为 null 或同时非 null。
- `prepared`、`committed` 必须持有完整 `sourceCommit,sha256,objectKey`。
- `createdAt` 是 server-owned ISO timestamp。

### 3.3 合法完整示例

下例与 `examples/release-committed.json` 语义相等,并由测试同时经过 schema 与关系 validator。

<!-- manifest-example:start -->
```json
{
	"schemaVersion": 1,
	"channels": {
		"internal-beta": { "latest": "1.55.0-beta.2" },
		"customer-release": { "latest": "1.55.0" }
	},
	"versions": {
		"1.55.0-beta.2": {
			"sha256": "924356fadf749ede33bb35b16abe7c61a066352073d5a464d245cedf93b28367",
			"key": "payloads/1.55.0-beta.2/924356fadf749ede33bb35b16abe7c61a066352073d5a464d245cedf93b28367.tgz",
			"size": 1234,
			"publishedAt": "2026-09-01T00:00:00.000Z",
			"channel": "beta",
			"status": "active",
			"sourceCommit": "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
			"releaseId": "beta-95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
			"derivedFromBeta": null,
			"retentionSince": null,
			"quarantinedAt": null
		},
		"1.55.0": {
			"sha256": "9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541",
			"key": "payloads/1.55.0/9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541.tgz",
			"size": 1234,
			"publishedAt": "2026-09-03T00:00:00.000Z",
			"channel": "release",
			"status": "active",
			"sourceCommit": "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
			"releaseId": "promo-1",
			"derivedFromBeta": "1.55.0-beta.2",
			"retentionSince": null,
			"quarantinedAt": null
		}
	},
	"releaseOps": {
		"beta-95400c4f1a7161ab32e84a5107befe5a0c78e7f3": {
			"kind": "beta",
			"state": "committed",
			"ver": "1.55.0-beta.2",
			"betaVersion": null,
			"sourceCommit": "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
			"sha256": "924356fadf749ede33bb35b16abe7c61a066352073d5a464d245cedf93b28367",
			"objectKey": "payloads/1.55.0-beta.2/924356fadf749ede33bb35b16abe7c61a066352073d5a464d245cedf93b28367.tgz",
			"createdAt": "2026-09-01T00:00:00.000Z"
		},
		"promo-1": {
			"kind": "release",
			"state": "committed",
			"ver": "1.55.0",
			"betaVersion": "1.55.0-beta.2",
			"sourceCommit": "95400c4f1a7161ab32e84a5107befe5a0c78e7f3",
			"sha256": "9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541",
			"objectKey": "payloads/1.55.0/9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541.tgz",
			"createdAt": "2026-09-03T00:00:00.000Z"
		}
	},
	"releaseLedger": { "1.55.0": { "nextBetaN": 3 } },
	"tombstones": []
}
```
<!-- manifest-example:end -->

其他合法状态见 `examples/empty.json`、`beta-only.json`、`prepared-candidate.json`、`paused.json`、`withdraw-fallback.json`。`examples/invalid/shape` 是 C-0 schema/运行时等价拒绝集;`examples/invalid/relations` 形状合法,只由对应关系编号拒绝。

## 4. 不变量

| 编号 | 可执行合同 |
|---|---|
| C-0 | 根、channel、entry、op、ledger record 都 exact-key;类型、枚举、hex、ISO、正整数、`schemaVersion=1` 都合法 |
| C-1 | 非 null pointer 必须指向存在、active、channel 匹配的 entry |
| C-1b | pointer 为 null 当且仅当对应 channel 没有 active entry。无历史是 `never-activated`;有历史但全 quarantined/expired 是 `paused`;按 channel 判定,不使用全局空态 |
| C-2 | entry `key` 与 op `objectKey` 都只能由 `(version,sha256)` 派生 |
| C-3 | version entry 只增不删;`sha256,key,size,channel,sourceCommit,releaseId,derivedFromBeta` 不可变;status 只允许 `active→quarantined→expired` 或 `active→expired`;时间戳由服务端覆盖 |
| C-4 | `nextBetaN` 为整数且至少 1、只增不减、允许空洞;递增必须和取得该 N 的 beta reservation 在同一 CAS |
| C-5 | latest entry 的 `retentionSince=null`;active 非 latest entry 必须带 retention timestamp;re-pin 清零并重新起算 |
| C-6 | release entry 的 `derivedFromBeta` 必须存在且为 beta,base 和 `sourceCommit` 必须与 clean entry 逐字一致 |
| C-6b | 新增/提交 release 的同一 CAS 结果中,对应 beta entry 必须仍为 active;否则整次 transition 422,manifest 不变。该规则只在 mutation-time 执行 |
| C-7 | op 与 entry 双向一一对应且 tuple 相等;op 身份 `kind,ver,betaVersion` 不可变;tuple 只能在 reserved 状态 null→值且 write-once;状态只能前进到 prepared、committed 或 abandoned |
| C-8 | tombstone 是追加式集合,只允许终态引用;加入后禁止新引用,物理删除在 CAS 之后并对全集重扫 |
| C-9 | version key 与 channel/kind 语法一致:beta 只能 `X.Y.Z-beta.N`,release 只能 `X.Y.Z` |
| C-10 | v1 形状的 schemaVersion 固定为 1;不兼容字段必须升版本并写明迁移规则 |

C-3、C-4 的融合递增、C-6b、C-7 状态机是 transition-only 规则,由 endpoint 的 `applyTransition` 在写入前执行;它们不能只靠静态快照 validator 表达。

### 4.1 C-6b 的两条 commit 路径

`payload-promote.mjs commit` 的输入保持 `{releaseId, expectedSha256}`。每次 CAS retry 都在当前 manifest 上重新判断:

1. `op.state=prepared`:op 必须存在、`kind=release`、sha 与 expected 相等;重新 `deriveVetoBinding`,要求 beta active,然后才构造 release entry、移动 pointer、提交 op。
2. `op.state=committed`:这是并发执行者先提交或冷启动重跑。只核 `releaseId` 存在、`kind=release`、`op.sha256===expectedSha256`;相等即幂等成功且零写入,不再要求 beta active。其余身份由 C-6/C-7 的不可变关系保证。
3. 其他状态、缺失、kind 或 sha 不匹配:fail closed。

静态 validator 不要求已经发布的 release 所依赖 beta 永远 active;beta 在 14 天后合法 expired 时,clean release 可以继续 active 28 天。仅做 veto window 结束前的一次预检不能替代服务端 C-6b barrier。

## 5. 双身份与 veto binding

| 类型 | 字段 | 派生前置 |
|---|---|---|
| `BetaCandidate` | `baseVersion,betaN,betaVersion,sourceCommit,betaPayloadSha256` | beta entry 存在、channel=beta、status=active、身份完整 |
| `ReleaseArtifact` | `releaseId,releaseVersion,sourceCommit,releasePayloadSha256,objectKey` | release op 存在、kind=release、state=prepared、tuple 完整且 object key 派生一致 |
| `VetoBinding` | `releaseId,betaVersion,betaPayloadSha256,releaseVersion,releasePayloadSha256,sourceCommit` | join 上述两身份;base 与 sourceCommit 两侧逐字一致 |

三个派生函数失败都抛错,不返回降级结果。B4 的决策记录由 Bridge 账本保存,以 `releaseId` 为键并包含完整 `VetoBinding`;不写入 manifest。调用 commit 前,B4 必须对当前 manifest 重派生并与决策记录逐字比较,不一致即 hold;随后只把 `releasePayloadSha256` 传入 `--expected-sha256`。

## 6. PRD §7.3 发布不变量的机器落点

| §7.3 | 机器断言 | 主要证据 |
|---|---|---|
| 1 immutable key + 回读 hash | 已存在的 PUT 返回 409;readback 流式复验 | endpoint admin tests、pipeline |
| 2 manifest 唯一 commit point | `POST /admin/manifest {baseEtag}`;冲突 412;失败不发布 | endpoint admin tests |
| 3 releaseId 幂等 + 单飞 | C-7 op ledger;workflow concurrency group | lifecycle、pipeline、workflow S2 |
| 4 薄壳独立发布 | shell prepare/preflight 不读 `doc/VERSION`;payload channel 不借 npm dist-tag 表达 | consumers lint、preflight |
| 5 客户端版本目录 + 自更新单飞 | 保留 PR2 合同 | onboard-shell install;B5 负责单飞 |
| 6 clean semver 永不复用 | C-3 entry 只增且核心身份不可变,包括 expired entry | lifecycle 具名负例 |
| 7 staging 清理 | expire→tombstone CAS→物理 delete;每次重扫完整 tombstone 集 | payload-key-cleanup |

三套外部状态不能原子提交,因此 v1 只把 manifest CAS 定义为 payload 发布 commit point;对象上传发生在 commit 前,清理物理删除发生在 tombstone CAS 后。任何步骤失败都不得用另一个系统的“成功”推断 payload 已发布。

## 7. REQ-0 对照

授权源、触发器/守卫、代码来源是三个不同概念。merge 到 main 可以是代码来源或授权前置,但绝不是 payload release 的触发器。

| 动作 | 授权源 | 触发器与守卫 | 执行面 | 机器断言 | 违反 |
|---|---|---|---|---|---|
| merge main | PRD §2.2 仅引用 FLY-1063 Option B 的 ship 合同 | `issue_comment` 🆒 → cool-ship-gate | `ship-on-comment.yml` | ship 路径无 payload capability/vendor credential | 无 |
| 薄壳 npm publish | main 代码 + Environment `release` | `workflow_dispatch`,main-only,`confirm=ACTIVATE`,`mode=publish` | `payload-activation.yml` | npm/OIDC credential 只在 release environment | 无 |
| beta publish | main 代码;无人门 | `schedule` 每 6h + `workflow_dispatch`;main-only;pre-activation guard | `payload-beta-release.yml` | 只持 beta-publish,不能切 customer pointer | 无 |
| promote prepare | 无人工门 | `workflow_dispatch` + main-only | `payload-promote.yml` | 只准备 op,不切 customer pointer | 无 |
| promote commit | B4 veto window 沉默或 founder 显式 go;不使用 🆒/merge/ship 账本 | B1 尚未实现 | B1 | 仅 `{releaseId,expectedSha256}`、零构建、C-6b;B1 必须显式重谈 S4b | 无,当前无 workflow |
| withdraw / paused | customer-release capability holder | B5 | B5 | 同一 CAS 摘 pointer 并 re-pin fallback 或进入 paused | 无 |

workflow 结构测试 S13 把真实 trigger set 锁为 beta=`{schedule,workflow_dispatch}`,promote=`{workflow_dispatch}`,activation=`{workflow_dispatch}` 且保留 `confirm`;三者都没有 `push` 或 `pull_request`,所以 release 不是 merge 副作用。

## 8. 客户视图 wire

成功的 `GET /manifest` v1 body 由 `schema/manifest-view.schema.json` 锁定:

```json
{"latest":"1.55.0","versions":[{"ver":"1.55.0","sha256":"9544ebb90c27a285f59a03f3af5fe8bfeb04cea01b3f3ac6673542f29f43d541"}]}
```

对象只允许 `latest`、`versions`;version item 只允许 `ver`、`sha256`;排序沿用字符串升序。

- channel 从未有 entry 且 pointer=null:`GET /manifest` → HTTP 503,body 逐字 `{"error":"not activated"}`。
- channel 有历史 entry、没有 active entry 且 pointer=null(`paused`):HTTP 503,body 逐字 `{"error":"no-release-available"}`。
- paused entitlement 禁止签发新 license key。

v1 的 200 body 不含 wire version 字段。不能通过底层 manifest `schemaVersion` 在原路由直接加字段;需要新字段时必须新增显式版本化协议,例如 `/v2/manifest`,并保留 v1。

## 9. 消费方式、迁移与边界

- JavaScript:从 `flywheel-release-contract` 导入;仓库根脚本可从本包 `src/index.mjs` 导入。
- TypeScript:以 `index.d.ts` 的 `Manifest`、discriminated `ReleaseOp`、identity 类型和函数签名为准。
- 外部 shape 验证:使用 `schema/manifest.schema.json`;customer view 使用 `schema/manifest-view.schema.json`。
- 运行时完整验证:调用 `validateManifest`;不能只跑 JSON Schema,因为 C-1…C-9 含跨字段关系。
- 新建 manifest:只用 `emptyManifest()`;`isEmptyInitialManifest` 只表示 conditional-create 的全空形状,不能用来判断单个 channel 的 paused/never-activated。

数据迁移为无:`schemaVersion` 仍为 1、manifest 字段不变。语义变化只有 C-1b 放宽与 C-6b 对新 release commit 收紧。激活 B1 前,必须用本包对生产 manifest 快照运行 schema + `validateManifest`。

本合同不新增 promote-commit workflow,不改变 S4b,不改变 broker/FLY-1323 凭据姿态,不实现 npm prerelease dist-tag、B4 决策账本、B5 客户话术或 `/v2/manifest`,也不执行任何真实发布、R2 或 npm 动作。
