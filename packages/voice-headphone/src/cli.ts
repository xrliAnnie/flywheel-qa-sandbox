#!/usr/bin/env node
/**
 * flywheel-voice-headphone — start the headphone daemon (desktop dry-run
 * audio face; the FLY-545 VC face lands in M-B4).
 */
import { loadHeadphoneConfig } from "./config.js";
import { runHeadphoneDaemon } from "./daemon.js";

const cfg = loadHeadphoneConfig({ env: process.env });
runHeadphoneDaemon(cfg).catch((err) => {
	console.error("[headphone] fatal:", err);
	process.exit(1);
});
