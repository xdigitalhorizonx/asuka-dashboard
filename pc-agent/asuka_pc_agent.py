#!/usr/bin/env python3
"""Asuka PC agent: runs named, allowlisted commands that Brandon queues by text.

Asuka never stores the PIN. Each queued command carries scrypt(PIN, salt); this agent
hashes its own local PIN (env ASUKA_PC_PIN, set only on this PC) with the same salt and
runs the command only on a match. Commands are looked up by name in a local JSON file
and run without a shell, so a text can never become arbitrary code.

Env (set on this PC only):
  ASUKA_PC_PIN          the PIN Brandon texts with each command (4-12 digits)
  ASUKA_PC_TOKEN        must match ASUKA_PC_TOKEN on the dashboard's Vercel project
  ASUKA_DASHBOARD_URL   default https://asuka-dashboard-jet.vercel.app
  ASUKA_PC_COMMANDS     default ~/.asuka/pc-commands.json  ({"name": ["exe", "arg", ...]})
  ASUKA_PC_INTERVAL     poll seconds, default 20

Usage:  python asuka_pc_agent.py          (runs forever)
        python asuka_pc_agent.py --once   (one poll, for testing)
Python 3.8+ standard library only.
"""
import base64, hashlib, hmac, json, os, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

URL = os.environ.get("ASUKA_DASHBOARD_URL", "https://asuka-dashboard-jet.vercel.app").rstrip("/") + "/api/pc"
COMMANDS_FILE = Path(os.environ.get("ASUKA_PC_COMMANDS", str(Path.home() / ".asuka" / "pc-commands.json")))
INTERVAL = max(5, int(os.environ.get("ASUKA_PC_INTERVAL", "20")))
TIMEOUT = 120


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def call(method, body=None):
    token = os.environ.get("ASUKA_PC_TOKEN", "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL, data=data, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


def pin_ok(cmd, pin):
    kdf = cmd.get("kdf") or {}
    try:
        salt = base64.b64decode(cmd["salt"])
        want = base64.b64decode(cmd["hash"])
        got = hashlib.scrypt(pin.encode(), salt=salt, n=int(kdf["N"]), r=int(kdf["r"]), p=int(kdf["p"]),
                             dklen=int(kdf["keylen"]), maxmem=256 * int(kdf["N"]) * int(kdf["r"]))
    except Exception:
        return False
    return hmac.compare_digest(got, want)


def load_commands():
    try:
        table = json.loads(COMMANDS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    return {k: v for k, v in table.items() if isinstance(v, list) and v and all(isinstance(a, str) for a in v)}


def handle(cmd, pin, commands):
    name = cmd.get("command", "")
    if not pin_ok(cmd, pin):
        return "rejected", "wrong PIN"
    argv = commands.get(name)
    if not argv:
        return "rejected", "'%s' is not an allowed command on this PC (allowed: %s)" % (name, ", ".join(sorted(commands)) or "none")
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=TIMEOUT, shell=False)
    except subprocess.TimeoutExpired:
        return "error", "timed out after %ss" % TIMEOUT
    except OSError as e:
        return "error", "could not start: %s" % e
    out = (p.stdout or "") + (("\n" + p.stderr) if p.stderr else "")
    return ("ok" if p.returncode == 0 else "error"), (out.strip() or "exit %d" % p.returncode)[-2000:]


def poll_once():
    pin = os.environ.get("ASUKA_PC_PIN", "")
    if not (pin.isdigit() and 4 <= len(pin) <= 12):
        log("ASUKA_PC_PIN is not set to 4-12 digits; refusing to run anything")
        return
    commands = load_commands()
    for cmd in call("GET").get("commands", []):
        status, output = handle(cmd, pin, commands)
        call("POST", {"id": cmd["id"], "status": status, "output": output})
        log("%s %s -> %s" % (cmd.get("id"), cmd.get("command"), status))


def main():
    if not os.environ.get("ASUKA_PC_TOKEN"):
        sys.exit("ASUKA_PC_TOKEN is not set")
    once = "--once" in sys.argv
    while True:
        try:
            poll_once()
        except urllib.error.HTTPError as e:
            log("dashboard answered HTTP %s" % e.code)
        except Exception as e:  # network blips: keep going
            log("poll failed: %s" % e)
        if once:
            return
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
