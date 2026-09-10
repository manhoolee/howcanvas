const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

const tick = () => new Promise(setImmediate);

function harness(fetchImpl) {
    let epoch = 0;
    const modules = new Map();
    const stores = new Map();
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    Object.assign(window, { setTimeout, clearTimeout });
    const backend = { getAuthEpoch: () => epoch, backend: {} };
    const mocks = {
        'localforage': { createInstance({ name, storeName }) {
            const id = `${name}:${storeName}`;
            if (!stores.has(id)) stores.set(id, new Map());
            const data = stores.get(id);
            return { getItem: async (key) => data.get(key) || null, setItem: async (key, value) => { data.set(key, value); return value; }, removeItem: async (key) => data.delete(key), clear: async () => data.clear(), iterate: async (fn) => { for (const [key, value] of data) fn(value, key); } };
        } },
        'nanoid': { nanoid: () => crypto.randomUUID() },
        '@/lib/image-utils': { readImageMeta: async () => ({ width: 1, height: 1, mimeType: 'image/png' }) },
    };
    function load(relative) {
        const file = path.resolve(__dirname, '../src', relative);
        if (modules.has(file)) return modules.get(file).exports;
        const module = { exports: {} };
        modules.set(file, module);
        const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
        const context = { module, exports: module.exports, console, window, document, navigator: { onLine: true }, fetch: (...args) => fetchImpl(...args), setTimeout, clearTimeout, setInterval, clearInterval, performance, Blob, URL, Response, AbortController, AbortSignal, DOMException, Error, TypeError, Uint8Array, TextEncoder, Event, CustomEvent, crypto: globalThis.crypto, requestAnimationFrame: () => 1 };
        context.require = (id) => {
            if (id in mocks) return mocks[id];
            if (id === './backend' || id === '@/services/api/backend') return backend;
            if (id.startsWith('@/')) return load(id.slice(2) + '.ts');
            if (id.startsWith('.')) return load(path.relative(path.resolve(__dirname, '../src'), path.resolve(path.dirname(file), id + '.ts')));
            return require(id);
        };
        vm.runInNewContext(code, context, { filename: file });
        return module.exports;
    }
    return { load, window, document, stores, backend, mocks, switchAccount: () => { epoch += 1; } };
}

test('an image that keeps receiving bytes can take more than 20 seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(async () => new Response(new ReadableStream({ start(controller) {
        setTimeout(() => controller.enqueue(new Uint8Array([1])), 25_000);
        setTimeout(() => { controller.enqueue(new Uint8Array([2])); controller.close(); }, 50_000);
    } }), { headers: { 'content-type': 'image/png' } }));
    const promise = h.load('services/api/image-transfer.ts').downloadImageBlob('/image');
    await tick();
    t.mock.timers.tick(25_000);
    await tick();
    t.mock.timers.tick(25_000);
    assert.equal((await promise).size, 2);
});

test('a transient download failure retries only the same GET', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const h = harness(async (url, options) => {
        calls.push({ url, method: options.method || 'GET' });
        if (calls.length === 1) throw new TypeError('connection reset');
        return new Response('image', { headers: { 'content-type': 'image/png' } });
    });
    const promise = h.load('services/api/image-transfer.ts').downloadImageBlob('/original-image');
    await tick();
    t.mock.timers.tick(1000);
    assert.equal((await promise).size, 5);
    assert.deepEqual(calls, [{ url: '/original-image', method: 'GET' }, { url: '/original-image', method: 'GET' }]);
});

