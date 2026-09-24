# FLY-2803 订阅确认录入 — 操作说明
Issue: FLY-2803 (https://linear.app/geoforge3d/issue/FLY-2803/额度页页面-页面一张单改完spec-e1-e19呈现改版分组排序在用号染绿进度条时间格式-订阅到期显示与手填记确认人时间-e19)
日期: 2026-09-23
基于: plan.md

## 边界

这份输入只影响额度页的「订阅到期」显示，不取消订阅、不切号、不写账号池、不设置 `retiresAt`。只有 Lead 收到 founder 的明确确认后才录入；本单不预填任何账号、日期或确认人。

## 取得当前身份键

先构建 `flywheel-teamlead`，再运行：

```sh
node packages/teamlead/dist/bridge/account-subscription-manual-cli.js identities
```

输出只含 provider、profile、是否有可信身份和非秘密 `identityKey`。若目标行 `hasIdentity=false`，停止录入；按独立授权补齐可信身份后重新运行，不能从用量或显示名猜身份。

## 输入与安装

在临时路径创建仅当前用户可读写的 JSON；不要把真实确认记录提交进 git。空 schema：

```json
{
  "version": 1,
  "confirmations": []
}
```

每条确认必须完整填写：

```json
{
  "provider": "Claude",
  "profile": "profile-name",
  "identityKey": "64位小写hex",
  "status": "active | canceled | unknown",
  "expiresOn": null,
  "confirmedBy": "确认人",
  "confirmedAt": "规范UTC ISO时间",
  "sourceRef": "可追溯的founder消息或issue引用"
}
```

只有 `canceled` 可把 `expiresOn` 写成 `YYYY-MM-DD`；日期尚未确认时仍写 `null`。`unknown` 是撤回旧判断的追加记录，不删除历史。

```sh
chmod 600 /tmp/subscriptions.json
node packages/teamlead/dist/bridge/account-subscription-manual-cli.js validate --input /tmp/subscriptions.json
node packages/teamlead/dist/bridge/account-subscription-manual-cli.js install --input /tmp/subscriptions.json
```

`validate` 不写目标文件。`install` 会重新校验时间、身份和 schema，在独立锁下 append-only 合并，再以 0600 原子写入 `<FLYWHEEL_STATE_DIR or ~/.flywheel>/account-subscriptions/manual.json`。失败只输出 safe error code；修正输入后重试，不清理未知 lock owner。

## 错误与回滚

- `identity_missing` / `identity_mismatch`：重新取得当前身份键；不要复用同名旧账号记录。
- `future_confirmation`：确认 `confirmedAt` 使用已经发生的 UTC 时刻。
- `invalid_schema` / `duplicate_confirmation`：逐字段修正；同一 provider/profile/identity/time 不得出现不同内容。
- `capacity_exceeded`：停止追加并交 Lead 决定历史归档；不得覆盖旧文件。
- `unsafe_file` / `path_escape`：确认输入是 0600 普通文件且非 symlink。

页面代码回滚时保留 `manual.json`，旧版本不会读取它；重新上线后可继续使用。若确需撤回某条结论，安装一条时间更新的 `unknown`，不要删除或手改已安装历史。
