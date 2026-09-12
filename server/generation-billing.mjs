import crypto from "node:crypto";
import Busboy from "busboy";

const VIDEO_CREATE_PATHS = [
    /^\/(?:v1\/)?videos$/,
    /^\/v2\/videos\/generations$/,
    /^\/v2\/video_generation$/,
    /^\/(?:v1\/)?contents\/generations\/tasks$/,
];

export function isVideoCreation(method, forwardPath) {
    const pathname = new URL(forwardPath, "http://local").pathname;
    return method === "POST" && VIDEO_CREATE_PATHS.some((pattern) => pattern.test(pathname));
}

export function videoTaskId(forwardPath) {
    const pathname = new URL(forwardPath, "http://local").pathname;
    const match = pathname.match(/\/(?:videos|videos\/generations|query\/video_generation|contents\/generations\/tasks)\/([^/]+)(?:\/content)?$/);
    return match ? decodeURIComponent(match[1]) : "";
}

export function videoOutcome(body) {
    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return { state: "unknown", taskId: "" }; }
    const task = payload?.task || payload?.data?.task || payload?.data || payload;
    const status = String(task?.status || payload?.status || "").toLowerCase();
    const taskId = String(task?.task_id || task?.id || payload?.task_id || payload?.id || "");
    const duration = Number(task?.seconds ?? task?.duration);
    const providerReportedSeconds = Number.isFinite(duration) && duration > 0 ? duration : undefined;
    const reason = String(task?.error?.message || payload?.error?.message || task?.fail_reason || payload?.fail_reason || task?.message || payload?.message || (typeof task?.error === "string" ? task.error : "") || status).slice(0, 500);
    if (["failed", "failure", "cancelled", "canceled", "rejected"].includes(status)) return { state: "failed", taskId, reason };
    if (status === "expired") return { state: "unknown", taskId, reason: "渠道返回过期，需核实任务或链接是否过期" };
    if (task?.error || payload?.error || (payload?.code !== undefined && ![0, 200, "0", "200"].includes(payload.code))) return { state: "unknown", taskId, reason };
    const url = task?.video_url || task?.url || task?.output || task?.result_url || task?.content?.video_url || task?.content?.url || task?.metadata?.url;
    if (typeof url === "string" || ["succeeded", "completed", "success"].includes(status)) return { state: "ready", taskId, providerReportedSeconds, resultUrl: typeof url === "string" ? url : "" };
    return { state: "pending", taskId };
}

export async function videoBillingQuantity(req, pricingUnit, channel = {}) {
    if (pricingUnit !== "second") return 1;
    let fields;
    if (/^multipart\/form-data\b/i.test(String(req.headers["content-type"] || ""))) {
        fields = await new Promise((resolve, reject) => {
            const values = {};
            const parser = Busboy({ headers: req.headers });
            parser.on("field", (name, value) => {
                if (name !== "seconds" && name !== "duration") return;
                if (name in values) { reject(new Error("视频时长参数重复")); return; }
                values[name] = value;
            });
            parser.on("file", (_name, stream) => stream.resume());
            parser.once("error", reject);
            parser.once("finish", () => resolve(values));
            parser.end(req.body);
        });
    } else {
        fields = JSON.parse(req.body.toString("utf8"));
    }
    const quantity = Number(fields.seconds ?? fields.duration);
    const automatic = quantity === -1 && /seedance/i.test(String(fields.model || ""));
    if (!automatic && (!Number.isInteger(quantity) || quantity <= 0 || quantity > 15)) throw new Error("按秒计费仅支持1至15秒，自动时长仅支持已适配的Seedance模型");
    if (!automatic && (/seedance/i.test(String(fields.model || "")) || channel.apiFormat === "minimax-h3") && quantity < 4) throw new Error("此模型的视频时长必须为4至15秒");
    if (channel.apiFormat === "grok-video-v2" && ![6, 10].includes(quantity)) throw new Error("Grok V2仅支持6秒或10秒");
    if (fields.seconds !== undefined && fields.duration !== undefined && Number(fields.seconds) !== Number(fields.duration)) throw new Error("视频 seconds 与 duration 时长参数不一致");
    req.videoRequestedSeconds = automatic ? null : quantity;
    return 15;
}

