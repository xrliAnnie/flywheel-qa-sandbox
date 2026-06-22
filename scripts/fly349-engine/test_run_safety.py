#!/usr/bin/env python3
"""Tests for run.py safety fixes (codex round-1 findings). Run: python3 test_run_safety.py
Monkeypatches module-level I/O (run._linear / _mcp_retry / _mcp_login_ok / subprocess) so no
network/MCP is hit."""
import os, sys, types
import run as R
ok = 0
def check(c, m):
    global ok
    assert c, "FAIL: " + m
    ok += 1


def _io():
    io = R.EngineIO.__new__(R.EngineIO)
    io._fallback_notified = set(); io._existing = []; io._covered = set()
    io.state_path = "/tmp/ignore.json"; io.dry_run = False
    return io


def test_create_issue_reconciles_across_crash_window():
    """Finding #1: issueCreate succeeded but checkpoint not saved → next run must NOT dup."""
    nid = "6a1828f7000000003502a0b3"
    io = _io()
    io._existing = [{"identifier": "FLY-352", "title": "x", "description": f"... source=https://www.xiaohongshu.com/explore/{nid}"}]
    io._covered = {nid}
    calls = {"create": 0}
    R._linear = lambda q, v: calls.__setitem__("create", calls["create"] + 1) or {}
    ident = io.create_issue({"id": nid, "tok": "T", "type": "video", "title": "t"})
    check(ident == "FLY-352", "reconciled to existing issue id")
    check(calls["create"] == 0, "no issueCreate mutation on reconcile (no duplicate)")


def test_create_issue_creates_when_uncovered_and_redacts_token():
    nid = "6bfreshfreshfreshfresh01"
    io = _io(); io._covered = set()
    seen = {}
    def fake_linear(q, v):
        if "issueCreate" in q:
            seen["desc"] = v["i"]["description"]; return {"issueCreate": {"issue": {"identifier": "FLY-900"}}}
        return {}
    R._linear = fake_linear
    R._TEAM_LABEL_CACHE.clear(); R._TEAM_LABEL_CACHE.update({"teamId": "t", "backlog": "b", "label": "l", "project": "p"})
    io._detail = lambda n: {"title": "T", "type": "video", "author": "A", "desc": "d", "imageUrls": []}
    io._analysis = lambda n: "USEFUL: yes\nSUMMARY: s\nKEYPOINTS:\n- k\n"
    ident = io.create_issue({"id": nid, "tok": "SECRETTOKEN123", "type": "video", "title": "t"})
    check(ident == "FLY-900", "created new issue")
    check("SECRETTOKEN123" not in seen["desc"], "finding #4: xsec_token NOT written into Linear description")
    check(nid in io._covered, "newly-created note added to in-run covered set")
    check("判断" in seen["desc"] and "[原帖]" in seen["desc"], "Annie ⑤: issue body has first-pass verdict + 原帖 link")


def test_attach_retention_idempotent():
    io = _io()
    calls = {"comment": 0}
    def fake_linear(q, v):
        if q.strip().startswith("query"):
            return {"issue": {"id": "uuid", "comments": {"nodes": [{"body": "📎 Retention (FLY-349 v2 engine · ...)"}]}}}
        calls["comment"] += 1; return {"commentCreate": {"comment": {"id": "c"}}}
    R._linear = fake_linear
    io._detail = lambda n: {"author": "A", "desc": "d", "imageUrls": []}
    io.attach_retention({"id": "6a1828f7000000003502a0b3"}, "FLY-352")
    check(calls["comment"] == 0, "finding #1: retention comment already present → not duplicated")


def test_load1_pause_bias_on_failure():
    """Finding #8: unmeasurable load → return value above absolute pause, not crash."""
    io = _io()
    orig = R.subprocess.run
    R.subprocess.run = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("uptime boom"))
    try:
        v = io.load1()
        check(v >= 30.0, "load1 biases to pause (>= absolute_pause) on sampling failure")
    finally:
        R.subprocess.run = orig


def test_enumerate_login_lost_escalates():
    """Finding #2: empty enumeration + login not confirmed → LoginLost (not silent empty)."""
    io = _io()
    R._mcp_retry = lambda *a, **k: None        # collection content empty
    R._mcp_login_ok = lambda: False            # login not confirmed
    raised = False
    try:
        io.enumerate_notes()
    except R.EngineIO.LoginLost:
        raised = True
    check(raised, "empty enum + unconfirmed login → LoginLost escalation")


