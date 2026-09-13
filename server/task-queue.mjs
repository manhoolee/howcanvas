export function createTaskQueue({ concurrency, worker, onError = () => {} }) {
    if (typeof worker !== "function") throw new TypeError("task queue worker must be a function");
    let limit = Math.max(1, Math.floor(Number(concurrency) || 1));
    const queue = [];
    const knownTasks = new Set();
    let running = 0;
    let drainScheduled = false;

    function taskKey(userId, taskId) {
        return `${String(userId)}\0${String(taskId)}`;
    }

    function scheduleDrain() {
        if (drainScheduled || running >= limit || queue.length === 0) return;
        drainScheduled = true;
        setImmediate(() => {
            drainScheduled = false;
            while (running < limit && queue.length > 0) {
                const task = queue.shift();
                running += 1;
                Promise.resolve()
                    .then(() => worker(task))
                    .catch((error) => {
                        try { onError(error, task); } catch {}
                    })
                    .finally(() => {
                        running -= 1;
                        knownTasks.delete(task.key);
                        scheduleDrain();
                    });
            }
        });
    }

    return {
        snapshot() { return { running, queued: queue.length, limit, oldestWaitMs: queue.length ? Date.now() - queue[0].enqueuedAt : 0 }; },
        setLimit(value) { limit = Math.min(10, Math.max(1, Math.floor(Number(value) || 1))); scheduleDrain(); },
        enqueue(userId, taskId) {
            const key = taskKey(userId, taskId);
            if (knownTasks.has(key)) return false;
            knownTasks.add(key);
            queue.push({ userId, taskId, key, enqueuedAt: Date.now() });
            scheduleDrain();
            return true;
        },
        remove(userId, taskId) {
            const key = taskKey(userId, taskId);
            const index = queue.findIndex((task) => task.key === key);
            if (index < 0) return false;
            queue.splice(index, 1);
            knownTasks.delete(key);
            return true;
        },
    };
}
