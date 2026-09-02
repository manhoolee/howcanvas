import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import cors from "cors";
import Busboy from "busboy";
import dotenv from "dotenv";
import express from "express";
import { createServerDatabase, legacyDocumentIsNewer } from "./database.mjs";
import { isArkSeedreamChannel, mergeSeedreamResults, prepareSeedreamRequest, seedreamUpstream } from "./seedream-routing.mjs";
import { createTaskQueue } from "./task-queue.mjs";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(serverDir, ".env") });

const PORT = Number(process.env.PORT) || 8787;
const secureAuthMode = process.env.NODE_ENV !== "development";
const configuredAuthSecret = (process.env.AUTH_SECRET || "").trim();
if (secureAuthMode && configuredAuthSecret.length < 32) {
    throw new Error("生产模式必须配置至少 32 个字符的 AUTH_SECRET");
}
const AUTH_SECRET = configuredAuthSecret || "insecure-dev-secret";
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(serverDir, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const USER_FILES_DIR = path.join(DATA_DIR, "users");
const PUBLIC_ASSETS_DIR = path.join(DATA_DIR, "public-assets");
const PUBLIC_ASSETS_FILE = path.join(DATA_DIR, "public-assets.json");
const CANVAS_DIR = path.join(DATA_DIR, "canvas");
const WORKBENCH_DIR = path.join(DATA_DIR, "workbench");
const IMAGE_TASKS_DIR = path.join(DATA_DIR, "image-tasks");
const DATABASE_FILE = path.join(DATA_DIR, "server.sqlite");

const ALL_PERMISSIONS = ["canvas", "image", "video", "prompts", "assets", "agent"];
const USAGE_KINDS = ["image", "video", "audio", "text"];
const AGENT_SKILL_IDS = [
    "image-creation",
    "video-creation",
    "canvas-orchestration",
    "quality-review",
    // Visual Workbench skills mirrored into the Canvas Agent.
    "visual-workbench-controller",
    "visual-prompt-optimizer",
    "visual-image-generator",
    "chinese-fairyland-suite",
    "oscar-director-cinematography",
    "fantasy-photo-utility",
];
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const AUTH_COOKIE = "infinite_canvas_session";
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === "true";
// 图片编辑/生成可能需要十多分钟；网关超时必须略长于或等于此值。
const AI_UPSTREAM_TIMEOUT_MS = Math.max(5_000, Number(process.env.AI_UPSTREAM_TIMEOUT_MS) || 1_200_000);
const RATE_LIMIT_WINDOW_MS = Math.max(60_000, Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000);
const MAX_USER_STORAGE_BYTES = Math.max(100 * 1024 * 1024, Number(process.env.MAX_USER_STORAGE_BYTES) || 20 * 1024 * 1024 * 1024);
const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, Number(process.env.MAX_UPLOAD_BYTES) || 100 * 1024 * 1024);
const MAX_AI_REQUEST_BYTES = Math.max(1024 * 1024, Number(process.env.MAX_AI_REQUEST_BYTES) || 128 * 1024 * 1024);
const MAX_AI_RESPONSE_BYTES = Math.max(1024 * 1024, Number(process.env.MAX_AI_RESPONSE_BYTES) || 256 * 1024 * 1024);
const MAX_TEXT_ASSET_BYTES = Math.max(64 * 1024, Number(process.env.MAX_TEXT_ASSET_BYTES) || 1024 * 1024);
const IMAGE_DOWNLOAD_TIMEOUT_MS = Math.max(5_000, Number(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS) || 120_000);
const IMAGE_TASK_CONCURRENCY = Math.min(8, Math.max(1, Math.floor(Number(process.env.IMAGE_TASK_CONCURRENCY) || 2)));
function normalizeOrigin(value) {
    try {
        const origin = new URL(String(value).trim()).origin;
        return /^https?:$/.test(new URL(origin).protocol) ? origin : "";
    } catch {
        return "";
    }
}
const CORS_ORIGINS = new Set((process.env.CORS_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(USER_FILES_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_ASSETS_DIR, { recursive: true });
fs.mkdirSync(CANVAS_DIR, { recursive: true });
fs.mkdirSync(WORKBENCH_DIR, { recursive: true });
fs.mkdirSync(IMAGE_TASKS_DIR, { recursive: true });
const database = createServerDatabase(DATABASE_FILE);

// ---------- 持久化 ----------
function loadJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}
function saveJson(file, value) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    const content = JSON.stringify(value, null, 2);
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryFile, "w", 0o600);
        fs.writeFileSync(descriptor, content, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryFile, file);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
}
function writeFileAtomic(file, data) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryFile, "w", 0o600);
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryFile, file);
        // On Linux, fsync the parent directory as well so the rename survives a
        // sudden restart after the task has been reported as persisted.
        let directoryDescriptor;
        try {
            directoryDescriptor = fs.openSync(directory, "r");
            fs.fsyncSync(directoryDescriptor);
        } catch {
            // Windows does not allow fsync on a directory handle.
        } finally {
            if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
        }
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
}
const userStorageUsage = new Map();
const userStorageQueues = new Map();

async function directorySize(directory) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { return 0; }
    const sizes = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return directorySize(entryPath);
        try { return (await fs.promises.stat(entryPath)).size; }
        catch { return 0; }
    }));
    return sizes.reduce((total, size) => total + size, 0);
}
async function measureUserStorageBytes(user) {
    const usernameDir = userFilesRoot(user);
    const safeUserId = String(user.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const canvasFiles = path.join(CANVAS_DIR, `${safeUserId}-files`);
    const workbenchFiles = path.join(WORKBENCH_DIR, safeUserId, "files");
    const taskFiles = path.join(IMAGE_TASKS_DIR, safeUserId, "files");
    const sizes = await Promise.all([usernameDir, canvasFiles, workbenchFiles, taskFiles].map(directorySize));
    return sizes.reduce((total, size) => total + size, 0);
}
async function reserveUserStorage(user, incomingBytes, replacedBytes = 0) {
    const userId = safeUserId(user);
    const previous = userStorageQueues.get(userId) || Promise.resolve();
    let releaseQueue;
    const gate = new Promise((resolve) => { releaseQueue = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    userStorageQueues.set(userId, queued);
    await previous.catch(() => {});
    try {
        let current = userStorageUsage.get(userId);
        if (!Number.isFinite(current)) {
            current = await measureUserStorageBytes(user);
            userStorageUsage.set(userId, current);
        }
        const delta = Math.max(0, incomingBytes) - Math.max(0, replacedBytes);
        if (current + delta > MAX_USER_STORAGE_BYTES) {
            const limitGb = (MAX_USER_STORAGE_BYTES / 1024 ** 3).toFixed(2);
            const error = new Error(`账户存储空间不足，当前上限为 ${limitGb}GB`);
            error.statusCode = 413;
            throw error;
        }
        userStorageUsage.set(userId, Math.max(0, current + delta));
        let rolledBack = false;
        return () => {
            if (rolledBack) return;
            rolledBack = true;
            const reserved = userStorageUsage.get(userId);
            if (Number.isFinite(reserved)) userStorageUsage.set(userId, Math.max(0, reserved - delta));
        };
    } finally {
        releaseQueue();
        if (userStorageQueues.get(userId) === queued) userStorageQueues.delete(userId);
    }
}
function releaseUserStorage(user, bytes) {
    const userId = safeUserId(user);
    const current = userStorageUsage.get(userId);
    if (Number.isFinite(current)) userStorageUsage.set(userId, Math.max(0, current - Math.max(0, bytes)));
}
function deletePrivateUserData(user) {
    const targets = [
        userFilesRoot(user),
        canvasFile(user.id),
        path.join(CANVAS_DIR, `${String(user.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-files`),
        path.join(WORKBENCH_DIR, String(user.id).replace(/[^a-zA-Z0-9_-]/g, "_")),
        path.join(IMAGE_TASKS_DIR, String(user.id).replace(/[^a-zA-Z0-9_-]/g, "_")),
    ];
    for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
    userStorageUsage.delete(safeUserId(user));
    userStorageQueues.delete(safeUserId(user));
    database.deleteUserData(user.id);
}

let users = loadJson(USERS_FILE, []);

function safeUserId(user) {
    return String(user?.id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function userFilesRoot(user) {
    return path.join(USER_FILES_DIR, safeUserId(user));
}
function migrateLegacyUserDirectories() {
    const groups = new Map();
    for (const user of users) {
        const legacyName = sanitizeFolderName(String(user.username || ""));
        const group = groups.get(legacyName) || [];
        group.push(user);
        groups.set(legacyName, group);
    }
    for (const [legacyName, group] of groups) {
        const legacy = path.join(USER_FILES_DIR, legacyName);
        if (!fs.existsSync(legacy)) continue;
        if (group.length !== 1) {
            console.warn(`[storage] 检测到旧用户名目录碰撞，已停止自动迁移：${legacyName}`);
            continue;
        }
        const target = userFilesRoot(group[0]);
        if (legacy === target || fs.existsSync(target)) continue;
        fs.renameSync(legacy, target);
        console.log(`[storage] 已迁移旧用户目录到 ID 命名空间：${safeUserId(group[0])}`);
    }
}
migrateLegacyUserDirectories();

let settings = loadJson(SETTINGS_FILE, null) || {
    pricing: {
        image: Number(process.env.PRICE_IMAGE) || 0,
        video: Number(process.env.PRICE_VIDEO) || 0,
        audio: Number(process.env.PRICE_AUDIO) || 0,
        text: Number(process.env.PRICE_TEXT) || 0,
    },
    defaultPermissions: (process.env.DEFAULT_PERMISSIONS || "canvas,image,prompts,assets")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => ALL_PERMISSIONS.includes(s)),
    defaultCredits: Number(process.env.DEFAULT_CREDITS) || 100,
    // 按具体模型定价（优先于按类型单价），如 { "gpt-image-2": 3 }
    modelPricing: (() => {
        try {
            const parsed = JSON.parse(process.env.MODEL_PRICING || "{}");
            return typeof parsed === "object" && parsed ? parsed : {};
        } catch {
            return {};
        }
    })(),
    agentLlm: {
        enabled: false,
        model: "",
        skills: [
            "image-creation",
            "video-creation",
            "canvas-orchestration",
            "quality-review",
            "visual-workbench-controller",
            "visual-prompt-optimizer",
            "visual-image-generator",
            "chinese-fairyland-suite",
            "oscar-director-cinematography",
            "fantasy-photo-utility",
        ],
    },
};
if (!settings.modelPricing || typeof settings.modelPricing !== "object") settings.modelPricing = {};
if (!settings.defaultModels || typeof settings.defaultModels !== "object") {
    settings.defaultModels = { image: "", video: "", audio: "", text: "" };
}
if (!settings.agentLlm || typeof settings.agentLlm !== "object") settings.agentLlm = {};
settings.agentLlm = {
    enabled: Boolean(settings.agentLlm.enabled),
    model: typeof settings.agentLlm.model === "string" ? settings.agentLlm.model.slice(0, 200) : "",
    skills: Array.isArray(settings.agentLlm.skills) ? settings.agentLlm.skills.filter((skill) => AGENT_SKILL_IDS.includes(skill)).slice(0, 20) : [...AGENT_SKILL_IDS],
};
const persistUsers = () => saveJson(USERS_FILE, users);
const persistSettings = () => saveJson(SETTINGS_FILE, settings);
if (!fs.existsSync(SETTINGS_FILE)) persistSettings();

// ---------- AI 渠道（多渠道，密钥只存服务器）----------
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");
let aiChannels = loadJson(CHANNELS_FILE, []);
const persistChannels = () => saveJson(CHANNELS_FILE, aiChannels);

// 一次性迁移：旧 .env 单渠道配置 → channels.json
(function migrateEnvChannel() {
    if (aiChannels.length) return;
    const baseUrl = normalizeChannelBaseUrl(process.env.AI_BASE_URL || "");
    const apiKey = (process.env.AI_API_KEY || "").trim();
    if (!baseUrl || !apiKey) {
        if (apiKey && !baseUrl) console.warn("[init] AI_BASE_URL 无效，跳过渠道迁移");
        return;
    }
    const models = [
        { name: (process.env.AI_IMAGE_MODEL || "").trim(), capability: "image" },
        { name: (process.env.AI_VIDEO_MODEL || "").trim(), capability: "video" },
        { name: (process.env.AI_AUDIO_MODEL || "").trim(), capability: "audio" },
        { name: (process.env.AI_TEXT_MODEL || "").trim(), capability: "text" },
    ].filter((m) => m.name);
    aiChannels.push({ id: "default", name: "默认渠道", baseUrl, apiKey, apiFormat: normalizeChannelApiFormat(process.env.AI_API_FORMAT), models });
    persistChannels();
    console.log("[init] 已将 .env 中的 AI 配置迁移为渠道 default");
})();

function normalizeChannelModels(models) {
    const caps = ["image", "video", "audio", "text"];
    if (!Array.isArray(models)) return [];
    const seen = new Set();
    return models
        .map((m) => ({ name: String(m?.name || "").trim().slice(0, 100), capability: caps.includes(m?.capability) ? m.capability : "image" }))
        .filter((m) => m.name && !seen.has(m.name) && seen.add(m.name))
        .slice(0, 100);
}

function normalizeChannelApiFormat(value) {
    const format = String(value || "").trim();
    return format === "gemini" || format === "grok-video-v2" || format === "minimax-h3" ? format : "openai";
}

function validateChannelProtocol(apiFormat, models) {
    if (apiFormat === "grok-video-v2") {
        return models.length === 1 && models[0].name === "grok-video-3" && models[0].capability === "video"
            ? ""
            : "Grok Video V2 渠道只能配置一个 grok-video-3 视频模型";
    }
    if (apiFormat === "minimax-h3") {
        return models.length === 1 && models[0].name === "MiniMax-H3" && models[0].capability === "video"
            ? ""
            : "MiniMax H3 渠道只能配置一个 MiniMax-H3 视频模型";
    }
    return "";
}

// ---------- 口令与令牌 ----------
function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 32).toString("hex");
}
function genSalt() {
    return crypto.randomBytes(16).toString("hex");
}
function b64url(input) {
    return Buffer.from(input).toString("base64url");
}
function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
}
function verify(token) {
    if (!token || !token.includes(".")) return null;
    const [body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}
function requestCookie(req, name) {
    const cookies = String(req.headers.cookie || "").split(";");
    const item = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
    if (!item) return "";
    try { return decodeURIComponent(item.trim().slice(name.length + 1)); } catch { return ""; }
}
function setAuthCookie(res, token) {
    res.cookie(AUTH_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true", maxAge: TOKEN_TTL_MS, path: "/" });
}
function clearAuthCookie(res) {
    res.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true", path: "/" });
}

// ---------- 用户 ----------
function zeroUsage() {
    return { image: 0, video: 0, audio: 0, text: 0, creditsSpent: 0 };
}
function publicUser(u) {
    const { passwordHash, salt, billingCharges, tokenVersion, ...rest } = u;
    return rest;
}
function findUser(id) {
    return users.find((u) => u.id === id);
}
function sanitizeFolderName(username) {
    return username.replace(/[^a-zA-Z0-9_\-一-龥]/g, "_");
}

function validUsername(value) {
    return /^[a-zA-Z0-9_\-一-龥]{3,40}$/.test(value);
}

function canvasFile(userId) {
    return path.join(CANVAS_DIR, `${String(userId).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function canvasMediaDir(userId) {
    const dir = path.join(CANVAS_DIR, `${String(userId).replace(/[^a-zA-Z0-9_-]/g, "_")}-files`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function canvasMediaPath(userId, storageKey) {
    const safeKey = String(storageKey || "");
    // Canvas media keys are generated by the client and use a fixed namespace.
    // Do not normalize arbitrary input here: values such as '..' could resolve
    // outside the user's media directory after path.join().
    if (!/^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/.test(safeKey)) return null;
    if (!safeKey || safeKey.length > 220) return null;
    return path.join(canvasMediaDir(userId), mediaStorageFilename(safeKey));
}

function mediaStorageFilename(storageKey) {
    // The logical key stays identical across clients and Linux production;
    // only the Windows development filename needs escaping for the colon.
    return process.platform === "win32" ? storageKey.replace(":", "__") : storageKey;
}

function loadCanvas(userId) {
    let document = database.getDocument(userId, "canvas");
    const legacy = loadJson(canvasFile(userId), { updatedAt: "", projects: [] });
    if (!document || legacyDocumentIsNewer(legacy.updatedAt, document.updatedAt)) {
        const migrated = { projects: Array.isArray(legacy.projects) ? legacy.projects : [] };
        const saved = database.putDocument(userId, "canvas", migrated, document ? "document.legacy-newer-migrated" : "document.migrated");
        document = { ...saved, data: migrated };
    }
    return { revision: document.revision, updatedAt: document.updatedAt, projects: Array.isArray(document.data?.projects) ? document.data.projects : [] };
}

function normalizeCanvasProjects(projects, ownerId) {
    return (Array.isArray(projects) ? projects : []).filter((project) => project && typeof project === "object" && typeof project.id === "string").slice(0, 500).map((project) => ({
        ...project,
        ownerId,
        title: String(project.title || "未命名画布").slice(0, 200),
        nodes: Array.isArray(project.nodes) ? project.nodes : [],
        connections: Array.isArray(project.connections) ? project.connections : [],
        chatSessions: Array.isArray(project.chatSessions) ? project.chatSessions : [],
        updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : new Date().toISOString(),
    }));
}

function saveCanvas(userId, projects) {
    return database.putDocument(userId, "canvas", { projects: normalizeCanvasProjects(projects, userId) }, "canvas.saved");
}

// 首次启动：种入 .env 中的管理员账号
(function seedAdmin() {
    const username = (process.env.ADMIN_USERNAME || "admin").trim();
    if (users.some((u) => u.role === "admin")) return;
    const adminPassword = (process.env.ADMIN_PASSWORD || "").trim();
    if (secureAuthMode && !adminPassword) throw new Error("生产模式首次启动必须配置 ADMIN_PASSWORD");
    const salt = genSalt();
    users.push({
        id: crypto.randomUUID(),
        username,
        displayName: "管理员",
        passwordHash: hashPassword(adminPassword || "admin123", salt),
        salt,
        role: "admin",
        permissions: [...ALL_PERMISSIONS],
        credits: 999999,
        status: "active",
        createdAt: new Date().toISOString(),
        usage: zeroUsage(),
        tokenVersion: 0,
    });
    persistUsers();
    console.log(`[init] 已种入管理员账号：${username}`);
})();

// ---------- 应用 ----------
const app = express();
const sessionStreams = new Map();

function publishUserEvent(userId, eventName, payload) {
    const streams = sessionStreams.get(userId);
    if (!streams) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const stream of [...streams]) {
        if (stream.response.destroyed || stream.response.writableEnded) {
            streams.delete(stream);
            continue;
        }
        try { stream.response.write(frame); }
        catch { streams.delete(stream); }
    }
    if (!streams.size) sessionStreams.delete(userId);
}
app.set("trust proxy", 1);
app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "infinite-canvas-server" }));
app.get("/api/auth/config", (_req, res) => res.json({ registrationEnabled: ALLOW_REGISTRATION }));
app.use(cors({
    // Same-origin requests do not send Origin and remain allowed. Cross-origin
    // access must be explicitly listed, so bearer tokens are not exposed to
    // arbitrary websites by the default configuration.
    origin(origin, callback) {
        if (!origin || CORS_ORIGINS.has(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true,
}));
app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !requestCookie(req, AUTH_COOKIE)) return next();
    const origin = String(req.headers.origin || "");
    if (!origin) return next();
    const sameOrigin = `${req.protocol}://${req.get("host")}`;
    if (origin === sameOrigin || CORS_ORIGINS.has(origin)) return next();
    return res.status(403).json({ error: "跨站请求被拒绝" });
});

function rateLimit({ max, name }) {
    const buckets = new Map();
    return (req, res, next) => {
        const now = Date.now();
        if (buckets.size > 1_000) {
            for (const [bucketKey, value] of buckets) {
                if (now - value.startedAt >= RATE_LIMIT_WINDOW_MS) buckets.delete(bucketKey);
            }
        }
        const key = `${name}:${req.ip || req.socket.remoteAddress || "unknown"}`;
        const bucket = buckets.get(key);
        if (!bucket || now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
            buckets.set(key, { startedAt: now, count: 1 });
            return next();
        }
        bucket.count += 1;
        if (bucket.count > max) {
            const retryAfter = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.startedAt)) / 1000));
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
        }
        return next();
    };
}

