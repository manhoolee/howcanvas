import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const [mode, rootArg, manifestArg, scope = 'full'] = process.argv.slice(2);
if (!['create', 'verify'].includes(mode) || !rootArg || !manifestArg || !['full', 'canvas'].includes(scope)) {
    throw new Error('Usage: node release-source-manifest.mjs create|verify ROOT MANIFEST [full|canvas]');
}
const root = resolve(rootArg);
const manifestPath = resolve(manifestArg);
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const hash = (content) => createHash('sha256').update(content).digest('hex');
const canvasFile = (path) => !/^(course\/|hoosland\/|hoosland-ins\/|nginx\.deploy\.conf$)/.test(path);
const safePath = (path) => {
    const file = resolve(root, path);
    const rel = relative(root, file);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Invalid path: ${path}`);
    return file;
};

if (mode === 'create') {
    if (git('status', '--porcelain').toString().trim()) throw new Error('Commit or preserve all changes before creating a release manifest.');
    const paths = git('ls-files', '-z').toString().split('\0').filter(Boolean);
    const manifest = {
        commit: git('rev-parse', 'HEAD').toString().trim(),
        version: readFileSync(resolve(root, 'VERSION'), 'utf8').trim(),
        files: Object.fromEntries(paths.map((path) => [path, hash(git('show', `HEAD:${path}`))])),
    };
    // Hash committed bytes, so Windows checkout conversion cannot silently enter a release.
    for (const [path, expected] of Object.entries(manifest.files)) {
        if (hash(readFileSync(safePath(path))) !== expected) throw new Error(`Checkout differs from committed bytes: ${path}`);
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify({ commit: manifest.commit, version: manifest.version, files: paths.length }));
} else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entries = Object.entries(manifest.files).filter(([path]) => scope === 'full' || canvasFile(path));
    const failures = [];
    for (const [path, expected] of entries) {
        try {
            if (hash(readFileSync(safePath(path))) !== expected) failures.push(`${path}: changed`);
        } catch (error) {
            failures.push(`${path}: ${error.code || error.message}`);
        }
    }
    console.log(JSON.stringify({ commit: manifest.commit, version: manifest.version, scope, checked: entries.length, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
}
