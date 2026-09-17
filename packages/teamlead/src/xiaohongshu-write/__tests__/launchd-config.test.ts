import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { renderAuthorityLaunchd } from "../launchd-config.js";

const config = {
	serviceUid: 450,
	serviceGid: 450,
	ingressGid: 451,
	launcher: {
		path: "/Library/Application Support/Flywheel/Xhs/bin/launcher",
		sha256: "a".repeat(64),
	},
	node: {
		path: "/Library/Application Support/Flywheel/Xhs/bin/node",
		sha256: "b".repeat(64),
	},
	entry: {
		path: "/Library/Application Support/Flywheel/Xhs/bin/authority.js",
		sha256: "c".repeat(64),
	},
	ingressSocket: "/var/run/flywheel-xhs-ingress/request.sock",
	authoritySocket: "/var/run/flywheel-xhs/authority.sock",
};
it("renders a parseable system daemon with separate public and private socket groups", () => {
	const policy = "/Library/Application Support/Flywheel/Xhs/a&b/policy.json";
	const xml = renderAuthorityLaunchd(config, policy);
	const parsed = JSON.parse(
		execFileSync(
			"python3",
			[
				"-c",
				"import sys,plistlib,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))",
			],
			{ input: xml, encoding: "utf8" },
		),
	);
	expect(parsed.ProgramArguments).toEqual([
		config.launcher.path,
		config.node.path,
		config.entry.path,
		"--config",
		policy,
	]);
	expect(parsed.UserName).toBe("_flywheel_xhs");
	expect(parsed.GroupName).toBe("_flywheel_xhs");
	expect(parsed.Umask).toBe(0o077);
	expect(parsed.Sockets.Ingress).toMatchObject({
		SockPathName: config.ingressSocket,
		SockPathOwner: 0,
		SockPathGroup: 451,
		SockPathMode: 0o660,
		SockPassive: true,
		SockFamily: "Unix",
	});
	expect(parsed.Sockets.Authority).toMatchObject({
		SockPathName: config.authoritySocket,
		SockPathOwner: 450,
		SockPathGroup: 450,
		SockPathMode: 0o600,
		SockPassive: true,
	});
	expect(parsed.EnvironmentVariables).toEqual({
		PATH: "/usr/bin:/bin",
		LANG: "C",
		LC_ALL: "C",
	});
	expect(parsed.LimitLoadToSessionType).toBeUndefined();
});
it("rejects root business identity, shared groups, invalid paths and socket aliases", () => {
	for (const change of [
		{ serviceUid: 0 },
		{ ingressGid: 450 },
		{ ingressGid: 80 },
		{ authoritySocket: config.ingressSocket },
		{ ingressSocket: "relative.sock" },
	]) {
		expect(() =>
			renderAuthorityLaunchd({ ...config, ...change }, "/trusted/policy.json"),
		).toThrow("authority_launchd_invalid");
	}
	expect(() =>
		renderAuthorityLaunchd(config, "/trusted/../policy.json"),
	).toThrow("authority_launchd_invalid");
});