test('401 is not retried and a canceled request does not start another transfer', async () => {
    let calls = 0;
    const h = harness(async () => { calls += 1; return new Response(JSON.stringify({ error: 'login required' }), { status: 401 }); });
    const transfer = h.load('services/api/image-transfer.ts');
    await assert.rejects(transfer.downloadImageBlob('/image'), { status: 401 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transfer.downloadImageBlob('/image', controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('generated image is downloaded once, registered as remote, and acknowledged before paint', async () => {
    const calls = [];
    const bytes = Buffer.from('verified-image');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const h = harness(async (url, options) => {
        calls.push({ url, method: options.method || 'GET', body: options.body });
        return url.endsWith('/ack') ? Response.json({ ok: true }) : new Response(bytes, { headers: { 'content-type': 'image/png' } });
    });
    const index = h.load('services/media-index.ts');
    const storage = h.load('services/image-storage.ts');
    index.setMediaIndexOwner('user-a');
    storage.setImageStorageOwner('user-a');
    const mediaIndex = { ownerId: 'user-a', scope: 'canvas', storageKey: 'image:test', version: 1, bytes: bytes.length, mimeType: 'image/png', sha256: hash, updatedAt: new Date().toISOString() };
    const input = { dataUrl: '/image', storageKey: 'image:test', bytes: bytes.length, mimeType: 'image/png', sha256: hash, mediaIndex, serverTaskId: 'original-task' };
    const [first, second] = await Promise.all([storage.storeGeneratedImage(input), storage.storeGeneratedImage(input)]);
    assert.equal(first.url, second.url);
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
    const blob = await storage.getImageBlob('image:test');
    assert.equal(await index.decideMediaSync('canvas', 'image:test', blob), 'reuse');
    const ack = calls.find((call) => call.url.endsWith('/ack'));
    assert.equal(JSON.parse(ack.body).stage, 'cached');
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
    URL.revokeObjectURL(first.url);
});

test('an account change during download cannot cache the old account image', async () => {
    let resolve;
    const h = harness(() => new Promise((done) => { resolve = done; }));
    const index = h.load('services/media-index.ts');
    const storage = h.load('services/image-storage.ts');
    index.setMediaIndexOwner('user-a');
    storage.setImageStorageOwner('user-a');
    const pending = storage.storeGeneratedImage({ dataUrl: '/image', storageKey: 'image:test' });
    const rejected = assert.rejects(pending, /账号已切换/);
    await tick();
    h.switchAccount();
    index.setMediaIndexOwner('user-b');
    storage.setImageStorageOwner('user-b');
    resolve(new Response('image', { headers: { 'content-type': 'image/png' } }));
    await rejected;
    assert.equal(await storage.getImageBlob('image:test'), null);
    assert.equal(index.getRemoteMediaEntry('canvas', 'image:test'), null);
});

test('a corrupted image is not cached or acknowledged', async () => {
    const calls = [];
    const h = harness(async (url) => { calls.push(url); return new Response('corrupt', { headers: { 'content-type': 'image/png' } }); });
    const index = h.load('services/media-index.ts');
    const storage = h.load('services/image-storage.ts');
    index.setMediaIndexOwner('user-a');
    storage.setImageStorageOwner('user-a');
    await assert.rejects(storage.storeGeneratedImage({ dataUrl: '/image', storageKey: 'image:test', sha256: 'wrong-hash' }), /哈希校验失败/);
    assert.equal(await storage.getImageBlob('image:test'), null);
    assert.equal(calls.length, 1);
});

test('returning to the page wakes an existing task without submitting generation', async () => {
    const calls = [];
    const h = harness(async (url, options) => {
        calls.push({ url, method: options.method || 'GET' });
        if (url.endsWith('/result')) return Response.json({ data: [{ url: '/image' }] });
        return Response.json({ task: { id: 'original-task', status: calls.length === 1 ? 'running' : 'succeeded', phase: 'persisted' } });
    });
    const waiting = h.load('services/api/image-task.ts').waitForServerImageTask('original-task');
    await tick();
    h.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal((await waiting).data[0].url, '/image');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.method === 'GET'));
});

test('canvas saves drain newer edits and synchronize at most three media files at once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(async () => { throw new Error('unexpected network request'); });
    let subscriber;
    let state = { ownerId: 'user-a', hydrated: true, serverUpdatedAt: 'v0', projects: [], allProjects: [] };
    state.setOwner = (ownerId) => { state = { ...state, ownerId }; };
    state.setServerUpdatedAt = (serverUpdatedAt) => { state = { ...state, serverUpdatedAt }; };
    h.mocks['@/stores/canvas/use-canvas-store'] = { useCanvasStore: { getState: () => state, subscribe: (fn) => { subscriber = fn; return () => {}; } } };
    h.mocks['@/services/file-storage'] = { getMediaBlob: async () => null };
    let running = 0;
    let maxRunning = 0;
    const releases = [];
    const saved = [];
    h.backend.backend.canvasMeta = async () => ({ updatedAt: 'v0' });
    h.backend.backend.uploadCanvasFile = async (storageKey, blob) => {
        running += 1;
        maxRunning = Math.max(running, maxRunning);
        await new Promise((resolve) => releases.push(resolve));
        running -= 1;
        return { ownerId: 'user-a', scope: 'canvas', storageKey, bytes: blob.size, mimeType: blob.type, sha256: crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'), version: 1, updatedAt: 'now' };
    };
    h.backend.backend.saveCanvas = async (projects) => { saved.push(projects.length); return { updatedAt: 'v' + saved.length }; };
    const index = h.load('services/media-index.ts');
    const storage = h.load('services/image-storage.ts');
    index.setMediaIndexOwner('user-a');
    storage.setImageStorageOwner('user-a');
    for (let i = 0; i < 7; i += 1) await storage.setImageBlob('image:' + i, new Blob(['image'], { type: 'image/png' }));
    const sync = h.load('services/canvas-cloud-sync.ts');
    await sync.syncCanvasOwner('user-a');
    function edit(count) {
        const previous = state;
        const projects = Array.from({ length: count }, (_, i) => ({ id: String(i), storageKey: 'image:' + i }));
        state = { ...state, projects, allProjects: projects };
        subscriber(state, previous);
    }
    edit(6);
    t.mock.timers.tick(800);
    await tick();
    assert.equal(running, 3);
    edit(7);
    t.mock.timers.tick(800);
    for (let attempt = 0; attempt < 30 && saved.length < 2; attempt += 1) {
        releases.splice(0).forEach((release) => release());
        await tick();
    }
    assert.equal(maxRunning, 3);
    assert.deepEqual(saved, [6, 7]);
    await sync.syncCanvasOwner(null);
});
