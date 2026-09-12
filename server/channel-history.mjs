import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createChannelHistory(db, transaction, databaseFile) {
    const secretFile = path.join(path.dirname(databaseFile), "channel-credentials.json");
    let secrets = {};
    if (fs.existsSync(secretFile)) secrets = JSON.parse(fs.readFileSync(secretFile, "utf8"));
    function persistSecrets() {
        const temp = `${secretFile}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(temp, "w", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(secrets)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, secretFile);
    }
    function saveSecret(key) {
        const existing = Object.entries(secrets).find(([, value]) => value.key === key);
        if (existing) return existing[0];
        const id = crypto.randomUUID();
        secrets[id] = { key, revoked: false };
        persistSecrets();
        return id;
    }
    db.exec(`CREATE TABLE IF NOT EXISTS channel_revisions (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_lifecycle (channel_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS channel_history_events (id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, event TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_recovery (revision_id TEXT PRIMARY KEY, credential_ref TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_route_recovery (revision_id TEXT PRIMARY KEY, base_url TEXT NOT NULL);`);
    const get = db.prepare("SELECT payload_json FROM channel_revisions WHERE id=?");
    const active = db.prepare("SELECT * FROM channel_lifecycle WHERE channel_id=?");
    function revision(id) { const row = get.get(id); return row ? JSON.parse(row.payload_json) : null; }
    function log(channelId, type, actor, payload) { db.prepare("INSERT INTO channel_history_events(channel_id,event,actor_id,created_at,payload_json) VALUES(?,?,?,?,?)").run(channelId, type, actor, new Date().toISOString(), JSON.stringify(payload)); }
    return {
        registerChannelRevision(channel, actorId = "startup") {
            const credentialRef = saveSecret(channel.apiKey);
            const { apiKey, ...config } = channel;
            return transaction(() => {
                const previous = revision(active.get(channel.id)?.revision_id || "");
                const content = { ...config, credentialRef };
                delete content.archived;
                if (previous && JSON.stringify(previous.config) === JSON.stringify(content)) return previous.id;
                const id = crypto.randomUUID();
                const namespace = previous?.config.credentialRef === credentialRef && previous.config.baseUrl === channel.baseUrl ? previous.namespace : crypto.randomUUID();
                const next = { id, channelId: channel.id, namespace, adapterVersion: 1, config: content };
                db.prepare("INSERT INTO channel_revisions VALUES(?,?,?,?)").run(id, channel.id, new Date().toISOString(), JSON.stringify(next));
                db.prepare("INSERT INTO channel_lifecycle(channel_id,revision_id) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET revision_id=excluded.revision_id").run(channel.id, id);
                log(channel.id, "revision-created", actorId, { revisionId: id, previousRevisionId: previous?.id || "" });
                return id;
            });
        },
        currentChannelRevision(channelId) {
            const current = active.get(channelId);
            return current ? { ...revision(current.revision_id), archived: Boolean(current.archived) } : null;
        },
        resolveChannelRevision(id) {
            const item = revision(id);
            if (!item) throw new Error("原渠道配置版本不存在，待核实");
            const recovery = db.prepare("SELECT credential_ref FROM channel_recovery WHERE revision_id=?").get(id);
            const credential = secrets[recovery?.credential_ref || item.config.credentialRef];
            if (!credential || credential.revoked) throw new Error("原渠道凭据不可用，待管理员恢复");
            const route = db.prepare("SELECT base_url FROM channel_route_recovery WHERE revision_id=?").get(id);
            return { ...item.config, ...(route ? { originalBaseUrl: item.config.baseUrl, baseUrl: route.base_url } : {}), apiKey: credential.key };
        },
        archiveChannel(channelId, archived, actorId) {
            transaction(() => {
                db.prepare("UPDATE channel_lifecycle SET archived=? WHERE channel_id=?").run(archived ? 1 : 0, channelId);
                log(channelId, archived ? "archived" : "restored", actorId, {});
            });
        },
        channelDependencies(channelId) {
            return db.prepare("SELECT payload_json FROM billing_ledger WHERE channel_id=? AND (status='pending' OR json_extract(payload_json,'$.externalUnresolved')=1)").all(channelId).map((r) => JSON.parse(r.payload_json));
        },
        channelHistory(channelId) {
            return db.prepare("SELECT event,actor_id,created_at,payload_json FROM channel_history_events WHERE channel_id=? ORDER BY id").all(channelId);
        },
        channelRevision(id) { return revision(id); },
        recoverChannelCredential(revisionId, key, actorId, taskId, baseUrl = "") {
            const item = revision(revisionId);
            if (!item) throw new Error("渠道版本不存在");
            const ref = saveSecret(key);
            transaction(() => {
                db.prepare("INSERT INTO channel_recovery VALUES(?,?) ON CONFLICT(revision_id) DO UPDATE SET credential_ref=excluded.credential_ref").run(revisionId, ref);
                if (baseUrl) db.prepare("INSERT INTO channel_route_recovery VALUES(?,?) ON CONFLICT(revision_id) DO UPDATE SET base_url=excluded.base_url").run(revisionId, baseUrl);
                log(item.channelId, "credential-recovered", actorId, { revisionId, credentialRef: ref, taskId, baseUrl });
            });
        },
        revokeChannelCredentials(channelId, actorId) {
            const items = db.prepare("SELECT payload_json FROM channel_revisions WHERE channel_id=?").all(channelId).map((r) => JSON.parse(r.payload_json));
            for (const item of items) {
                const recovery = db.prepare("SELECT credential_ref FROM channel_recovery WHERE revision_id=?").get(item.id);
                for (const ref of [item.config.credentialRef, recovery?.credential_ref]) if (secrets[ref]) secrets[ref].revoked = true;
            }
            persistSecrets();
            log(channelId, "credentials-disabled-locally", actorId, {});
        },
    };
}
