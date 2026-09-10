const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = 'http://127.0.0.1:3011/tests/canvas-alignment-preview.html';

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge' });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const snapshot = () => page.evaluate(() => {
            const { nodes, connections } = window.alignmentStore.getState().projects[0];
            return { nodes, connections };
        });
        const ready = async (reset = false, theme = 'light') => {
            await page.goto(`${url}?connections=1&theme=${theme}${reset ? '&reset=1' : ''}`);
            await page.locator('[data-node-id="a"]').waitFor();
            await page.waitForTimeout(500);
        };
        const undo = async () => { await page.keyboard.press('Control+z'); await page.waitForTimeout(300); };
        const redo = async () => { await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(650); };
        for (const method of ['mouse', 'Enter', 'Space', 'zoom']) {
            await ready(true, method === 'zoom' ? 'dark' : 'light');
            const before = await snapshot();
            if (method === 'zoom') {
                await page.mouse.move(600, 350);
                await page.mouse.wheel(0, 350);
                await page.waitForTimeout(350);
            }
            await page.locator('path[data-connection-id="ab"]').click();
            const button = page.getByRole('button', { name: '删除连线', exact: true });
            if (method === 'Enter' || method === 'Space') {
                await button.focus();
                await page.keyboard.press(method);
            } else {
                // Exercise hit testing, including the circle away from the line itself.
                const box = await button.boundingBox();
                await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.25);
            }
            await page.waitForTimeout(300);
            const after = await snapshot();
            assert.deepEqual(after.nodes, before.nodes);
            assert.deepEqual(after.connections, before.connections.filter((c) => c.id !== 'ab'));
            await undo();
            assert.deepEqual(await snapshot(), before, 'delete undo');
            await redo();
            assert.deepEqual(await snapshot(), after, 'delete redo');
            await ready();
            assert.deepEqual(await snapshot(), after, 'delete persistence');
            console.log(`PASS connection delete: ${method}, unrelated connections, undo/redo, persistence`);
        }
        await ready(true);
        const original = await snapshot();
        for (const sourceId of ['b', 'a', 'c']) {
            const before = await snapshot();
            await page.locator(`[data-node-id="${sourceId}"]`).click({ button: 'right', position: { x: 40, y: 70 } });
            await page.getByRole('menuitem', { name: '复制', exact: true }).click();
            await page.waitForTimeout(300);
            const after = await snapshot();
            assert.equal(after.nodes.length, before.nodes.length + 1);
            const copy = after.nodes.find((node) => !before.nodes.some((old) => old.id === node.id));
            const related = before.connections.filter((c) => c.fromNodeId === sourceId || c.toNodeId === sourceId);
            assert.deepEqual(after.connections.slice(0, before.connections.length), before.connections, 'original links remain intact');
            const inherited = after.connections.slice(before.connections.length);
            assert.equal(inherited.length, related.length);
            assert.deepEqual(inherited.map((c) => [c.fromNodeId, c.toNodeId]), related.map((c) => [c.fromNodeId === sourceId ? copy.id : c.fromNodeId, c.toNodeId === sourceId ? copy.id : c.toNodeId]));
            assert.equal(new Set(after.connections.map((c) => c.id)).size, after.connections.length);
            await page.mouse.click(900, 120);
            await undo();
            assert.deepEqual(await snapshot(), before, 'one undo removes copy and inherited links');
            await redo();
            assert.deepEqual(await snapshot(), after);
            await ready();
            assert.deepEqual(await snapshot(), after, 'copy persistence');
            console.log(`PASS duplicate ${sourceId}: inherited inputs/outputs, original links, unique IDs, undo/redo, persistence`);
        }
        const final = await snapshot();
        assert.deepEqual(final.connections.slice(0, original.connections.length), original.connections);
        await page.locator('path[data-connection-id="ab"]').click({ button: 'right' });
        await page.getByRole('menuitem', { name: '删除', exact: true }).click();
        await page.waitForTimeout(300);
        assert.equal((await snapshot()).connections.some((c) => c.id === 'ab'), false);
        assert.deepEqual(errors, []);
        console.log('PASS existing right-click delete; no browser errors');
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
