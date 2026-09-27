#!/usr/bin/env python3
"""FLY-2951 experiment: can a running `codex app-server` switch ChatGPT account
without restarting, and does the same thread continue across accounts?

Secrets are never printed: tokens are loaded from profile copies and only
account-id prefixes / plan types are logged.

Phases (single app-server process, temp CODEX_HOME, starts as account A):
  P0  account/read + turn 1 on thread T as A (reasoning on -> encrypted content)
  P1  overwrite $CODEX_HOME/auth.json with account B on disk (the way a
      founder `codex-profile use` rewrites the canonical file)  ->  account/read
      + turn 2 on T  => does the process pick up B?
  P2  account/login/start {type: chatgptAuthTokens} with B's access token
      (experimental API)  ->  account/read + turn 3 on T  => hot swap +
      thread continuation under B?
  P3  account/rateLimits/read to see which account the backend attributes.
"""
import json, os, shutil, subprocess, sys, threading, time, base64, queue

HOME = os.path.expanduser("~")
PROFILES = os.path.join(HOME, ".codex/profiles")
A, B = sys.argv[1], sys.argv[2]
WORK = sys.argv[3]
MODEL = sys.argv[4] if len(sys.argv) > 4 else "gpt-5.6-sol"
SKIP_P1 = os.environ.get("SKIP_P1") == "1"

def claims(tok):
    p = tok.split(".")[1]; p += "=" * (-len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))

def load(profile):
    d = json.load(open(os.path.join(PROFILES, profile, "auth.json")))
    return d

def ident(d):
    t = d["tokens"]; c = claims(t["access_token"]).get("https://api.openai.com/auth", {})
    return f"{t.get('account_id','')[:8]}/{c.get('chatgpt_plan_type')}"

codex_home = os.path.join(WORK, "codex-home")
shutil.rmtree(codex_home, ignore_errors=True)
os.makedirs(codex_home)
auth_a, auth_b = load(A), load(B)
with open(os.path.join(codex_home, "auth.json"), "w") as f:
    json.dump(auth_a, f)
os.chmod(os.path.join(codex_home, "auth.json"), 0o600)
with open(os.path.join(codex_home, "config.toml"), "w") as f:
    f.write(f'model = "{MODEL}"\nmodel_reasoning_effort = "low"\n')
cwd = os.path.join(WORK, "cwd"); os.makedirs(cwd, exist_ok=True)

log = open(os.path.join(WORK, "events.jsonl"), "w")
def say(*a):
    print(*a, flush=True)

env = dict(os.environ, CODEX_HOME=codex_home, RUST_LOG="codex_login=info,codex_core::client=info,warn")
proc = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=open(os.path.join(WORK, "stderr.log"), "w"), env=env, text=True, bufsize=1)
say(f"app-server pid={proc.pid} A={A}:{ident(auth_a)} B={B}:{ident(auth_b)} model={MODEL}")

pending = {}; notes = queue.Queue(); nid = [0]
def reader():
    for line in proc.stdout:
        try: msg = json.loads(line)
        except Exception: continue
        log.write(line); log.flush()
        if "id" in msg and ("result" in msg or "error" in msg) and msg["id"] in pending:
            pending[msg["id"]].put(msg)
        elif "id" in msg and "method" in msg:
            # server -> client request (e.g. account/chatgptAuthTokens/refresh)
            say(f"  << server request {msg['method']} params={json.dumps(msg.get('params'))[:200]}")
            notes.put(msg)
        else:
            notes.put(msg)
threading.Thread(target=reader, daemon=True).start()

def rpc(method, params=None, timeout=60):
    nid[0] += 1; i = nid[0]; q = queue.Queue(); pending[i] = q
    proc.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n"); proc.stdin.flush()
    try: return q.get(timeout=timeout)
    except queue.Empty: return {"error": {"message": f"timeout {method}"}}

def notify(method, params=None):
    proc.stdin.write(json.dumps({"method": method, "params": params}) + "\n"); proc.stdin.flush()