async function requestFingerprint(req, scope) {
    const contentType = String(req.headers["content-type"] || "");
    let body = req.body;
    if (/^multipart\/form-data\b/i.test(contentType)) {
        // Browsers choose a new multipart boundary on each retry; hash the actual parts.
        body = await new Promise((resolve, reject) => {
            const parts = [];
            const parser = Busboy({ headers: { "content-type": contentType } });
            parser.on("field", (name, value) => parts.push([name, "field", value]));
            parser.on("file", (name, stream, info) => {
                const hash = crypto.createHash("sha256");
                const part = [name, info.filename, info.mimeType, ""];
                parts.push(part);
                stream.on("data", (chunk) => hash.update(chunk));
                stream.once("error", reject);
                stream.once("end", () => { part[3] = hash.digest("hex"); });
            });
            parser.once("error", reject);
            parser.once("finish", () => resolve(JSON.stringify(parts)));
            parser.end(req.body);
        });
    }
    return crypto.createHash("sha256").update(scope).update("\0").update(body || "").digest("hex");
}

export async function replayGenerationRequest(database, req, res, scope) {
    const previous = database.generationRequest(req.user.id, String(req.headers["idempotency-key"] || ""));
    if (!previous) return false;
    let fingerprint;
    try { fingerprint = await requestFingerprint(req, scope); }
    catch { res.status(400).json({ error: "生成请求格式无效" }); return true; }
    if (previous.fingerprint !== fingerprint) res.status(409).json({ code: "GENERATION_CONFLICT", error: "同一生成请求标识不能用于不同参数" });
    else if (previous.response_json) {
        const response = JSON.parse(previous.response_json);
        res.status(response.status).setHeader("Content-Type", response.contentType);
        res.end(Buffer.from(response.body, "base64"));
    } else res.status(409).setHeader("Retry-After", "2").json({ code: "GENERATION_PENDING", error: "原请求仍在处理或待核实" });
    return true;
}

// Reserve before charging or contacting the provider. An interrupted reservation is
// intentionally retained: its upstream result is unknown and must not be resubmitted.
export async function reserveGenerationRequest(database, req, res, scope) {
    const requestId = String(req.headers["idempotency-key"] || "");
    if (!requestId) return true;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
        res.status(400).json({ error: "生成请求标识无效" });
        return false;
    }
    let fingerprint;
    try { fingerprint = await requestFingerprint(req, scope); }
    catch {
        res.status(400).json({ error: "生成请求格式无效" });
        return false;
    }
    if (req.aborted || res.destroyed) return false;
    const previous = database.reserveGeneration(req.user.id, requestId, fingerprint);
    if (previous) {
        if (previous.fingerprint !== fingerprint) {
            res.status(409).json({ code: "GENERATION_CONFLICT", error: "同一生成请求标识不能用于不同参数" });
        } else if (previous.response_json) {
            const response = JSON.parse(previous.response_json);
            res.status(response.status).setHeader("Content-Type", response.contentType);
            res.end(Buffer.from(response.body, "base64"));
        } else {
            res.setHeader("Retry-After", "2");
            res.status(409).json({ code: "GENERATION_PENDING", error: "原生成请求仍在处理或结果待确认，请勿重复生成" });
        }
        return false;
    }

    const end = res.end;
    const write = res.write;
    let streamed = false;
    res.write = function (...args) {
        streamed = true;
        return write.apply(this, args);
    };
    res.end = function (chunk, encoding, callback) {
        const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === "string" ? chunk : "", typeof encoding === "string" ? encoding : "utf8");
        // Only small task-submission responses are replayed, never generated media.
        if (!streamed && body.length <= 1024 * 1024) {
            database.completeGeneration(req.user.id, requestId, {
                status: res.statusCode,
                contentType: String(res.getHeader("Content-Type") || "application/json"),
                body: body.toString("base64"),
            });
        }
        return end.call(this, chunk, encoding, callback);
    };
    return true;
}