const aiProxyRateLimit = rateLimit({ max: 60, name: "ai" });
const miniMaxH3QueryRateLimit = rateLimit({ max: 240, name: "minimax-h3-query" });

function aiProxyRateLimitByRequest(req, res, next) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    // Only polling a submitted H3 task gets its own, still bounded bucket. Creation
    // and every other AI request retain the stricter general protection above.
    if (/^\/(?:[A-Za-z0-9_-]+\/)?v2\/query\/video_generation\/[A-Za-z0-9_-]+$/.test(pathname)) {
        return miniMaxH3QueryRateLimit(req, res, next);
    }
    return aiProxyRateLimit(req, res, next);
}

app.post("/api/landing/visits", rateLimit({ max: 30, name: "landing-visit" }), (_req, res) => {
    const visits = database.incrementSiteCounter("hoosland-home", 1000);
    res.status(201).json({ visits });
});

function sessionToken(user, session) {
    return sign({ id: user.id, ver: user.tokenVersion || 0, sid: session.sessionId, sver: session.version, exp: Date.now() + TOKEN_TTL_MS });
}

function notifyReplacedSession(userId, activeSessionId) {
    const streams = sessionStreams.get(userId);
    if (!streams) return;
    for (const stream of [...streams]) {
        if (stream.sessionId === activeSessionId) continue;
        stream.response.write(`event: session-replaced\ndata: ${JSON.stringify({ code: "SESSION_REPLACED", message: "账号已在其他设备登录" })}\n\n`);
        stream.response.end();
        streams.delete(stream);
    }
    if (!streams.size) sessionStreams.delete(userId);
}

function issueUserSession(req, res, user, allowReuse = true) {
    const existing = verify(requestCookie(req, AUTH_COOKIE));
    const reuseSessionId = allowReuse && existing?.id === user.id && database.validateSession(user.id, existing.sid, existing.sver) ? existing.sid : "";
    const session = database.issueSession(user.id, { reuseSessionId, ip: req.ip || req.socket.remoteAddress || "", userAgent: req.headers["user-agent"] || "" });
    setAuthCookie(res, sessionToken(user, session));
    if (session.replacedSessionId) notifyReplacedSession(user.id, session.sessionId);
    return session;
}

function auth(req, res, next) {
    const header = req.headers.authorization || "";
    const headerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
    const cookieToken = requestCookie(req, AUTH_COOKIE);
    const payload = verify(headerToken) || verify(cookieToken);
    const user = payload ? findUser(payload.id) : null;
    if (!user || user.status === "disabled" || Number(payload.ver || 0) !== Number(user.tokenVersion || 0)) return res.status(401).json({ error: "未登录或登录已过期", code: "AUTH_EXPIRED" });
    if (!payload.sid) {
        const current = database.getSession(user.id);
        if (current?.active_session_id) {
            res.setHeader("X-Auth-Error", "SESSION_REPLACED");
            return res.status(401).json({ error: "账号已在其他设备登录", code: "SESSION_REPLACED" });
        }
        const session = issueUserSession(req, res, user, false);
        payload.sid = session.sessionId;
        payload.sver = session.version;
    }
    if (!database.validateSession(user.id, payload.sid, payload.sver)) {
        res.setHeader("X-Auth-Error", "SESSION_REPLACED");
        return res.status(401).json({ error: "账号已在其他设备登录", code: "SESSION_REPLACED" });
    }
    req.user = user;
    req.sessionId = payload.sid;
    req.sessionVersion = Number(payload.sver || 0);
    next();
}

function requirePermission(...permissions) {
    return (req, res, next) => {
        if (req.user.role === "admin" || permissions.some((permission) => req.user.permissions?.includes(permission))) return next();
        return res.status(403).json({ error: "当前账户没有使用该功能的权限" });
    };
}

function canUseCapability(user, capability) {
    if (user.role === "admin") return true;
    if (capability === "image" || capability === "video") return user.permissions?.includes(capability);
    if (capability === "text") return user.permissions?.includes("agent") || user.permissions?.includes("canvas");
    if (capability === "audio") return user.permissions?.includes("canvas");
    return false;
}

function aiPathAllowed(forwardPath, capability, method) {
    const pathname = new URL(forwardPath, "http://local").pathname;
    const rules = {
        image: [
            ["POST", /^\/(?:v1\/)?images\/(?:generations|edits|variations)$/],
            ["POST", /^\/(?:v1\/)?responses$/],
            ["POST", /^\/(?:v1beta\/)?models\/[^/]+:(?:generateContent|streamGenerateContent)$/],
        ],
        video: [
            ["POST", /^\/(?:v1\/)?videos$/],
            ["GET", /^\/(?:v1\/)?videos\/[A-Za-z0-9._-]+(?:\/content)?$/],
            ["POST", /^\/v2\/videos\/generations$/],
            ["GET", /^\/v2\/videos\/generations\/[A-Za-z0-9%:._-]+$/],
            ["POST", /^\/v2\/video_generation$/],
            ["GET", /^\/v2\/query\/video_generation\/[A-Za-z0-9_-]+$/],
            ["POST", /^\/(?:v1\/)?contents\/generations\/tasks$/],
            ["GET", /^\/(?:v1\/)?contents\/generations\/tasks\/[A-Za-z0-9._-]+$/],
        ],
        audio: [["POST", /^\/(?:v1\/)?audio\/speech$/]],
        text: [
            ["POST", /^\/(?:v1\/)?(?:chat\/completions|responses)$/],
            ["POST", /^\/(?:v1beta\/)?models\/[^/]+:(?:generateContent|streamGenerateContent)$/],
        ],
    };
    return (rules[capability] || []).some(([allowedMethod, pattern]) => method === allowedMethod && pattern.test(pathname));
}

function channelProtocolAllowsPath(channel, forwardPath, capability) {
    if (capability !== "video") return true;
    const pathname = new URL(forwardPath, "http://local").pathname;
    const isGrokVideoV2Path = /^\/v2\/videos\/generations(?:\/|$)/.test(pathname);
    const isMiniMaxH3Path = /^\/v2\/(?:video_generation|query\/video_generation\/[A-Za-z0-9_-]+)$/.test(pathname);
    if (channel.apiFormat === "grok-video-v2") return isGrokVideoV2Path;
    if (channel.apiFormat === "minimax-h3") return isMiniMaxH3Path;
    return !isGrokVideoV2Path && !isMiniMaxH3Path;
}

function multipartModel(body, contentType) {
    return new Promise((resolve, reject) => {
        let model = "";
        let parser;
        try {
            parser = Busboy({ headers: { "content-type": contentType }, limits: { fields: 100, files: 20, fileSize: MAX_AI_REQUEST_BYTES } });
        } catch (error) {
            reject(error);
            return;
        }
        parser.on("field", (name, value) => {
            if (name === "model") model = String(value);
        });
        parser.on("file", (_name, stream) => stream.resume());
        parser.once("error", reject);
        parser.once("finish", () => resolve(model));
        parser.end(body);
    });
}

async function requestModel(req, forwardPath) {
    const headerModel = String(req.headers["x-infinite-canvas-model"] || "").trim();
    if (!headerModel) return "";
    if (["GET", "HEAD"].includes(req.method) || !Buffer.isBuffer(req.body) || !req.body.length) return headerModel;
    const contentType = String(req.headers["content-type"] || "");
    const normalizedContentType = contentType.toLowerCase();
    let bodyModel = "";
    if (normalizedContentType.includes("application/json")) {
        try { bodyModel = String(JSON.parse(req.body.toString("utf8"))?.model || "").trim(); } catch { throw new Error("AI 请求 JSON 格式无效"); }
    } else if (normalizedContentType.includes("multipart/form-data")) {
        bodyModel = String(await multipartModel(req.body, contentType)).trim();
    } else if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
        bodyModel = String(new URLSearchParams(req.body.toString("utf8")).get("model") || "").trim();
    }
    const geminiMatch = new URL(forwardPath, "http://local").pathname.match(/\/models\/([^/:]+):/);
    const pathModel = geminiMatch ? decodeURIComponent(geminiMatch[1]).replace(/^models\//, "") : "";
    const declaredModel = bodyModel || pathModel;
    if (declaredModel && declaredModel !== headerModel) throw new Error("AI 请求模型与服务器授权模型不一致");
    return headerModel;
}