def test_enumerate_empty_ok_when_login_healthy():
    io = _io()
    R._mcp_retry = lambda *a, **k: {"notes": []}  # genuinely empty
    R._mcp_login_ok = lambda: True
    check(io.enumerate_notes() == [], "confirmed-healthy login + empty collection → [] (not escalation)")


def test_auth_classifier_does_not_falsepositive_on_healthy():
    """codex R2 blocker: the bare word 登录 must NOT make 已登录 (healthy) classify as auth-lost.
    Tests the REAL _is_auth_lost_text (not monkeypatched) + the _mcp_login_ok logic inline."""
    check(not R._is_auth_lost_text("✅ 已登录\n用户名: xiaohongshu-mcp"), "已登录 (healthy) NOT auth-lost")
    check(R._is_auth_lost_text("❌ 未登录\n请使用 get_login_qrcode"), "未登录 IS auth-lost")
    check(R._is_auth_lost_text("请扫码登录 / captcha 验证码"), "captcha/扫码登录 IS auth-lost")
    check(not R._is_auth_lost_text('{"notes": null, "count": 0}'), "genuinely-empty (no auth wording) NOT auth-lost")
    # _mcp_login_ok logic: '已登录' present AND '未登录' absent (verified directly, not via the
    # module global which other tests monkeypatch)
    login_ok = lambda blob: ("已登录" in blob) and ("未登录" not in blob)
    check(login_ok("✅ 已登录 用户名:x") and not login_ok("❌ 未登录"), "login_ok logic: 已登录 yes / 未登录 no")


def test_dry_run_no_linear_writes():
    """QA controlled smoke: dry_run must make create/attach skip all Linear mutations."""
    io = _io(); io.dry_run = True
    calls = {"n": 0}
    R._linear = lambda q, v: calls.__setitem__("n", calls["n"] + 1) or {}
    ident = io.create_issue({"id": "6a1828f7000000003502a0b3", "tok": "T", "type": "video", "title": "t"})
    io.attach_retention({"id": "6a1828f7000000003502a0b3"}, ident)
    check(ident.startswith("DRY-"), "dry-run create returns DRY- placeholder id")
    check(calls["n"] == 0, "dry-run performs ZERO Linear writes (no double-write during QA)")


