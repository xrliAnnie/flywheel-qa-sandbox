# Research: Supabase Storage REST API — GEO-294

**Issue**: GEO-294
**Date**: 2026-03-30
**Source**: `doc/engineer/exploration/new/GEO-294-triage-html-report.md`

## 结论

Supabase Storage REST API 非常简单，用 plain `fetch` 即可完成上传，**不需要** `@supabase/supabase-js` SDK。

## API 规格

### Upload (Upsert)

```
POST https://{PROJECT_REF}.supabase.co/storage/v1/object/{BUCKET}/{FILE_PATH}
Headers:
  apikey: {SERVICE_ROLE_KEY}
  Authorization: Bearer {SERVICE_ROLE_KEY}
  Content-Type: text/html; charset=utf-8
  x-upsert: true
  Cache-Control: max-age=3600
Body: <raw HTML content>
```

- `x-upsert: true` — 覆盖已存在文件（否则返回 400 "Asset Already Exists"）
- 同一个 key 同时放 `apikey` 和 `Authorization` header

### Public URL

```
https://{PROJECT_REF}.supabase.co/storage/v1/object/public/{BUCKET}/{FILE_PATH}
```

确定性 URL，无需 API 调用即可构建。Public bucket 无需 auth 即可访问。

### Create Bucket (一次性)

```bash
curl -X POST 'https://{REF}.supabase.co/storage/v1/bucket' \
  -H "apikey: {KEY}" -H "Authorization: Bearer {KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name":"triage-reports","public":true,"fileSizeLimit":"10485760"}'
```

也可通过 Supabase Dashboard 创建。

## Limits

| 限制 | Free Plan |
|------|-----------|
| 单文件最大 | 50 MB |
| 存储总量 | 1 GB |
| 带宽 | 2 GB/month |

HTML 报告 <100KB，完全足够。

## 现有集成

项目已使用 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`（CIPHER sync）和 `SUPABASE_KEY`（Memory service）。Storage 上传可复用 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`。

## TypeScript 实现

```typescript
async function uploadToSupabaseStorage(
  supabaseUrl: string,
  serviceRoleKey: string,
  bucket: string,
  path: string,
  content: string,
  contentType = "text/html; charset=utf-8",
): Promise<string> {
  // Extract project ref from URL
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": contentType,
      "x-upsert": "true",
      "Cache-Control": "max-age=3600",
    },
    body: content,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase Storage upload failed (${res.status}): ${err}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}
```

## 注意事项

1. CDN 传播延迟 — 覆盖 `latest.html` 后，边缘缓存可能延迟几分钟
2. `Cache-Control: max-age=3600` 可调，或用 `no-cache` 确保实时性
3. Bucket 创建是一次性操作，可手动在 Dashboard 完成
4. 无需 RLS policy — service_role_key 绕过 RLS
