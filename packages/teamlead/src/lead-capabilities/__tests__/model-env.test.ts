import { describe, expect, it } from "vitest";
import { buildLeadModelEnv } from "../model-env.js";

const pins = {
	codexHome: "/managed/home",
	brokerSocket: "/managed/run/broker.sock",
	manifestPath: "/managed/run/manifest.json",
	artifactRoot: "/managed/run/artifacts",
	modelTempRoot: "/project/.lead-tmp",
	projectName: "flywheel",
	leadId: "product",
	activationId: "activation-1",
};
describe("bundle v2 model process environment", () => {
	it("forwards only non-secret shell basics and parent-pinned public coordinates", () => {
		const env = buildLeadModelEnv(
			{
				HOME: "/home/lead",
				PATH: "/usr/bin",
				LANG: "en_US.UTF-8",
				DISCORD_BOT_TOKEN: "discord-secret",
				TEAMLEAD_API_TOKEN: "bridge-secret",
				GH_TOKEN: "gh-secret",
				OPENAI_API_KEY: "api-secret",
				DATABASE_URL: "opaque-secret",
				FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier-secret",
				UNUSUAL_CREDENTIAL: "secret",
				NODE_OPTIONS: "--require=/work/injected.js",
				DYLD_INSERT_LIBRARIES: "/work/injected.dylib",
				HTTP_PROXY: "http://user:password@proxy",
				FLYWHEEL_PROJECT_NAME: "foreign",
			},
			pins,
		);
		expect(env.HOME).toBe("/home/lead");
		expect(env.FLYWHEEL_PROJECT_NAME).toBe("flywheel");
		expect(env.CODEX_HOME).toBe(pins.codexHome);
		expect(env.FLYWHEEL_LEAD_CAPABILITY_SOCKET).toBe(pins.brokerSocket);
		expect(JSON.stringify(env)).not.toMatch(
			/secret|carrier-secret|injected|password|foreign/,
		);
		expect(env).not.toHaveProperty("HTTP_PROXY");
		expect(env).not.toHaveProperty("NODE_OPTIONS");
	});
	it("rejects injected newlines or relative trusted coordinates", () => {
		expect(() =>
			buildLeadModelEnv({}, { ...pins, brokerSocket: "relative" }),
		).toThrow();
		expect(() =>
			buildLeadModelEnv({}, { ...pins, leadId: "product\nOTHER=1" }),
		).toThrow();
	});
});

it("uses a separate writable temp coordinate and refuses overlap with protected artifacts", () => {
	expect(buildLeadModelEnv({}, pins).TMPDIR).toBe(pins.modelTempRoot);
	for (const modelTempRoot of [
		pins.artifactRoot,
		`${pins.artifactRoot}/tmp`,
		"relative",
	])
		expect(() => buildLeadModelEnv({}, { ...pins, modelTempRoot })).toThrow();
});

it("supplies terminal and UTF-8 defaults in a minimal launchd environment", () => {
	expect(buildLeadModelEnv({}, pins)).toMatchObject({
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
	});
	expect(
		buildLeadModelEnv({ TERM: "screen-256color", LANG: "C.UTF-8" }, pins),
	).toMatchObject({ TERM: "screen-256color", LANG: "C.UTF-8" });
});
