/* FLY-1911 v3 probe — WebRTC handshake + stability, NO Discord.
 * Questions: 1) does v3 SDP answer come back now (legal voice + credits)?
 *            2) does the PC reach connected? 3) does it hold for STAY_MIN minutes?
 */
import { spawn } from "node:child_process";
import { MediaStreamTrack, RTCPeerConnection } from "werift";

const BIN = process.env.CODEX_BIN ||
	"/Users/xiaorongli/.codex-mufasa/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex";
const STAY_MS = Number(process.env.STAY_MIN || 5) * 60_000;
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const cx = spawn(BIN, process.env.CX_EXTRA ? ["--enable","realtime_conversation","-c",process.env.CX_EXTRA,"app-server"] : ["--enable","realtime_conversation","app-server"], {
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, CODEX_HOME: `${process.env.HOME}/.codex-honeylemon` },
});
let rpcId = 0,
	buf = "",
	answerSdp = null,
	started = false,
	closedReason = null;
const waiters = new Map();
function rpc(method, params) {
	const id = ++rpcId;
	cx.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	return new Promise((res) => waiters.set(id, res));
}
cx.stderr.on("data", (d) => {
	const s = String(d).trim();
	if (/ERROR|realtime/i.test(s)) console.log(stamp(), "STDERR:", s.slice(0, 260));
});
cx.stdout.on("data", (d) => {
	buf += String(d);
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}
		if (m.id && waiters.has(m.id)) {
			waiters.get(m.id)(m);
			waiters.delete(m.id);
		}
		const meth = m.method || "";
		if (meth === "thread/realtime/sdp") {
			answerSdp = String(m.params?.sdp || "");
			console.log(stamp(), "SDP-ANSWER chars=", answerSdp.length);
		} else if (meth === "thread/realtime/started") {
			started = true;
			console.log(stamp(), "REALTIME STARTED", JSON.stringify(m.params).slice(0, 120));
		} else if (/realtime\/(error|closed)/.test(meth)) {
			closedReason = JSON.stringify(m.params).slice(0, 260);
			console.log(stamp(), "EVENT:", meth, closedReason);
		}
	}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	await rpc("initialize", {
		clientInfo: { name: "fly1911-v3-probe", title: "v3 probe", version: "0.0.1" },
		capabilities: { experimentalApi: true },
	});
	cx.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
	await sleep(400);
	const th = await rpc("thread/start", { cwd: "/tmp" });
	const threadId = th?.result?.threadId ?? th?.result?.thread?.id;
	console.log(stamp(), "thread:", threadId ?? JSON.stringify(th?.error));
	if (!threadId) process.exit(2);

	const pc = new RTCPeerConnection({});
	pc.createDataChannel("oai-events");
	const outTrack = new MediaStreamTrack({ kind: "audio" });
	pc.addTransceiver(outTrack, { direction: "sendrecv" });
	pc.connectionStateChange.subscribe((st) =>
		console.log(stamp(), "PC-STATE:", st),
	);
	const off = await pc.createOffer();
	await pc.setLocalDescription(off);
	const r = await rpc("thread/realtime/start", {
		threadId,
		transport: { type: "webrtc", sdp: pc.localDescription.sdp },
		outputModality: "audio",
		voice: process.env.RT_VOICE || "cove",
		version: process.env.RT_VER || "v3",
		realtimeStartInstructions: "probe session: remain silent.",
	});
	console.log(stamp(), "realtime/start rpc:", r?.error ? "ERR " + JSON.stringify(r.error) : "ok");
	if (r?.error) process.exit(3);

	const s2 = Date.now();
	while (!answerSdp && Date.now() - s2 < 20000) await sleep(100);
	if (!answerSdp) {
		console.log(stamp(), "FAIL: no SDP answer in 20s");
		process.exit(4);
	}
	await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
	const s3 = Date.now();
	while (pc.connectionState !== "connected" && Date.now() - s3 < 25000) await sleep(200);
	console.log(stamp(), "PC final:", pc.connectionState);
	if (pc.connectionState !== "connected") process.exit(5);

	console.log(stamp(), `HOLDING for ${STAY_MS / 60000} min (stability watch)…`);
	const s4 = Date.now();
	while (Date.now() - s4 < STAY_MS) {
		await sleep(5000);
		if (closedReason) {
			console.log(stamp(), "DISCONNECT during hold:", closedReason, "pc=", pc.connectionState);
			process.exit(6);
		}
		if (pc.connectionState !== "connected") {
			console.log(stamp(), "PC left connected state:", pc.connectionState);
			process.exit(7);
		}
	}
	console.log(stamp(), "STABLE: held", STAY_MS / 60000, "min. started=", started);
	cx.kill("SIGTERM");
	process.exit(0);
})();
