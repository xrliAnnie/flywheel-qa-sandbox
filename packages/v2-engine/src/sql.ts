export const ENGINE_SQL = {
	readCutoverEpoch: "SELECT value FROM meta WHERE key='cutover_epoch'",
	initializeCutoverEpoch: `INSERT INTO meta(key,value,updated_at)
		VALUES ('cutover_epoch','1',@now)
		ON CONFLICT(key) DO NOTHING`,
	readAgent: `SELECT agent_id,kind,generation,instance_id,session_binding,last_poll_at,state
		FROM agents WHERE agent_id=@agentId`,
	insertProvisionedAgent: `INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
		VALUES (@agentId,@kind,0,NULL,'offline')
		ON CONFLICT(agent_id) DO NOTHING`,
	insertRegisteredAgent: `INSERT INTO agents
		(agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
		VALUES (@agentId,@kind,1,@instanceId,@sessionBinding,NULL,'online')`,
	casRegisterAgent: `UPDATE agents
		SET generation=@newGeneration,instance_id=@instanceId,
		    session_binding=@sessionBinding,last_poll_at=NULL,state='online'
		WHERE agent_id=@agentId AND kind=@kind AND generation=@oldGeneration`,
	casReattachAgent: `UPDATE agents SET last_poll_at=@now,state='online'
		WHERE agent_id=@agentId AND kind=@kind AND generation=@generation
		  AND instance_id=@instanceId AND session_binding=@sessionBinding`,
	casHeartbeat: `UPDATE agents SET last_poll_at=@now,state='online'
		WHERE agent_id=@agentId AND kind=@kind AND generation=@generation`,
	casOffline: `UPDATE agents SET state='offline'
		WHERE agent_id=@agentId AND kind=@kind AND generation=@generation`,
	readMailboxForStart: `SELECT message_uid,to_agent,state,next_retry_at,payload,kind,
			source_kind,seq,created_at
		FROM mailbox WHERE message_uid=@messageUid`,
	readRecipientRunning: `SELECT pa.attempt_uid,pa.message_uid,pa.instance_id,pa.generation,
			pa.activation_id,pa.started_at
		FROM processing_attempts pa
		JOIN mailbox m ON m.message_uid=pa.message_uid
		WHERE pa.outcome='running' AND m.to_agent=@agent
		ORDER BY pa.started_at,pa.attempt_uid`,
	readRecipientRunningMessage: `SELECT pa.attempt_uid,pa.message_uid,pa.instance_id,
			pa.generation,pa.activation_id,pa.started_at,m.payload,m.kind,m.source_kind,
			m.seq,m.created_at
		FROM processing_attempts pa
		JOIN mailbox m ON m.message_uid=pa.message_uid
		WHERE pa.outcome='running' AND m.to_agent=@agent
		ORDER BY pa.started_at,pa.attempt_uid`,
	readMaxAttemptNo: `SELECT COALESCE(MAX(attempt_no),0) AS attempt_no
		FROM processing_attempts WHERE message_uid=@messageUid`,
	insertProcessingAttempt: `INSERT INTO processing_attempts
		(attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,started_at,outcome)
		VALUES (@attemptUid,@messageUid,@attemptNo,@instanceId,@generation,@activationId,@startedAt,'running')`,
	readAttemptBinding: `SELECT pa.attempt_uid,pa.message_uid,pa.instance_id,pa.generation,
			pa.activation_id,pa.started_at,pa.outcome,m.to_agent,m.state AS mailbox_state,
			m.cutover_epoch AS mailbox_cutover_epoch
		FROM processing_attempts pa
		JOIN mailbox m ON m.message_uid=pa.message_uid
		WHERE pa.attempt_uid=@attemptUid`,
	readRunnerActionBinding: `SELECT a.attempt_id, a.generation AS attempt_generation,
			at.task_id
		FROM activations a
		JOIN attempts at ON at.id=a.attempt_id
		WHERE a.id=@activationId`,
	readActivation: `SELECT id,session_ref,generation,state
		FROM activations WHERE id=@activationId`,
	readActivationFull: `SELECT id,attempt_id,session_ref,generation,state,
			session_binding,last_poll_at
		FROM activations WHERE id=@activationId`,
	readActiveActivationBySessionRef: `SELECT id,attempt_id,session_ref,generation,state,
			session_binding,last_poll_at
		FROM activations WHERE session_ref=@sessionRef AND state='active'`,
	casActivationHeartbeat: `UPDATE activations SET last_poll_at=@now
		WHERE id=@activationId AND session_ref=@sessionRef AND state='active'`,
	readMailboxRetry: `SELECT retry_count,state,to_agent
		FROM mailbox WHERE message_uid=@messageUid`,
	insertEvent: `INSERT INTO events
		(event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,cutover_epoch,created_at)
		VALUES (@eventUid,@taskId,@attemptId,@kind,@sourceKind,@sourceId,@payload,@cutoverEpoch,@createdAt)`,
	insertEventIfAbsent: `INSERT INTO events
		(event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,cutover_epoch,created_at)
		VALUES (@eventUid,NULL,NULL,@kind,@sourceKind,@sourceId,@payload,@cutoverEpoch,@createdAt)
		ON CONFLICT(event_uid) DO NOTHING`,
	readEventByUid: `SELECT event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,
			cutover_epoch,created_at FROM events WHERE event_uid=@eventUid`,
	insertTask: `INSERT INTO tasks
		(id,project_id,kind,state,payload,lineage_root_id,created_at)
		VALUES (@id,@projectId,@kind,@state,@payload,@lineageRootId,@createdAt)`,
	countPendingForRecipient: `SELECT count(*) AS count FROM
		(SELECT 1 FROM mailbox WHERE to_agent=@agent AND state='pending'
		 LIMIT @probeLimit)`,
	insertMailbox: `INSERT INTO mailbox
		(message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
		 retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at)
		VALUES (@messageUid,@sourceKind,@sourceId,@payload,@payloadDigest,@toAgent,@kind,
		 @retentionClass,@cutoverEpoch,'pending',0,NULL,@createdAt)`,
	readMailboxByCanonicalSource: `SELECT message_uid,payload_digest,to_agent,kind,retention_class
		FROM mailbox WHERE source_kind=@sourceKind AND source_id=@sourceId`,
} as const;
