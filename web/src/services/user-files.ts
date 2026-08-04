// 将生成内容保存到服务器上该用户的专属 ID 目录（server/data/users/<user-id>/…）。
// 保存失败不影响生成流程（仅记录警告）。
import { backend } from "@/services/api/backend";

function extFromMime(mime: string, fallback: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/ogg": "ogg",
        "audio/aac": "aac",
        "audio/flac": "flac",
    };
    return map[mime.toLowerCase()] || fallback;
}

export function saveGeneratedDataUrl(kind: "image" | "video" | "audio", dataUrl: string): void {
    try {
        const match = /^data:([^;,]+)[^,]*,/.exec(dataUrl);
        if (!match) return;
        const mime = match[1];
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        void backend.uploadFile(kind, bytes.buffer as ArrayBuffer, extFromMime(mime, "bin")).catch((e) => console.warn("[user-files] 保存失败", e));
    } catch (e) {
        console.warn("[user-files] 保存失败", e);
    }
}

export function saveGeneratedBlob(kind: "image" | "video" | "audio", blob: Blob, fallbackExt: string): void {
    void backend.uploadFile(kind, blob, extFromMime(blob.type || "", fallbackExt)).catch((e) => console.warn("[user-files] 保存失败", e));
}

export function saveGeneratedText(content: string): void {
    if (!content.trim()) return;
    void backend.uploadFile("text", new Blob([content], { type: "text/plain" }), "txt").catch((e) => console.warn("[user-files] 保存失败", e));
}
