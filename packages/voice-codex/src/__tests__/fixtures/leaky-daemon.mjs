// FLY-2885 QA@1 stand-in for a voice daemon that ran an engine-B session,
// driven through the CLI's own shutdown order (superviseDaemon):
// - a real werift session over max-compat leaves QA's leaked UDP sockets;
// - a lead alert is in flight, its shell waiting on a grandchild like curl.
// The process must still end within the grace and leave no alert process.
// Usage: node --experimental-transform-types leaky-daemon.mjs
//        <sigterm|idle|hang> <graceMs> <drainMs> <alertScript>
import { createRequire } from "node:module";

const { createShutdownExit, superviseDaemon } = await import(
	new URL("../../shutdown-exit.ts", import.meta.url).href
);
const { VoiceHealthAlertDispatcher } = await import(
	new URL("../../health-alert.ts", import.meta.url).href
);
const require = createRequire(import.meta.url);
const { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } =
	require("werift");

const [mode, graceArg, drainArg, alertScript] = process.argv.slice(2);
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

const shutdownExit = createShutdownExit({ graceMs: Number(graceArg) });
const alerts = new VoiceHealthAlertDispatcher({ leadAlertPath: alertScript });
shutdownExit.onForcedExit(() => alerts.killNow());
alerts.notify("a".repeat(64));

let requestStop;
const stopped = new Promise((resolve) => {
	requestStop = resolve;
});
await superviseDaemon({
	shutdownExit,
	requestStop: () => requestStop(),
	run: async () => {
		console.log("READY");
		// "idle": run() returns on its own, like the idle exit.
		if (mode !== "idle") await stopped;
	},
	cleanup: async () => {
		// "hang": a cleanup that never ends must still stop at the deadline.
		if (mode === "hang") await new Promise(() => undefined);
		await alerts.shutdown(Number(drainArg));
	},
});
shutdownExit.finish(0);