function beginProxyCharge(user, capability, model) {
    const modelPrice = Number.isFinite(Number(settings.modelPricing[model])) ? Number(settings.modelPricing[model]) : null;
    const unitPrice = modelPrice !== null ? modelPrice : Number(settings.pricing[capability]) || 0;
    const cost = user.role === "admin" ? 0 : Math.max(0, unitPrice);
    if (user.role !== "admin" && user.credits < cost) {
        const error = new Error(`额度不足：本次生成需要 ${cost} 点，当前余额 ${user.credits} 点`);
        error.statusCode = 402;
        throw error;
    }
    user.credits = Math.max(0, user.credits - cost);
    user.usage ||= zeroUsage();
    user.usage[capability] = Number(user.usage[capability] || 0) + 1;
    user.usage.creditsSpent = Number(user.usage.creditsSpent || 0) + cost;
    user.billingCharges ||= [];
    const receipt = { id: crypto.randomUUID(), kind: capability, model, cost, refunded: false, source: "proxy", status: "pending", createdAt: new Date().toISOString() };
    user.billingCharges.push(receipt);
    user.billingCharges = user.billingCharges.slice(-200);
    persistUsers();
    return receipt;
}

function rollbackProxyCharge(user, receipt) {
    if (!receipt || receipt.refunded) return;
    user.credits += receipt.cost;
    user.usage[receipt.kind] = Math.max(0, Number(user.usage[receipt.kind] || 0) - 1);
    user.usage.creditsSpent = Math.max(0, Number(user.usage.creditsSpent || 0) - receipt.cost);
    receipt.refunded = true;
    receipt.status = "failed";
    receipt.refundedAt = new Date().toISOString();
    persistUsers();
}

function completeProxyCharge(receipt) {
    if (!receipt) return;
    receipt.status = "completed";
    persistUsers();
}

async function readBodyLimited(body, maximum) {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
        size += chunk.length;
        if (size > maximum) {
            await body.cancel().catch(() => {});
            throw new Error("AI 上游响应超过服务器大小限制");
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function requestWithGrokAiohttp(url, { method, headers, body, signal }) {
    const executable = process.env.GROK_AIOHTTP_PYTHON || "python3";
    const helper = process.env.GROK_AIOHTTP_HELPER || path.join(serverDir, "grok_request.py");
    const requestBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const metadata = Buffer.from(`${JSON.stringify({
        url,
        method,
        headers,
        bodyLength: requestBody.length,
        timeoutMs: AI_UPSTREAM_TIMEOUT_MS,
        maxResponseBytes: MAX_AI_RESPONSE_BYTES,
    })}\n`, "utf8");

    return new Promise((resolve, reject) => {
        const child = spawn(executable, [helper], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        const cleanup = () => signal?.removeEventListener("abort", abortChild);
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (child.exitCode === null) child.kill("SIGKILL");
            reject(error);
        };
        const abortChild = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("Grok 上游请求已中止"));

        if (signal?.aborted) return abortChild();
        signal?.addEventListener("abort", abortChild, { once: true });
        child.once("error", (error) => fail(new Error(`Grok aiohttp 传输启动失败: ${error.message}`)));
        child.stdin.once("error", (error) => {
            if (error.code !== "EPIPE") fail(new Error(`Grok aiohttp 请求写入失败: ${error.message}`));
        });
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_AI_RESPONSE_BYTES + 64 * 1024) return fail(new Error("Grok aiohttp 响应超过服务器大小限制"));
            stdoutChunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            if (stderrBytes >= 16 * 1024) return;
            const retained = chunk.subarray(0, 16 * 1024 - stderrBytes);
            stderrChunks.push(retained);
            stderrBytes += retained.length;
        });
        child.once("close", (code) => {
            if (settled) return;
            if (code !== 0) {
                const detail = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 1000);
                return fail(new Error(`Grok aiohttp 传输失败（退出码 ${code}）${detail ? `: ${detail}` : ""}`));
            }
            try {
                const output = Buffer.concat(stdoutChunks);
                const separator = output.indexOf(0x0a);
                if (separator < 0 || separator > 64 * 1024) throw new Error("Grok aiohttp 响应头部无效");
                const responseMetadata = JSON.parse(output.subarray(0, separator).toString("utf8"));
                const responseBody = output.subarray(separator + 1);
                const status = Number(responseMetadata.status);
                if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Grok aiohttp 响应状态码无效");
                if (responseBody.length !== Number(responseMetadata.bodyLength)) throw new Error("Grok aiohttp 响应长度不一致");
                settled = true;
                cleanup();
                resolve({
                    status,
                    ok: status >= 200 && status < 300,
                    headers: {
                        get(name) {
                            return String(name).toLowerCase() === "content-type" ? responseMetadata.contentType || null : null;
                        },
                    },
                    body: responseBody.length ? Readable.toWeb(Readable.from([responseBody])) : null,
                });
            } catch (error) {
                fail(error);
            }
        });
        child.stdin.end(Buffer.concat([metadata, requestBody]));
    });
}

// ---------- 持久化图片任务 ----------
// 浏览器只负责提交和查询；上游请求由服务器持有，因此切换页面、刷新或关闭标签页
// 都不会中断已经提交的文生图/图生图任务。
const activeImageTasks = new Map();
const imageTaskQueue = createTaskQueue({
    concurrency: IMAGE_TASK_CONCURRENCY,
    worker: ({ userId, taskId }) => runImageTask(userId, taskId),
    onError: (error, task) => console.error(`[image-task] queue worker ${task.taskId} failed: ${error?.message || error}`),
});

function safeTaskId(value) {
    const id = String(value || "");
    return /^[a-f0-9-]{36}$/i.test(id) ? id : "";
}

function imageTaskUserDir(userId) {
    const dir = path.join(IMAGE_TASKS_DIR, String(userId).replace(/[^a-zA-Z0-9_-]/g, "_"));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function imageTaskPaths(userId, taskId) {
    const id = safeTaskId(taskId);
    if (!id) return null;
    const dir = imageTaskUserDir(userId);
    return {
        metadata: path.join(dir, `${id}.json`),
        request: path.join(dir, `${id}.request`),
        result: path.join(dir, `${id}.result`),
    };
}

function loadImageTask(userId, taskId) {
    const paths = imageTaskPaths(userId, taskId);
    if (!paths) return null;
    const stored = database.getTask(userId, taskId);
    if (stored) return stored;
    if (!fs.existsSync(paths.metadata)) return null;
    const legacy = loadJson(paths.metadata, null);
    if (legacy?.id && legacy.userId === userId) database.saveTask(legacy, "task.migrated");
    return legacy;
}

function saveImageTask(task, eventType) {
    const paths = imageTaskPaths(task.userId, task.id);
    if (!paths) throw new Error("图片任务 ID 无效");
    task.updatedAt = new Date().toISOString();
    database.saveTask(task, eventType || `task.${task.status}`);
}

function updateImageTask(task, changes, eventName = "image-task-updated", databaseEventType) {
    Object.assign(task, changes);
    saveImageTask(task, databaseEventType || `task.${task.phase || task.status}`);
    publishUserEvent(task.userId, eventName, { task: publicImageTask(task) });
}

function publicImageTask(task) {
    return {
        id: task.id,
        status: task.status,
        phase: task.phase || (task.status === "queued" ? "queued" : task.status === "running" ? "generating" : task.status === "succeeded" ? "persisted" : task.status === "failed" ? "failed" : task.status),
        action: task.action,
        model: task.model,
        createdAt: task.createdAt,
        startedAt: task.startedAt || "",
        finishedAt: task.finishedAt || "",
        updatedAt: task.updatedAt,
        upstreamStatus: task.upstreamStatus || 0,
        error: task.error || "",
        upstreamCompletedAt: task.upstreamCompletedAt || "",
        retrievalStartedAt: task.retrievalStartedAt || "",
        persistedAt: task.persistedAt || "",
        deliveryStatus: task.deliveryStatus || "pending",
        clientAckAt: task.clientAckAt || "",
        media: Array.isArray(task.media) ? task.media.map((item) => ({
            storageKey: item.storageKey,
            url: item.url,
            bytes: item.bytes,
            mimeType: item.mimeType,
            sha256: item.sha256,
            persistedAt: item.persistedAt,
        })) : [],
        context: task.context && typeof task.context === "object" ? task.context : undefined,
    };
}

function imageTaskUpstream(channel, action) {
    let forwardPath = `/v1/images/${action}`;
    let base = channel.baseUrl.trim().replace(/\/+$/, "");
    if (channel.apiFormat === "grok-video-v2" && /\/v1$/i.test(base) && forwardPath.toLowerCase().startsWith("/v2/")) {
        // Grok V2 is rooted at /v2 even when an OpenAI-compatible channel was
        // originally saved with a trailing /v1 base path.
        base = base.slice(0, -3);
    } else if (/\/(?:v1|v1beta)$/i.test(base) && forwardPath.toLowerCase().startsWith(`${base.slice(base.lastIndexOf("/")).toLowerCase()}/`)) {
        forwardPath = forwardPath.slice(base.slice(base.lastIndexOf("/")).length);
    } else if (/\/api\/(?:plan\/)?v3$/i.test(base) && forwardPath.toLowerCase().startsWith("/v1/")) {
        forwardPath = forwardPath.slice(3);
    }
    return { url: base + forwardPath, forwardPath };
}

function imageTaskReceipt(user, receiptId) {
    return Array.isArray(user?.billingCharges) ? user.billingCharges.find((item) => item.id === receiptId) : null;
}

async function runImageTask(userId, taskId) {
    const task = loadImageTask(userId, taskId);
    const paths = imageTaskPaths(userId, taskId);
    if (!task || !paths || activeImageTasks.has(taskId) || !["queued", "running"].includes(task.status)) return;
    const user = findUser(userId);
    const channel = aiChannels.find((item) => item.id === task.channelId);
    const receipt = imageTaskReceipt(user, task.receiptId);
    if (!user || !channel || !channel.baseUrl || !channel.apiKey || !fs.existsSync(paths.request)) {
        updateImageTask(task, { status: "failed", phase: "failed", error: "后台图片任务配置或请求数据不存在", finishedAt: new Date().toISOString() });
        if (user && receipt) rollbackProxyCharge(user, receipt);
        return;
    }

    const controller = new AbortController();
    activeImageTasks.set(taskId, controller);
    updateImageTask(task, { status: "running", phase: "generating", startedAt: task.startedAt || new Date().toISOString(), error: "" });

    try {
        const rawRequest = fs.readFileSync(paths.request);
        const seedreamTask = task.routeKind === "seedream" || isArkSeedreamChannel(channel, task.model);
        if (task.routeKind === "seedream" && !isArkSeedreamChannel(channel, task.model)) throw new Error("Seedream 专用任务的渠道或模型无效");
        const prepared = seedreamTask
            ? { ...prepareSeedreamRequest(task, rawRequest), provider: "ark-seedream" }
            : { body: rawRequest, contentType: task.requestContentType || "application/octet-stream", count: 1, provider: "compatible" };
        const { url, forwardPath } = seedreamTask ? seedreamUpstream(channel) : imageTaskUpstream(channel, task.action);
        task.upstreamProvider = prepared.provider;
        task.upstreamPath = forwardPath;
        saveImageTask(task, "task.routed");
        console.info(`[image-task] route ${task.id} ${channel.id} ${prepared.provider} POST ${forwardPath}`);
        const key = channel.apiKey.trim();
        const headers = { Authorization: `Bearer ${key}`, "Content-Type": prepared.contentType };
        if (channel.apiFormat === "gemini") headers["x-goog-api-key"] = key;
        const resultBodies = [];
        let contentType = "application/json";
        let resultBytes = 0;
        for (let index = 0; index < prepared.count; index += 1) {
            const upstream = await fetch(url, {
                method: "POST",
                headers,
                body: prepared.body,
                signal: AbortSignal.any([AbortSignal.timeout(AI_UPSTREAM_TIMEOUT_MS), controller.signal]),
            });
            contentType = upstream.headers.get("content-type") || contentType;
            const body = upstream.body ? await readBodyLimited(upstream.body, MAX_AI_RESPONSE_BYTES) : Buffer.alloc(0);
            task.upstreamStatus = upstream.status;
            if (!upstream.ok) {
                const summary = body.toString("utf8").replace(/[\r\n\t]+/g, " ").slice(0, 1000);
                console.warn(`[image-task] upstream ${upstream.status} POST ${forwardPath}: ${summary}`);
                updateImageTask(task, { status: "failed", phase: "failed", error: summary || `上游请求失败（${upstream.status}）`, finishedAt: new Date().toISOString() });
                if (receipt) rollbackProxyCharge(user, receipt);
                return;
            }
            resultBytes += body.length;
            if (resultBytes > MAX_AI_RESPONSE_BYTES) throw new Error("AI 上游响应超过服务器大小限制");
            resultBodies.push(body);
        }
        const resultBody = seedreamTask ? mergeSeedreamResults(resultBodies) : resultBodies[0];
        const upstreamCompletedAt = new Date().toISOString();
        updateImageTask(task, { phase: "upstream-complete", upstreamCompletedAt });
        updateImageTask(task, { phase: "retrieving", retrievalStartedAt: new Date().toISOString() });
        const media = await persistImageTaskResult(user, task, channel, contentType, resultBody, controller.signal);
        const persistedAt = new Date().toISOString();
        const normalizedResult = { data: media.map((item) => ({ ...item, serverTaskId: task.id })) };
        writeFileAtomic(paths.result, Buffer.from(JSON.stringify(normalizedResult), "utf8"));
        updateImageTask(task, {
            status: "succeeded",
            phase: "persisted",
            media,
            resultContentType: "application/json; charset=utf-8",
            resultBytes: Buffer.byteLength(JSON.stringify(normalizedResult)),
            persistedAt,
            finishedAt: persistedAt,
            deliveryStatus: "pending",
        }, "image-task-completed");
        console.log(`[image-task] ${task.id} persisted ${media.length} image(s), ${media.reduce((total, item) => total + item.bytes, 0)} bytes`);
        if (receipt) {
            completeProxyCharge(receipt);
            persistUsers();
        }
    } catch (error) {
        const latest = loadImageTask(userId, taskId) || task;
        if (latest.status === "canceled") return;
        const cause = error?.cause;
        updateImageTask(latest, {
            status: "failed",
            phase: "failed",
            error: [error?.message || String(error), cause?.code, cause?.message].filter(Boolean).join(" · ").slice(0, 1000),
            finishedAt: new Date().toISOString(),
        });
        console.error(`[image-task] ${taskId} failed: ${latest.error}`);
        if (receipt) rollbackProxyCharge(user, receipt);
    } finally {
        activeImageTasks.delete(taskId);
        try { fs.unlinkSync(paths.request); } catch {}
    }
}

function decodeTaskContext(value) {
    const encoded = String(value || "");
    if (!encoded || encoded.length > 4_000) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        return Object.fromEntries(Object.entries(parsed).slice(0, 20).map(([key, item]) => [String(key).slice(0, 80), typeof item === "string" ? item.slice(0, 500) : typeof item === "number" || typeof item === "boolean" ? item : undefined]).filter(([, item]) => item !== undefined));
    } catch {
        return undefined;
    }
}

