import crypto from "node:crypto";

export function creditUnits(value) {
    const text = String(value);
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw Object.assign(new Error("积分必须为非负数，最多六位小数"), { statusCode: 400 });
    const [whole, fraction = ""] = text.split(".");
    const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error("积分金额超出允许范围"), { statusCode: 400 });
    return Number(amount);
}

export function durationCost(unitPrice, durationMs) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("实际视频时长无效");
    const units = (BigInt(creditUnits(unitPrice)) * BigInt(durationMs) + 500n) / 1000n;
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("积分金额超出允许范围");
    return Number(units) / 1000000;
}

export function createCreditAccounting(db, transaction) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS credit_accounts (
            user_id TEXT PRIMARY KEY, available INTEGER NOT NULL CHECK(available >= 0),
            reserved INTEGER NOT NULL CHECK(reserved >= 0), usage_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credit_postings (
            operation_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
            available_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL,
            created_at TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_task_owners (
            namespace TEXT NOT NULL, task_id TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE,
            PRIMARY KEY(namespace, task_id)
        );
        CREATE TABLE IF NOT EXISTS video_runtime (
            receipt_id TEXT PRIMARY KEY, lease_owner TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
            next_check INTEGER NOT NULL DEFAULT 0, result_url TEXT NOT NULL DEFAULT ''
        );
    `);
    const account = db.prepare("SELECT * FROM credit_accounts WHERE user_id = ?");
    const receiptById = db.prepare("SELECT payload_json FROM billing_ledger WHERE receipt_id = ?");
    const writeReceipt = db.prepare(`INSERT INTO billing_ledger(receipt_id,user_id,created_at,kind,model,channel_id,task_id,status,payload_json)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(receipt_id) DO UPDATE SET task_id=excluded.task_id,status=excluded.status,payload_json=excluded.payload_json`);
    const event = db.prepare("INSERT INTO billing_events(receipt_id,event_type,created_at,payload_json) VALUES(?,?,?,?)");
    const posting = db.prepare("INSERT INTO credit_postings VALUES(?,?,?,?,?,?,?,?)");
    function readReceipt(id) { const row = receiptById.get(id); return row ? JSON.parse(row.payload_json) : null; }
    function save(receipt, type) {
        const json = JSON.stringify(receipt);
        writeReceipt.run(receipt.id, receipt.userId, receipt.createdAt, receipt.kind, receipt.model || "", receipt.channelId || "", receipt.taskId || "", receipt.status, json);
        if (type) event.run(receipt.id, type, new Date().toISOString(), json);
    }
    function change(row, da, dr, key, receiptId, actor = "system", reason = "") {
        const available = row.available + da, reserved = row.reserved + dr;
        if (![available, reserved].every((v) => Number.isSafeInteger(v) && v >= 0)) throw Object.assign(new Error("可用积分不足或账务金额异常"), { statusCode: 402 });
        db.prepare("UPDATE credit_accounts SET available=?,reserved=?,usage_json=? WHERE user_id=?").run(available, reserved, row.usage_json, row.user_id);
        posting.run(key, row.user_id, receiptId, da, dr, new Date().toISOString(), actor, reason);
    }
    function usageChange(row, receipt, amount, count) {
        const usage = JSON.parse(row.usage_json);
        usage[receipt.kind] = Math.max(0, Number(usage[receipt.kind] || 0) + count);
        usage.creditsSpent = Math.max(0, (creditUnits(usage.creditsSpent || 0) + amount) / 1000000);
        row.usage_json = JSON.stringify(usage);
    }
    return {
        initializeCredits(user) {
            return transaction(() => {
                if (account.get(user.id)) return;
                const receipts = (user.billingCharges || []).map((r) => ({ ...r, userId: user.id, generationTaskId: r.generationTaskId || crypto.randomUUID(), status: r.status || "legacy", migrated: true }));
                // Only receipts with an explicit pending state constitute an existing hold.
                const reserved = receipts.filter((r) => r.status === "pending" && !r.refunded).reduce((sum, r) => sum + creditUnits(r.cost), 0);
                const available = creditUnits(user.credits || 0);
                if (!Number.isSafeInteger(reserved)) throw new Error("迁移预扣余额超出范围");
                const usage = { image: 0, video: 0, audio: 0, text: 0, creditsSpent: 0, ...user.usage };
                usage.creditsSpent = Math.max(0, (creditUnits(usage.creditsSpent || 0) - reserved) / 1000000);
                db.prepare("INSERT INTO credit_accounts VALUES(?,?,?,?)").run(user.id, available, reserved, JSON.stringify(usage));
                posting.run(`opening:${user.id}`, user.id, "", available, reserved, new Date().toISOString(), "migration", "期初余额导入");
                for (const r of receipts) if (!readReceipt(r.id)) save(r, "imported");
            });
        },
        creditAccount(userId) {
            const row = account.get(userId);
            return row ? { credits: row.available / 1000000, reservedCredits: row.reserved / 1000000, usage: JSON.parse(row.usage_json) } : null;
        },
        reserveCredit(receipt) {
            return transaction(() => {
                const previous = readReceipt(receipt.id);
                if (previous) return previous;
                const row = account.get(receipt.userId);
                if (!row) throw new Error("积分账户不存在");
                if (receipt.channelRevisionId) {
                    const channel = db.prepare("SELECT revision_id,archived FROM channel_lifecycle WHERE channel_id=?").get(receipt.channelId);
                    if (!channel || channel.archived || channel.revision_id !== receipt.channelRevisionId) throw Object.assign(new Error("渠道配置已变化，请重新提交"), { statusCode: 409 });
                }
                const amount = creditUnits(receipt.cost);
                if (row.available < amount) throw Object.assign(new Error(`预扣需要 ${receipt.cost} 点，当前可用 ${row.available / 1000000} 点`), { statusCode: 402 });
                const next = { ...receipt, reservedCost: receipt.cost, confirmedCost: 0, returnedCost: 0, status: "pending", refunded: false };
                change(row, -amount, amount, `reserve:${next.id}`, next.id);
                save(next, "precharged");
                return next;
            });
        },
        settleCredit(receiptId, cost) {
            return transaction(() => {
                const receipt = readReceipt(receiptId);
                if (!receipt) throw new Error("账单不存在");
                if (receipt.status !== "pending") return receipt;
                if (!receipt.generationTaskId || (receipt.videoBilling && (!receipt.taskId || !receipt.media?.sha256 || !receipt.actualDurationMs))) throw new Error("任务或视频交付证据尚未齐全");
                const amount = creditUnits(cost), held = creditUnits(receipt.reservedCost ?? receipt.cost);
                if (amount > held) throw new Error("实际费用超过15秒预扣，待核实");
                const row = account.get(receipt.userId);
                usageChange(row, receipt, amount, 1);
                change(row, held - amount, -held, `settle:${receipt.id}`, receipt.id);
                const next = { ...receipt, status: "completed", cost, confirmedCost: cost, returnedCost: (held - amount) / 1000000, confirmedAt: new Date().toISOString() };
                save(next, "confirmed");
                if (held > amount) event.run(next.id, "difference-returned", next.confirmedAt, JSON.stringify(next));
                return next;
            });
        },
        releaseCredit(receiptId, { allowCompleted = false, reason = "生成失败", actorId = "system", externalTerminal = false } = {}) {
            return transaction(() => {
                const r = readReceipt(receiptId);
                if (!r) throw new Error("账单不存在");
                if (r.refunded || (r.status !== "pending" && !allowCompleted)) return r;
                const settled = r.status === "completed";
                const amount = creditUnits(settled ? r.confirmedCost ?? r.cost : r.reservedCost ?? r.cost);
                const row = account.get(r.userId);
                if (settled) usageChange(row, r, -amount, -1);
                change(row, amount, settled ? 0 : -amount, `release:${r.id}`, r.id, actorId, reason);
                const next = { ...r, refunded: true, status: "failed", externalUnresolved: Boolean(r.videoBilling && !externalTerminal), returnedCost: ((creditUnits(r.returnedCost || 0)) + amount) / 1000000, refundedAt: new Date().toISOString(), lastError: reason };
                save(next, "refunded");
                return next;
            });
        },
        adjustCredits(userId, delta, operationKey, actorId, reason) {
            return transaction(() => {
                if (!operationKey || !reason) throw Object.assign(new Error("调整积分必须提供操作标识和原因"), { statusCode: 400 });
                const key = `adjust:${userId}:${operationKey}`;
                const previous = db.prepare("SELECT * FROM credit_postings WHERE operation_key=?").get(key);
                const amount = creditUnits(Math.abs(delta)) * Math.sign(delta);
                if (previous) {
                    if (previous.available_delta !== amount || previous.reason !== reason) throw Object.assign(new Error("调整标识参数冲突"), { statusCode: 409 });
                    return;
                }
                const row = account.get(userId);
                if (!row) throw new Error("积分账户不存在");
                change(row, amount, 0, key, "", actorId, reason);
            });
        },
        updateBilling(receipt, eventType) {
            return transaction(() => {
                const current = readReceipt(receipt.id);
                if (current && current.status !== "pending") return current;
                const next = current ? { ...receipt, status: current.status, cost: current.cost, reservedCost: current.reservedCost, confirmedCost: current.confirmedCost, returnedCost: current.returnedCost, refunded: current.refunded } : receipt;
                save(next, eventType);
                return next;
            });
        },
        associateProviderTask(receiptId, namespace, taskId) {
            return transaction(() => {
                const receipt = readReceipt(receiptId);
                if (!receipt || !namespace || !taskId || (receipt.taskId && receipt.taskId !== taskId)) return false;
                const binding = db.prepare("SELECT namespace,task_id FROM provider_task_owners WHERE receipt_id=?").get(receiptId);
                if (binding && (binding.namespace !== namespace || binding.task_id !== taskId)) return false;
                const owner = db.prepare("SELECT receipt_id FROM provider_task_owners WHERE namespace=? AND task_id=?").get(namespace, taskId);
                if (owner && owner.receipt_id !== receiptId) return false;
                db.prepare("INSERT OR IGNORE INTO provider_task_owners VALUES(?,?,?)").run(namespace, taskId, receiptId);
                if (receipt && !receipt.taskId) save({ ...receipt, taskId }, "task-associated");
                return true;
            });
        },
        pendingBilling() { return db.prepare("SELECT payload_json FROM billing_ledger WHERE status='pending'").all().map((row) => JSON.parse(row.payload_json)); },
        videoLease(id, owner, ttl = 45000) {
            db.prepare("INSERT OR IGNORE INTO video_runtime(receipt_id) VALUES(?)").run(id);
            return Boolean(db.prepare("UPDATE video_runtime SET lease_owner=?,lease_until=? WHERE receipt_id=? AND (lease_owner=? OR (lease_until<? AND next_check<=?))").run(owner, Date.now() + ttl, id, owner, Date.now(), Date.now()).changes);
        },
        videoDue(id) { const row = db.prepare("SELECT lease_until,next_check FROM video_runtime WHERE receipt_id=?").get(id); return !row || (row.lease_until < Date.now() && row.next_check <= Date.now()); },
        retryVideo(id) { db.prepare("UPDATE video_runtime SET next_check=0 WHERE receipt_id=?").run(id); },
        releaseVideoLease(id, owner, delay) { db.prepare("UPDATE video_runtime SET lease_owner='',lease_until=0,next_check=? WHERE receipt_id=? AND lease_owner=?").run(Date.now() + delay, id, owner); },
        setVideoResult(id, url) {
            db.prepare("INSERT INTO video_runtime(receipt_id,result_url) VALUES(?,?) ON CONFLICT(receipt_id) DO UPDATE SET result_url=excluded.result_url").run(id, url);
        },
        videoResult(id) { return db.prepare("SELECT result_url FROM video_runtime WHERE receipt_id=?").get(id)?.result_url || ""; },
        creditPostings(userId) { return db.prepare("SELECT * FROM credit_postings WHERE user_id=? ORDER BY created_at,operation_key").all(userId); },
    };
}
