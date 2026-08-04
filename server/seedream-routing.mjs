const ARK_V3_PATH = /\/api\/(?:plan\/)?v3$/i;
const SEEDREAM_MODEL = /(?:^|[-_.])seedream(?:[-_.]|$)/i;

export function isArkSeedreamChannel(channel, model) {
    if (!SEEDREAM_MODEL.test(String(model || "").trim())) return false;
    try {
        const url = new URL(String(channel?.baseUrl || "").trim());
        return /(?:^|\.)volces\.com$/i.test(url.hostname) && ARK_V3_PATH.test(url.pathname.replace(/\/+$/, ""));
    } catch {
        return false;
    }
}

export function seedreamUpstream(channel) {
    const base = String(channel?.baseUrl || "").trim().replace(/\/+$/, "");
    if (!ARK_V3_PATH.test(base)) throw new Error("Seedream 渠道必须使用火山 Ark /api/v3 地址");
    return { url: `${base}/images/generations`, forwardPath: "/images/generations" };
}

function parseMultipartForm(body, contentType) {
    const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
    if (!boundary || boundary.length > 200) throw new Error("图片编辑请求缺少 multipart boundary");
    const marker = Buffer.from(`--${boundary}`);
    const fields = {};
    const files = [];
    let markerAt = body.indexOf(marker);
    while (markerAt >= 0) {
        let partStart = markerAt + marker.length;
        if (body.subarray(partStart, partStart + 2).toString("latin1") === "--") break;
        if (body.subarray(partStart, partStart + 2).toString("latin1") === "\r\n") partStart += 2;
        const nextMarker = body.indexOf(marker, partStart);
        if (nextMarker < 0) break;
        const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), partStart);
        if (headersEnd >= 0 && headersEnd < nextMarker) {
            const headerText = body.subarray(partStart, headersEnd).toString("latin1");
            const name = headerText.match(/content-disposition:[^\r\n]*\bname="([^"]+)"/i)?.[1] || "";
            const filename = headerText.match(/content-disposition:[^\r\n]*\bfilename="([^"]*)"/i)?.[1];
            const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "application/octet-stream";
            let dataEnd = nextMarker;
            if (body.subarray(Math.max(headersEnd + 4, dataEnd - 2), dataEnd).toString("latin1") === "\r\n") dataEnd -= 2;
            const data = body.subarray(headersEnd + 4, dataEnd);
            if (name) {
                if (filename !== undefined || name === "image" || name === "mask") files.push({ name, filename: filename || "", mimeType, data });
                else fields[name] = data.toString("utf8").trim();
            }
        }
        markerAt = nextMarker;
    }
    return { fields, files };
}

function seedreamSize(size, quality) {
    const requested = String(size || "").trim();
    if (/^\d{3,5}x\d{3,5}$/i.test(requested)) return requested.toLowerCase();
    const normalizedQuality = String(quality || "").trim().toLowerCase();
    return ["low", "standard", "1k"].includes(normalizedQuality) ? "1K" : "2K";
}

export function prepareSeedreamRequest(task, rawBody) {
    let source;
    let images = [];
    if (task.action === "edits") {
        source = parseMultipartForm(rawBody, task.requestContentType);
        if (source.files.some((file) => file.name === "mask")) throw new Error("Seedream 不接收独立 mask，请将标记直接绘制到参考图上");
        images = source.files.filter((file) => file.name === "image").map((file) => `data:${file.mimeType};base64,${file.data.toString("base64")}`);
        if (!images.length) throw new Error("Seedream 图片编辑请求缺少参考图");
    } else {
        try { source = { fields: JSON.parse(rawBody.toString("utf8")), files: [] }; }
        catch { throw new Error("Seedream 请求 JSON 格式无效"); }
        const supplied = source.fields.image;
        images = Array.isArray(supplied) ? supplied.map(String) : supplied ? [String(supplied)] : [];
    }
    if (images.length > 10) throw new Error("Seedream 最多支持 10 张参考图");
    const fields = source.fields;
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(fields.n)) || 1)));
    if (images.length + count > 15) throw new Error("Seedream 参考图与生成图总数不能超过 15 张");
    const image = images.length === 1 ? images[0] : images.length ? images : undefined;
    const payload = {
        model: task.model,
        prompt: String(fields.prompt || ""),
        ...(image ? { image } : {}),
        size: seedreamSize(fields.size, fields.quality),
        response_format: "b64_json",
        output_format: String(fields.output_format || "png").toLowerCase() === "jpeg" ? "jpeg" : "png",
        watermark: false,
    };
    return { body: Buffer.from(JSON.stringify(payload)), contentType: "application/json", count };
}

export function mergeSeedreamResults(results) {
    if (results.length === 1) return results[0];
    const payloads = results.map((body) => JSON.parse(body.toString("utf8")));
    return Buffer.from(JSON.stringify({ ...payloads[0], data: payloads.flatMap((payload) => Array.isArray(payload?.data) ? payload.data : []) }));
}
