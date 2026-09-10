const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative, mocks = {}) {
    const module = { exports: {} };
    const file = path.resolve(__dirname, '../src', relative);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    vm.runInNewContext(code, {
        module, exports: module.exports, console, FormData, File, Blob, AbortController, TextDecoder,
        require: (id) => id in mocks ? mocks[id] : (() => { throw new Error(`Unexpected import: ${id}`); })(),
    }, { filename: file });
    return module.exports;
}
const sizes = load('lib/gpt-image-25.ts');
const model = 'gpt-image-2.5-flare';

test('all resolution and ratio combinations are legal and preserve the chosen ratio', () => {
    for (const resolution of sizes.gptImage25Resolutions) for (const ratio of sizes.gptImage25Ratios) {
        const size = sizes.gptImage25PresetSize(resolution, ratio);
        assert.equal(sizes.gptImage25RequestSize(model, size), size);
        const [width, height] = size.split('x').map(Number);
        const [w, h] = ratio.split(':').map(Number);
        assert.equal(width * h, height * w);
        assert.equal(sizes.gptImage25Settings(model, size).resolution, resolution);
    }
});

test('documented presets and adaptive size survive unchanged', () => {
    for (const size of ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840']) {
        assert.equal(sizes.gptImage25RequestSize(model, size), size);
    }
    assert.equal(sizes.gptImage25PresetSize('2K', '16:9'), '2048x1152');
    assert.equal(sizes.gptImage25PresetSize('4K', '16:9'), '3840x2160');
    assert.equal(sizes.gptImage25PresetSize('4K', '1:1'), '2880x2880');
    assert.equal(sizes.gptImage25RequestSize(model, '2048X1152'), '2048x1152');
});

test('invalid custom sizes fail before an upstream request', () => {
    for (const size of ['4096x4096', '3840x3840', '1024x576', '2049x1152', '3072x512', '0x1024', 'garbage']) {
        assert.throws(() => sizes.gptImage25RequestSize(model, size));
    }
    assert.equal(sizes.gptImage25RequestSize(model, '1600x1200'), '1600x1200');
});

test('model choices collapse only registered variants of the same channel', () => {
    const values = ['a::gpt-image-2.5-flare', 'a::gpt-image-2.5-flare-2k', 'a::gpt-image-2.5-flare-4k', 'a::gpt-image-2.5-sunburst', 'a::gpt-image-2.5-sunburst-2k', 'a::gpt-image-2.5-sunburst-4k', 'b::gpt-image-2.5-flare-2k', 'a::gpt-image-2'];
    assert.deepEqual([...sizes.visibleImageModelSelections(values)], [values[0], values[3], values[6], values[7]]);
    assert.equal(sizes.gptImage25ModelSelection('a::gpt-image-2.5-flare-4k'), values[0]);
    assert.equal(sizes.gptImage25ModelSelection('gpt-image-2.5-flare-4k'), model);
    assert.equal(sizes.gptImage25BaseModel('gpt-image-2'), '');
});

function imageHarness() {
    const calls = [];
    const api = load('services/api/image.ts', {
        axios: {}, nanoid: { nanoid: () => 'image-id' },
        '@/lib/gpt-image-25': sizes,
        '@/stores/use-config-store': {
            resolveModelRequestConfig: (config) => ({ ...config, model: sizes.gptImage25BaseModel(config.model) || config.model }),
            resolveModelScript: () => '',
        },
        './model-plugin': {},
        '@/lib/image-utils': { dataUrlToFile: () => new File(['reference'], 'reference.png', { type: 'image/png' }) },
        '@/lib/image-reference-prompt': { buildImageReferencePromptText: (prompt) => prompt },
        '@/services/image-storage': { imageToDataUrl: async (image) => image.dataUrl },
        '@/lib/billing': { withCharge: async (_kind, _model, run) => run() },
        './image-task': {
            supportsServerImageTasks: () => true,
            requestServerImageTask: async (config, action, body, contentType) => {
                calls.push({ model: config.model, action, body, contentType });
                return { data: [{ b64_json: 'test' }] };
            },
        },
        '@/services/user-files': { saveGeneratedDataUrl: () => {}, saveGeneratedText: () => {} },
    });
    return { api, calls };
}

test('generation keeps every quality independent of exact size and sends the base model', async () => {
    const { api, calls } = imageHarness();
    for (const { value: quality } of sizes.gptImage25Qualities) {
        await api.requestGeneration({ model: model + '-4k', size: '3840x2160', quality, count: '1', apiFormat: 'openai', background: '', systemPrompt: '' }, 'lighthouse');
        const call = calls.at(-1);
        const payload = JSON.parse(call.body);
        assert.equal(call.model, model);
        assert.equal(payload.model, model);
        assert.equal(payload.size, '3840x2160');
        assert.equal(payload.quality, quality);
        assert.equal(payload.resolution, undefined);
        assert.equal(payload.aspect_ratio, undefined);
    }
});

test('edits use multipart edits with the exact size and extended quality', async () => {
    const { api, calls } = imageHarness();
    await api.requestEdit({ model, size: '2048x1152', quality: 'max', count: '1', apiFormat: 'openai', background: '', systemPrompt: '' }, 'green teapot', [{ id: 'ref', dataUrl: 'data:image/png;base64,dGVzdA==' }]);
    assert.equal(calls[0].action, 'edits');
    assert.equal(calls[0].body.get('size'), '2048x1152');
    assert.equal(calls[0].body.get('quality'), 'max');
    assert.equal(calls[0].body.getAll('image').length, 1);
});

test('adaptive size is sent explicitly and invalid dimensions never submit a task', async () => {
    const { api, calls } = imageHarness();
    const config = { model, size: 'auto', quality: 'auto', count: '1', apiFormat: 'openai', background: '', systemPrompt: '' };
    await api.requestGeneration(config, 'lighthouse');
    assert.equal(JSON.parse(calls[0].body).size, 'auto');
    await assert.rejects(api.requestGeneration({ ...config, size: '4096x4096' }, 'lighthouse'));
    await assert.rejects(api.requestGeneration({ ...config, quality: 'low', background: 'transparent' }, 'lighthouse'));
    assert.equal(calls.length, 1);
});
