import type { openKernelDb } from "../connection.js";

export function seedRetiredRows(db: ReturnType<typeof openKernelDb>): void {
	db.prepare(
		`INSERT INTO commands(id,kind,cutover_epoch,created_at)
		 VALUES ('command-root','notify',1,'2026-07-28T00:00:00.000Z'),
		        ('command-child','notify',1,'2026-07-28T00:00:01.000Z')`,
	).run();
	db.prepare(
		`INSERT INTO command_dependencies(command_id,depends_on_command_id,kind)
		 VALUES ('command-child','command-root','notify_before')`,
	).run();
	db.prepare(
		`INSERT INTO obligations
		 (id,kind,target_kind,target_agent_id,root_episode_id,depth,state,opened_at)
		 VALUES ('obligation-root','mailbox_backlog','agent','runner-a',
		         'episode-a',0,'open','2026-07-28T00:00:00.000Z')`,
	).run();
	db.prepare(
		`INSERT INTO obligations
		 (id,kind,target_kind,target_agent_id,root_episode_id,parent_obligation_id,
		  depth,state,opened_at)
		 VALUES ('obligation-child','notify','agent','runner-a','episode-a',
		         'obligation-root',1,'open','2026-07-28T00:00:01.000Z')`,
	).run();
}
