# Investigation only. No live sockets; environment contains no credentials.
import array, json, os, select, shutil, socket, subprocess, tempfile, threading, time
result = {"model": "healthy newline server; real tmux 3.7c client; not actual cmux app"}
with tempfile.TemporaryDirectory(prefix="fly2965-", dir="/tmp") as root:
    path = root + "/model.sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path); server.listen(4); server.settimeout(0.1)
    stop = threading.Event()
    counts, workers, connections, received_fds = [], [], [], []
    def handle(conn):
        data = b""
        conn.settimeout(0.1)
        try:
            with conn:
                while not stop.is_set():
                    try:
                        chunk, ancillary, flags, addr = conn.recvmsg(4096, socket.CMSG_SPACE(64))
                        for level, kind, payload in ancillary:
                            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                                fds = array.array("i"); fds.frombytes(payload)
                                received_fds.extend(fds)
                    except socket.timeout: continue
                    if not chunk: break
                    data += chunk
                    if b"\n" in data:
                        conn.sendall(b'{"ok":true,"result":{"pong":true}}\n')
                        break
        except OSError: pass
        counts.append({"bytes": len(data), "newline": b"\n" in data})
    def accept():
        while not stop.is_set():
            try: conn, _ = server.accept()
            except socket.timeout: continue
            connections.append(conn)
            t = threading.Thread(target=handle, args=(conn,), daemon=True)
            t.start(); workers.append(t)
    def close_connections():
        while received_fds:
            os.close(received_fds.pop())
        for c in connections:
            try: c.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            c.close()
    thread = threading.Thread(target=accept, daemon=True); thread.start()
    env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin", "HOME": root, "TERM": "xterm-256color"}
    argv = [shutil.which("tmux"), "-S", path, "-N", "list-sessions", "-F", "#{session_name}"]
    proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        proc.communicate(timeout=1)
        result["client_waited_past_1s"] = False
    except subprocess.TimeoutExpired:
        result["client_waited_past_1s"] = True
        proc.kill()
        result["killed_client_returncode"] = proc.wait(timeout=1)
        result["received_descriptor_count"] = len(received_fds)
        try:
            proc.communicate(timeout=0.5)
            result["pipes_still_open_after_client_exit"] = False
        except subprocess.TimeoutExpired:
            result["pipes_still_open_after_client_exit"] = True
            close_connections()
            proc.communicate(timeout=2)
            result["peer_close_released_pipes"] = True
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(1); client.connect(path)
        client.sendall(b'{"id":"control","method":"system.ping","params":{}}\n')
        result["correct_protocol_control"] = json.loads(client.recv(4096))
    probe = 'source scripts/lib/tmux-server-rescue.sh; tmux_rescue_probe 1 "$@"'
    # Existing 1s wrapper is allowed 3s of server connection lifetime.
    timer = threading.Timer(3, close_connections); timer.start()
    started = time.monotonic()
    try:
        wrapped = subprocess.run(["/bin/bash", "-c", probe, "repro"] + argv, env=env, capture_output=True, text=True, timeout=5)
        result["existing_wrapper"] = {"rc": wrapped.returncode, "seconds": round(time.monotonic()-started, 3), "stderr": wrapped.stderr[:300]}
    finally:
        timer.cancel(); close_connections(); stop.set(); thread.join(timeout=1)
        server.close()
        for t in workers: t.join(timeout=1)
    result["connections"] = counts
print(json.dumps(result, indent=2))
