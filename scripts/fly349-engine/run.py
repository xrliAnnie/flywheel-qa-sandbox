#!/usr/bin/env python3
"""FLY-349 v2 deep-scan engine — live I/O wiring + entrypoint.

Implements the orchestrator's injected IO protocol with the spike-proven pieces:
  - enumerate/fetch  : RedNote MCP over raw HTTP JSON-RPC (fresh session per note — the
                       MCP single-browser is flaky under rapid same-session calls)
  - download         : yt-dlp (video) + curl (images), credential-hygienic cookie file
  - analyze          : paid Gemini File API (gemini-2.5-pro) DEFAULT — pure inference, safe on
                       untrusted content (no tool execution → injection can't escalate; commit
                       review HIGH-2). `agy` (Antigravity Pro, gemini-3.1-pro) is OPT-IN only
                       (FLY349_USE_AGY=1) AND sandboxed (--sandbox); notifies the Lead on use.
                       Annie's cost-vs-security decision (paid-default vs free-Pro-sandbox) pending.
  - create/attach    : Linear GraphQL (LINEAR_API_KEY) — issue (Backlog, Flywheel label,
                       provenance) + retention comment (caption + deep-read + image URLs)
  - build_report     : self-contained per-batch review HTML (default-agree semantics)

Run ONE batch then pause:  python3 run.py --batch-size 10
Resumable: re-invoking continues the unfinished batch from the checkpoint.
Conservative + 宁慢勿崩: load gate bends concurrency; this runner processes notes serially
within a batch (the bounded-parallel consumer pool is a follow-up; serial is the safe v1).
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time, urllib.request, urllib.error, html, argparse, shutil, tempfile

import checkpoint as C
import load_gate as LG
import orchestrator as O

# ---- config / env -----------------------------------------------------------
COLLECTION = "claude"
COLLECTION_ID = "6884765b0000000023036a58"
MCP = "http://127.0.0.1:18060/mcp"
LINEAR_API = "https://api.linear.app/graphql"
STATE_DIR = os.path.expanduser("~/.flywheel/state/fly349-engine")
WORK_DIR = os.path.expanduser("~/.flywheel/state/fly349-engine/work")
REPORT_DIR = os.path.expanduser("~/fly349-batches")
COOKIE_JSON = os.path.expanduser("~/.config/xiaohongshu-mcp/cookies.json")
FLY_TEAM_KEY = "FLY"
FLYWHEEL_PROJECT = "Flywheel"
FLYWHEEL_LABEL = "Flywheel"
COMM_CLI = os.environ.get("FLYWHEEL_COMM_CLI", os.path.expanduser("~/Dev/flywheel/packages/flywheel-comm/dist/index.js"))
EXEC_ID = os.environ.get("FLYWHEEL_EXEC_ID", "ee5dfc82-8c7d-4d58-af54-7d83a208f4f2")
LEAD = "flywheel-eng-lead"


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---- input validation (untrusted external content: noteId/token/URLs from MCP) ----
import urllib.parse as _urlparse
_NOTEID = re.compile(r"^[0-9a-f]{24}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_=-]{1,256}$")


def _valid_noteid(s: str) -> bool:
    return bool(isinstance(s, str) and _NOTEID.match(s))


def _valid_token(s: str) -> bool:
    # tokens may contain '-' internally but must not be interpretable as a CLI flag
    return bool(isinstance(s, str) and _TOKEN.match(s) and not s.startswith("-"))


def _valid_http_url(u: str) -> bool:
    if not isinstance(u, str) or u.startswith("-"):
        return False
    p = _urlparse.urlparse(u)
    return p.scheme in ("http", "https") and bool(p.netloc)


# F0 (QA FLY-372): a real deep-read MUST be the structured format. agy intermittently returns
# agentic chatter (e.g. "waiting for the file search command to locate img0.png") on multi-image
# notes — that must NOT pass as analysis. Require the USEFUL: + SUMMARY: skeleton.
_AGENTIC_CHATTER = ("waiting for", "file search", "locate img", "i will ", "let me ", "running command", "i'll ")
# codex R(qafix)-2: a model can also emit a long agentic PREAMBLE and *then* a skeleton whose
# SUMMARY admits it never actually read the media. Reject those failure-admission summaries so
# they can't become a shallow/ungrounded issue.
_FAILURE_SUMMARY = ("cannot access", "can't access", "unable to access", "could not access",
                    "无法访问", "无法读取", "无法查看", "尚未", "分析失败")


def _valid_analysis(text: str) -> bool:
    """True only for a structured, grounded deep-read. codex R(qafix): anchor the skeleton at the
    START (a long agentic preamble before USEFUL:/SUMMARY: is NOT a valid read) and reject
    failure-admission summaries."""
    if not text:
        return False
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if not lines:
        return False
    # structure must be anchored: the first non-empty line is the USEFUL verdict (not buried
    # after agentic preamble).
    if not re.match(r"^USEFUL:\s*(yes|no)\b", lines[0], re.I):
        return False
    m = re.search(r"^SUMMARY:\s*(.+)$", text, re.M | re.I)
    if not m:
        return False
    summary = m.group(1).strip().lower()
    if not summary or any(f in summary for f in _FAILURE_SUMMARY):
        return False
    # cheap extra guard: no agentic chatter in the head region
    return not any(c in text.strip()[:120].lower() for c in _AGENTIC_CHATTER)


def _open0600(path, flags):
    """open() opener that creates files mode 0600 from the start (no permissive-umask window)
    for artifacts holding a credential-like xsec_token."""
    return os.open(path, flags, 0o600)


def _gemini_key() -> str:
    for k in ("GEMINI_API_KEY", "GEMINI_IMAGE_API_KEY", "NANOBANANA_GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(k):
            return os.environ[k]
    # fall back to ~/.zshrc export
    try:
        out = subprocess.run(["bash", "-lc", "grep -hE '^[[:space:]]*export[[:space:]]+(GEMINI_API_KEY|GEMINI_IMAGE_API_KEY|NANOBANANA_GEMINI_API_KEY|GOOGLE_API_KEY)=' ~/.zshrc | head -1 | sed -E 's/.*=//; s/^\"//; s/\"$//'"],
                             capture_output=True, text=True, timeout=10)
        return out.stdout.strip()
    except Exception:
        return ""


def notify_lead(msg: str) -> None:
    """Best-effort milestone/flag to the Lead via flywheel-comm (so a parked runner wakes)."""
    try:
        subprocess.run(["node", COMM_CLI, "ask", "--lead", LEAD, "--exec-id", EXEC_ID, msg],
                       capture_output=True, text=True, timeout=30)
    except Exception as e:
        print(f"[notify failed: {e}]", file=sys.stderr)


# ---- MCP raw-HTTP (fresh session per call) ----------------------------------
def _mcp_call(name: str, args: dict, timeout: int = 200) -> dict | None:
    """Fresh JSON-RPC session + one tools/call. Returns parsed content text JSON or None."""
    req = urllib.request.Request(MCP, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "fly349-engine", "version": "1"}}}).encode())
    with urllib.request.urlopen(req, timeout=60) as r:
        sid = r.headers.get("Mcp-Session-Id")
        r.read()
    if not sid:
        return None
    hdr = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Mcp-Session-Id": sid}
    urllib.request.urlopen(urllib.request.Request(MCP, method="POST", headers=hdr,
        data=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode()), timeout=30).read()
    body = urllib.request.urlopen(urllib.request.Request(MCP, method="POST", headers=hdr,
        data=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": args}}).encode()), timeout=timeout).read()
    d = json.loads(body)
    txt = d["result"]["content"][0]["text"]
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return {"_text": txt}


def _mcp_retry(name, args, attempts=3, timeout=200):
    for i in range(attempts):
        try:
            r = _mcp_call(name, args, timeout=timeout)
            if r is not None:
                return r
        except Exception as e:
            print(f"[mcp {name} attempt {i+1} err: {e}]", file=sys.stderr)
        time.sleep(25)
    return None


# auth/CAPTCHA wording that means "stop + escalate", not "retry as transient".
# NOTE: must NOT contain the bare word "登录" — it is a substring of the HEALTHY "已登录"
# (logged-in). Use only specific lost/captcha phrases.
_AUTH_LOST = ("未登录", "get_login_qrcode", "扫码登录", "登录二维码", "请扫码", "captcha", "验证码", "二维码", "qrcode")


def _is_auth_lost_text(text: str) -> bool:
    t = (text or "").lower()
    return any(k.lower() in t for k in _AUTH_LOST)


def _mcp_login_ok() -> bool:
    """True only on a confirmed healthy login. Positive signal '已登录' AND absence of the
    explicit '未登录' — does not rely on the broad lost-phrase classifier (which would false-
    positive on '已登录' if it ever contained a lost phrase)."""
    st = _mcp_retry("check_login_status", {}, attempts=2, timeout=90)
    if not st:
        return False
    blob = json.dumps(st, ensure_ascii=False)
    return ("已登录" in blob) and ("未登录" not in blob)


# ---- Linear GraphQL ---------------------------------------------------------
def _linear(query: str, variables: dict) -> dict:
    key = os.environ.get("LINEAR_API_KEY")
    if not key:
        raise RuntimeError("LINEAR_API_KEY not set")
    req = urllib.request.Request(LINEAR_API, method="POST",
        headers={"Content-Type": "application/json", "Authorization": key},
        data=json.dumps({"query": query, "variables": variables}).encode())
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    if "errors" in d:
        raise RuntimeError(f"Linear GraphQL: {d['errors']}")
    return d["data"]


_TEAM_LABEL_CACHE: dict = {}


def _ids():
    if _TEAM_LABEL_CACHE:
        return _TEAM_LABEL_CACHE
    d = _linear("query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id key states{nodes{id name type}} labels{nodes{id name}}}}}", {"k": FLY_TEAM_KEY})
    t = d["teams"]["nodes"][0]
    backlog = next(s["id"] for s in t["states"]["nodes"] if s["type"] == "backlog")
    label = next((l["id"] for l in t["labels"]["nodes"] if l["name"] == FLYWHEEL_LABEL), None)
    projs = _linear("query($n:String!){projects(filter:{name:{eq:$n}}){nodes{id name}}}", {"n": FLYWHEEL_PROJECT})["projects"]["nodes"]
    _TEAM_LABEL_CACHE.update({"teamId": t["id"], "backlog": backlog, "label": label, "project": projs[0]["id"] if projs else None})
    return _TEAM_LABEL_CACHE


# ---- interactive review page (Annie's LOCKED template) ----------------------
# Single source of truth: build_report() below renders with this. Apple light theme
# (~/.claude/rules/html-report-style.md), full document (DOCTYPE+html+head+body so
# publish-report doesn't 400), per-card 建/候选/不建 toggle + comment + a「复制我的决定」
# button → copyable JSON. The <script> is a STATIC raw string with ZERO interpolation
# (reads everything from the DOM) — the deliberate fix for the prior f-string-newline bug.
_REVIEW_JS = r"""
function copyDecisions(){
  var cards = document.querySelectorAll('.card');
  var out = [];
  cards.forEach(function(c){
    var sel = c.querySelector('input[type=radio]:checked');
    out.push({
      issueId: c.getAttribute('data-issue') || null,
      noteId:  c.getAttribute('data-note'),
      title:   c.getAttribute('data-title') || '',
      "决定":   sel ? sel.value : '',
      comment: (c.querySelector('.cmt').value || '').trim()
    });
  });
  var payload = JSON.stringify({batch: document.body.getAttribute('data-batch'), decisions: out}, null, 2);
  var box = document.getElementById('out');   // a visible <textarea> — selectable on mobile
  var note = document.getElementById('flash');
  box.style.display = 'block';
  box.value = payload;
  // select the text so the user can long-press → Copy (mobile) AND so execCommand can run.
  box.focus();
  try { box.setSelectionRange(0, payload.length); } catch (e) {}
  try { box.select(); } catch (e) {}
  // 1) mobile-reliable: synchronous execCommand within the click gesture (navigator.clipboard
  //    is often blocked / silently empty on mobile Safari — this puts the real text on the clipboard).
  var execOk = false;
  try { execOk = document.execCommand('copy'); } catch (e) { execOk = false; }
  var manual = '已选中 ✓ 长按上面文本框选「拷贝」，再贴回 Discord 给 Tadashi';
  // 2) desktop/modern: async clipboard API (writes the same payload).
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(payload).then(
      function(){ note.textContent = '✓ 已复制到剪贴板 — 贴回 Discord 给 Tadashi'; },
      function(){ note.textContent = execOk ? '✓ 已复制 — 贴回 Discord 给 Tadashi' : manual; }
    );
  } else {
    note.textContent = execOk ? '✓ 已复制 — 贴回 Discord 给 Tadashi' : manual;
  }
}
document.addEventListener('change', function(e){
  if (e.target && e.target.type === 'radio') {
    var c = e.target.closest('.card');
    c.classList.remove('build','cand','skip');
    var v = e.target.value;
    c.classList.add(v === '建' ? 'build' : (v === '候选' ? 'cand' : 'skip'));
  }
});
// Wire the button via addEventListener (NOT inline onclick): under the hosted CSP
// `script-src 'nonce-…'`, inline event-handler attributes are blocked, but this nonce'd
// script runs and binds the handler.
var __copyBtn = document.getElementById('copyBtn');
if (__copyBtn) __copyBtn.addEventListener('click', copyDecisions);
"""

_REVIEW_CSS = """
:root{--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--gray:#86868b;--navy:#1a365d}
*{box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f;max-width:960px;margin:0 auto;padding:16px;line-height:1.55}
h1{font-size:22px;margin:0 0 2px}
.sub{color:var(--gray);font-size:13px;margin:0 0 8px}
.bar{position:sticky;top:0;background:rgba(245,245,247,.95);backdrop-filter:saturate(180%) blur(8px);padding:12px 0;margin-bottom:8px;z-index:10;border-bottom:1px solid #e2e2e4}
.btn{background:var(--navy);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-size:15px;font-weight:600;cursor:pointer}
.btn:active{opacity:.85}
.flash{color:var(--green);font-size:13px;margin-left:10px;font-weight:600}
#out{display:none;width:100%;white-space:pre;font-family:'SF Mono',ui-monospace,monospace;font-size:12px;background:#fff;color:#1d1d1f;border:1px solid #e2e2e4;border-radius:10px;padding:12px;margin-top:10px;resize:vertical;-webkit-user-select:all;user-select:all}
.card{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--gray)}
.card.build{border-left-color:var(--green)}
.card.cand{border-left-color:var(--amber)}
.card.skip{border-left-color:var(--gray)}
.card.fail{border-left-color:var(--red)}
.meta{font-size:12px;color:var(--gray);margin-bottom:3px}
.title{font-size:16px;font-weight:600;margin:2px 0 8px}
.title a{color:var(--navy);text-decoration:none}.title a:hover{text-decoration:underline}
.links{font-size:13px;margin:4px 0 8px}
.links a{color:var(--blue);text-decoration:none;margin-right:14px}.links a:hover{text-decoration:underline}
.issue{font-weight:600;color:var(--navy)}
.id{font-family:'SF Mono',ui-monospace,monospace;font-size:12px}
.fp{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-left:6px}
.fp.build{background:#e7f7ec;color:#1a7f37}.fp.cand{background:#fff4e0;color:#b06f00}.fp.skip{background:#eef0f2;color:#5b6168}.fp.fail{background:#fdecec;color:#c0362c}
.sec{margin:9px 0;font-size:14px}
.sec b{display:block;color:var(--navy);font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.sec pre{white-space:pre-wrap;font-family:inherit;margin:2px 0;background:#fafafa;padding:8px;border-radius:6px}
.sec p{margin:3px 0}
.sec ul{margin:4px 0;padding-left:20px}
.sec li{margin:2px 0}
.sec strong{font-weight:600;color:#1d1d1f}
.sec em{font-style:italic}
.sec code{font-family:'SF Mono',ui-monospace,monospace;font-size:12px;background:#f0f0f2;padding:1px 5px;border-radius:4px}
.ctrl{margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f2}
.ctrl-l{font-size:12px;color:var(--gray);margin-bottom:6px}
.seg{display:inline-flex;border:1px solid #d0d0d2;border-radius:9px;overflow:hidden;margin-bottom:8px}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg label{padding:7px 18px;font-size:14px;cursor:pointer;background:#fff;border-right:1px solid #d0d0d2;user-select:none}
.seg label:last-of-type{border-right:0}
.seg input:checked+label{background:var(--navy);color:#fff}
.cmt{display:block;width:100%;min-height:46px;margin-top:4px;border:1px solid #d8d8da;border-radius:8px;padding:8px;font-family:inherit;font-size:14px;resize:vertical}
"""


# ---- markdown → HTML (review-page card bodies) ------------------------------
# The card bodies are AI analysis of UNTRUSTED third-party XHS content. Render a
# SMALL markdown subset so Annie sees clean HTML (not literal */**/- markers), but
# html.escape ALL of it FIRST so the untrusted text can never inject markup — only
# the safe tags added below ever reach the page (escape-first ⇒ XSS-safe).
_MD_CODE_RE = re.compile(r"`([^`]+)`")
_MD_BOLD_RE = re.compile(r"\*\*([^*]+?)\*\*")
_MD_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)")


def _inline_md(s):
    """Inline markdown on ALREADY-html.escape'd text: `code`, **bold**, *italic*.
    The markers (`, *) aren't HTML-special so they survive escaping; only safe tags
    are added here."""
    s = _MD_CODE_RE.sub(r"<code>\1</code>", s)
    s = _MD_BOLD_RE.sub(r"<strong>\1</strong>", s)
    s = _MD_ITALIC_RE.sub(r"<em>\1</em>", s)
    return s


def _md_to_html(text):
    """Render a safe markdown subset (paragraphs, '-'/'*' bullets, **bold**, *italic*,
    `code`) to HTML for the review-page card bodies. UNTRUSTED input → html.escape
    everything FIRST, then layer on only safe formatting tags. '' for empty input.
    Fixes the raw-markdown leak (literal */**/- shown to the founder)."""
    text = (text or "").strip()
    if not text:
        return ""
    esc = html.escape(text)
    out = []
    para = []
    bullets = []

    def flush_para():
        if para:
            out.append("<p>" + "<br>".join(_inline_md(x) for x in para) + "</p>")
            para.clear()

    def flush_bullets():
        if bullets:
            out.append("<ul>" + "".join(f"<li>{_inline_md(x)}</li>" for x in bullets) + "</ul>")
            bullets.clear()

    for raw in esc.split("\n"):
        line = raw.strip()
        if not line:
            flush_para()
            flush_bullets()
        elif line[:2] in ("- ", "* "):
            flush_para()
            bullets.append(line[2:].strip())
        else:
            flush_bullets()
            para.append(line)
    flush_para()
    flush_bullets()
    return "".join(out)


def _seg(nid, default):
    """3-way 建/候选/不建 toggle; default radio = the engine's first-pass decision.
    nid is escaped for the id/name/for attributes (defense-in-depth — codex non-blocking note;
    real XHS note ids are 24-hex so this is a no-op on live data)."""
    safe = html.escape(nid)
    parts = []
    for val, pfx in (("建", "b"), ("候选", "c"), ("不建", "s")):
        rid = f"{pfx}-{safe}"
        chk = " checked" if val == default else ""
        parts.append(f'<input type="radio" id="{rid}" name="d-{safe}" value="{val}"{chk}>'
                     f'<label for="{rid}">{val}</label>')
    return f'<div class="seg">{"".join(parts)}</div>'


def _render_review_page(notes, batch_no, url_key):
    """PURE renderer (Annie's locked format). notes = list of dicts: noteId, issueId, issueTitle,
    author, title, sourceUrl, type, summary, keypoints, honest, vclass, vlabel, default.
    Returns a COMPLETE self-contained HTML document."""
    esc = html.escape
    cards = []
    for n in notes:
        nid = n["noteId"]
        iid = n.get("issueId")
        src = n.get("sourceUrl") or (f"https://www.xiaohongshu.com/explore/{nid}" if nid else "")
        title = esc(n.get("title") or "(无标题)")
        links = []
        if src:
            links.append(f'<a href="{esc(src)}" target="_blank" rel="noopener">↗ 原帖</a>')
        # Annie: show the CREATED issue's title (FLY-xxx: <title>) — only for created issues.
        if iid:
            it = n.get("issueTitle") or ""
            lbl = f'{esc(iid)}: {esc(it)}' if it else esc(iid)
            if url_key and not str(iid).startswith("DRY-"):
                links.append(f'<a class="issue" href="https://linear.app/{esc(url_key)}/issue/{esc(iid)}" target="_blank" rel="noopener">📋 {lbl}</a>')
            else:
                links.append(f'<span class="issue id">📋 {lbl}</span>')
        sec = ""
        if n.get("summary"):
            sec += f'<div class="sec"><b>提炼</b>{_md_to_html(n["summary"])}</div>'
        if n.get("keypoints"):
            sec += f'<div class="sec"><b>对 Flywheel 可执行点</b>{_md_to_html(n["keypoints"])}</div>'
        if n.get("honest"):
            sec += f'<div class="sec"><b>诚实标注（展示 vs 推断）</b>{_md_to_html(n["honest"])}</div>'
        if not sec:
            sec = '<div class="sec"><b>分析</b>(无分析 — 该条降级/未完成)</div>'
        cards.append(
            f'<div class="card {n["vclass"]}" data-note="{esc(nid)}" '
            f'data-issue="{esc(iid) if iid else ""}" data-title="{title}">'
            f'<div class="meta">{esc(n.get("type","?"))} · 作者 {esc(n.get("author",""))}'
            f'<span class="fp {n["vclass"]}">系统判断: {esc(n["vlabel"])}</span></div>'
            f'<div class="title">{title}</div>'
            f'<div class="links">{" ".join(links)}</div>'
            f'{sec}'
            f'<div class="ctrl"><div class="ctrl-l">我的决定（默认=系统判断，改你不同意的）:</div>'
            f'{_seg(nid, n["default"])}'
            f'<textarea class="cmt" placeholder="备注 / 不同意的原因（可选）"></textarea></div>'
            f'</div>')
    return (
        '<!DOCTYPE html>\n<html lang="zh">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<title>小红书 deep-scan — batch {batch_no} review</title>\n'
        f'<style>{_REVIEW_CSS}</style>\n</head>\n'
        f'<body data-batch="{batch_no}">\n'
        f'<h1>小红书 deep-scan — batch {batch_no}</h1>\n'
        '<p class="sub">默认同意系统判断；改你<b>不同意</b>的那几条，写上备注，点「复制我的决定」→ 贴回 Discord 给 Tadashi。</p>\n'
        '<div class="bar"><button class="btn" id="copyBtn">📋 复制我的决定</button>'
        '<span class="flash" id="flash"></span>'
        '<textarea id="out" rows="8" spellcheck="false" readonly></textarea></div>\n'
        f'{"".join(cards)}\n'
        # nonce placeholder: publish-report's injectHeadMeta swaps __CSP_NONCE__ for a real
        # nonce + relaxes the hosted CSP to script-src 'nonce-…' so this script runs. Locally
        # (file://, no CSP) the literal placeholder is a harmless unused attribute.
        f'<script nonce="__CSP_NONCE__">{_REVIEW_JS}</script>\n</body>\n</html>\n')


# ---- the IO implementation --------------------------------------------------
class EngineIO:
    class LoginLost(Exception):
        pass

    def __init__(self, state_path: str, dry_run: bool = False):
        self.state_path = state_path
        self.dry_run = dry_run     # QA controlled smoke: real reads, NO Linear writes
        self._fallback_notified = set()
        self._existing = []        # cached Linear FLY issues (for crash-window dedupe)
        self._covered = set()      # noteIds already covered by an issue
        os.makedirs(WORK_DIR, exist_ok=True)
        os.makedirs(REPORT_DIR, exist_ok=True)

    def _find_identifier_for_note(self, note_id):
        import dedupe as _D
        for iss in self._existing:
            blob = (iss.get("title") or "") + "\n" + (iss.get("description") or "")
            if note_id in _D.extract_note_ids(blob):
                return iss.get("identifier")
        return None

    # -- enumeration / dedupe --
    def enumerate_notes(self):
        r = _mcp_retry("get_collection_content", {"collection_id": COLLECTION_ID, "limit": 126}, attempts=3, timeout=260)
        notes = (r or {}).get("notes") if r else None
        if notes:
            return [{"id": n["noteId"], "tok": n["xsecToken"], "type": n["type"], "title": n["displayTitle"]} for n in notes]
        # empty/None: do NOT treat as "no fresh notes" — confirm login first (finding #2/#6).
        if (r and _is_auth_lost_text(json.dumps(r, ensure_ascii=False))) or not _mcp_login_ok():
            raise self.LoginLost("enumeration returned empty + login not confirmed (logged-out/CAPTCHA?) — escalate")
        return []  # confirmed healthy login + genuinely empty collection

    def existing_issues(self):
        # XHS-origin issues live in the FLY team; pull title+description for noteId dedupe.
        # Cached on self so create_issue can reconcile across the crash-window (finding #1).
        out, cursor = [], None
        q = ("query($k:String!,$after:String){issues(first:100, after:$after, "
             "filter:{team:{key:{eq:$k}}}){pageInfo{hasNextPage endCursor} nodes{identifier title description}}}")
        for _ in range(12):
            page = _linear(q, {"k": FLY_TEAM_KEY, "after": cursor})["issues"]
            out.extend(page["nodes"])
            if not page["pageInfo"]["hasNextPage"]:
                break
            cursor = page["pageInfo"]["endCursor"]
        import dedupe as _D
        self._existing = out
        self._covered = _D.covered_note_ids(out)
        return out

    def load1(self):
        # 宁慢勿崩 (finding #8): if load is unmeasurable, bias to PAUSE (return a value above the
        # absolute crash-guard) rather than crashing the runner or proceeding blind.
        try:
            return LG.parse_load1(subprocess.run(["uptime"], capture_output=True, text=True, timeout=10).stdout)
        except Exception as e:
            print(f"[load1 sample failed: {e} — biasing to pause]", file=sys.stderr)
            return 999.0

    def save(self, state):
        C.save_state(state, self.state_path)

    # -- per-note dir --
    def _ndir(self, nid):
        d = os.path.join(WORK_DIR, nid)
        os.makedirs(d, exist_ok=True)
        return d

    # -- producer: fetch detail (fresh session) --
    def fetch(self, meta):
        if not (_valid_noteid(meta["id"]) and _valid_token(meta["tok"])):
            raise RuntimeError(f"invalid noteId/token: {meta['id']!r}")
        r = _mcp_retry("get_feed_detail", {"feed_id": meta["id"], "xsec_token": meta["tok"]}, attempts=3, timeout=200)
        note = (r or {}).get("data", {}).get("note") if r else None
        if not note:
            # auth/CAPTCHA classification is FATAL (escalate); only genuine transient empty retries.
            if (r and _is_auth_lost_text(json.dumps(r, ensure_ascii=False))) or not _mcp_login_ok():
                raise self.LoginLost("MCP login lost / CAPTCHA (need RedNote QR re-login) — escalate")
            raise RuntimeError("get_feed_detail empty after retries (transient)")
        d = self._ndir(meta["id"])
        detail = {
            "noteId": meta["id"], "title": note.get("title", meta.get("title", "")),
            "type": note.get("type", meta.get("type")), "author": note.get("user", {}).get("nickname", ""),
            "desc": note.get("desc", ""),
            "comments": [c.get("content", "") for c in note.get("comments", {}).get("list", [])][:10],
            "imageUrls": [i.get("urlDefault", "") for i in note.get("imageList", [])],
            # Annie ③: an OPENABLE original-post link for the LOCAL review page only. This is the
            # same token-bearing URL the engine uses for download (known to open while fresh).
            # SECURITY: kept local (0600 detail.json + local review HTML) and NEVER written to
            # Linear — create_issue uses the redacted noteId-only URL (finding #4).
            "sourceUrl": f"https://www.xiaohongshu.com/explore/{meta['id']}?xsec_token={meta['tok']}&xsec_source=pc_feed",
        }
        dp = os.path.join(d, "detail.json")
        # holds a credential-like xsec_token → create owner-only (no permissive-umask window)
        with open(dp, "w", encoding="utf-8", opener=_open0600) as f:
            json.dump(detail, f, ensure_ascii=False, indent=2)

    def _detail(self, nid):
        with open(os.path.join(self._ndir(nid), "detail.json"), encoding="utf-8") as f:
            return json.load(f)

    # -- producer: download media (token-fresh; per-note, deleted after analyze) --
    def download(self, meta):
        # SECURITY: meta values come from the (untrusted) MCP/xiaohongshu response. Validate
        # before they touch a subprocess arg, and pass URLs after a `--` end-of-options guard.
        if not (_valid_noteid(meta["id"]) and _valid_token(meta["tok"])):
            raise RuntimeError(f"invalid noteId/token (refusing to shell out): {meta['id']!r}")
        d = self._ndir(meta["id"])
        det = self._detail(meta["id"])
        ck = os.path.join(d, "cookies.txt")
        self._cookie_file(ck)
        try:
            if det["type"] == "video":
                url = f'https://www.xiaohongshu.com/explore/{meta["id"]}?xsec_token={meta["tok"]}&xsec_source=pc_feed'
                for i in range(3):
                    subprocess.run(["yt-dlp", "--cookies", ck, "--no-warnings", "--socket-timeout", "30",
                                    "--retries", "2", "--max-filesize", "200M", "-f", "0/1/best",
                                    "-o", os.path.join(d, "video.mp4"), "--", url], capture_output=True, text=True, timeout=400)
                    if os.path.exists(os.path.join(d, "video.mp4")):
                        break
                    time.sleep(22)  # retry-after-idle (extractor flaky on first try)
            # images (cover/slides) — reference original; download a bounded few for vision
            for idx, iu in enumerate(det.get("imageUrls", [])[:6]):
                if not _valid_http_url(iu):
                    print(f"[skip non-http image url for {meta['id']}#{idx}]", file=sys.stderr)
                    continue
                subprocess.run(["curl", "-sS", "--max-time", "60", "-o", os.path.join(d, f"img{idx}.webp"), "--", iu],
                               capture_output=True, timeout=70)
                if os.path.exists(os.path.join(d, f"img{idx}.webp")):
                    subprocess.run(["sips", "-s", "format", "png", os.path.join(d, f"img{idx}.webp"),
                                    "--out", os.path.join(d, f"img{idx}.png")], capture_output=True, timeout=30)
        finally:
            if os.path.exists(ck):
                os.remove(ck)
        # finding #5: verify expected artifacts — a failed download must NOT pass as a full
        # multimodal read (→ misleading issue). Missing media → raise (transient → retry; after
        # the retry cap the note becomes terminal 'failed' and never gets an issue).
        missing = (det["type"] == "video" and not os.path.exists(os.path.join(d, "video.mp4"))) or \
                  (det.get("imageUrls") and not any(f.endswith(".png") for f in os.listdir(d)))
        if missing:
            # F2 (QA): a total download failure can be a stale cookie (MCP login died) → escalate
            # re-login rather than burning retries; only treat as transient when login is healthy.
            if not _mcp_login_ok():
                raise self.LoginLost(f"download failed for {meta['id']} + login not confirmed (stale cookie?) — re-login")
            raise RuntimeError(f"download produced no usable media for {meta['id']} (transient, retry)")

    def _cookie_file(self, path):
        os.umask(0o077)
        data = json.load(open(COOKIE_JSON, encoding="utf-8"))
        with open(path, "w", encoding="utf-8") as f:
            f.write("# Netscape HTTP Cookie File\n")
            for c in data:
                dom = c["domain"] if c["domain"].startswith(".") else "." + c["domain"]
                exp = 0 if (c.get("expires") in (None, -1)) else int(c["expires"])
                f.write("\t".join([dom, "TRUE", c.get("path", "/"), "TRUE" if c.get("secure") else "FALSE",
                                   str(exp), c["name"], str(c["value"])]) + "\n")
        os.chmod(path, 0o600)

    # -- consumer: deep multimodal read + extract (Gemini-primary DEFAULT; agy opt-in FLY349_USE_AGY=1) --
    def analyze(self, meta, gate):
        d = self._ndir(meta["id"])
        det = self._detail(meta["id"])
        prompt = self._prompt(det)
        media = []
        vid = os.path.join(d, "video.mp4")
        if os.path.exists(vid):
            media.append(vid)
        media += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".png")][:4]
        text = self._deep_read(d, media, prompt, meta)
        with open(os.path.join(d, "analysis.txt"), "w", encoding="utf-8") as f:
            f.write(text)
        # bounded temp: keep analysis.txt + detail.json, drop heavy media
        for f in os.listdir(d):
            if f.endswith((".mp4", ".webp", ".png")):
                os.remove(os.path.join(d, f))

    def _prompt(self, det):
        # F1 (Annie ①): feed caption (desc) + top comments into the prompt, not just title.
        cap = (det.get("desc") or "")[:600]
        cmts = " / ".join((det.get("comments") or [])[:5])[:400]
        ctx = (f"\n作者 caption: {cap}" if cap else "") + (f"\n热门评论: {cmts}" if cmts else "")
        return (f"严格基于真实内容（视频画面+语音+屏幕文字 / 图片 + 下面文字层）。小红书 AI 笔记《{det['title']}》。{ctx}\n"
                "为做 AI 多 Agent 编排/自动化开发产品(Flywheel)的团队提炼，输出严格用这个格式:\n"
                "USEFUL: yes 或 no（对 Flywheel 是否有可执行价值）\n"
                "SUMMARY: 这条具体做/讲了什么(1-3句实质)\n"
                "KEYPOINTS:\n- 可执行点1\n- 可执行点2\n"
                "HONEST: 哪些是内容明确展示 vs 推断\n简洁中文。")

    def _deep_read(self, d, media, prompt, meta):
        # Analysis backend (Annie's decision, relayed via Tadashi 2026-06-21): PROCESSING uses the
        # paid Gemini File API (gemini-2.5-pro) as the DEFAULT — it is stable and, being pure
        # inference, safe on untrusted content (no tool execution → injection can't escalate).
        # agy (free Antigravity Pro, gemini-3.1-pro) was the prior default (737653df) but is
        # unstable on multi-image notes (QA FLY-372 F0 = agentic chatter instead of a real read),
        # so it is now OPT-IN only (FLY349_USE_AGY=1), reserved for the parallel agy-research
        # issue and NOT used in processing. The #1 arg-injection validation is KEPT as zero-cost
        # defense either way.
        text = None
        if os.environ.get("FLY349_USE_AGY") == "1":
            # agy opt-in (research path): agy primary; Gemini File API is the F0 fallback on agy
            # auth/failure OR invalid/agentic output (with a one-time Lead notification per note).
            try:
                text = self._agy(d, media, prompt, meta)
            except Exception as e:
                print(f"[agy err {meta['id']}: {e}]", file=sys.stderr)
            if not _valid_analysis(text):
                if meta["id"] not in self._fallback_notified:
                    self._fallback_notified.add(meta["id"])
                    notify_lead(f"[FLY-349 引擎] agy 在 note {meta['id']} 返回无效/agentic 输出 → 切付费 Gemini API(~$0.05)。继续。")
                text = self._gemini_api(media, prompt)
        else:
            # Gemini-primary (DEFAULT, the processing path): agy is deferred to the research issue
            # and never invoked here — a Gemini failure/invalid output degrades the note (NO agy
            # fallback), so processing never depends on the unstable agy path.
            text = self._gemini_api(media, prompt)
        # F0 (QA FLY-372): a real deep-read MUST be the structured format. If the chosen backend
        # produced unstructured/agentic output → raise so the note degrades to 'failed' and NEVER
        # creates a fake/shallow issue (#5).
        if not _valid_analysis(text):
            raise RuntimeError(f"analysis unstructured for {meta['id']} — degrade (no fake issue)")
        return text

    def _agy(self, d, media, prompt, meta):
        # agy is the primary path per Annie's decision (free Pro, gemini-3.1-pro, no sandbox).
        env = dict(os.environ, PATH=os.path.expanduser("~/.local/bin") + ":" + os.environ.get("PATH", ""))
        at = " ".join(f"@{os.path.basename(m)}" for m in media)
        p = subprocess.run(["agy", "--model", "gemini-3.1-pro", "--dangerously-skip-permissions",
                            "-p", f"{at} {prompt}"], cwd=d, env=env, capture_output=True, text=True, timeout=420)
        out = p.stdout.strip()
        if out and "Authentication required" not in out and "Please sign in" not in (out + p.stderr):
            return out
        raise RuntimeError("agy empty/auth-required")

    def _gemini_api(self, media, prompt):
        # codex R(qafix)-1: a transport/config failure must RAISE (→ note degrades to retry/failed),
        # NOT return a valid-looking "USEFUL: no" sentinel that silently marks the note done-no-action.
        key = _gemini_key()
        if not key:
            raise RuntimeError("Gemini fallback unavailable: no API key configured")
        base = "https://generativelanguage.googleapis.com"
        parts = []
        for m in media:
            data = open(m, "rb").read()
            mime = "video/mp4" if m.endswith(".mp4") else "image/png"
            # SECURITY: pass the API key via the documented header, NOT the URL query string
            # (a key in the URL leaks into request logs/proxies/history).
            req = urllib.request.Request(f"{base}/upload/v1beta/files", method="POST",
                headers={"x-goog-api-key": key, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                         "X-Goog-Upload-Header-Content-Length": str(len(data)),
                         "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json"},
                data=json.dumps({"file": {"display_name": os.path.basename(m)}}).encode())
            up_url = urllib.request.urlopen(req, timeout=120).headers.get("X-Goog-Upload-URL")
            up = urllib.request.urlopen(urllib.request.Request(up_url, method="POST",
                headers={"X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": str(len(data))},
                data=data), timeout=300)
            f = json.loads(up.read())["file"]
            name, uri, state = f["name"], f["uri"], f.get("state", "PROCESSING")
            waited = 0
            while state == "PROCESSING" and waited < 180:
                time.sleep(3); waited += 3
                poll = urllib.request.Request(f"{base}/v1beta/{name}", headers={"x-goog-api-key": key})
                state = json.loads(urllib.request.urlopen(poll, timeout=60).read())["state"]
            parts.append({"file_data": {"mime_type": mime, "file_uri": uri}})
        parts.append({"text": prompt})
        gen = urllib.request.urlopen(urllib.request.Request(f"{base}/v1beta/models/gemini-2.5-pro:generateContent",
            method="POST", headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            data=json.dumps({"contents": [{"parts": parts}]}).encode()), timeout=300)
        out = json.loads(gen.read())
        cand = out.get("candidates", [{}])[0]
        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
        if not text.strip():
            raise RuntimeError("Gemini fallback returned no candidates/text")
        return text

    # -- aggregator: judge / create / attach / report --
    def _analysis(self, nid):
        p = os.path.join(self._ndir(nid), "analysis.txt")
        return open(p, encoding="utf-8").read() if os.path.exists(p) else ""

    def judge(self, meta):
        a = self._analysis(meta["id"])
        m = re.search(r"USEFUL:\s*(yes|no)", a, re.I)
        # F0: default FALSE if no explicit USEFUL (analyze guarantees structure; never create on
        # ambiguous/garbage output — that was the fake-issue bug QA caught).
        return bool(m) and m.group(1).lower() == "yes"

    def _kv(self, text, key):
        m = re.search(rf"{key}:\s*(.+?)(?=\n[A-Z]+:|\Z)", text, re.S)
        return (m.group(1).strip() if m else "")

    def create_issue(self, meta):
        # idempotency (finding #1): reconcile an already-created issue for this note before
        # creating a new one. self._covered/_existing are (re)populated by existing_issues()
        # at batch start each run, so a crash AFTER issueCreate but BEFORE checkpoint-save is
        # recovered on resume (the created issue is in the fresh scan → reconcile, no dup).
        if meta["id"] in self._covered:
            ident = self._find_identifier_for_note(meta["id"])
            if ident:
                print(f"[reconcile] {meta['id']} already has issue {ident} — no dup", file=sys.stderr)
                return ident
        if self.dry_run:
            print(f"[DRY-RUN] would create issue for {meta['id']} (no Linear write)", file=sys.stderr)
            return f"DRY-{meta['id'][:8]}"
        ids = _ids()
        det = self._detail(meta["id"])
        a = self._analysis(meta["id"])
        summary = self._kv(a, "SUMMARY") or det.get("desc", "")[:200]
        kps = self._kv(a, "KEYPOINTS")
        honest = self._kv(a, "HONEST")
        # finding #4: NO xsec_token in durable Linear text (credential). noteId-only source URL.
        src = f"https://www.xiaohongshu.com/explore/{meta['id']}"
        title = f"[XHS-deep] {det['title'][:80]}"
        # Annie ⑤: clearer issue body — explicit first-pass verdict + 诚实标注 + markdown 原帖链接.
        desc = (f"> **[XHS-AUTO-CREATED — FLY-349 v2 deep-scan engine · 待 review]**\n"
                f"> provenance: opId=`fly349:{meta['id']}:issue` · collection=`{COLLECTION}` · 作者 {det.get('author','')} · source={src} (xsec_token redacted)\n"
                f"> Backlog、不自动起 Runner。\n\n"
                f"## 判断（first-pass）\n**建单** — 对 Flywheel 有可执行价值。\n\n"
                f"## 提炼\n{summary}\n\n## 对 Flywheel 可执行点\n{kps}\n\n"
                + (f"## 诚实标注（内容展示 vs 推断）\n{honest}\n\n" if honest else "")
                + f"**来源**: 小红书《{det['title']}》({det['type']}) — [原帖]({src})，Gemini 多模态深读。")
        inp = {"teamId": ids["teamId"], "title": title, "description": desc, "stateId": ids["backlog"], "priority": 4}
        if ids.get("project"):
            inp["projectId"] = ids["project"]
        if ids.get("label"):
            inp["labelIds"] = [ids["label"]]
        d = _linear("mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{identifier}}}", {"i": inp})
        ident = d["issueCreate"]["issue"]["identifier"]
        # keep the in-memory dedupe set current within this run too
        self._covered.add(meta["id"])
        self._existing.append({"identifier": ident, "title": title, "description": desc})
        return ident

    _RET_MARKER = "Retention (FLY-349 v2 engine"

    def attach_retention(self, meta, issue_id):
        if self.dry_run:
            print(f"[DRY-RUN] would attach retention to {issue_id} for {meta['id']} (no Linear write)", file=sys.stderr)
            return
        # idempotency (finding #1): skip if a retention comment already exists on this issue.
        info = _linear("query($id:String!){issue(id:$id){id comments{nodes{body}}}}", {"id": issue_id})["issue"]
        if any(self._RET_MARKER in (c.get("body") or "") for c in info["comments"]["nodes"]):
            print(f"[reconcile] retention comment already on {issue_id} — skip", file=sys.stderr)
            return
        det = self._detail(meta["id"])
        imgs = "\n".join(f"  - {u}" for u in det.get("imageUrls", [])[:6])  # original-CDN content refs (not user tokens)
        body = (f"📎 **Retention (FLY-349 v2 engine · 策略 C)** — 留存物随 issue 走（不进 repo）。\n"
                f"- **作者**: {det.get('author','')}\n- **caption(raw)**: {det.get('desc','')[:500]}\n"
                f"- **Gemini 深读**: 见 issue 描述。\n- **关键帧/slide（原站 CDN 链接，未 re-host）**:\n{imgs}\n"
                f"- ⏳ 视频真·逐帧抽取 = follow-up（raw video 不默认留）。")
        _linear("mutation($i:CommentCreateInput!){commentCreate(input:$i){comment{id}}}", {"i": {"issueId": info["id"], "body": body}})

    def _url_key(self):
        """Linear workspace slug (ground truth) for clickable issue links (Annie ②). Cached;
        degrades to '' (identifier text only) if Linear is unreachable."""
        if getattr(self, "_urlkey_cache", None) is not None:
            return self._urlkey_cache
        try:
            self._urlkey_cache = _linear("query{organization{urlKey}}", {})["organization"]["urlKey"] or ""
        except Exception as e:
            print(f"[urlKey lookup failed: {e} — Linear links degrade to text]", file=sys.stderr)
            self._urlkey_cache = ""
        return self._urlkey_cache

    def _first_pass(self, n):
        """Map note state → (vclass, vlabel, default-decision) for the review card."""
        if n.get("useful") and n.get("issueId"):
            return "build", "建", "建"
        if n.get("useful"):
            return "cand", "候选", "候选"
        if n.get("status") in ("failed", "degraded"):
            return "fail", "未完成(降级)", "不建"
        return "skip", "不建", "不建"

    def build_report(self, state, batch_no):
        """Annie's LOCKED interactive review page — single source of truth (renders via
        _render_review_page). Each card carries the note author/title, the OPENABLE 原帖 link,
        and for CREATED issues the clickable 'FLY-xxx: <issue title>' link; plus a 建/候选/不建
        toggle (default = first-pass), a comment box, and a top「复制我的决定」→ JSON button."""
        b = state["batches"][str(batch_no)]
        url_key = self._url_key()
        # issue-title map from the dedup scan (self._existing holds all FLY issues incl. ones just
        # created); falls back to the note-derived title if absent.
        title_map = {e.get("identifier"): e.get("title", "") for e in (getattr(self, "_existing", None) or [])}
        notes = []
        for nid in b["noteIds"]:
            n = state["notes"].get(nid, {})
            det = {}
            dp = os.path.join(self._ndir(nid), "detail.json")
            if os.path.exists(dp):
                det = json.load(open(dp, encoding="utf-8"))
            a = self._analysis(nid)
            iid = n.get("issueId")
            issue_title = ""
            if iid:
                raw = (title_map.get(iid) or f"[XHS-deep] {det.get('title', '')}").strip()
                for pfx in ("[XHS-deep] ", "[XHS-deep]"):  # Linear may trim the trailing space
                    if raw.startswith(pfx):
                        raw = raw[len(pfx):].strip()
                        break
                issue_title = raw or "(无标题)"
            vclass, vlabel, default = self._first_pass(n)
            notes.append({
                "noteId": nid, "issueId": iid, "issueTitle": issue_title,
                "author": det.get("author", ""), "title": det.get("title", ""),
                "sourceUrl": det.get("sourceUrl", ""), "type": det.get("type", "?"),
                "summary": self._kv(a, "SUMMARY"), "keypoints": self._kv(a, "KEYPOINTS"), "honest": self._kv(a, "HONEST"),
                "vclass": vclass, "vlabel": vlabel, "default": default,
            })
        page = _render_review_page(notes, batch_no, url_key)
        path = os.path.join(REPORT_DIR, f"batch-{batch_no}.html")
        # contains openable token links → create owner-only (no permissive-umask window)
        with open(path, "w", encoding="utf-8", opener=_open0600) as f:
            f.write(page)
        subprocess.run(["open", path], capture_output=True)
        return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=10)
    ap.add_argument("--video-concurrency", type=int, default=1)
    ap.add_argument("--mark-reviewed", type=int, help="mark a batch reviewed (after Annie's review) then exit")
    ap.add_argument("--rebuild-report", type=int, metavar="N", help="re-render batch N's review page from current state (no processing, no Linear writes); refreshes issue titles via a read-only Linear scan")
    ap.add_argument("--dry-run", action="store_true", help="QA controlled smoke: real MCP/analysis reads, NO Linear writes; uses a SEPARATE state file so the real checkpoint is never touched")
    args = ap.parse_args()

    # dry-run uses an isolated state file → never pollutes/double-writes the real checkpoint
    state_file = f"{COLLECTION}-dryrun.json" if args.dry_run else f"{COLLECTION}.json"
    state_path = os.path.join(STATE_DIR, state_file)
    state = C.load_state(state_path) or C.fresh_state(COLLECTION, COLLECTION_ID, now())
    io = EngineIO(state_path, dry_run=args.dry_run)

    if args.mark_reviewed:
        C.mark_batch(state, args.mark_reviewed, "reviewed", now())
        io.save(state)
        print(f"batch {args.mark_reviewed} marked reviewed")
        return

    if args.rebuild_report:
        # read-only: refresh the issue-title map from Linear (no writes), then re-render the page
        # from the existing checkpoint. Used to re-emit a batch after a template change.
        try:
            io.existing_issues()
        except Exception as e:
            print(f"[rebuild-report: Linear scan failed ({e}) — issue titles fall back to note titles]", file=sys.stderr)
        path = io.build_report(state, args.rebuild_report)
        print(f"batch {args.rebuild_report} review page rebuilt → {path}")
        return

    cfg = LG.GateConfig(cores=os.cpu_count() or 8, video_concurrency=args.video_concurrency)
    try:
        batch = O.run_batch(state, io, cfg, now, batch_size=args.batch_size, log=print)
    except EngineIO.LoginLost as e:
        notify_lead(f"🔴 [FLY-349 引擎] MCP 登录失效/CAPTCHA: {e} — 已停(state 已 checkpoint，可续)。需 Annie 重扫 RedNote QR(我可生成二维码)，恢复后从断点续跑。")
        print(f"LoginLost (escalated, stopped): {e}", file=sys.stderr)
        sys.exit(2)
    rp = state["batches"].get(str(batch.get("batchNo")), {}).get("reportPath")
    if rp and state["batches"][str(batch["batchNo"])]["status"] == "reported":
        if args.dry_run:
            print(f"[DRY-RUN] batch {batch['batchNo']} report → {rp} (no Lead notify, no Linear writes)")
        else:
            notify_lead(f"[FLY-349 引擎] batch {batch['batchNo']} 跑完 → report {rp}（{len(batch['noteIds'])} 条）。转 Annie review；过完 `run.py --mark-reviewed {batch['batchNo']}` 再跑下批。")


if __name__ == "__main__":
    main()
