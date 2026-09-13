#!/usr/bin/env python3
"""Online SQLite backup + verification. Root-only archives; media has a separate release snapshot."""
import datetime, fcntl, json, os, pathlib, shutil, sqlite3, subprocess, tempfile
root = pathlib.Path('/opt/hoosland-archive/canvas-monitor-backups')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
lock = open(root / '.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
now = datetime.datetime.now(datetime.timezone.utc)
target = root / now.strftime('%Y%m%dT%H%M%SZ')
target.mkdir(mode=0o700)
status = {'at': now.isoformat(), 'ok': False, 'scope': 'SQLite and account/channel metadata; release media snapshot kept separately'}
try:
    location = subprocess.check_output(['docker','volume','inspect','infinite-canvas_canvas-observability','--format','{{.Mountpoint}}'], text=True).strip()
    sources = [('server',pathlib.Path('/opt/infinite-canvas/server-data/server.sqlite')),('analytics',pathlib.Path(location)/'analytics.sqlite')]
    for name, source in sources:
        src = sqlite3.connect(f'file:{source}?mode=ro',uri=True,timeout=10)
        destination = target / (name+'.sqlite')
        dst = sqlite3.connect(destination)
        src.backup(dst,pages=256,sleep=0.05)
        if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('backup verification failed')
        dst.close(); src.close(); destination.chmod(0o600)
        # Open a restored copy, independent of both source and backup file.
        with tempfile.TemporaryDirectory(prefix='canvas-restore-') as temp:
            restored = pathlib.Path(temp)/'restore.sqlite'
            shutil.copy2(destination,restored)
            conn=sqlite3.connect(restored)
            if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('restore verification failed')
            conn.close()
    for source in pathlib.Path('/opt/infinite-canvas/server-data').glob('*.json'):
        shutil.copy2(source,target/source.name)
        (target/source.name).chmod(0o600)
    status.update(ok=True, restored=True)
    (target/'verified.json').write_text(json.dumps(status))
    # Bounded retention applies only to this dedicated backup tree.
    archives=sorted(p for p in root.iterdir() if p.is_dir() and (p/'verified.json').is_file())
    for item in archives[:-14]:
        shutil.rmtree(item)
finally:
    monitor=pathlib.Path('/opt/hoosland-monitor');monitor.mkdir(exist_ok=True)
    temp=monitor/'.backup-status.tmp';temp.write_text(json.dumps(status));temp.chmod(0o644);temp.replace(monitor/'backup-status.json')
if not status['ok']:
    raise RuntimeError('backup incomplete')
print(json.dumps(status))
