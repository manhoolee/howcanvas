import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function legacyDocumentIsNewer(legacyUpdatedAt, currentUpdatedAt) {
    const legacyTime = Date.parse(String(legacyUpdatedAt || ""));
    const currentTime = Date.parse(String(currentUpdatedAt || ""));
    return Number.isFinite(legacyTime) && (!Number.isFinite(currentTime) || legacyTime > currentTime);
}

export function createServerDatabase(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS account_sessions (
            user_id TEXT PRIMARY KEY,
            active_session_id TEXT NOT NULL,
            session_version INTEGER NOT NULL DEFAULT 1,
            last_login_at TEXT NOT NULL,
            last_login_ip TEXT NOT NULL DEFAULT '',
            last_user_agent TEXT NOT NULL DEFAULT '',
            last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_documents (
            user_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (user_id, domain)
        );

        CREATE TABLE IF NOT EXISTS image_tasks (
            task_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS image_tasks_user_status_idx ON image_tasks(user_id, status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS media_assets (
            user_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            bytes INTEGER NOT NULL DEFAULT 0,
            mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            sha256 TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (user_id, scope, storage_key)
        );
        CREATE INDEX IF NOT EXISTS media_assets_user_scope_idx ON media_assets(user_id, scope, updated_at DESC);

        CREATE TABLE IF NOT EXISTS sync_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            entity_id TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sync_events_user_sequence_idx ON sync_events(user_id, sequence);

        CREATE TABLE IF NOT EXISTS site_counters (
            counter_key TEXT PRIMARY KEY,
            value INTEGER NOT NULL CHECK (value >= 0),
            updated_at TEXT NOT NULL
        );
    `);

    const statements = {
        session: db.prepare("SELECT * FROM account_sessions WHERE user_id = ?"),
        upsertSession: db.prepare(`
            INSERT INTO account_sessions (user_id, active_session_id, session_version, last_login_at, last_login_ip, last_user_agent, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                active_session_id = excluded.active_session_id,
                session_version = excluded.session_version,
                last_login_at = excluded.last_login_at,
                last_login_ip = excluded.last_login_ip,
                last_user_agent = excluded.last_user_agent,
                last_seen_at = excluded.last_seen_at
        `),
        clearSession: db.prepare("UPDATE account_sessions SET active_session_id = '', session_version = session_version + 1, last_seen_at = ? WHERE user_id = ? AND active_session_id = ?"),
        touchSession: db.prepare("UPDATE account_sessions SET last_seen_at = ? WHERE user_id = ? AND active_session_id = ?"),
        document: db.prepare("SELECT user_id, domain, revision, updated_at, payload_json FROM server_documents WHERE user_id = ? AND domain = ?"),
        documents: db.prepare("SELECT domain, revision, updated_at FROM server_documents WHERE user_id = ? ORDER BY domain"),
        upsertDocument: db.prepare(`
            INSERT INTO server_documents (user_id, domain, revision, updated_at, payload_json)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(user_id, domain) DO UPDATE SET
                revision = server_documents.revision + 1,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            RETURNING revision, updated_at
        `),
        insertTask: db.prepare(`
            INSERT INTO image_tasks (task_id, user_id, status, created_at, updated_at, payload_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
        `),
        task: db.prepare("SELECT payload_json FROM image_tasks WHERE task_id = ? AND user_id = ?"),
        activeTasks: db.prepare("SELECT payload_json FROM image_tasks WHERE user_id = ? AND status IN ('queued', 'running', 'unknown') ORDER BY created_at"),
        interruptedTasks: db.prepare("SELECT payload_json FROM image_tasks WHERE status IN ('queued', 'running') ORDER BY created_at"),
        insertEvent: db.prepare("INSERT INTO sync_events (user_id, domain, entity_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
        cursor: db.prepare("SELECT COALESCE(MAX(sequence), 0) AS cursor FROM sync_events WHERE user_id = ?"),
        changes: db.prepare("SELECT sequence, domain, entity_id, event_type, payload_json, created_at FROM sync_events WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT ?"),
        deleteSessions: db.prepare("DELETE FROM account_sessions WHERE user_id = ?"),
        deleteDocuments: db.prepare("DELETE FROM server_documents WHERE user_id = ?"),
        deleteTasks: db.prepare("DELETE FROM image_tasks WHERE user_id = ?"),
        mediaAsset: db.prepare("SELECT user_id, scope, storage_key, bytes, mime_type, sha256, updated_at, version FROM media_assets WHERE user_id = ? AND scope = ? AND storage_key = ?"),
        mediaAssets: db.prepare("SELECT user_id, scope, storage_key, bytes, mime_type, sha256, updated_at, version FROM media_assets WHERE user_id = ? ORDER BY scope, storage_key"),
        upsertMediaAsset: db.prepare(`
            INSERT INTO media_assets (user_id, scope, storage_key, bytes, mime_type, sha256, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(user_id, scope, storage_key) DO UPDATE SET
                bytes = excluded.bytes,
                mime_type = excluded.mime_type,
                sha256 = excluded.sha256,
                updated_at = CASE
                    WHEN media_assets.bytes != excluded.bytes OR media_assets.mime_type != excluded.mime_type OR media_assets.sha256 != excluded.sha256
                    THEN excluded.updated_at ELSE media_assets.updated_at END,
                version = CASE
                    WHEN media_assets.bytes != excluded.bytes OR media_assets.mime_type != excluded.mime_type OR media_assets.sha256 != excluded.sha256
                    THEN media_assets.version + 1 ELSE media_assets.version END
            RETURNING user_id, scope, storage_key, bytes, mime_type, sha256, updated_at, version
        `),
        deleteMediaAsset: db.prepare("DELETE FROM media_assets WHERE user_id = ? AND scope = ? AND storage_key = ?"),
        deleteMediaAssets: db.prepare("DELETE FROM media_assets WHERE user_id = ?"),
        deleteEvents: db.prepare("DELETE FROM sync_events WHERE user_id = ?"),
        incrementSiteCounter: db.prepare(`
            INSERT INTO site_counters (counter_key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(counter_key) DO UPDATE SET
                value = site_counters.value + 1,
                updated_at = excluded.updated_at
            RETURNING value
        `),
    };

    function transaction(callback) {
        db.exec("BEGIN IMMEDIATE");
        try {
            const value = callback();
            db.exec("COMMIT");
            return value;
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }

    function appendEvent(userId, domain, entityId, eventType, payload = {}) {
        const now = new Date().toISOString();
        const result = statements.insertEvent.run(userId, domain, entityId || "", eventType, JSON.stringify(payload ?? {}), now);
        return Number(result.lastInsertRowid || 0);
    }

    return {
        file,
        getSession(userId) {
            return statements.session.get(userId) || null;
        },
        issueSession(userId, { reuseSessionId = "", ip = "", userAgent = "" } = {}) {
            return transaction(() => {
                const current = statements.session.get(userId);
                const reused = Boolean(reuseSessionId && current?.active_session_id === reuseSessionId);
                const sessionId = reused ? current.active_session_id : crypto.randomUUID();
                const version = reused ? Number(current.session_version || 1) : Number(current?.session_version || 0) + 1;
                const now = new Date().toISOString();
                statements.upsertSession.run(userId, sessionId, version, now, String(ip).slice(0, 200), String(userAgent).slice(0, 500), now);
                appendEvent(userId, "session", sessionId, reused ? "session.refreshed" : "session.started", { replacedSessionId: reused ? "" : current?.active_session_id || "" });
                return { sessionId, version, reused, replacedSessionId: reused ? "" : current?.active_session_id || "", lastLoginAt: now };
            });
        },
        validateSession(userId, sessionId, version) {
            const current = statements.session.get(userId);
            return Boolean(current && current.active_session_id && current.active_session_id === sessionId && Number(current.session_version) === Number(version));
        },
        touchSession(userId, sessionId) {
            statements.touchSession.run(new Date().toISOString(), userId, sessionId);
        },
        clearSession(userId, sessionId) {
            return transaction(() => {
                const result = statements.clearSession.run(new Date().toISOString(), userId, sessionId);
                if (result.changes) appendEvent(userId, "session", sessionId, "session.ended");
                return Boolean(result.changes);
            });
        },
        getDocument(userId, domain) {
            const row = statements.document.get(userId, domain);
            if (!row) return null;
            try { return { revision: Number(row.revision), updatedAt: row.updated_at, data: JSON.parse(row.payload_json) }; }
            catch { return null; }
        },
        putDocument(userId, domain, data, eventType = "document.updated") {
            return transaction(() => {
                const now = new Date().toISOString();
                const row = statements.upsertDocument.get(userId, domain, now, JSON.stringify(data ?? {}));
                const cursor = appendEvent(userId, domain, domain, eventType, { revision: Number(row.revision), updatedAt: row.updated_at });
                return { revision: Number(row.revision), updatedAt: row.updated_at, cursor };
            });
        },
        listDocuments(userId) {
            return statements.documents.all(userId).map((row) => ({ domain: row.domain, revision: Number(row.revision), updatedAt: row.updated_at }));
        },
        getTask(userId, taskId) {
            const row = statements.task.get(taskId, userId);
            if (!row) return null;
            try { return JSON.parse(row.payload_json); } catch { return null; }
        },
        saveTask(task, eventType = "task.updated") {
            return transaction(() => {
                const updatedAt = task.updatedAt || new Date().toISOString();
                task.updatedAt = updatedAt;
                statements.insertTask.run(task.id, task.userId, task.status, task.createdAt || updatedAt, updatedAt, JSON.stringify(task));
                const cursor = appendEvent(task.userId, "image-tasks", task.id, eventType, { status: task.status, updatedAt });
                return { ...task, cursor };
            });
        },
        listActiveTasks(userId) {
            return statements.activeTasks.all(userId).flatMap((row) => { try { return [JSON.parse(row.payload_json)]; } catch { return []; } });
        },
        listInterruptedTasks() {
            return statements.interruptedTasks.all().flatMap((row) => { try { return [JSON.parse(row.payload_json)]; } catch { return []; } });
        },
        getMediaAsset(userId, scope, storageKey) {
            return normalizeMediaAsset(statements.mediaAsset.get(userId, scope, storageKey));
        },
        listMediaAssets(userId) {
            return statements.mediaAssets.all(userId).map(normalizeMediaAsset);
        },
        upsertMediaAsset(asset) {
            const updatedAt = asset.updatedAt || new Date().toISOString();
            return normalizeMediaAsset(
                statements.upsertMediaAsset.get(
                    asset.userId,
                    asset.scope,
                    asset.storageKey,
                    Math.max(0, Number(asset.bytes) || 0),
                    asset.mimeType || "application/octet-stream",
                    asset.sha256 || "",
                    updatedAt,
                ),
            );
        },
        deleteMediaAsset(userId, scope, storageKey) {
            return Boolean(statements.deleteMediaAsset.run(userId, scope, storageKey).changes);
        },
        cursor(userId) {
            return Number(statements.cursor.get(userId)?.cursor || 0);
        },
        changes(userId, after = 0, limit = 200) {
            return statements.changes.all(userId, Math.max(0, Number(after) || 0), Math.min(500, Math.max(1, Number(limit) || 200))).map((row) => {
                let payload = {};
                try { payload = JSON.parse(row.payload_json); } catch {}
                return { sequence: Number(row.sequence), domain: row.domain, entityId: row.entity_id, eventType: row.event_type, payload, createdAt: row.created_at };
            });
        },
        incrementSiteCounter(counterKey, startingValue = 0) {
            const key = String(counterKey || "").trim().slice(0, 100);
            if (!key) throw new Error("计数器标识不能为空");
            const baseline = Math.max(0, Math.floor(Number(startingValue) || 0));
            const row = statements.incrementSiteCounter.get(key, baseline + 1, new Date().toISOString());
            return Number(row?.value || baseline + 1);
        },
        deleteUserData(userId) {
            transaction(() => {
                statements.deleteSessions.run(userId);
                statements.deleteDocuments.run(userId);
                statements.deleteTasks.run(userId);
                statements.deleteMediaAssets.run(userId);
                statements.deleteEvents.run(userId);
            });
        },
        close() { db.close(); },
    };
}

function normalizeMediaAsset(row) {
    if (!row) return null;
    return {
        ownerId: row.user_id,
        scope: row.scope,
        storageKey: row.storage_key,
        bytes: Number(row.bytes || 0),
        mimeType: row.mime_type || "application/octet-stream",
        sha256: row.sha256 || "",
        updatedAt: row.updated_at,
        version: Number(row.version || 1),
    };
}
