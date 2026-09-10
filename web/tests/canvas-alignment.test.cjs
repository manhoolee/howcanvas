const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const moduleStub = { exports: {} };
const source = fs.readFileSync(path.join(__dirname, '../src/lib/canvas/canvas-node-geometry.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module: moduleStub, exports: moduleStub.exports,
    require: () => ({ CanvasNodeType: { Group: 'group' } }),
});
const { alignCanvasNodes } = moduleStub.exports;
const node = (id, x, y, width, height, metadata = {}, type = 'text') => ({ id, position: { x, y }, width, height, metadata, type });
const plain = (value) => JSON.parse(JSON.stringify(value));
const originals = [node('a', -100, 20, 80, 60), node('b', 120, 100, 100, 120), node('c', 400, 400, 30, 30)];

for (const [mode, positions] of Object.entries({
    left: [[-100, 20], [-100, 100]], right: [[140, 20], [120, 100]],
    top: [[-100, 20], [120, 20]], bottom: [[-100, 160], [120, 100]],
    'horizontal-center': [[20, 20], [10, 100]], 'vertical-center': [[-100, 90], [120, 60]],
})) test(`${mode}: mixed sizes and negative coordinates, no resize or unrelated edits`, () => {
    const before = JSON.stringify(originals);
    const result = alignCanvasNodes(originals, new Set(['a', 'b']), mode);
    assert.deepEqual(plain(result.slice(0, 2).map(({ position: { x, y } }) => [x, y])), positions);
    result.forEach((item, i) => {
        assert.equal(item.width, originals[i].width);
        assert.equal(item.height, originals[i].height);
        assert.equal(item.metadata, originals[i].metadata);
    });
    assert.equal(result[2], originals[2]);
    assert.equal(JSON.stringify(originals), before);
    assert.equal(alignCanvasNodes(result, new Set(['a', 'b']), mode), result);
});

test('empty, stale and single selections are no-ops', () => {
    for (const ids of [[], ['missing', 'a'], ['a']]) assert.equal(alignCanvasNodes(originals, new Set(ids), 'left'), originals);
});

test('groups carry nested groups and batch children once, regardless of selection order', () => {
    const nodes = [
        node('batch-child', 340, 150, 30, 40, { batchRootId: 'batch' }),
        node('nested', 240, 100, 140, 180, { groupId: 'group' }, 'group'),
        node('batch', 260, 130, 50, 70, { groupId: 'nested', batchChildIds: ['batch-child'] }),
        node('group', 200, 80, 240, 240, {}, 'group'),
        node('other', -100, 20, 80, 60),
    ];
    const result = alignCanvasNodes(nodes, new Set(['batch-child', 'batch', 'nested', 'group', 'other']), 'left');
    for (let i = 0; i < 4; i++) {
        assert.equal(result[i].position.x, nodes[i].position.x - 300);
        assert.equal(result[i].position.y, nodes[i].position.y);
    }
    assert.equal(result[4], nodes[4]);
    assert.equal(alignCanvasNodes(nodes, new Set(['group', 'batch']), 'left'), nodes);
});

test('selecting ordinary children aligns them independently without moving their group', () => {
    const nodes = [node('g', 0, 0, 500, 500, {}, 'group'), node('a', 30, 40, 100, 80, { groupId: 'g' }), node('b', 200, 180, 80, 100, { groupId: 'g' })];
    const result = alignCanvasNodes(nodes, new Set(['a', 'b']), 'right');
    assert.equal(result[0], nodes[0]);
    assert.equal(result[1].position.x, 180);
    assert.equal(result[2].position.x, 200);
});