function createQueuedImageTask(req, { channel, action, model, routeKind }) {
    const now = new Date().toISOString();
    const task = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        channelId: channel.id,
        action,
        model,
        routeKind,
        status: "queued",
        phase: "queued",
        requestContentType: String(req.headers["content-type"] || "application/octet-stream"),
        context: decodeTaskContext(req.headers["x-infinite-canvas-context"]),
        createdAt: now,
        updatedAt: now,
    };
    const paths = imageTaskPaths(task.userId, task.id);
    let receipt;
    try {
        receipt = beginProxyCharge(req.user, "image", model);
        task.receiptId = receipt?.id || "";
        writeFileAtomic(paths.request, req.body);
        saveImageTask(task, "task.queued");
        return task;
    } catch (error) {
        if (receipt) rollbackProxyCharge(req.user, receipt);
        try { fs.unlinkSync(paths.request); } catch {}
        throw error;
    }
}

function dispatchQueuedImageTask(res, task) {
    res.status(202).json({ task: publicImageTask(task) });
    publishUserEvent(task.userId, "image-task-updated", { task: publicImageTask(task) });
    imageTaskQueue.enqueue(task.userId, task.id);
}

function migrateLegacyImageTasks() {
    try {
        for (const userEntry of fs.readdirSync(IMAGE_TASKS_DIR, { withFileTypes: true })) {
            if (!userEntry.isDirectory()) continue;
            const userDir = path.join(IMAGE_TASKS_DIR, userEntry.name);
            for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
                const task = loadJson(path.join(userDir, entry.name), null);
                if (task?.id && task?.userId && !database.getTask(task.userId, task.id)) database.saveTask(task, "task.migrated");
            }
        }
    } catch (error) {
        console.warn(`[database] 旧图片任务迁移失败：${error?.message || error}`);
    }
}

function recoverInterruptedImageTasks() {
    for (const task of database.listInterruptedTasks()) {
        if (task.status === "queued") {
            imageTaskQueue.enqueue(task.userId, task.id);
            continue;
        }
        task.status = "unknown";
        task.phase = "unknown";
        task.error = "服务器重启时渠道请求仍在运行，无法确认渠道最终结果；为避免重复扣费，系统没有自动重试。";
        task.finishedAt = new Date().toISOString();
        saveImageTask(task, "task.unknown");
    }
}

migrateLegacyImageTasks();
recoverInterruptedImageTasks();

app.post("/api/image-tasks/:channelId/:action", (req, _res, next) => {
    if (req.params.action === "generations" || req.params.action === "edits") return next();
    return next("route");
}, auth, rateLimit({ max: 60, name: "image-task-submit" }), express.raw({ type: "*/*", limit: MAX_AI_REQUEST_BYTES }), async (req, res) => {
    const action = req.params.action;
    const channel = aiChannels.find((item) => item.id === req.params.channelId);
    if (!channel) return res.status(404).json({ error: "图片任务渠道或接口不存在" });
    if (!channel.baseUrl || !channel.apiKey) return res.status(503).json({ error: "图片任务渠道配置不完整" });
    const forwardPath = `/v1/images/${action}`;
    let model;
    try { model = await requestModel(req, forwardPath); }
    catch (error) { return res.status(400).json({ error: error.message || "图片任务模型无效" }); }
    const modelConfig = channel.models.find((item) => item.name === model);
    if (!modelConfig || modelConfig.capability !== "image") return res.status(403).json({ error: "图片模型未在服务器渠道中授权" });
    if (!canUseCapability(req.user, "image")) return res.status(403).json({ error: "当前账户没有使用图片模型的权限" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "图片任务请求体为空" });

    let task;
    try {
        task = createQueuedImageTask(req, { channel, action, model, routeKind: isArkSeedreamChannel(channel, model) ? "seedream" : "image" });
    } catch (error) {
        return res.status(error?.statusCode || 500).json({ error: error?.message || "创建图片任务失败" });
    }
    dispatchQueuedImageTask(res, task);
});

app.post("/api/seedream-tasks/:channelId/:action", auth, rateLimit({ max: 60, name: "seedream-task-submit" }), express.raw({ type: "*/*", limit: MAX_AI_REQUEST_BYTES }), async (req, res) => {
    const action = req.params.action === "generations" || req.params.action === "edits" ? req.params.action : "";
    const channel = aiChannels.find((item) => item.id === req.params.channelId);
    if (!action || !channel) return res.status(404).json({ error: "Seedream 任务渠道或接口不存在" });
    if (!channel.baseUrl || !channel.apiKey) return res.status(503).json({ error: "Seedream 渠道配置不完整" });
    let model;
    try { model = await requestModel(req, `/v1/images/${action}`); }
    catch (error) { return res.status(400).json({ error: error.message || "Seedream 模型无效" }); }
    const modelConfig = channel.models.find((item) => item.name === model);
    if (!modelConfig || modelConfig.capability !== "image" || !isArkSeedreamChannel(channel, model)) return res.status(403).json({ error: "该渠道或模型不是火山 Ark Seedream" });
    if (!canUseCapability(req.user, "image")) return res.status(403).json({ error: "当前账户没有使用图片模型的权限" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Seedream 任务请求体为空" });

    let task;
    try {
        task = createQueuedImageTask(req, { channel, action, model, routeKind: "seedream" });
    } catch (error) {
        return res.status(error?.statusCode || 500).json({ error: error?.message || "创建 Seedream 任务失败" });
    }
    dispatchQueuedImageTask(res, task);
});

app.get("/api/image-tasks/:taskId", auth, (req, res) => {
    const task = loadImageTask(req.user.id, req.params.taskId);
    if (!task) return res.status(404).json({ error: "图片任务不存在" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ task: publicImageTask(task) });
});

app.get("/api/image-tasks/:taskId/result", auth, (req, res) => {
    const task = loadImageTask(req.user.id, req.params.taskId);
    const paths = imageTaskPaths(req.user.id, req.params.taskId);
    if (!task || !paths) return res.status(404).json({ error: "图片任务不存在" });
    if (task.status !== "succeeded" || !fs.existsSync(paths.result)) return res.status(409).json({ error: task.error || "图片任务尚未完成" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", task.resultContentType || "application/json");
    res.setHeader("Content-Length", fs.statSync(paths.result).size);
    res.sendFile(paths.result);
});

app.get("/api/image-tasks/:taskId/media/:storageKey", auth, (req, res) => {
    const task = loadImageTask(req.user.id, req.params.taskId);
    if (!task || task.status !== "succeeded") return res.status(404).json({ error: "图片任务媒体不存在" });
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).json({ error: "媒体 storageKey 无效" }); }
    const media = Array.isArray(task.media) ? task.media.find((item) => item.storageKey === storageKey) : null;
    const target = media ? imageTaskMediaTarget(task, storageKey) : null;
    if (!media || !target?.file || !fs.existsSync(target.file)) return res.status(404).json({ error: "图片任务媒体不存在" });
    res.setHeader("Content-Type", media.mimeType || "application/octet-stream");
    res.setHeader("ETag", `"${media.sha256}"`);
    res.setHeader("X-File-Sha256", media.sha256);
    res.sendFile(target.file);
});

app.post("/api/image-tasks/:taskId/ack", auth, express.json({ limit: "32kb" }), (req, res) => {
    const task = loadImageTask(req.user.id, req.params.taskId);
    if (!task) return res.status(404).json({ error: "图片任务不存在" });
    if (task.status !== "succeeded") return res.status(409).json({ error: "图片任务尚未完成落盘" });
    if (!task.clientAckAt) {
        const metrics = req.body?.metrics && typeof req.body.metrics === "object"
            ? Object.fromEntries(Object.entries(req.body.metrics).slice(0, 10).map(([key, value]) => [String(key).slice(0, 60), Number(value)]).filter(([, value]) => Number.isFinite(value) && value >= 0))
            : undefined;
        updateImageTask(task, { deliveryStatus: "delivered", clientAckAt: new Date().toISOString(), ...(metrics && Object.keys(metrics).length ? { deliveryMetrics: metrics } : {}) }, "image-task-updated", "task.delivery-ack");
        console.log(`[image-task] ${task.id} delivery acknowledged`);
    }
    res.json({ ok: true, task: publicImageTask(task) });
});

app.post("/api/image-tasks/:taskId/cancel", auth, (req, res) => {
    const task = loadImageTask(req.user.id, req.params.taskId);
    if (!task) return res.status(404).json({ error: "图片任务不存在" });
    if (!["queued", "running"].includes(task.status)) return res.status(409).json({ error: "图片任务已经结束" });
    const wasQueued = task.status === "queued";
    updateImageTask(task, { status: "canceled", phase: "canceled", error: "任务已取消", finishedAt: new Date().toISOString() });
    imageTaskQueue.remove(req.user.id, task.id);
    if (wasQueued) {
        const paths = imageTaskPaths(req.user.id, task.id);
        try { fs.unlinkSync(paths.request); } catch {}
    }
    activeImageTasks.get(task.id)?.abort(new Error("任务已取消"));
    const receipt = imageTaskReceipt(req.user, task.receiptId);
    if (receipt) rollbackProxyCharge(req.user, receipt);
    res.json({ task: publicImageTask(task) });
});

// ---------- AI 接口代理（按渠道路由）----------
// 前端不持有真实 API Key：请求发到 /api/ai/<渠道id>/*，由服务器查出该渠道的密钥后转发。
// 必须注册在 express.json 之前，保证请求体原样透传（JSON / multipart / 二进制均可）。
app.use("/api/ai", auth, aiProxyRateLimitByRequest, express.raw({ type: "*/*", limit: MAX_AI_REQUEST_BYTES }), async (req, res) => {
    // 路径形如 /<channelId>/v1...；仅兼容旧路径 /v1...，未知渠道不再静默回退。
    let forwardPath = req.url;
    let channel = null;
    const match = forwardPath.match(/^\/([A-Za-z0-9_-]+)(\/.*)$/);
    if (match) {
        const found = aiChannels.find((c) => c.id === match[1]);
        if (found) {
            channel = found;
            forwardPath = match[2];
        }
    }
    if (!channel && /^\/v1(?:beta)?\//i.test(forwardPath)) channel = aiChannels[0] || null;
    if (!channel) return res.status(404).json({ error: "AI 渠道不存在" });
    if (!channel || !channel.baseUrl || !channel.apiKey) {
        return res.status(503).json({ error: "服务器未配置 AI 渠道，请管理员在「管理后台 → 渠道与模型」中添加" });
    }

    let model;
    try { model = await requestModel(req, forwardPath); }
    catch (error) { return res.status(400).json({ error: error.message || "AI 请求模型无效" }); }
    const modelConfig = channel.models.find((item) => item.name === model);
    if (!modelConfig) return res.status(403).json({ error: "AI 模型未在服务器渠道中授权" });
    if (!canUseCapability(req.user, modelConfig.capability)) return res.status(403).json({ error: "当前账户没有使用该模型能力的权限" });
    if (!aiPathAllowed(forwardPath, modelConfig.capability, req.method)) return res.status(403).json({ error: "该 AI 接口路径不在服务器允许列表中" });
    if (!channelProtocolAllowsPath(channel, forwardPath, modelConfig.capability)) return res.status(403).json({ error: "当前渠道协议不允许该视频接口路径" });

    const base = channel.baseUrl.trim().replace(/\/+$/, "");
    const legacySeedancePath = base.toLowerCase().includes("api.seedance.nz") && /^\/v1\/contents\/generations\/tasks(?:\/|$)/i.test(forwardPath);
    // 兼容旧版前端的 Seedance 路径；新渠道统一使用 /v1/videos。
    if (legacySeedancePath) forwardPath = forwardPath.replace(/^\/v1\/contents\/generations\/tasks/i, "/v1/videos");
    const key = channel.apiKey.trim();
    // 前端按 OpenAI 惯例会拼出 /v1/...；若渠道 Base URL 本身已带 /v1 则去重
    if (/\/(?:v1|v1beta)$/i.test(base) && forwardPath.toLowerCase().startsWith(`${base.slice(base.lastIndexOf("/")).toLowerCase()}/`)) {
        forwardPath = forwardPath.slice(base.slice(base.lastIndexOf("/")).length);
    } else if (/\/v1$/i.test(base) && forwardPath.toLowerCase().startsWith("/v1/")) {
        forwardPath = forwardPath.slice(3);
    } else if (/\/api\/(?:plan\/)?v3$/i.test(base) && forwardPath.toLowerCase().startsWith("/v1/")) {
        // 前端按 OpenAI 约定发送 /v1；火山方舟 Base URL 已包含 /api/v3。
        forwardPath = forwardPath.slice(3);
    }
    const url = base + forwardPath;

    const headers = { Authorization: `Bearer ${key}` };
    if (channel.apiFormat === "gemini") headers["x-goog-api-key"] = key;
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
    if (channel.apiFormat === "grok-video-v2") {
        headers.Accept = "application/json";
        headers["User-Agent"] = "Python/3.11 aiohttp/3.13.5";
    } else if (req.headers.accept) headers.Accept = req.headers.accept;

    let upstreamBody = req.body;
    if (legacySeedancePath && req.method === "POST" && Buffer.isBuffer(req.body)) {
        try {
            const legacy = JSON.parse(req.body.toString("utf8"));
            const content = Array.isArray(legacy.content) ? legacy.content : [];
            const text = content.find((item) => item?.type === "text")?.text || legacy.prompt || "";
            const oldModel = String(legacy.model || model);
            const normalizedModel = oldModel.toLowerCase();
            const apiModel = /^seedance-2\.0-(?:global-)?(?:standard|fast|mini)-(?:t2v|i2v|multi)$/i.test(oldModel)
                ? oldModel
                : `seedance-2.0-global-${normalizedModel.includes("mini") ? "mini" : normalizedModel.includes("fast") ? "fast" : "standard"}-multi`;
            upstreamBody = Buffer.from(JSON.stringify({
                model: apiModel,
                ...(String(text).trim() ? { prompt: String(text).trim() } : {}),
                seconds: String(legacy.duration ?? "5"),
                metadata: {
                    resolution: legacy.resolution || "720p",
                    ratio: legacy.ratio || "adaptive",
                    generate_audio: legacy.generate_audio !== false,
                    ...(content.length ? { content } : {}),
                },
            }));
            headers["Content-Type"] = "application/json";
        } catch {
            return res.status(400).json({ error: "Seedance 请求格式无效" });
        }
    }

    let receipt;
    const clientAbortController = new AbortController();
    const abortForDisconnectedClient = () => {
        if (!res.writableEnded) clientAbortController.abort(new Error("AI 客户端已断开"));
    };
    res.once("close", abortForDisconnectedClient);
    try {
        receipt = beginProxyCharge(req.user, modelConfig.capability, model);
        const requestOptions = {
            method: req.method,
            headers,
            body: ["GET", "HEAD"].includes(req.method) || !Buffer.isBuffer(upstreamBody) ? undefined : upstreamBody,
            signal: AbortSignal.any([AbortSignal.timeout(AI_UPSTREAM_TIMEOUT_MS), clientAbortController.signal]),
        };
        const upstream = channel.apiFormat === "grok-video-v2"
            ? await requestWithGrokAiohttp(url, requestOptions)
            : await fetch(url, requestOptions);
        const contentType = upstream.headers.get("content-type");
        if (!upstream.ok) {
            const body = upstream.body ? await readBodyLimited(upstream.body, Math.min(MAX_AI_RESPONSE_BYTES, 1024 * 1024)) : Buffer.alloc(0);
            rollbackProxyCharge(req.user, receipt);
            const summary = body.toString("utf8").replace(/[\r\n\t]+/g, " ").slice(0, 500);
            console.warn(`[ai] upstream ${upstream.status} ${req.method} ${forwardPath}: ${summary}`);
            if (contentType) res.setHeader("Content-Type", contentType);
            return res.status(upstream.status).end(body);
        }
        completeProxyCharge(receipt);
        res.status(upstream.status);
        if (contentType) res.setHeader("Content-Type", contentType);
        if (!upstream.body) return res.end();
        const isStream = contentType?.toLowerCase().includes("text/event-stream") || String(req.headers.accept || "").toLowerCase().includes("text/event-stream");
        if (isStream) {
            // 流式转发（兼容 SSE 文本流）
            res.setHeader("X-Accel-Buffering", "no");
            let streamed = 0;
            for await (const chunk of upstream.body) {
                streamed += chunk.length;
                if (streamed > MAX_AI_RESPONSE_BYTES) throw new Error("AI 上游流式响应超过服务器大小限制");
                res.write(chunk);
            }
            res.end();
        } else {
            // 图片/视频等非流式响应先完整读取，避免上游断流时向浏览器发送半截 200。
            const body = await readBodyLimited(upstream.body, MAX_AI_RESPONSE_BYTES);
            res.end(body);
        }
    } catch (error) {
        if (!res.headersSent) rollbackProxyCharge(req.user, receipt);
        // 上游可能在已发送部分响应后断开；此时不能再次设置状态码/JSON，
        // 否则会触发 ERR_HTTP_HEADERS_SENT 并崩溃整个后端进程。
        if (res.headersSent) {
            res.destroy(error instanceof Error ? error : undefined);
            return;
        }
        if (!res.destroyed && !res.writableEnded) {
            res.status(error?.statusCode || 502).json({ error: `AI 接口转发失败：${error?.message || error}` });
        }
    } finally {
        res.off("close", abortForDisconnectedClient);
    }
});

app.use(express.json({ limit: "20mb" }));

function adminOnly(req, res, next) {
    if (req.user.role !== "admin") return res.status(403).json({ error: "需要管理员权限" });
    next();
}

// ---------- 认证 ----------
app.post("/api/auth/register", rateLimit({ max: 10, name: "register" }), (req, res) => {
    if (!ALLOW_REGISTRATION) return res.status(403).json({ error: "公开注册已关闭，请联系管理员创建账户" });
    const { username = "", password = "", displayName = "" } = req.body || {};
    const name = String(username).trim();
    if (!validUsername(name)) return res.status(400).json({ error: "用户名需为 3-40 位中文、字母、数字、下划线或连字符" });
    if (String(password).length < 10) return res.status(400).json({ error: "密码至少 10 个字符" });
    if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "该用户名已被注册" });

    const salt = genSalt();
    const user = {
        id: crypto.randomUUID(),
        username: name,
        displayName: String(displayName).trim() || name,
        passwordHash: hashPassword(String(password), salt),
        salt,
        role: "user",
        permissions: [...settings.defaultPermissions],
        credits: settings.defaultCredits,
        status: "active",
        createdAt: new Date().toISOString(),
        usage: zeroUsage(),
        tokenVersion: 0,
    };
    users.push(user);
    persistUsers();
    const session = issueUserSession(req, res, user, false);
    res.json({ user: publicUser(user), syncCursor: database.cursor(user.id), session: { lastLoginAt: session.lastLoginAt } });
});

app.post("/api/auth/login", rateLimit({ max: 20, name: "login" }), (req, res) => {
    const { username = "", password = "" } = req.body || {};
    const user = users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
    if (!user || user.passwordHash !== hashPassword(String(password), user.salt)) return res.status(401).json({ error: "用户名或密码错误" });
    if (user.status === "disabled") return res.status(403).json({ error: "该账号已被禁用，请联系管理员" });
    const session = issueUserSession(req, res, user, true);
    res.json({ user: publicUser(user), syncCursor: database.cursor(user.id), session: { lastLoginAt: session.lastLoginAt, reused: session.reused } });
});

app.post("/api/auth/logout", auth, (req, res) => {
    database.clearSession(req.user.id, req.sessionId);
    clearAuthCookie(res);
    res.json({ ok: true });
});

// 服务器代取带签名的外部媒体，避免浏览器直接读取对象存储时触发 CORS。
app.get("/api/media/proxy", auth, async (req, res) => {
    const rawUrl = String(req.query.url || "");
    let target;
    try { target = new URL(rawUrl); } catch { return res.status(400).json({ error: "媒体地址无效" }); }
    const host = target.hostname.toLowerCase();
    const allowed = /(?:\.volces\.com|\.aiproxy\.vip|api\.seedance\.nz)$/.test(host) || host === "algeng-video-infer.oss-cn-shanghai.aliyuncs.com";
    if (target.protocol !== "https:" || !allowed) {
        return res.status(403).json({ error: "媒体地址不在允许列表" });
    }
    try {
        const upstream = await fetch(target, { signal: AbortSignal.timeout(120_000) });
        if (!upstream.ok || !upstream.body) return res.status(upstream.status || 502).json({ error: "媒体下载失败" });
        res.status(200);
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
        if (upstream.headers.get("content-length")) res.setHeader("Content-Length", upstream.headers.get("content-length"));
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
        return res.status(502).json({ error: error?.message || "媒体下载失败" });
    }
});

app.get("/api/auth/me", auth, (req, res) => {
    res.json({ user: publicUser(req.user) });
});

app.get("/api/sync/handshake", auth, (req, res) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    // 首次握手时完成旧 JSON 文档的惰性迁移，之后所有读写均以 SQLite 为准。
    loadCanvas(req.user.id);
    loadWorkbenchLogs(req.user.id, "image");
    loadWorkbenchLogs(req.user.id, "video");
    database.touchSession(req.user.id, req.sessionId);
    res.json({
        cursor: database.cursor(req.user.id),
        documents: database.listDocuments(req.user.id),
        changes: database.changes(req.user.id, after),
        activeImageTasks: database.listActiveTasks(req.user.id).map(publicImageTask),
    });
});

