import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { videoOutcome } from "./generation-billing.mjs";
import { durationCost } from "./credit-accounting.mjs";

const execute = promisify(execFile);
export async function probeVideo(file) {
    const { stdout } = await execute(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height,duration,nb_frames", "-of", "json", file], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const stream = JSON.parse(stdout).streams?.[0];
    const durationMs = Math.round(Number(stream?.duration) * 1000);
    if (!stream || stream.codec_type !== "video" || !(stream.width > 0 && stream.height > 0) || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("视频轨或实际时长无效，待核实");
    await execute(process.env.FFMPEG_PATH || "ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-threads", "2", "-i", file, "-map", "0:v:0", "-an", "-f", "null", "-"], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { actualDurationMs: durationMs, width: stream.width, height: stream.height, durationSource: "ffprobe-video-stream" };
}

export function videoQueryUrl(receipt, channel) {
    const submissionUrl = channel?.originalBaseUrl && receipt.submissionUrl.startsWith(channel.originalBaseUrl)
        ? channel.baseUrl + receipt.submissionUrl.slice(channel.originalBaseUrl.length) : receipt.submissionUrl;
    const url = new URL(submissionUrl);
    url.pathname = url.pathname.replace(/\/v2\/video_generation$/, "/v2/query/video_generation") + `/${encodeURIComponent(receipt.taskId)}`;
    return url.href;
}

export function createVideoDelivery({ database, directory, findUser, fetchProvider, readLimited, assertSafeUrl, reserveStorage, writeAtomic, maximumBytes }) {
    fs.mkdirSync(directory, { recursive: true });
    const owner = crypto.randomUUID();
    const running = new Map();
    function fileFor(receipt) {
        if (![receipt.userId, receipt.generationTaskId].every((v) => /^[A-Za-z0-9_-]+$/.test(v))) throw new Error("视频任务标识无效");
        const folder = path.join(directory, receipt.userId);
        fs.mkdirSync(folder, { recursive: true });
        return path.join(folder, `${receipt.generationTaskId}.mp4`);
    }
    async function download(urlValue, channel) {
        let url = new URL(urlValue);
        const trusted = new URL(channel.baseUrl).origin;
        for (let redirects = 0; redirects < 5; redirects++) {
            if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("渠道视频地址无效");
            await assertSafeUrl(url, trusted);
            const response = await fetch(url, { redirect: "manual", headers: { Accept: "video/*", ...(url.origin === trusted ? { Authorization: `Bearer ${channel.apiKey}` } : {}) }, signal: AbortSignal.timeout(120000) });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                const location = response.headers.get("location");
                if (!location) throw new Error("视频下载跳转无目标");
                url = new URL(location, url);
                continue;
            }
            if (!response.ok) { await response.body?.cancel(); throw new Error(`视频取回失败 HTTP ${response.status}`); }
            if (Number(response.headers.get("content-length")) > maximumBytes) { await response.body?.cancel(); throw new Error("视频超过文件大小上限"); }
            if (!response.body) throw new Error("视频内容为空");
            return readLimited(response.body, maximumBytes);
        }
        throw new Error("视频下载跳转过多");
    }
    async function process(receipt) {
        if (!receipt.taskId || !receipt.channelRevisionId || !receipt.submissionUrl) return;
        if (!database.videoLease(receipt.id, owner)) return;
        const heartbeat = setInterval(() => database.videoLease(receipt.id, owner), 10000);
        heartbeat.unref();
        let delay = 20000;
        try {
            let current = database.getBillingReceipt(receipt.userId, receipt.id);
            if (!current || current.status !== "pending") return;
            const user = findUser(current.userId);
            if (!user) throw new Error("任务所属账号不存在，待核实");
            const channel = database.resolveChannelRevision(current.channelRevisionId);
            const target = fileFor(current);
            let metadata;
            if (!fs.existsSync(target)) {
                const response = await fetchProvider(videoQueryUrl(current, channel), channel);
                if (!response.ok) {
                    await response.body?.cancel();
                    delay = Math.max(delay, (Number(response.headers.get("retry-after")) || 0) * 1000);
                    throw new Error(`原任务查询失败 HTTP ${response.status}`);
                }
                const outcome = videoOutcome(await readLimited(response.body, 1024 * 1024));
                if (outcome.taskId && outcome.taskId !== current.taskId) throw new Error("渠道返回任务ID与原任务不符");
                if (outcome.state === "failed") {
                    database.releaseCredit(current.id, { reason: outcome.reason || "渠道确认生成失败", externalTerminal: true });
                    return;
                }
                current.upstreamState = outcome.state;
                if (outcome.reason) current.lastError = outcome.reason;
                if (outcome.state === "unknown" && Date.now() - Date.parse(current.createdAt) > 24 * 60 * 60 * 1000) current.needsReview = true;
                current.lastCheckedAt = new Date().toISOString();
                if (outcome.providerReportedSeconds) current.providerReportedSeconds = outcome.providerReportedSeconds;
                database.recordBilling(current, receipt.upstreamState !== outcome.state ? "task-status" : undefined);
                if (outcome.state !== "ready") return;
                const resultUrl = outcome.resultUrl || (/\/videos$/.test(new URL(current.submissionUrl).pathname) ? `${videoQueryUrl(current, channel)}/content` : "");
                if (!resultUrl) throw new Error("渠道已完成但结果地址尚未取得");
                database.setVideoResult(current.id, resultUrl);
                const buffer = await download(resultUrl, channel);
                if (!buffer.length) throw new Error("渠道返回空视频");
                const temporary = `${target}.probe.mp4`;
                fs.writeFileSync(temporary, buffer, { mode: 0o600 });
                try { metadata = await probeVideo(temporary); } finally { fs.unlinkSync(temporary); }
                const rollback = await reserveStorage(user, buffer.length);
                try { writeAtomic(target, buffer); } catch (error) { rollback(); throw error; }
                current = { ...current, ...metadata };
            }
            const buffer = fs.readFileSync(target);
            metadata ||= await probeVideo(target);
            current = database.getBillingReceipt(receipt.userId, receipt.id);
            if (current.status !== "pending") return;
            Object.assign(current, metadata, { media: { bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), mimeType: "video/mp4" }, deliveredAt: new Date().toISOString(), upstreamState: "ready", lastError: "" });
            if (current.pricingUnit === "second") {
                current.quantity = metadata.actualDurationMs / 1000;
                current.billableDurationMs = metadata.actualDurationMs;
            }
            database.recordBilling(current, "media-verified");
            if (current.pricingUnit === "second" && metadata.actualDurationMs > 15000) throw new Error("实际时长超过15秒预扣范围，待管理员核实");
            const cost = current.exempt ? 0 : current.pricingUnit === "second" ? durationCost(current.unitPrice, metadata.actualDurationMs) : current.reservedCost;
            database.settleCredit(current.id, cost);
        } catch (error) {
            const current = database.getBillingReceipt(receipt.userId, receipt.id);
            if (current?.status === "pending") {
                // Do not persist signed URLs, credentials or raw provider response bodies.
                const reason = error.code === "ENOENT" ? "服务器视频测量工具不可用" : String(error.message || "取回失败").replace(/https?:\/\/\S+/g, "[地址]").slice(0, 300);
                const changed = current.lastError !== reason;
                current.lastError = reason;
                current.lastCheckedAt = new Date().toISOString();
                current.attempts = Number(current.attempts || 0) + 1;
                if (/超过15秒|ID.*不符/.test(reason)) { current.needsReview = true; delay = 3600000; }
                else delay = Math.max(delay, Math.min(300000, 20000 * 2 ** Math.min(current.attempts, 4)));
                database.recordBilling(current, changed ? "delivery-failed" : undefined);
            }
        } finally {
            clearInterval(heartbeat);
            database.releaseVideoLease(receipt.id, owner, delay);
        }
    }
    function run(receipt) {
        if (running.has(receipt.id)) return running.get(receipt.id);
        if (running.size >= 2) return Promise.resolve();
        const promise = process(receipt).finally(() => running.delete(receipt.id));
        running.set(receipt.id, promise);
        return promise;
    }
    const timer = setInterval(() => {
        if (running.size >= 2) return;
        for (const receipt of database.pendingBilling().filter((r) => r.videoBilling && r.taskId && !r.needsReview)) {
            if (running.size >= 2) break;
            if (!running.has(receipt.id) && database.videoDue(receipt.id)) void run(receipt).catch(() => {});
        }
    }, 5000);
    timer.unref();
    return { run, fileFor };
}
