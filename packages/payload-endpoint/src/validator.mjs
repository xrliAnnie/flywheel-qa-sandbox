// Compatibility re-export: the runtime validator is owned by the release
// contract package so B1-B5 consume the same invariant implementation.
export {
	isEmptyInitialManifest,
	validateManifest,
} from "flywheel-release-contract";