app.get("/api/session/events", auth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const stream = { sessionId: req.sessionId, response: res };
    const streams = sessionStreams.get(req.user.id) || new Set();
    streams.add(stream);
    sessionStreams.set(req.user.id, streams);
    res.write(`event: ready\ndata: ${JSON.stringify({ cursor: database.cursor(req.user.id) })}\n\n`);
    const heartbeat = setInterval(() => {
        database.touchSession(req.user.id, req.sessionId);
        res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 20_000);
    req.on("close", () => {
        clearInterval(heartbeat);
        streams.delete(stream);
        if (!streams.size) sessionStreams.delete(req.user.id);
    });
});

// ---------- 账户画布（服务器为主数据，浏览器只做版本化缓存） ----------
app.get("/api/canvas/meta", auth, requirePermission("canvas"), (req, res) => {
    const canvas = loadCanvas(req.user.id);
    res.json({ revision: canvas.revision, updatedAt: canvas.updatedAt, projectCount: canvas.projects.length });
});

app.get("/api/canvas", auth, requirePermission("canvas"), (req, res) => {
    const canvas = loadCanvas(req.user.id);
    res.json({ revision: canvas.revision, updatedAt: canvas.updatedAt, projects: canvas.projects });
});

app.put("/api/canvas", auth, requirePermission("canvas"), (req, res) => {
    const baseUpdatedAt = String(req.body?.baseUpdatedAt || "");
    const current = loadCanvas(req.user.id);
    if (baseUpdatedAt && current.updatedAt && baseUpdatedAt !== current.updatedAt) {
        return res.status(409).json({ error: "画布已在其他设备更新", updatedAt: current.updatedAt, projects: current.projects });
    }
    const saved = saveCanvas(req.user.id, req.body?.projects);
    res.json({ ok: true, revision: saved.revision, updatedAt: saved.updatedAt, cursor: saved.cursor, projectCount: normalizeCanvasProjects(req.body?.projects, req.user.id).length });
});

app.put("/api/canvas/files/:storageKey", auth, requirePermission("canvas"), rateLimit({ max: 60, name: "canvas-file-upload" }), express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).json({ error: "媒体 storageKey 无效" }); }
    const file = canvasMediaPath(req.user.id, storageKey);
    if (!file) return res.status(400).json({ error: "媒体 storageKey 无效" });
    const body = req.body || Buffer.alloc(0);
    let rollbackQuota;
    let writeCompleted = false;
    try {
        rollbackQuota = await reserveUserStorage(req.user, body.length, fs.existsSync(file) ? fs.statSync(file).size : 0);
        writeFileAtomic(file, body);
        writeCompleted = true;
        const updatedAt = new Date().toISOString();
        const mimeType = req.headers["content-type"] || "application/octet-stream";
        const sha256 = crypto.createHash("sha256").update(body).digest("hex");
        saveJson(`${file}.meta.json`, { mimeType, sha256, bytes: body.length, updatedAt });
        const media = database.upsertMediaAsset({ userId: req.user.id, scope: "canvas", storageKey, bytes: body.length, mimeType, sha256, updatedAt });
        res.json({ ok: true, storageKey, media });
    } catch (error) {
        if (!writeCompleted) rollbackQuota?.();
        return res.status(error.statusCode || 500).json({ error: error.message || "保存画布媒体失败" });
    }
});

app.head("/api/canvas/files/:storageKey", auth, requirePermission("canvas"), (req, res) => {
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).end(); }
    const file = canvasMediaPath(req.user.id, storageKey);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    const metadata = indexedMediaMetadata(req.user.id, "canvas", storageKey, file);
    res.setHeader("Content-Type", metadata.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(metadata.bytes));
    res.setHeader("ETag", `"${metadata.sha256}"`);
    res.setHeader("X-File-Sha256", metadata.sha256);
    res.setHeader("X-Media-Version", String(metadata.version));
    res.setHeader("Last-Modified", new Date(metadata.updatedAt).toUTCString());
    res.end();
});

app.get("/api/canvas/file-meta/:storageKey", auth, requirePermission("canvas"), (req, res) => {
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).json({ error: "媒体 storageKey 无效" }); }
    const file = canvasMediaPath(req.user.id, storageKey);
    if (!file) return res.status(400).json({ error: "媒体 storageKey 无效" });
    const exists = fs.existsSync(file);
    if (!exists) return res.json({ exists: false, size: 0 });
    const metadata = indexedMediaMetadata(req.user.id, "canvas", storageKey, file);
    res.json({ exists: true, size: metadata.bytes, sha256: metadata.sha256, mimeType: metadata.mimeType, updatedAt: metadata.updatedAt, version: metadata.version });
});

app.get("/api/media-index", auth, (req, res) => {
    const allowedScopes = new Set();
    if (req.user.role === "admin" || req.user.permissions.includes("canvas")) allowedScopes.add("canvas");
    if (req.user.role === "admin" || req.user.permissions.includes("image")) allowedScopes.add("workbench-image");
    if (req.user.role === "admin" || req.user.permissions.includes("video")) allowedScopes.add("workbench-video");
    const entries = database.listMediaAssets(req.user.id).filter((entry) => allowedScopes.has(entry.scope));
    const updatedAt = entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, "");
    res.json({ ownerId: req.user.id, updatedAt, entries });
});

function workbenchKind(value) {
    return value === "image" || value === "video" ? value : "";
}
function workbenchUserDir(userId) {
    return path.join(WORKBENCH_DIR, String(userId).replace(/[^a-zA-Z0-9_-]/g, "_"));
}
function workbenchLogFile(userId, kind) {
    return path.join(workbenchUserDir(userId), `${kind}.json`);
}
function workbenchMediaPath(userId, storageKey) {
    if (!/^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/.test(storageKey) || storageKey.length > 220) return null;
    return path.join(workbenchUserDir(userId), "files", mediaStorageFilename(storageKey));
}

function imageMimeFromBuffer(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
    if (buffer.length >= 12 && buffer.toString("ascii", 4, 12).includes("ftypavif")) return "image/avif";
    if (buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM") return "image/bmp";
    return "";
}

function decodeImageDataUrl(value) {
    const match = String(value || "").match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return null;
    if (match[2].length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 16) throw Object.assign(new Error("渠道图片超过服务器单文件大小限制"), { statusCode: 413 });
    return Buffer.from(match[2].replace(/\s/g, ""), "base64");
}

function imageSourcesFromPayload(payload) {
    const groups = [payload?.data, payload?.images, payload?.output?.data, payload?.output?.images].filter(Array.isArray);
    const items = groups.flat().slice(0, 15);
    return items.map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        if (typeof item.b64_json === "string" && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
        return [item.url, item.image_url, item.data].find((value) => typeof value === "string" && value) || "";
    }).filter(Boolean);
}

function isPrivateNetworkAddress(address) {
    const value = String(address || "").toLowerCase();
    if (value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    const ipv4 = mapped || (/^\d+\.\d+\.\d+\.\d+$/.test(value) ? value : "");
    if (!ipv4) return false;
    const octets = ipv4.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

async function assertSafeImageUrl(url, trustedChannelOrigin) {
    if (url.origin === trustedChannelOrigin) return;
    if (url.hostname.toLowerCase() === "localhost") throw new Error("渠道图片 URL 不允许访问服务器本地地址");
    let addresses;
    try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); }
    catch { throw new Error("渠道图片 URL 域名解析失败"); }
    if (!addresses.length || addresses.some((item) => isPrivateNetworkAddress(item.address))) throw new Error("渠道图片 URL 不允许访问服务器私网地址");
}

