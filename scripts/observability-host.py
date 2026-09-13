#!/usr/bin/env python3
"""Read-only host sampler. Writes only an allowlisted operational snapshot, never container env."""
import datetime
import json
import os
import pathlib
import shutil
import subprocess
import time
import urllib.request

directory = pathlib.Path(os.environ.get("CANVAS_MONITOR_DIR", "/opt/hoosland-monitor"))
directory.mkdir(parents=True, exist_ok=True)
target = directory / "snapshot.json"
try:
    previous = json.loads(target.read_text())
except (OSError, ValueError):
    previous = {}
now = time.time()
cpu = [int(x) for x in pathlib.Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
total, idle = sum(cpu[:8]), cpu[3] + cpu[4]
old = previous.get("_cpu", [total, idle])
elapsed = total - old[0]
memory = {}
for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
    key, value = line.split(":", 1)
    memory[key] = int(value.split()[0]) * 1024
disk = shutil.disk_usage("/opt")
containers = []
try:
    stats = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{json .}}"], capture_output=True, text=True, timeout=8, check=True)
    statuses = subprocess.run(["docker", "ps", "-a", "--format", "{{json .}}"], capture_output=True, text=True, timeout=3, check=True)
    state = {r["Names"]: r["Status"] for r in map(json.loads, statuses.stdout.splitlines())}
    for row in map(json.loads, stats.stdout.splitlines()):
        if row["Name"].startswith(("infinite-canvas-", "hoosland-gateway-", "hoosland-monitor-")):
            containers.append({"name": row["Name"], "cpu": row["CPUPerc"], "memory": row["MemUsage"], "network": row["NetIO"], "io": row["BlockIO"], "status": state.get(row["Name"], "unknown")})
except (OSError, subprocess.SubprocessError):
    pass
checks = []
for name, host, route in [("画布", "can.hoosland.com", "/"), ("画布API", "can.hoosland.com", "/api/health"), ("独立视觉工作台", "ins.hoosland.com", "/tools/visual-workbench/")]:
    started = time.monotonic()
    try:
        req = urllib.request.Request("http://127.0.0.1" + route, headers={"Host": host})
        with urllib.request.urlopen(req, timeout=3) as response:
            body = response.read(16384)
            ok = response.status == 200 and (name != "画布API" or json.loads(body).get("service") == "infinite-canvas-server")
    except (OSError, ValueError):
        ok = False
    checks.append({"name": name, "ok": ok, "latencyMs": round((time.monotonic() - started) * 1000)})
try:
    backup = json.loads((directory / "backup-status.json").read_text())
except (OSError, ValueError):
    backup = None
snapshot = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "cpuPercent": round(100 * (1 - (idle - old[1]) / elapsed), 2) if elapsed > 0 else None, "cpuCores": os.cpu_count(), "memoryTotal": memory["MemTotal"], "memoryAvailable": memory["MemAvailable"], "memoryPercent": round(100 * (1 - memory["MemAvailable"] / memory["MemTotal"]), 2), "diskTotal": disk.total, "diskAvailable": disk.free, "diskUsedPercent": round(100 * disk.used / disk.total, 2), "load": list(os.getloadavg()), "containers": containers, "checks": checks, "backup": backup, "_cpu": [total, idle], "_sampledAt": now}
temp = directory / ".snapshot.tmp"
temp.write_text(json.dumps(snapshot, ensure_ascii=False))
temp.chmod(0o644)
temp.replace(target)