def account():
    r = rpc("account/read", {"refreshToken": False})
    acc = (r.get("result") or {}).get("account") or {}
    wr = (r.get("result") or {}).get("workspaceRouting") or {}
    import hashlib
    eh = hashlib.sha256(str(acc.get('email')).encode()).hexdigest()[:6]
    return f"type={acc.get('type')} plan={acc.get('planType')} email#={eh} routing_acct={str(wr.get('chatgptAccountId'))[:8]}" if "result" in r else f"ERR {r.get('error')}"

def ratelimits():
    r = rpc("account/rateLimits/read", None)
    res = r.get("result") or {}
    rl = res.get("rateLimits") or {}
    return f"account_id={str(res.get('accountId'))[:8]} ordinaryAllowed={res.get('ordinaryUsageAllowed')} primary_used%={(rl.get('primary') or {}).get('usedPercent')}" if "result" in r else f"ERR {json.dumps(r.get('error'))[:200]}"

def turn(thread_id, text, timeout=240):
    r = rpc("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": text}]})
    if "error" in r:
        return f"turn/start ERR {json.dumps(r['error'])[:300]}"
    deadline = time.time() + timeout; out = []; err = None; reasoning = 0
    while time.time() < deadline:
        try: m = notes.get(timeout=5)
        except queue.Empty: continue
        meth = m.get("method", "")
        p = m.get("params") or {}
        if meth == "item/completed":
            it = p.get("item") or {}
            if it.get("type") == "agentMessage": out.append(it.get("text", ""))
            if it.get("type") == "reasoning": reasoning += 1
        if meth == "error": err = json.dumps(p)[:400]
        if meth == "turn/completed":
            st = (p.get("turn") or {}).get("status"); te = (p.get("turn") or {}).get("error")
            return f"status={st} reasoning_items={reasoning} reply={' | '.join(out)[:160]!r}" + (f" turn_error={json.dumps(te)[:400]}" if te else "") + (f" error_note={err}" if err else "")
    return f"TIMEOUT reply={out} err={err}"

init = rpc("initialize", {"clientInfo": {"name": "fly2951-probe", "title": None, "version": "0.0.1"},
                          "capabilities": {"experimentalApi": True}})
say("initialize:", "ok" if "result" in init else init)
notify("initialized")

say("P0 account:", account()); say("P0 ratelimits:", ratelimits())
ts = rpc("thread/start", {"cwd": cwd, "approvalPolicy": "never", "sandbox": "read-only"})
if "error" in ts: say("thread/start ERR", ts); sys.exit(1)
tid = ts["result"]["thread"]["id"]; say("thread", tid)
say("P0 turn1 (A):", turn(tid, "Remember the secret word PELICAN. First work out step by step: what is 17*23+19*29? Then reply only with the number and OK-1"))

if not SKIP_P1:
    with open(os.path.join(codex_home, "auth.json"), "w") as f:
        json.dump(auth_b, f)
    say("P1 wrote B to auth.json on disk")
    time.sleep(2)
    say("P1 account:", account()); say("P1 ratelimits:", ratelimits())
    say("P1 turn2:", turn(tid, "Reply only: OK-2"))
    # put A back so P2 isolates the protocol path
    with open(os.path.join(codex_home, "auth.json"), "w") as f:
        json.dump(auth_a, f)

tb = auth_b["tokens"]
c = claims(tb["access_token"]).get("https://api.openai.com/auth", {})
r = rpc("account/login/start", {"type": "chatgptAuthTokens", "accessToken": tb["access_token"],
                                "chatgptAccountId": tb["account_id"], "chatgptPlanType": c.get("chatgpt_plan_type")})
say("P2 login/start chatgptAuthTokens:", "ok " + json.dumps(r["result"]) if "result" in r else f"ERR {json.dumps(r.get('error'))[:300]}")
time.sleep(1)
say("P2 account:", account()); say("P2 ratelimits:", ratelimits())
say("P2 turn3 (B, same thread):", turn(tid, "What was the secret word I asked you to remember? Reply with just the word."))
say("P2 turn4 (B again):", turn(tid, "Reply only: OK-4"))

# was the on-disk auth.json touched by the process?
d = json.load(open(os.path.join(codex_home, "auth.json")))
say("disk auth.json now:", ident(d), "last_refresh", d.get("last_refresh"))
proc.terminate(); proc.wait(timeout=10)
say("done")