async function retrieveImageSource(source, controllerSignal, trustedChannelOrigin) {
    const inline = decodeImageDataUrl(source);
    if (inline) return inline;
    let url;
    try { url = new URL(String(source)); }
    catch { throw new Error("渠道返回了无效的图片 URL"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("渠道图片 URL 只允许 HTTP(S)");
    await assertSafeImageUrl(url, trustedChannelOrigin);
    const response = await fetch(url, {
        headers: { Accept: "image/*" },
        signal: AbortSignal.any([AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS), controllerSignal]),
    });
    if (response.url) await assertSafeImageUrl(new URL(response.url), trustedChannelOrigin);
    if (!response.ok) throw new Error(`服务器取回渠道图片失败（${response.status}）`);
    const declaredLength = Number(response.headers.get("content-length")) || 0;
    if (declaredLength > MAX_UPLOAD_BYTES) throw Object.assign(new Error("渠道图片超过服务器单文件大小限制"), { statusCode: 413 });
    return response.body ? readBodyLimited(response.body, MAX_UPLOAD_BYTES) : Buffer.alloc(0);
}

function imageTaskMediaTarget(task, storageKey) {
    if (task.context?.surface === "canvas") {
        return { file: canvasMediaPath(task.userId, storageKey), url: `/api/canvas/files/${encodeURIComponent(storageKey)}`, scope: "canvas" };
    }
    if (task.context?.surface === "workbench" && task.context?.kind === "image") {
        return { file: workbenchMediaPath(task.userId, storageKey), url: `/api/workbench/image/files/${encodeURIComponent(storageKey)}`, scope: "workbench-image" };
    }
    const file = path.join(imageTaskUserDir(task.userId), "files", mediaStorageFilename(storageKey));
    return { file, url: `/api/image-tasks/${encodeURIComponent(task.id)}/media/${encodeURIComponent(storageKey)}`, scope: "" };
}

async function persistImageTaskMedia(user, task, buffer) {
    if (!buffer.length) throw new Error("渠道返回了空图片");
    const mimeType = imageMimeFromBuffer(buffer);
    if (!mimeType) throw new Error("渠道返回内容不是真实的受支持图片");
    const storageKey = `image:${crypto.randomUUID()}`;
    const target = imageTaskMediaTarget(task, storageKey);
    if (!target.file) throw new Error("图片任务存储路径无效");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    let rollbackQuota;
    try {
        rollbackQuota = await reserveUserStorage(user, buffer.length, fs.existsSync(target.file) ? fs.statSync(target.file).size : 0);
        writeFileAtomic(target.file, buffer);
        const persistedAt = new Date().toISOString();
        saveJson(`${target.file}.meta.json`, { storageKey, serverTaskId: task.id, bytes: buffer.length, mimeType, sha256, persistedAt, updatedAt: persistedAt });
        const indexed = target.scope
            ? database.upsertMediaAsset({ userId: task.userId, scope: target.scope, storageKey, bytes: buffer.length, mimeType, sha256, updatedAt: persistedAt })
            : null;
        return { storageKey, url: target.url, bytes: buffer.length, mimeType, sha256, persistedAt, ...(indexed ? { version: indexed.version } : {}) };
    } catch (error) {
        rollbackQuota?.();
        try { fs.unlinkSync(target.file); } catch {}
        try { fs.unlinkSync(`${target.file}.meta.json`); } catch {}
        throw error;
    }
}

async function persistImageTaskResult(user, task, channel, contentType, body, controllerSignal) {
    let sources;
    if (String(contentType).toLowerCase().startsWith("image/")) sources = [body];
    else {
        let payload;
        try { payload = JSON.parse(body.toString("utf8")); }
        catch { throw new Error("渠道完成响应不是有效的图片 JSON"); }
        sources = imageSourcesFromPayload(payload);
    }
    if (!sources.length) throw new Error("渠道完成响应中没有图片");
    const media = [];
    const trustedChannelOrigin = new URL(channel.baseUrl).origin;
    try {
        for (const source of sources) {
            const buffer = Buffer.isBuffer(source) ? source : await retrieveImageSource(source, controllerSignal, trustedChannelOrigin);
            media.push(await persistImageTaskMedia(user, task, buffer));
        }
    } catch (error) {
        for (const item of media) {
            const target = imageTaskMediaTarget(task, item.storageKey);
            try { fs.unlinkSync(target.file); } catch {}
            try { fs.unlinkSync(`${target.file}.meta.json`); } catch {}
            releaseUserStorage(user, item.bytes);
        }
        throw error;
    }
    return media;
}
function fileSha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function indexedMediaMetadata(userId, scope, storageKey, file) {
    const stat = fs.statSync(file);
    const metadataFile = `${file}.meta.json`;
    const metadata = loadJson(metadataFile, {});
    const hash = typeof metadata.sha256 === "string" && metadata.sha256 ? metadata.sha256 : fileSha256(file);
    const updatedAt = metadata.updatedAt || stat.mtime.toISOString();
    const mimeType = metadata.mimeType || "application/octet-stream";
    if (!metadata.sha256 || metadata.bytes !== stat.size) saveJson(metadataFile, { ...metadata, bytes: stat.size, mimeType, sha256: hash, updatedAt });
    const current = database.getMediaAsset(userId, scope, storageKey);
    if (current && current.bytes === stat.size && current.mimeType === mimeType && current.sha256 === hash) return current;
    return database.upsertMediaAsset({ userId, scope, storageKey, bytes: stat.size, mimeType, sha256: hash, updatedAt });
}
function workbenchFileMetadata(userId, kind, storageKey, file) {
    return indexedMediaMetadata(userId, `workbench-${kind}`, storageKey, file);
}
function loadWorkbenchLogs(userId, kind) {
    const domain = `workbench-${kind}`;
    let document = database.getDocument(userId, domain);
    const legacy = loadJson(workbenchLogFile(userId, kind), { updatedAt: "", logs: [] });
    if (!document || legacyDocumentIsNewer(legacy.updatedAt, document.updatedAt)) {
        const migrated = { logs: Array.isArray(legacy.logs) ? legacy.logs.slice(0, 500) : [] };
        const saved = database.putDocument(userId, domain, migrated, document ? "document.legacy-newer-migrated" : "document.migrated");
        document = { ...saved, data: migrated };
    }
    return { revision: document.revision, updatedAt: document.updatedAt, logs: Array.isArray(document.data?.logs) ? document.data.logs.slice(0, 500) : [] };
}
function migrateLegacyAccountDocuments() {
    for (const user of users) {
        loadCanvas(user.id);
        loadWorkbenchLogs(user.id, "image");
        loadWorkbenchLogs(user.id, "video");
    }
    console.log(`[database] 已确认 ${users.length} 个账号的画布与工作台主记录`);
}
migrateLegacyAccountDocuments();
function reconcileMediaIndex() {
    let indexed = 0;
    for (const user of users) {
        const seen = new Set();
        try {
            for (const entry of fs.readdirSync(canvasMediaDir(user.id), { withFileTypes: true })) {
                if (!entry.isFile() || entry.name.endsWith(".meta.json") || !/^(image|video|audio|file|video-reference|audio-reference):[A-Za-z0-9_-]+$/.test(entry.name)) continue;
                indexedMediaMetadata(user.id, "canvas", entry.name, path.join(canvasMediaDir(user.id), entry.name));
                seen.add(`canvas:${entry.name}`);
                indexed += 1;
            }
        } catch {
            // 新账号尚未产生画布媒体时目录不存在。
        }
        for (const kind of ["image", "video"]) {
            const scope = `workbench-${kind}`;
            const storageKeys = collectIndexedStorageKeys(loadWorkbenchLogs(user.id, kind).logs);
            for (const storageKey of storageKeys) {
                const file = workbenchMediaPath(user.id, storageKey);
                if (!file || !fs.existsSync(file)) continue;
                indexedMediaMetadata(user.id, scope, storageKey, file);
                seen.add(`${scope}:${storageKey}`);
                indexed += 1;
            }
        }
        for (const item of database.listMediaAssets(user.id)) {
            if (!seen.has(`${item.scope}:${item.storageKey}`)) database.deleteMediaAsset(user.id, item.scope, item.storageKey);
        }
    }
    console.log(`[database] 已建立 ${indexed} 个账号媒体索引`);
}
reconcileMediaIndex();
function collectIndexedStorageKeys(value, keys = new Set()) {
    if (!value || typeof value !== "object") return keys;
    if (typeof value.storageKey === "string" && /^(image|video|audio|file|video-reference|audio-reference):/.test(value.storageKey)) keys.add(value.storageKey);
    for (const item of Object.values(value)) Array.isArray(item) ? item.forEach((child) => collectIndexedStorageKeys(child, keys)) : collectIndexedStorageKeys(item, keys);
    return keys;
}
function filterCrossAccountWorkbenchLogs(userId, kind, logs) {
    const ownerByLogId = new Map();
    for (const owner of users) {
        if (owner.id === userId) continue;
        for (const log of loadWorkbenchLogs(owner.id, kind).logs) {
            if (typeof log?.id === "string" && log.id) ownerByLogId.set(log.id, owner.id);
        }
    }
    return logs.filter((log) => typeof log?.id !== "string" || !ownerByLogId.has(log.id));
}
function workbenchMediaBelongsToOtherUser(userId, storageKey) {
    try {
        for (const entry of fs.readdirSync(WORKBENCH_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === userId) continue;
            const candidate = workbenchMediaPath(entry.name, storageKey);
            if (candidate && fs.existsSync(candidate)) return true;
        }
    } catch {
        // 工作台目录不存在时按空目录处理。
    }
    return false;
}

app.get("/api/workbench/:kind", auth, (req, res, next) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "工作台类型无效" });
    return requirePermission(kind)(req, res, next);
}, (req, res) => {
    const kind = workbenchKind(req.params.kind);
    const data = loadWorkbenchLogs(req.user.id, kind);
    res.json(data);
});

app.put("/api/workbench/:kind", auth, (req, res, next) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "工作台类型无效" });
    return requirePermission(kind)(req, res, next);
}, (req, res) => {
    const kind = workbenchKind(req.params.kind);
    const submittedLogs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, 500) : [];
    const logs = filterCrossAccountWorkbenchLogs(req.user.id, kind, submittedLogs);
    const droppedCrossAccount = submittedLogs.length - logs.length;
    // 工作台当前没有“删除服务器记录”的独立接口；空/更少的同步结果通常表示
    // 浏览器缓存未完成恢复或会话竞态，不能覆盖服务器已有的完整历史。
    const current = loadWorkbenchLogs(req.user.id, kind);
    if (current.logs.length > logs.length) {
        return res.json({ ok: true, updatedAt: current.updatedAt, count: current.logs.length, preserved: true, droppedCrossAccount });
    }
    const saved = database.putDocument(req.user.id, `workbench-${kind}`, { logs }, "workbench.saved");
    res.json({ ok: true, revision: saved.revision, updatedAt: saved.updatedAt, cursor: saved.cursor, count: logs.length, droppedCrossAccount });
});

app.put("/api/workbench/:kind/files/:storageKey", auth, (req, res, next) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "工作台类型无效" });
    return requirePermission(kind)(req, res, next);
}, rateLimit({ max: 60, name: "workbench-file-upload" }), express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "工作台类型无效" });
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).json({ error: "媒体 storageKey 无效" }); }
    const file = workbenchMediaPath(req.user.id, storageKey);
    if (!file) return res.status(400).json({ error: "媒体 storageKey 无效" });
    if (!fs.existsSync(file) && workbenchMediaBelongsToOtherUser(req.user.id, storageKey)) return res.status(409).json({ error: "该工作台媒体已属于其他账号" });
    const body = req.body || Buffer.alloc(0);
    const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
    const allowedMime = mimeType === "application/octet-stream" || mimeType.startsWith("image/") || (kind === "video" && (mimeType.startsWith("video/") || mimeType.startsWith("audio/")));
    if (!allowedMime) return res.status(415).json({ error: "工作台媒体类型不受支持" });
    let rollbackQuota;
    let writeCompleted = false;
    try {
        rollbackQuota = await reserveUserStorage(req.user, body.length, fs.existsSync(file) ? fs.statSync(file).size : 0);
        writeFileAtomic(file, body);
        writeCompleted = true;
        const updatedAt = new Date().toISOString();
        const sha256 = crypto.createHash("sha256").update(body).digest("hex");
        saveJson(`${file}.meta.json`, { mimeType, sha256, bytes: body.length, updatedAt });
        const media = database.upsertMediaAsset({ userId: req.user.id, scope: `workbench-${kind}`, storageKey, bytes: body.length, mimeType, sha256, updatedAt });
        res.json({ ok: true, storageKey, media });
    } catch (error) {
        if (!writeCompleted) rollbackQuota?.();
        return res.status(error.statusCode || 500).json({ error: error.message || "保存工作台媒体失败" });
    }
});

app.head("/api/workbench/:kind/files/:storageKey", auth, (req, res, next) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).end();
    return requirePermission(kind)(req, res, next);
}, (req, res) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).end();
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).end(); }
    const file = workbenchMediaPath(req.user.id, storageKey);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    const metadata = workbenchFileMetadata(req.user.id, kind, storageKey, file);
    res.setHeader("Content-Length", String(metadata.bytes));
    res.setHeader("Content-Type", metadata.mimeType);
    res.setHeader("ETag", `\"${metadata.sha256}\"`);
    res.setHeader("X-File-Sha256", metadata.sha256);
    res.setHeader("X-Media-Version", String(metadata.version));
    res.setHeader("Last-Modified", new Date(metadata.updatedAt).toUTCString());
    return res.status(200).end();
});

app.get("/api/workbench/:kind/files/:storageKey", auth, (req, res, next) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "工作台类型无效" });
    return requirePermission(kind)(req, res, next);
}, (req, res) => {
    const kind = workbenchKind(req.params.kind);
    if (!kind) return res.status(400).json({ error: "工作台类型无效" });
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).json({ error: "媒体 storageKey 无效" }); }
    const file = workbenchMediaPath(req.user.id, storageKey);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "工作台媒体不存在" });
    const metadata = workbenchFileMetadata(req.user.id, kind, storageKey, file);
    res.setHeader("Content-Type", metadata.mimeType);
    res.setHeader("ETag", `\"${metadata.sha256}\"`);
    res.setHeader("X-File-Sha256", metadata.sha256);
    res.setHeader("X-Media-Version", String(metadata.version));
    res.sendFile(file);
});

