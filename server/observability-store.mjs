// Outbox references are committed with the source row; payloads are restricted at the caller.
export function createObservabilityStore(db) {
  db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}');
        CREATE INDEX IF NOT EXISTS telemetry_outbox_time ON telemetry_outbox(created_at);
        CREATE TABLE IF NOT EXISTS observability_settings(key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    `);
  for (const [table, id] of [
    ["image_tasks", "task_id"],
    ["billing_ledger", "receipt_id"],
    ["media_assets", "user_id || ':' || NEW.scope || ':' || NEW.storage_key"],
    ["credit_postings", "operation_key"],
  ]) {
    for (const action of ["INSERT", "UPDATE"])
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS observe_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN INSERT INTO telemetry_outbox(entity,entity_id,created_at) VALUES('${table}',NEW.${id},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`,
      );
  }
  // Preserve task output history when an account is deleted. Never persist its input or prompt.
  db.exec(`DROP TRIGGER IF EXISTS observe_task_delete;
        CREATE TRIGGER observe_task_delete BEFORE DELETE ON image_tasks BEGIN
        INSERT INTO telemetry_outbox(entity,entity_id,created_at,payload_json) VALUES('task-deleted',OLD.task_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('id',json_extract(OLD.payload_json,'$.id'),'userId',json_extract(OLD.payload_json,'$.userId'),'receiptId',json_extract(OLD.payload_json,'$.receiptId'),'model',json_extract(OLD.payload_json,'$.model'),'channelId',json_extract(OLD.payload_json,'$.channelId'),'createdAt',json_extract(OLD.payload_json,'$.createdAt'),'startedAt',json_extract(OLD.payload_json,'$.startedAt'),'finishedAt',json_extract(OLD.payload_json,'$.finishedAt'),'persistedAt',json_extract(OLD.payload_json,'$.persistedAt'),'status',json_extract(OLD.payload_json,'$.status'),'expectedOutputs',json_extract(OLD.payload_json,'$.expectedOutputs'),'phase',json_extract(OLD.payload_json,'$.phase'),'upstreamCompletedAt',json_extract(OLD.payload_json,'$.upstreamCompletedAt'),'retrievalStartedAt',json_extract(OLD.payload_json,'$.retrievalStartedAt'),'clientAckAt',json_extract(OLD.payload_json,'$.clientAckAt'),'clientRenderedAt',json_extract(OLD.payload_json,'$.clientRenderedAt'),'media',json(COALESCE((SELECT json_group_array(json_object('bytes',json_extract(value,'$.bytes'),'sha256',json_extract(value,'$.sha256'))) FROM json_each(OLD.payload_json,'$.media')),'[]')))); END;`);
  const insert = db.prepare(
    "INSERT INTO telemetry_outbox(entity,entity_id,created_at,payload_json) VALUES(?,?,?,?)",
  );
  return {
    observe(entity, id, data = {}) {
      insert.run(entity, id, new Date().toISOString(), JSON.stringify(data));
    },
    pruneObservations(cursor, before) {
      db.prepare(
        "DELETE FROM telemetry_outbox WHERE sequence IN (SELECT sequence FROM telemetry_outbox WHERE sequence<=? AND created_at<? LIMIT 5000)",
      ).run(cursor, before);
    },
    observationSetting(key) {
      const r = db
        .prepare("SELECT payload_json FROM observability_settings WHERE key=?")
        .get(key);
      return r ? JSON.parse(r.payload_json) : null;
    },
    setObservationSetting(key, value) {
      db.prepare(
        "INSERT INTO observability_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
      ).run(key, JSON.stringify(value));
    },
  };
}