def test_build_report_locked_interactive_template():
    """Annie's LOCKED interactive review page: ① structured summary ② clickable draft-issue link
    WITH issue title ③ openable RedNote link ④ first-pass toggle (default) + comment + copy-JSON
    button ⑥ complete HTML document (publish-report needs DOCTYPE+html+head+body)."""
    import tempfile, json as _json
    io = _io()
    io._existing = [{"identifier": "FLY-352", "title": "[XHS-deep] 英伟达 agent 走向物理世界", "description": ""}]
    root = tempfile.mkdtemp()
    io._ndir = lambda nid: (os.makedirs(os.path.join(root, nid), exist_ok=True) or os.path.join(root, nid))
    nid_a, nid_b = "6a1828f7000000003502a0b3", "6bcccccccccccccccccccccc"
    for nid, useful in [(nid_a, True), (nid_b, False)]:
        d = io._ndir(nid)
        _json.dump({"title": "标题" + nid[:4], "type": "video", "author": "作者X", "desc": "正文",
                    "sourceUrl": f"https://www.xiaohongshu.com/explore/{nid}?xsec_token=TOKZZ&xsec_source=pc_feed"},
                   open(os.path.join(d, "detail.json"), "w", encoding="utf-8"), ensure_ascii=False)
        open(os.path.join(d, "analysis.txt"), "w", encoding="utf-8").write(
            "USEFUL: %s\nSUMMARY: 这条讲了具体内容 X Y Z\nKEYPOINTS:\n- 可执行点1\n- 可执行点2\nHONEST: 大部分展示" % ("yes" if useful else "no"))
    state = {"batches": {"1": {"batchNo": 1, "noteIds": [nid_a, nid_b]}},
             "notes": {nid_a: {"useful": True, "issueId": "FLY-352", "status": "done"},
                       nid_b: {"useful": False, "issueId": None, "status": "done"}}}
    R._linear = lambda q, v: {"organization": {"urlKey": "studio"}}
    R.subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="", stderr="")
    orig_report = R.REPORT_DIR
    R.REPORT_DIR = tempfile.mkdtemp()
    try:
        path = io.build_report(state, 1)
        page = open(path, encoding="utf-8").read()
        # ⑥ complete document (publish-report 400s on a fragment)
        check(page.startswith("<!DOCTYPE html>") and "<html" in page and "<head>" in page
              and "<body" in page and "</body>" in page and "</html>" in page, "⑥ complete HTML document")
        check("xsec_token=TOKZZ" in page, "③ openable RedNote link (token URL) in LOCAL review page")
        check("https://linear.app/studio/issue/FLY-352" in page, "② clickable draft issue link present")
        # NEW (Annie): created issue shows its TITLE next to the id, prefix stripped
        check("FLY-352: 英伟达 agent 走向物理世界" in page, "issue link shows 'FLY-xxx: <title>' (prefix stripped)")
        check(page.count('class="issue"') == 1, "issue title/link ONLY on the created card (not-created shows none)")
        # ④ interaction: toggle + comment + copy button
        check(page.count('class="seg"') == 2 and 'type="radio"' in page, "④ 建/候选/不建 toggle on every card")
        check(page.count('class="cmt"') == 2, "④ comment box on every card")
        check("copyDecisions" in page and 'data-note="6a1828f7000000003502a0b3"' in page
              and 'data-issue="FLY-352"' in page, "④ copy-JSON button + data attributes for export")
        # P1 mobile fix: visible selectable <textarea> output + execCommand fallback (navigator.clipboard
        # is blocked/empty on mobile Safari) — must not regress to a non-copyable <pre>.
        check('<textarea id="out"' in page and "execCommand('copy')" in page
              and "navigator.clipboard" in page, "P1: mobile-safe copy (textarea + execCommand + clipboard)")
        # P1 CSP fix: button bound via addEventListener (NOT inline onclick — blocked by hosted
        # script-src 'nonce-…'), and the <script> carries the nonce placeholder for publish-report.
        check('id="copyBtn"' in page and "onclick=" not in page
              and "addEventListener('click', copyDecisions)" in page, "P1: button via addEventListener, no inline onclick (CSP)")
        check('<script nonce="__CSP_NONCE__">' in page, "P1: <script> carries nonce placeholder for hosted CSP")
        check("系统判断: 建" in page and "系统判断: 不建" in page, "first-pass verdict badge per card")
        check("提炼" in page and "可执行点" in page and "诚实标注" in page, "① structured summary sections")
        check(oct(os.stat(path).st_mode)[-3:] == "600", "review page is 0600 (holds token links)")
    finally:
        R.REPORT_DIR = orig_report


def test_validators_reject_injection():
    check(R._valid_noteid("6a1828f7000000003502a0b3") and not R._valid_noteid("-rf") and not R._valid_noteid("a;b"), "noteid validator")
    check(R._valid_token("AB-_=token") and not R._valid_token("-O/x") and not R._valid_token("a b"), "token validator")
    check(R._valid_http_url("https://x/y") and not R._valid_http_url("file:///etc") and not R._valid_http_url("-O"), "url validator")


def test_valid_analysis_rejects_agentic_chatter():
    """F0 (QA FLY-372): agy's multi-image agentic chatter must NOT pass as a real analysis."""
    chatter = "waiting for the file search command to locate img0.png before I can proceed"
    check(not R._valid_analysis(chatter), "agentic chatter rejected (no USEFUL/SUMMARY)")
    check(not R._valid_analysis("Let me locate img0.png first.\nUSEFUL: yes\nSUMMARY: x"),
          "chatter-prefixed skeleton rejected")
    check(not R._valid_analysis(""), "empty rejected")
    check(not R._valid_analysis("USEFUL: yes\n(no summary key)"), "missing SUMMARY rejected")
    # codex R(qafix)-2: a LONG agentic preamble (>80 chars) before the skeleton must still be
    # rejected — anchor the verdict at the first non-empty line.
    chatter_late = ("I need to inspect the uploaded images before making a determination. "
                    "After reviewing them, here is the requested format:\nUSEFUL: yes\nSUMMARY: ok")
    check(not R._valid_analysis(chatter_late), "long preamble before skeleton rejected (anchored)")
    # codex R(qafix)-2: a skeleton whose SUMMARY admits it never read the media must be rejected.
    check(not R._valid_analysis("USEFUL: yes\nSUMMARY: I cannot access the images yet."),
          "failure-admission summary rejected (no shallow issue)")
    check(not R._valid_analysis("USEFUL: yes\nSUMMARY: 无法访问图片"), "中文 failure-admission rejected")
    check(R._valid_analysis("USEFUL: yes\nSUMMARY: 这条讲了 X\nKEYPOINTS:\n- a\nHONEST: 展示"),
          "well-formed structured analysis accepted")
    check(R._valid_analysis("USEFUL: no\nSUMMARY: 与 Flywheel 无关，是穿搭内容"),
          "well-formed USEFUL:no accepted")


