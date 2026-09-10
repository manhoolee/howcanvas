const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = 'http://127.0.0.1:3011/tests/canvas-alignment-preview.html';
const output = process.env.ALIGNMENT_OUTPUT || path.join(__dirname, '../../../..', 'output');

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge' });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const nodes = () => page.evaluate(() => window.alignmentStore.getState().projects[0].nodes);
        const select = async () => {
            const a = await page.locator('[data-node-id="a"]').boundingBox();
            const b = await page.locator('[data-node-id="b"]').boundingBox();
            await page.keyboard.down('Control');
            await page.mouse.move(Math.min(a.x, b.x) - 35, Math.min(a.y, b.y) - 40);
            await page.mouse.down();
            await page.mouse.move(Math.max(a.x + a.width, b.x + b.width) + 35, Math.max(a.y + a.height, b.y + b.height) + 35, { steps: 12 });
            await page.mouse.up();
            await page.keyboard.up('Control');
        };
        const selectedCount = () => page.locator('[data-node-id].z-50').count();
        for (const label of ['左对齐', '右对齐', '顶对齐', '底对齐', '水平居中', '垂直居中']) {
            await page.goto(`${url}?reset=1`);
            await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 3);
            await page.waitForTimeout(500);
            const original = await nodes();
            await select();
            assert.equal(await selectedCount(), 2, 'box selection');
            await page.locator('[data-node-id="a"]').click({ button: 'right', position: { x: 40, y: 70 } });
            assert.equal(await selectedCount(), 2, 'right click preserves selection');
            await page.getByRole('menuitem', { name: label, exact: true }).click();
            await page.waitForTimeout(300);
            const result = await nodes();
            const [a, b] = result;
            if (label === '左对齐') assert.equal(a.position.x, b.position.x);
            if (label === '右对齐') assert.equal(a.position.x + a.width, b.position.x + b.width);
            if (label === '顶对齐') assert.equal(a.position.y, b.position.y);
            if (label === '底对齐') assert.equal(a.position.y + a.height, b.position.y + b.height);
            if (label === '水平居中') assert.equal(a.position.x + a.width / 2, b.position.x + b.width / 2);
            if (label === '垂直居中') assert.equal(a.position.y + a.height / 2, b.position.y + b.height / 2);
            assert.deepEqual(result[2], original[2]);
            assert.equal(await selectedCount(), 2, 'alignment preserves selection');
            result.forEach((n, i) => assert.deepEqual([n.width, n.height], [original[i].width, original[i].height]));
            await page.keyboard.press('Control+z');
            await page.waitForTimeout(300);
            assert.deepEqual(await nodes(), original, 'one undo restores positions');
            await page.keyboard.press('Control+Shift+z');
            await page.waitForTimeout(650);
            assert.deepEqual(await nodes(), result, 'redo restores alignment');
            await page.goto(url);
            await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 3);
            assert.deepEqual(await nodes(), result, 'refresh preserves alignment');
            console.log(`PASS ${label}: box select, right click, dimensions, undo, redo, persistence`);
        }
        for (const theme of ['light', 'dark']) {
            await page.goto(`${url}?reset=1&theme=${theme}`);
            await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 3);
            await page.waitForTimeout(300);
            await select();
            await page.mouse.click(1425, 780, { button: 'right' });
            const menu = page.getByRole('menu', { name: '画布右键菜单' });
            assert.equal(await menu.getByRole('menuitem').count(), 7);
            const box = await menu.boundingBox();
            assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900);
            await page.screenshot({ path: path.join(output, `canvas-alignment-${theme}.png`) });
            await page.keyboard.press('Escape');
            assert.equal(await menu.count(), 0);
            await page.locator('[data-node-id="c"]').click({ button: 'right', position: { x: 40, y: 70 } });
            assert.equal(await menu.getByRole('menuitem').count(), 2, 'unselected card has single-node menu');
            assert.equal(await selectedCount(), 1);
            console.log(`PASS ${theme}: background menu, edge placement, Escape, unselected card`);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${url}?reset=1&theme=dark`);
        await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 3);
        await page.keyboard.press('Control+a');
        await page.mouse.click(378, 700, { button: 'right' });
        const mobileMenu = page.getByRole('menu', { name: '画布右键菜单' });
        const box = await mobileMenu.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
        await page.screenshot({ path: path.join(output, 'canvas-alignment-mobile.png') });
        assert.deepEqual(errors, []);
        console.log('PASS mobile menu bounds; no browser errors');
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