app.get("/api/canvas/files/:storageKey", auth, requirePermission("canvas"), (req, res) => {
    let storageKey;
    try { storageKey = decodeURIComponent(String(req.params.storageKey || "")); } catch { return res.status(400).json({ error: "媒体 storageKey 无效" }); }
    const requestedOwner = String(req.query.owner || "");
    if (requestedOwner && requestedOwner !== req.user.id) return res.status(403).json({ error: "无权访问该画布媒体" });
    const file = canvasMediaPath(req.user.id, storageKey);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "画布媒体不存在" });
    const metadata = indexedMediaMetadata(req.user.id, "canvas", storageKey, file);
    res.setHeader("Content-Type", metadata.mimeType || "application/octet-stream");
    res.setHeader("ETag", `"${metadata.sha256}"`);
    res.setHeader("X-File-Sha256", metadata.sha256);
    res.setHeader("X-Media-Version", String(metadata.version));
    res.setHeader("Last-Modified", new Date(metadata.updatedAt).toUTCString());
    if (requestedOwner && req.query.version) {
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.setHeader("Vary", "Cookie, Authorization");
    }
    res.sendFile(file);
});

// ---------- AI 渠道下发（密钥绝不下发到前端）----------
app.get("/api/config/ai", auth, (req, res) => {
    res.json({
        channels: aiChannels.map((c) => ({ id: c.id, name: c.name, apiFormat: c.apiFormat, models: c.models })),
        defaultModels: settings.defaultModels,
        agentLlm: settings.agentLlm,
    });
});

// ---------- 计费 ----------
app.post("/api/billing/charge", rateLimit({ max: 120, name: "billing-charge" }), auth, (req, res) => {
    const kind = String(req.body?.kind || "");
    const model = String(req.body?.model || "").trim();
    if (!USAGE_KINDS.includes(kind)) return res.status(400).json({ error: "未知的计费类型" });
    const user = req.user;
    if (!canUseCapability(user, kind)) return res.status(403).json({ error: "当前账户没有使用该模型能力的权限" });
    // 单价：优先按具体模型定价，未配置时回退到按类型单价
    const modelPrice = model && Number.isFinite(Number(settings.modelPricing[model])) ? Number(settings.modelPricing[model]) : null;
    const unitPrice = modelPrice !== null ? modelPrice : Number(settings.pricing[kind]) || 0;
    const cost = user.role === "admin" ? 0 : unitPrice;
    if (user.role !== "admin" && user.credits < cost) {
        return res.status(402).json({ error: `额度不足：本次生成${model ? `（${model}）` : ""}需要 ${cost} 点，当前余额 ${user.credits} 点，请联系管理员充值。` });
    }
    user.credits = Math.max(0, user.credits - cost);
    user.usage[kind] += 1;
    user.usage.creditsSpent += cost;
    if (!Array.isArray(user.billingCharges)) user.billingCharges = [];
    const receiptId = crypto.randomUUID();
    user.billingCharges.push({ id: receiptId, kind, model, cost, refunded: false, createdAt: new Date().toISOString() });
    user.billingCharges = user.billingCharges.slice(-200);
    persistUsers();
    res.json({ receiptId, user: publicUser(user) });
});

app.post("/api/billing/refund", rateLimit({ max: 120, name: "billing-refund" }), auth, (req, res) => {
    const receiptId = String(req.body?.receiptId || "");
    const user = req.user;
    const receipt = Array.isArray(user.billingCharges) ? user.billingCharges.find((item) => item.id === receiptId) : null;
    if (!receipt) return res.status(404).json({ error: "计费收据不存在" });
    if (receipt.source === "proxy") return res.status(403).json({ error: "服务器代理账单不能手动退款" });
    if (receipt.refunded) return res.status(409).json({ error: "该计费收据已经退款" });
    const cost = Math.max(0, Number(receipt.cost) || 0);
    user.credits += cost;
    user.usage[receipt.kind] = Math.max(0, (Number(user.usage[receipt.kind]) || 0) - 1);
    user.usage.creditsSpent = Math.max(0, (Number(user.usage.creditsSpent) || 0) - cost);
    receipt.refunded = true;
    receipt.refundedAt = new Date().toISOString();
    persistUsers();
    res.json({ ok: true, user: publicUser(user) });
});

// ---------- 用户文件（生成内容按用户分文件夹保存）----------
const KIND_DIRS = { image: "images", video: "videos", audio: "audios", text: "texts" };

app.post("/api/files/upload", auth, rateLimit({ max: 30, name: "file-upload" }), express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const kind = String(req.query.kind || "");
    const dir = KIND_DIRS[kind];
    if (!dir) return res.status(400).json({ error: "未知的文件类型" });
    if (!canUseCapability(req.user, kind)) return res.status(403).json({ error: "当前账户没有上传该类型文件的权限" });
    const ext = String(req.query.ext || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
    if (!assetExtensions(kind).includes(ext.toLowerCase())) return res.status(400).json({ error: "文件扩展名与生成类型不匹配" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!body.length) return res.status(400).json({ error: "空文件" });
    if (kind === "text" && body.length > MAX_TEXT_ASSET_BYTES) return res.status(413).json({ error: "文本文件超过大小限制" });
    const folder = path.join(userFilesRoot(req.user), dir);
    fs.mkdirSync(folder, { recursive: true });
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
    let rollbackQuota;
    try {
        rollbackQuota = await reserveUserStorage(req.user, body.length);
        writeFileAtomic(path.join(folder, filename), body);
        res.json({ ok: true, path: `users/${safeUserId(req.user)}/${dir}/${filename}` });
    } catch (error) {
        rollbackQuota?.();
        return res.status(error.statusCode || 500).json({ error: error.message || "保存用户文件失败" });
    }
});

app.get("/api/files/mine", auth, (req, res) => {
    const base = userFilesRoot(req.user);
    const result = {};
    for (const [kind, dir] of Object.entries(KIND_DIRS)) {
        try {
            result[kind] = fs.readdirSync(path.join(base, dir)).sort().reverse();
        } catch {
            result[kind] = [];
        }
    }
    res.json(result);
});

// ---------- 公共资产 ----------
// 所有登录用户可查看、上传（把个人资产转为公共）；仅管理员可删除。
let publicAssets = loadJson(PUBLIC_ASSETS_FILE, []);
const persistPublicAssets = () => saveJson(PUBLIC_ASSETS_FILE, publicAssets);

const ASSET_KINDS = ["text", "image", "video"];
const MIME_BY_EXT = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    txt: "text/plain; charset=utf-8",
};

function assetExtensions(kind) {
    if (kind === "text") return ["txt"];
    if (kind === "image") return ["png", "jpg", "jpeg", "webp", "gif"];
    if (kind === "video") return ["mp4", "webm"];
    if (kind === "audio") return ["mp3", "wav", "ogg", "aac", "flac"];
    return [];
}

app.get("/api/public-assets", auth, requirePermission("assets"), (req, res) => {
    res.json({ assets: publicAssets });
});

app.post("/api/public-assets", auth, requirePermission("assets"), rateLimit({ max: 20, name: "public-asset-upload" }), express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const kind = String(req.query.kind || "");
    if (!ASSET_KINDS.includes(kind)) return res.status(400).json({ error: "未知的资产类型" });
    const title = String(req.query.title || "").trim() || "未命名资产";
    const note = String(req.query.note || "").trim();
    const tags = String(req.query.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
    const ext = String(req.query.ext || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
    if (!assetExtensions(kind).includes(ext.toLowerCase())) return res.status(400).json({ error: "文件扩展名与资产类型不匹配" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!body.length) return res.status(400).json({ error: "空文件" });
    if (kind === "text" && body.length > MAX_TEXT_ASSET_BYTES) return res.status(413).json({ error: "文本资产超过大小限制" });
    const publicBytes = publicAssets.filter((asset) => asset.uploadedBy === req.user.id).reduce((total, asset) => total + Math.max(0, Number(asset.bytes) || 0), 0);
    if (publicBytes + body.length > MAX_USER_STORAGE_BYTES) return res.status(413).json({ error: "公共资产已达到当前账户存储上限" });

    const id = crypto.randomUUID();
    const filename = `${id}.${ext}`;
    writeFileAtomic(path.join(PUBLIC_ASSETS_DIR, filename), body);
    const asset = {
        id,
        title,
        kind,
        filename,
        mimeType: MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream",
        bytes: body.length,
        tags,
        note,
        folder: String(req.query.folder || "").trim().slice(0, 50),
        uploadedBy: req.user.id,
        uploadedByName: req.user.displayName,
        uploadedAt: new Date().toISOString(),
    };
    publicAssets.unshift(asset);
    persistPublicAssets();
    res.json({ asset });
});

// 管理员整理公共资产（移动文件夹 / 改标题）
app.patch("/api/public-assets/:id", auth, adminOnly, (req, res) => {
    const asset = publicAssets.find((a) => a.id === req.params.id);
    if (!asset) return res.status(404).json({ error: "资产不存在" });
    const { folder, title } = req.body || {};
    if (typeof folder === "string") asset.folder = folder.trim().slice(0, 50);
    if (typeof title === "string" && title.trim()) asset.title = title.trim().slice(0, 200);
    persistPublicAssets();
    res.json({ asset });
});

// 文件本体公开可读（供 <img>/<video> 标签直接引用）
app.get("/api/public-assets/:id/file", (req, res) => {
    const asset = publicAssets.find((a) => a.id === req.params.id);
    if (!asset) return res.status(404).json({ error: "资产不存在" });
    const file = path.join(PUBLIC_ASSETS_DIR, asset.filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "文件不存在" });
    res.setHeader("Content-Type", asset.mimeType);
    res.sendFile(file);
});

app.delete("/api/public-assets/:id", auth, adminOnly, (req, res) => {
    const asset = publicAssets.find((a) => a.id === req.params.id);
    if (!asset) return res.status(404).json({ error: "资产不存在" });
    publicAssets = publicAssets.filter((a) => a.id !== req.params.id);
    persistPublicAssets();
    try {
        fs.unlinkSync(path.join(PUBLIC_ASSETS_DIR, asset.filename));
    } catch {
        // 文件可能已不存在
    }
    res.json({ ok: true });
});

// ---------- 个人资产（跟账号走：全部保存在服务器，按用户隔离）----------
function userAssetsDir(user) {
    return path.join(userFilesRoot(user), "assets");
}
function userAssetsFile(user) {
    return path.join(userFilesRoot(user), "assets.json");
}
function loadUserAssets(user) {
    return loadJson(userAssetsFile(user), []);
}
function saveUserAssets(user, assets) {
    fs.mkdirSync(path.dirname(userAssetsFile(user)), { recursive: true });
    saveJson(userAssetsFile(user), assets);
}
app.get("/api/assets", auth, requirePermission("assets"), (req, res) => {
    res.json({ assets: loadUserAssets(req.user) });
});

app.post("/api/assets", auth, requirePermission("assets"), rateLimit({ max: 30, name: "asset-upload" }), express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const q = req.query;
    const kind = String(q.kind || "");
    if (!ASSET_KINDS.includes(kind)) return res.status(400).json({ error: "未知的资产类型" });
    const id = String(q.id || "").replace(/[^a-zA-Z0-9_-]/g, "") || crypto.randomUUID();
    const assets = loadUserAssets(req.user);
    if (assets.some((a) => a.id === id)) return res.status(409).json({ error: "资产已存在" });

    const now = new Date().toISOString();
    const coverUrl = String(q.coverUrl || "");
    const record = {
        id,
        kind,
        title: String(q.title || "").slice(0, 200) || "未命名资产",
        tags: String(q.tags || "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 10),
        note: String(q.note || "").slice(0, 2000),
        source: String(q.source || "").slice(0, 200),
        folder: String(q.folder || "").trim().slice(0, 50),
        coverUrl: /^https?:/i.test(coverUrl) ? coverUrl : "",
        createdAt: now,
        updatedAt: now,
    };
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    let ext = "";
    if (kind === "text") {
        if (body.length > MAX_TEXT_ASSET_BYTES) return res.status(413).json({ error: "文本资产超过大小限制" });
        record.content = body.toString("utf8");
    } else {
        if (!body.length) return res.status(400).json({ error: "空文件" });
        ext = String(q.ext || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
        if (!assetExtensions(kind).includes(ext.toLowerCase())) return res.status(400).json({ error: "文件扩展名与资产类型不匹配" });
        record.filename = `${id}.${ext}`;
        record.mimeType = MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
        record.bytes = body.length;
        record.width = Number(q.width) || 0;
        record.height = Number(q.height) || 0;
    }
    let rollbackQuota;
    let writtenFile = "";
    try {
        rollbackQuota = await reserveUserStorage(req.user, body.length);
        if (kind !== "text") {
            fs.mkdirSync(userAssetsDir(req.user), { recursive: true });
            writtenFile = path.join(userAssetsDir(req.user), record.filename);
            writeFileAtomic(writtenFile, body);
        }
        assets.unshift(record);
        saveUserAssets(req.user, assets);
        res.json({ asset: record });
    } catch (error) {
        if (writtenFile) try { fs.unlinkSync(writtenFile); } catch {}
        rollbackQuota?.();
        return res.status(error.statusCode || 500).json({ error: error.message || "保存资产失败" });
    }
});

app.patch("/api/assets/:id", auth, requirePermission("assets"), async (req, res) => {
    const assets = loadUserAssets(req.user);
    const record = assets.find((a) => a.id === req.params.id);
    if (!record) return res.status(404).json({ error: "资产不存在" });
    const { title, tags, note, source, coverUrl, content, folder } = req.body || {};
    if (typeof title === "string") record.title = title.slice(0, 200) || record.title;
    if (Array.isArray(tags)) record.tags = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
    if (typeof note === "string") record.note = note.slice(0, 2000);
    if (typeof source === "string") record.source = source.slice(0, 200);
    if (typeof folder === "string") record.folder = folder.trim().slice(0, 50);
    if (typeof coverUrl === "string") record.coverUrl = /^https?:/i.test(coverUrl) ? coverUrl : "";
    let rollbackQuota;
    try {
        if (record.kind === "text" && typeof content === "string") {
            const bytes = Buffer.byteLength(content, "utf8");
            if (bytes > MAX_TEXT_ASSET_BYTES) return res.status(413).json({ error: "文本资产超过大小限制" });
            rollbackQuota = await reserveUserStorage(req.user, bytes, Buffer.byteLength(String(record.content || ""), "utf8"));
            record.content = content;
        }
        record.updatedAt = new Date().toISOString();
        saveUserAssets(req.user, assets);
        res.json({ asset: record });
    } catch (error) {
        rollbackQuota?.();
        return res.status(error.statusCode || 500).json({ error: error.message || "更新资产失败" });
    }
});

app.put("/api/assets/:id/file", auth, requirePermission("assets"), rateLimit({ max: 30, name: "asset-file-upload" }), express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const assets = loadUserAssets(req.user);
    const record = assets.find((a) => a.id === req.params.id);
    if (!record || record.kind === "text") return res.status(404).json({ error: "资产不存在" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!body.length) return res.status(400).json({ error: "空文件" });
    const ext = String(req.query.ext || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
    if (!assetExtensions(record.kind).includes(ext.toLowerCase())) return res.status(400).json({ error: "文件扩展名与资产类型不匹配" });
    const previousFile = record.filename ? path.join(userAssetsDir(req.user), record.filename) : "";
    const previousBytes = previousFile && fs.existsSync(previousFile) ? fs.statSync(previousFile).size : 0;
    record.filename = `${record.id}.${ext}`;
    record.mimeType = MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
    record.bytes = body.length;
    record.width = Number(req.query.width) || record.width || 0;
    record.height = Number(req.query.height) || record.height || 0;
    record.updatedAt = new Date().toISOString();
    fs.mkdirSync(userAssetsDir(req.user), { recursive: true });
    const nextFile = path.join(userAssetsDir(req.user), record.filename);
    let rollbackQuota;
    let writeCompleted = false;
    try {
        rollbackQuota = await reserveUserStorage(req.user, body.length, previousBytes);
        writeFileAtomic(nextFile, body);
        writeCompleted = true;
        if (previousFile && previousFile !== nextFile) {
            try { fs.unlinkSync(previousFile); } catch { /* 旧文件可能不存在 */ }
        }
        saveUserAssets(req.user, assets);
        res.json({ asset: record });
    } catch (error) {
        if (!writeCompleted) rollbackQuota?.();
        return res.status(error.statusCode || 500).json({ error: error.message || "更新资产文件失败" });
    }
});

// <img>/<video> 标签无法带请求头，文件路由依赖同源 HttpOnly Cookie。
app.get("/api/assets/:id/file", auth, requirePermission("assets"), (req, res) => {
    const record = loadUserAssets(req.user).find((a) => a.id === req.params.id);
    if (!record || !record.filename) return res.status(404).json({ error: "文件不存在" });
    const file = path.join(userAssetsDir(req.user), record.filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "文件不存在" });
    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.sendFile(file);
});

app.delete("/api/assets/:id", auth, requirePermission("assets"), (req, res) => {
    const assets = loadUserAssets(req.user);
    const record = assets.find((a) => a.id === req.params.id);
    if (!record) return res.status(404).json({ error: "资产不存在" });
    if (record.filename) {
        const file = path.join(userAssetsDir(req.user), record.filename);
        const bytes = fs.existsSync(file) ? fs.statSync(file).size : Number(record.bytes) || 0;
        try {
            fs.unlinkSync(file);
            releaseUserStorage(req.user, bytes);
        } catch {
            // 文件可能已不存在
        }
    } else if (record.kind === "text") {
        releaseUserStorage(req.user, Buffer.byteLength(String(record.content || ""), "utf8"));
    }
    saveUserAssets(req.user, assets.filter((a) => a.id !== req.params.id));
    res.json({ ok: true });
});

// ---------- 管理员 ----------
app.get("/api/admin/users", auth, adminOnly, (req, res) => {
    res.json({ users: users.map(publicUser) });
});

// 管理员新建用户
app.post("/api/admin/users", auth, adminOnly, (req, res) => {
    const { username = "", password = "", displayName = "", role = "user", permissions, credits } = req.body || {};
    const name = String(username).trim();
    if (!validUsername(name)) return res.status(400).json({ error: "用户名需为 3-40 位中文、字母、数字、下划线或连字符" });
    if (String(password).length < 10) return res.status(400).json({ error: "密码至少 10 个字符" });
    if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "该用户名已被注册" });

    const salt = genSalt();
    const isAdminRole = role === "admin";
    const user = {
        id: crypto.randomUUID(),
        username: name,
        displayName: String(displayName).trim() || name,
        passwordHash: hashPassword(String(password), salt),
        salt,
        role: isAdminRole ? "admin" : "user",
        permissions: isAdminRole ? [...ALL_PERMISSIONS] : Array.isArray(permissions) ? permissions.filter((p) => ALL_PERMISSIONS.includes(p)) : [...settings.defaultPermissions],
        credits: Number.isFinite(Number(credits)) && Number(credits) >= 0 ? Number(credits) : settings.defaultCredits,
        status: "active",
        createdAt: new Date().toISOString(),
        usage: zeroUsage(),
        tokenVersion: 0,
    };
    users.push(user);
    persistUsers();
    res.json({ user: publicUser(user) });
});