def test_judge_defaults_false_on_ambiguous():
    """F0: judge must NOT default useful=True on garbage/ambiguous output (the fake-issue bug)."""
    io = _io()
    io._analysis = lambda nid: "blah blah no structure here"
    check(io.judge({"id": "6a1828f7000000003502a0b3"}) is False, "no USEFUL token → judge False (no fake issue)")
    io._analysis = lambda nid: "USEFUL: no\nSUMMARY: not relevant"
    check(io.judge({"id": "6a1828f7000000003502a0b3"}) is False, "explicit USEFUL: no → False")
    io._analysis = lambda nid: "USEFUL: yes\nSUMMARY: relevant\nKEYPOINTS:\n- k"
    check(io.judge({"id": "6a1828f7000000003502a0b3"}) is True, "explicit USEFUL: yes → True")


def test_prompt_includes_caption_and_comments():
    """F1 (Annie ①): caption (desc) + top comments must be fed into the analyze prompt."""
    io = _io()
    det = {"title": "T", "desc": "作者写的正文 caption 内容", "comments": ["评论一", "评论二", "评论三"]}
    p = io._prompt(det)
    check("作者写的正文 caption 内容" in p, "caption (desc) included in prompt")
    check("评论一" in p and "评论二" in p, "top comments included in prompt")
    # empty desc/comments must not crash or inject empty labels
    p2 = io._prompt({"title": "T"})
    check("作者 caption:" not in p2 and "热门评论:" not in p2, "no empty caption/comment labels when absent")


def test_gemini_fallback_raises_not_sentinel():
    """codex R(qafix)-1: a Gemini fallback failure must RAISE (→ note degrades to retry/failed),
    NOT return a valid-looking 'USEFUL: no' sentinel that silently marks the note done-no-action."""
    io = _io()
    orig = R._gemini_key
    R._gemini_key = lambda: ""
    try:
        raised = False
        try:
            io._gemini_api(["/tmp/x.png"], "p")
        except RuntimeError:
            raised = True
        check(raised, "no-key Gemini fallback raises (not a silent sentinel)")
    finally:
        R._gemini_key = orig


def _set_agy_env(val):
    """Set/restore FLY349_USE_AGY around a test; returns the prior value."""
    prev = os.environ.get("FLY349_USE_AGY")
    if val is None:
        os.environ.pop("FLY349_USE_AGY", None)
    else:
        os.environ["FLY349_USE_AGY"] = val
    return prev


def test_deep_read_gemini_primary_default():
    """Annie's latest decision (relayed via Tadashi): processing DEFAULTS to Gemini-primary.
    With FLY349_USE_AGY unset, _deep_read uses the Gemini API and NEVER invokes agy."""
    io = _io()
    prev = _set_agy_env(None)
    called = {"agy": False}
    def agy_spy(*a, **k):
        called["agy"] = True
        return "USEFUL: yes\nSUMMARY: agy ran (should not in default mode)"
    io._agy = agy_spy
    io._gemini_api = lambda media, prompt: "USEFUL: yes\nSUMMARY: Gemini 读出 X\nKEYPOINTS:\n- a"
    try:
        out = io._deep_read("/tmp", ["/tmp/img0.png"], "p", {"id": "6a1828f7000000003502a0b3"})
        check(not called["agy"], "default mode: agy NOT invoked (Gemini-primary)")
        check("Gemini 读出 X" in out, "default mode returns the Gemini analysis")
    finally:
        _set_agy_env(prev)


