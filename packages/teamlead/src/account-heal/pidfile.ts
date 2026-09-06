export type {
	OwnProcessStartTimeDeps,
	PidfileRecord,
	SingletonPidfileDeps,
} from "flywheel-config";
export {
	acquireSingletonPidfile,
	parsePidfile,
	processAlive,
	processStartTime,
	resolveOwnProcessStartTime,
	safeOwnedRegularFile,
} from "flywheel-config";
