// Install these reviewed bytes as runtime/installer-entry.js. No imports occur
// before fixed-path/root checks. The native launcher verifies the complete tree.
const expectedRoot = "/Library/Application Support/Flywheel/Xhs/runtime";
const fail = () => {
	process.stderr.write("installed_fixture_unavailable\n");
	process.exitCode = 1;
};
if (
	process.getuid?.() !== 0 ||
	process.geteuid?.() !== 0 ||
	process.argv.length !== 2 ||
	process.execPath !== `${expectedRoot}/node` ||
	process.argv[1] !== `${expectedRoot}/installer-entry.js`
) {
	fail();
} else {
	import("./packages/teamlead/dist/xiaohongshu-write/installer-main.js")
		.then((module) => module.runInstalledFixture())
		.then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
		.catch(fail);
}
