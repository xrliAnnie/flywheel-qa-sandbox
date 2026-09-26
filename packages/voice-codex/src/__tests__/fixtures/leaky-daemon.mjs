// FLY-2885 QA@1 stand-in for a voice daemon that ran an engine-B session:
// a real werift session over max-compat leaves the exact two UDP sockets QA
// saw after pc.close(). The daemon's shutdown wiring must still end the
// process within the grace, on SIGTERM and on the idle exit alike.
// Usage: node --experimental-strip-types leaky-daemon.mjs <sigterm|idle|hang> <graceMs>
import { createRequire } from "node:module";

const { createShutdownExit } = await import(
	new URL("../../shutdown-exit.ts", import.meta.url).href
);
const require = createRequire(import.meta.url);
const { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } =
	require("werift");

const [mode, graceArg] = process.argv.slice(2);
const shutdownExit = createShutdownExit({ graceMs: Number(graceArg) });
const udp = () =>
	process.getActiveResourcesInfo().filter((kind) => kind === "UDPWrap").length;

const peer = () => {
	const pc = new RTCPeerConnection({
		bundlePolicy: "max-compat",
		codecs: {
			audio: [
				new RTCRtpCodecParameters({
					mimeType: "audio/opus",
					clockRate: 48_000,
					channels: 2,
					payloadType: 111,
				}),
			],
			video: [],
		},
		iceServers: [],
	});
	pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
		direction: "sendrecv",
	});
	return pc;
};
const offerer = peer();
const answerer = peer();
offerer.createDataChannel("oai-events");
await offerer.setLocalDescription(await offerer.createOffer());
await answerer.setRemoteDescription(offerer.localDescription);
await answerer.setLocalDescription(await answerer.createAnswer());
await offerer.setRemoteDescription(answerer.localDescription);
const started = Date.now();
while (offerer.connectionState !== "connected" && Date.now() - started < 10_000)
	await new Promise((resolve) => setTimeout(resolve, 50));
await offerer.close();
await answerer.close();
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(`LEAKED ${udp()}`);

const cleanup = () => new Promise((resolve) => setTimeout(resolve, 100));
if (mode === "idle") {
	// run() returned on the idle exit: cleanup, then exit.
	shutdownExit.begin("run_returned");
	await cleanup();
	shutdownExit.finish(0);
} else {
	process.once("SIGTERM", async () => {
		shutdownExit.begin("signal");
		// "hang": a cleanup that never finishes must still end at the grace.
		if (mode === "hang") return;
		await cleanup();
		shutdownExit.finish(0);
	});
	console.log("READY");
}
