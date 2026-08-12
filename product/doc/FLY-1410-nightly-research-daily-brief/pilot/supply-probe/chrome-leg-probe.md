# 真 Chrome 那一截的补验脚本 — 照着跑,不用改

判据(Honey Lemon 原话,一个字不改):含中文 + emoji + 弯引号的载荷,
**页面内用 `TextEncoder` 算真值长度与校验和**(真值必须在页面里生成,不能事后回推),
落盘后比 **长度 + 校验和 + 严格 `TextDecoder(fatal)` 解码**,**三项全过**。

> ⚠️ 一句更正:我此前报告里说「脚本已经写好」——**那句超前了**,我想清楚了但没落盘。
> 这个文件就是把它补上。

---

## 第 0 步(宿主)· 先放哨兵,证明后面读到的是浏览器新写的、不是剪贴板残留

```bash
printf 'SENTINEL-%s' "$(date +%s)" | pbcopy
LC_CTYPE=UTF-8 pbpaste     # 应当打印哨兵。若最后读到的仍是它 ⇒ 浏览器根本没写成功
```

**没有这一步,一个「读到了正确内容」的结果可能只是上一次的残留。**

---

## 第 1 步(页面)· 造载荷 + 在页面内算真值 + 注入按钮

任意 http 页面都行(本地起一个即可:`python3 -m http.server 8791`)。
`javascript_tool` 里整段贴进去:

```js
// 载荷刻意做成真早报的形态:中文为主 + emoji + 弯引号
const items = [];
for (let i = 1; i <= 100; i++) {
  items.push({
    id: "100000" + i,
    au: "@作者_" + i,
    text: "第" + i + "条:把「同时开一队编码 agent、每个跑在自己的 git worktree 里」做成了带手机端的桌面产品 —— 作者原话是 anthropic’s rule is simple。🔴✅ 樱白 · 方向 E · 十条一屏。",
    check: "⚪ 只扫了,没核"
  });
}
window.__payload = JSON.stringify({ probe: "FLY-1410 chrome-leg", count: items.length, items });

// 🔴 真值在页面内生成 —— 这是判据的核心,不能在落盘后回推
// 校验和用 SHA-256,不用手写哈希:手写 FNV 若写成 h * 0x01000193 会超过 2^53、
// 浮点丢精度,JS 端算错而宿主端算对 —— 会把一次【成功】误判成失败。(实战踩过)
const bytes = new TextEncoder().encode(window.__payload);
const digest = await crypto.subtle.digest("SHA-256", bytes);
// 🔴 回传【前 12 字节的十进制、连字符连接】,不要回传 64 位 hex 长串 ——
// 那种形状会被当成 base64/密钥拦掉,你收到的失败会跟编码毫无关系,极易误判。
// 12 字节 = 96 位,足够。
const sha12 = [...new Uint8Array(digest)].slice(0, 12).join("-");
window.__truth = { len: bytes.length, sha12 };

const old = document.getElementById("__fw_btn"); if (old) old.remove();
const btn = document.createElement("button");
btn.id = "__fw_btn";
btn.textContent = "COPY";
btn.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;width:260px;height:90px;font:700 28px/90px system-ui;background:#0a0;color:#fff;border:0;cursor:pointer";
btn.addEventListener("click", function () {
  navigator.clipboard.writeText(window.__payload).then(
    function () { btn.textContent = "OK " + window.__truth.len; btn.style.background = "#060"; },
    function (e) { btn.textContent = "FAIL " + e.name; btn.style.background = "#a00"; });
});
document.body.appendChild(btn);

JSON.stringify(window.__truth)   // ← 只回传 {len, sha12} 两个小值,载荷不经过对话通道
```

把回传的 `len` 和 `sha12` 记下来,那就是**真值**。

## 第 2 步 · 真点一下那个按钮

必须是**真点击**(`computer` 的 left_click)。用 JS 调 `click()` 不构成用户手势,
剪贴板 API 必拒 —— 这点已经踩过一次,按钮会显示 `FAIL NotAllowedError`。

按钮左上角固定在 (0,0)、260×90,点中心附近即可。
**坐标取自截图像素,不是 `getBoundingClientRect` 的 CSS 像素** —— 这点也踩过一次。

成功时按钮变成 `OK <len>`。

## 第 3 步(宿主)· 落盘 + 三项判据 + 对照组

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-1410/product/doc/FLY-1410-nightly-research-daily-brief/pilot/supply-probe

LC_CTYPE=UTF-8 pbpaste > chrome-leg-fixed.json     # 修法
pbpaste                > chrome-leg-default.json   # 对照组:不加 LC_CTYPE,应当失败

TRUTH_LEN=<第1步回传的 len>
TRUTH_SHA=<第1步回传的 sha12,形如 81-159-114-106-…>

node -e '
const fs=require("fs");
const wantLen=Number(process.argv[1]), wantSha=process.argv[2];
for (const f of ["chrome-leg-fixed.json","chrome-leg-default.json"]) {
  const b=fs.readFileSync(f);
  let strict=true; try{ new TextDecoder("utf-8",{fatal:true}).decode(b) }catch(e){ strict=false }
  const sha=[...require("crypto").createHash("sha256").update(b).digest()].slice(0,12).join("-");
  let items="-"; try{ items=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(b)).items.length }catch(e){ items="解析失败" }
  const pass = strict && b.length===wantLen && sha===wantSha;
  console.log(f);
  console.log("  长度 "+b.length+" / 真值 "+wantLen+"  "+(b.length===wantLen?"✅":"❌"));
  console.log("  SHA-256 前12字节 "+sha+"\n           真值 "+wantSha+"  "+(sha===wantSha?"✅":"❌"));
  console.log("  严格 UTF-8 "+(strict?"✅":"❌")+"  · JSON "+items);
  console.log("  三项全过: "+(pass?"✅ 通过":"❌ 不通过"));
}
' "$TRUTH_LEN" "$TRUTH_SHA"
```

---

## 判读

- **`chrome-leg-fixed.json` 三项全过** ⇒ **A 成立**:真 Chrome 写入 + `LC_CTYPE=UTF-8 pbpaste` 取回,
  中文和 emoji 逐字节无损。
- **`chrome-leg-default.json` 应当失败**(预期:字节数远小于真值、严格解码不过、JSON 解析失败)。
  **这个对照组不是可选项** —— 它证明这台机器上缺陷确实存在、修法确实是那个修法,
  而不是「反正都能过」。

## 已知会出错的两处(都是我踩过的,写在这里免得重踩)

1. **用 JS 调 `click()`** → `FAIL NotAllowedError`,不是页面坏了,是探针不构成用户手势。
2. **用 `getBoundingClientRect` 的坐标去点** → 点空,而且**点空和功能坏了长得一模一样**,
   都是「点了没反应」。坐标要取自截图。
