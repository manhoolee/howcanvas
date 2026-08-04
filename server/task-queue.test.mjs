import assert from "node:assert/strict";
import test from "node:test";
import { createTaskQueue } from "./task-queue.mjs";

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("等待任务队列状态超时");
}

test("任务队列按配置限制最大并发并保持 FIFO", async () => {
    const started = [];
    const releases = [];
    let active = 0;
    let maximumActive = 0;
    const queue = createTaskQueue({
        concurrency: 2,
        worker: ({ taskId }) => new Promise((resolve) => {
            started.push(taskId);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            releases.push(() => {
                active -= 1;
                resolve();
            });
        }),
    });

    for (const taskId of ["a", "b", "c", "d"]) queue.enqueue("user", taskId);
    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ["a", "b"]);
    assert.equal(maximumActive, 2);

    releases.shift()();
    await waitFor(() => started.length === 3);
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(maximumActive, 2);

    while (releases.length) releases.shift()();
    await waitFor(() => started.length === 4);
    while (releases.length) releases.shift()();
    await waitFor(() => active === 0);
    assert.deepEqual(started, ["a", "b", "c", "d"]);
});

test("任务队列去重并允许移除尚未开始的任务", async () => {
    const started = [];
    let releaseFirst;
    const queue = createTaskQueue({
        concurrency: 1,
        worker: ({ taskId }) => {
            started.push(taskId);
            return taskId === "first" ? new Promise((resolve) => { releaseFirst = resolve; }) : Promise.resolve();
        },
    });

    assert.equal(queue.enqueue("user", "first"), true);
    assert.equal(queue.enqueue("user", "second"), true);
    assert.equal(queue.enqueue("user", "second"), false);
    await waitFor(() => started.length === 1);
    assert.equal(queue.remove("user", "second"), true);
    assert.equal(queue.remove("user", "second"), false);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started, ["first"]);
});
