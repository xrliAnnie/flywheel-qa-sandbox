import { describe, expect, it } from "vitest";
import type { LeadModelEnvPins } from "../../../lead-capabilities/model-env.js";
import { buildFullAccessAppServerEnv } from "../codex-lead-runtime.js";
import { buildTuiDaemonEnv } from "../codex-lead-tui-runtime.js";

const capabilityModelEnv: LeadModelEnvPins = {
	codexHome: "/trusted/codex",
	brokerSocket: "/trusted/broker/activation.sock",
	manifestPath: "/trusted/manifest.json",
	artifactRoot: "/trusted/artifacts",
	modelTempRoot: "/trusted/model-tmp",
	projectName: "flywheel",
	leadId: "flywheel-product-lead",
	activationId: "activation-1",
};
const env = {
	HOME: "/model/home",
	PATH: "/usr/bin:/bin",
	SHELL: "/bin/zsh",
	DISCORD_BOT_TOKEN: "HOST_SECRET",
	TEAMLEAD_API_TOKEN: "HOST_SECRET",
	GH_TOKEN: "HOST_SECRET",
	OPENAI_API_KEY: "HOST_SECRET",
	CUSTOM_AUTH_VALUE: "HOST_SECRET",
	NODE_OPTIONS: "HOST_SECRET",
	FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "HOST_SECRET",
	FLYWHEEL_CODEX_TUI_HOME: "/untrusted/home",
	TMPDIR: "/untrusted/tmp",
	FLYWHEEL_PROJECT_NAME: "wrong-project",
	FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
};
const expected = {
	HOME: "/model/home",
	PATH: "/usr/bin:/bin",
	SHELL: "/bin/zsh",
	TERM: "xterm-256color",
	LANG: "en_US.UTF-8",
	CODEX_HOME: "/trusted/codex",
	FLYWHEEL_CODEX_TUI_HOME: "/trusted/codex",
	TMPDIR: "/trusted/model-tmp",
	FLYWHEEL_PROJECT_NAME: "flywheel",
	FLYWHEEL_LEAD_ID: "flywheel-product-lead",
	FLYWHEEL_LEAD_CAPABILITY_ACTIVATION: "activation-1",
	FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
	FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
	FLYWHEEL_LEAD_CAPABILITY_SOCKET: "/trusted/broker/activation.sock",
	FLYWHEEL_LEAD_CAPABILITY_MANIFEST: "/trusted/manifest.json",
};
const appPins = {
	botToken: "EXPLICIT_SECRET",
	apiToken: "EXPLICIT_SECRET",
	bridgeUrl: "http://private-bridge",
	runnerActionContext: {
		env: {
			DISCORD_BOT_TOKEN: "CONTEXT_SECRET",
			CUSTOM_AUTH_VALUE: "CONTEXT_SECRET",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CONTEXT_SECRET",
			HOME: "/context/home",
		},
	},
	capabilityModelEnv,
};
const tuiOpts = {
	profile: "full-access" as const,
	env,
	codexHome: "/legacy/codex",
	botToken: "EXPLICIT_SECRET",
	bridgeUrl: "http://private-bridge",
	apiToken: "EXPLICIT_SECRET",
	carrierInstanceId: "EXPLICIT_SECRET",
	leadId: "wrong-lead",
	projectName: "wrong-project",
	capabilityModelEnv,
};
describe("explicit capability model environment boundary", () => {
	it("app-server never merges host auth, explicit credentials or runner context over trusted pins", () => {
		expect(buildFullAccessAppServerEnv(env, appPins)).toEqual(expected);
	});
	it("TUI never merges host auth, explicit credentials or carrier context over trusted pins", () => {
		expect(buildTuiDaemonEnv(tuiOpts)).toEqual(expected);
	});
	it("does not enable a companion by supplying capability pins", () => {
		expect(() =>
			buildTuiDaemonEnv({ ...tuiOpts, profile: "companion" }),
		).toThrow(/full-access/);
	});
	it("does not derive trusted activation from a host bundle marker", () => {
		const { capabilityModelEnv: _app, ...legacyApp } = appPins;
		const { capabilityModelEnv: _tui, ...legacyTui } = tuiOpts;
		const app = buildFullAccessAppServerEnv(env, legacyApp),
			tui = buildTuiDaemonEnv(legacyTui);
		expect(app.DISCORD_BOT_TOKEN).toBe("EXPLICIT_SECRET");
		expect(app.TEAMLEAD_API_TOKEN).toBe("EXPLICIT_SECRET");
		expect(app.HOME).toBe("/context/home");
		expect(app.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID).toBe("CONTEXT_SECRET");
		expect(tui.DISCORD_BOT_TOKEN).toBe("EXPLICIT_SECRET");
		expect(tui.TEAMLEAD_API_TOKEN).toBe("EXPLICIT_SECRET");
		expect(tui.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID).toBe("EXPLICIT_SECRET");
		expect(tui.FLYWHEEL_CODEX_TUI_HOME).toBe("/legacy/codex");
	});
});
