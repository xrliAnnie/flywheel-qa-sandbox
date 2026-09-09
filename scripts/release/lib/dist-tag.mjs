const CLEAN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PRERELEASE = /^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$/;

export function distTagForVersion(version) {
	if (CLEAN.test(version)) return "latest";
	if (PRERELEASE.test(version)) return "next";
	throw new Error(`unsupported shell version for npm dist-tag: ${version}`);
}