def test_deep_read_gemini_primary_raises_no_agy_fallback():
    """Default Gemini-primary: a Gemini failure RAISES (note degrades) and does NOT fall back to
    agy — agy is deferred to the parallel research issue, never used in processing."""
    io = _io()
    prev = _set_agy_env(None)
    called = {"agy": False}
    def agy_spy(*a, **k):
        called["agy"] = True
        return "USEFUL: yes\nSUMMARY: agy should not be a processing fallback"
    io._agy = agy_spy
    io._gemini_api = lambda media, prompt: (_ for _ in ()).throw(RuntimeError("gemini down"))
    try:
        raised = False
        try:
            io._deep_read("/tmp", ["/tmp/img0.png"], "p", {"id": "6a1828f7000000003502a0b3"})
        except RuntimeError:
            raised = True
        check(raised, "Gemini fail in default mode → raise (degrade)")
        check(not called["agy"], "default mode: no agy fallback after Gemini failure")
    finally:
        _set_agy_env(prev)


def test_deep_read_degrades_when_both_analyzers_fail():
    """F0 end-to-end (agy opt-in mode, FLY349_USE_AGY=1): agy returns chatter (invalid) + the
    Gemini fallback fails → _deep_read RAISES so the note degrades and NEVER creates a fake issue."""
    io = _io()
    prev = _set_agy_env("1")
    io._agy = lambda d, media, prompt, meta: "waiting for the file search command to locate img0.png"
    def boom(media, prompt):
        raise RuntimeError("gemini down")
    io._gemini_api = boom
    orig_notify = R.notify_lead
    R.notify_lead = lambda msg: None
    try:
        raised = False
        try:
            io._deep_read("/tmp", ["/tmp/img0.png"], "p", {"id": "6a1828f7000000003502a0b3"})
        except RuntimeError:
            raised = True
        check(raised, "agy-invalid + gemini-fail → _deep_read raises (degrade, no fake issue)")
    finally:
        R.notify_lead = orig_notify
        _set_agy_env(prev)


def test_deep_read_returns_valid_agy_without_fallback():
    """agy opt-in (FLY349_USE_AGY=1) happy path: a valid agy analysis is returned as-is (no paid
    Gemini fallback spent)."""
    io = _io()
    prev = _set_agy_env("1")
    try:
        io._agy = lambda d, media, prompt, meta: "USEFUL: yes\nSUMMARY: 讲了 X\nKEYPOINTS:\n- a"
        io._gemini_api = lambda media, prompt: (_ for _ in ()).throw(AssertionError("must not fall back"))
        out = io._deep_read("/tmp", ["/tmp/img0.png"], "p", {"id": "6a1828f7000000003502a0b3"})
        check("USEFUL: yes" in out, "agy opt-in: valid agy analysis returned without paid fallback")
    finally:
        _set_agy_env(prev)


def test_download_failure_with_lost_login_escalates():
    """F2 (QA FLY-372): a total download failure under a dead login → LoginLost (re-login),
    not an endless transient retry on a stale cookie."""
    import tempfile
    io = _io()
    d = tempfile.mkdtemp()
    io._ndir = lambda nid: d
    io._detail = lambda nid: {"type": "video", "imageUrls": []}
    io._cookie_file = lambda path: None
    R.subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=1, stdout="", stderr="")
    R.time.sleep = lambda *a, **k: None  # skip the 22s retry-after-idle waits in test
    meta = {"id": "6a1828f7000000003502a0b3", "tok": "GOODTOKEN"}
    # login dead → LoginLost
    R._mcp_login_ok = lambda: False
    raised_login = False
    try:
        io.download(meta)
    except R.EngineIO.LoginLost:
        raised_login = True
    except RuntimeError:
        pass
    check(raised_login, "download fail + dead login → LoginLost escalation")
    # login healthy → transient RuntimeError (retryable), NOT LoginLost
    R._mcp_login_ok = lambda: True
    raised_transient = False
    try:
        io.download(meta)
    except R.EngineIO.LoginLost:
        check(False, "healthy login must not raise LoginLost")
    except RuntimeError:
        raised_transient = True
    check(raised_transient, "download fail + healthy login → transient RuntimeError (retry)")


for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print(f"✅ ALL RUN-SAFETY TESTS PASSED ({ok} assertions)")