app.patch("/api/admin/users/:id", auth, adminOnly, (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: "用户不存在" });
    const { permissions, role, status, addCredits, password } = req.body || {};

    if (Array.isArray(permissions)) user.permissions = permissions.filter((p) => ALL_PERMISSIONS.includes(p));
    if (role === "admin" || role === "user") {
        if (user.id === req.user.id && role !== "admin") return res.status(400).json({ error: "不能取消自己的管理员角色" });
        user.role = role;
        if (role === "admin") user.permissions = [...ALL_PERMISSIONS];
    }
    if (status === "active" || status === "disabled") {
        if (user.id === req.user.id && status === "disabled") return res.status(400).json({ error: "不能禁用自己" });
        user.status = status;
    }
    if (typeof addCredits === "number" && Number.isFinite(addCredits)) {
        user.credits = Math.max(0, user.credits + Math.trunc(addCredits));
    }
    if (typeof password === "string" && password) {
        if (password.length < 10) return res.status(400).json({ error: "密码至少 10 个字符" });
        user.salt = genSalt();
        user.passwordHash = hashPassword(password, user.salt);
        user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    }
    persistUsers();
    res.json({ user: publicUser(user) });
});

app.delete("/api/admin/users/:id", auth, adminOnly, (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: "不能删除自己" });
    const user = findUser(req.params.id);
    const before = users.length;
    users = users.filter((u) => u.id !== req.params.id);
    if (users.length === before) return res.status(404).json({ error: "用户不存在" });
    persistUsers();
    deletePrivateUserData(user);
    res.json({ ok: true });
});

app.get("/api/admin/settings", auth, adminOnly, (req, res) => {
    res.json({ settings });
});

// ---------- AI 渠道管理（管理员，多渠道，保存到 channels.json 即时生效）----------
function maskKey(key) {
    if (!key) return "";
    if (key.length <= 8) return "****";
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function publicChannel(c) {
    const { apiKey, ...rest } = c;
    return { ...rest, hasKey: Boolean(apiKey), apiKeyMasked: maskKey(apiKey) };
}
function channelModelSelectionExists(selection, capability) {
    return aiChannels.some((channel) => Array.isArray(channel?.models) && channel.models.some((model) => model.capability === capability && `${channel.id}::${model.name}` === selection));
}
function clearInvalidDefaultModels() {
    let changed = false;
    for (const kind of USAGE_KINDS) {
        const selection = String(settings.defaultModels[kind] || "");
        if (selection && !channelModelSelectionExists(selection, kind)) {
            settings.defaultModels[kind] = "";
            changed = true;
        }
    }
    return changed;
}
function clearInvalidAgentLlmModel() {
    const selection = String(settings.agentLlm?.model || "").trim();
    if (selection && !channelModelSelectionExists(selection, "text")) {
        settings.agentLlm.model = "";
        return true;
    }
    return false;
}
// 清理历史配置中已被删除或改为其它能力的模型，避免管理页和 Agent
// 首次请求继续携带失效的渠道选择。
const startupDefaultsChanged = clearInvalidDefaultModels();
const startupAgentModelChanged = clearInvalidAgentLlmModel();
if (startupDefaultsChanged || startupAgentModelChanged) persistSettings();
function normalizeChannelBaseUrl(value) {
    const baseUrl = String(value ?? "").replace(/[\r\n]/g, "").trim();
    try {
        const parsed = new URL(baseUrl);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return "";
        return baseUrl.replace(/\/+$/, "");
    } catch {
        return "";
    }
}

app.get("/api/admin/channels", auth, adminOnly, (req, res) => {
    res.json({ channels: aiChannels.map(publicChannel) });
});

app.post("/api/admin/channels", auth, adminOnly, (req, res) => {
    const { name, baseUrl, apiKey, apiFormat, models } = req.body || {};
    const clean = (v) => String(v ?? "").replace(/[\r\n]/g, "").trim();
    const normalizedBaseUrl = normalizeChannelBaseUrl(baseUrl);
    if (!normalizedBaseUrl) return res.status(400).json({ error: "Base URL 必须是有效的 HTTP/HTTPS 地址" });
    if (!clean(apiKey)) return res.status(400).json({ error: "请填写 API Key" });
    const normalizedApiFormat = normalizeChannelApiFormat(apiFormat);
    const normalizedModels = normalizeChannelModels(models);
    const protocolError = validateChannelProtocol(normalizedApiFormat, normalizedModels);
    if (protocolError) return res.status(400).json({ error: protocolError });
    const channel = {
        id: `ch${crypto.randomBytes(4).toString("hex")}`,
        name: clean(name).slice(0, 50) || "未命名渠道",
        baseUrl: normalizedBaseUrl,
        apiKey: clean(apiKey),
        apiFormat: normalizedApiFormat,
        models: normalizedModels,
    };
    aiChannels.push(channel);
    persistChannels();
    res.json({ channel: publicChannel(channel) });
});

app.patch("/api/admin/channels/:id", auth, adminOnly, (req, res) => {
    const channel = aiChannels.find((c) => c.id === req.params.id);
    if (!channel) return res.status(404).json({ error: "渠道不存在" });
    const { name, baseUrl, apiKey, apiFormat, models } = req.body || {};
    const clean = (v) => String(v ?? "").replace(/[\r\n]/g, "").trim();
    const nextApiFormat = typeof apiFormat === "string" ? normalizeChannelApiFormat(apiFormat) : channel.apiFormat;
    const nextModels = Array.isArray(models) ? normalizeChannelModels(models) : channel.models;
    const protocolError = validateChannelProtocol(nextApiFormat, nextModels);
    if (protocolError) return res.status(400).json({ error: protocolError });
    if (typeof name === "string") channel.name = clean(name).slice(0, 50) || channel.name;
    if (typeof baseUrl === "string") {
        const normalizedBaseUrl = normalizeChannelBaseUrl(baseUrl);
        if (!normalizedBaseUrl) return res.status(400).json({ error: "Base URL 必须是有效的 HTTP/HTTPS 地址" });
        channel.baseUrl = normalizedBaseUrl;
    }
    if (typeof apiKey === "string" && clean(apiKey)) channel.apiKey = clean(apiKey); // 留空保持不变
    if (typeof apiFormat === "string") channel.apiFormat = nextApiFormat;
    if (Array.isArray(models)) channel.models = nextModels;
    persistChannels();
    const defaultsChanged = clearInvalidDefaultModels();
    const agentModelChanged = clearInvalidAgentLlmModel();
    if (defaultsChanged || agentModelChanged) persistSettings();
    res.json({ channel: publicChannel(channel) });
});

app.delete("/api/admin/channels/:id", auth, adminOnly, (req, res) => {
    const before = aiChannels.length;
    aiChannels = aiChannels.filter((c) => c.id !== req.params.id);
    if (aiChannels.length === before) return res.status(404).json({ error: "渠道不存在" });
    persistChannels();
    // 清理指向该渠道的默认模型
    for (const key of Object.keys(settings.defaultModels)) {
        if (String(settings.defaultModels[key]).startsWith(`${req.params.id}::`)) settings.defaultModels[key] = "";
    }
    clearInvalidAgentLlmModel();
    persistSettings();
    res.json({ ok: true });
});

app.put("/api/admin/settings", auth, adminOnly, (req, res) => {
    const { pricing, defaultPermissions, defaultCredits, modelPricing, defaultModels, agentLlm } = req.body || {};
    // 在修改其它设置前校验 Agent LLM 选择，避免无效模型导致请求 400
    // 但其它字段已经留在进程内存、随后被意外持久化。
    const requestedAgentModel = agentLlm && typeof agentLlm === "object" ? String(agentLlm.model ?? "").trim() : "";
    if (requestedAgentModel && (requestedAgentModel.length > 200 || !channelModelSelectionExists(requestedAgentModel, "text"))) {
        return res.status(400).json({ error: "Agent LLM 文本模型不存在或能力不匹配" });
    }
    if (defaultModels && typeof defaultModels === "object") {
        const updates = {};
        for (const kind of ["image", "video", "audio", "text"]) {
            if (!(kind in defaultModels)) continue;
            const selection = String(defaultModels[kind] ?? "").trim();
            if (selection && (selection.length > 200 || !channelModelSelectionExists(selection, kind))) {
                return res.status(400).json({ error: `${kind} 默认模型不存在或能力不匹配` });
            }
            updates[kind] = selection;
        }
        Object.assign(settings.defaultModels, updates);
    }
    if (pricing && typeof pricing === "object") {
        for (const kind of USAGE_KINDS) {
            const v = Number(pricing[kind]);
            if (Number.isFinite(v) && v >= 0) settings.pricing[kind] = v;
        }
    }
    if (modelPricing && typeof modelPricing === "object") {
        const next = {};
        for (const [name, value] of Object.entries(modelPricing)) {
            const model = String(name).trim();
            const v = Number(value);
            if (model && Number.isFinite(v) && v >= 0) next[model] = v;
        }
        settings.modelPricing = next;
    }
    if (Array.isArray(defaultPermissions)) settings.defaultPermissions = defaultPermissions.filter((p) => ALL_PERMISSIONS.includes(p));
    if (Number.isFinite(Number(defaultCredits)) && Number(defaultCredits) >= 0) settings.defaultCredits = Number(defaultCredits);
    if (agentLlm && typeof agentLlm === "object") {
        settings.agentLlm.model = requestedAgentModel.slice(0, 200);
        if (typeof agentLlm.enabled === "boolean") settings.agentLlm.enabled = agentLlm.enabled;
        if (Array.isArray(agentLlm.skills)) settings.agentLlm.skills = agentLlm.skills.filter((skill) => AGENT_SKILL_IDS.includes(skill)).slice(0, 20);
    }
    persistSettings();
    res.json({ settings });
});

app.use((error, _req, res, next) => {
    if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ error: "请求 JSON 格式无效" });
    return next(error);
});

app.listen(PORT, () => {
    console.log(`[server] infinite-canvas 后端已启动: http://localhost:${PORT}`);
    console.log(`[server] 账号数据: ${USERS_FILE}`);
    console.log(`[server] 用户文件目录: ${USER_FILES_DIR}`);
});
