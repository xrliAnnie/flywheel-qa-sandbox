#!/usr/bin/env python3
"""NON-PRODUCTION design/QA stand-in. Never prints token values; logs sha8 only."""
import json, sys, hashlib, time, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
truth2, port, ledger = sys.argv[1], int(sys.argv[2]), sys.argv[3]
j = json.load(open(truth2)); REAL_AT = j["tokens"]["access_token"]
state = {"current": hashlib.sha256(j["tokens"]["refresh_token"].encode()).hexdigest()[:8], "n": 0}
lock = threading.Lock()
def h(s): return hashlib.sha256(s.encode()).hexdigest()[:8]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        rt = body.get("refresh_token", ""); t = time.time()
        with lock:
            if h(rt) == state["current"]:
                state["n"] += 1; new = f"fake-rt-{state['n']}-{t}"; state["current"] = h(new)
                time.sleep(0.4)  # emulate authority RTT so the race window is realistic
                out = {"access_token": REAL_AT, "refresh_token": new, "id_token": None}; code = 200; verdict = "ROTATED"
            else:
                out = {"error": {"code": "refresh_token_reused", "message": "refresh token already used"}}; code = 401; verdict = "REUSED"
            open(ledger, "a").write(json.dumps({"ts": t, "rt_sha8": h(rt), "verdict": verdict, "n": state["n"]}) + "\n")
        data = json.dumps(out).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
HTTPServer(("127.0.0.1", port), H).serve_forever()
