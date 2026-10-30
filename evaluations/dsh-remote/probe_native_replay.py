"""Run after restarting the isolated native DSH process, following queue probe."""
import json
import os
from pathlib import Path
import time
import httpx

cache = Path(os.environ["EVAL_CACHE"])
replay = json.loads((cache / "queue-replay.json").read_text())

def count():
    attempts = [json.loads(line) for line in (cache / "model-attempts.jsonl").read_text().splitlines()]
    return sum(a["phase"] == "start" and a["text"] == replay["marker"] for a in attempts)

before = count()
with httpx.Client(base_url="http://127.0.0.1:18181", headers={"Cookie": (cache / "browser-cookie").read_text()}, trust_env=False) as http:
    result = http.post("/api/session/prompt", json={"type": "client-request", "rpcId": "restart-replay", "method": "session/prompt", "payload": {"args": {"request": replay["request"]}}}).json()["result"]
time.sleep(2.5)
after = count()
outcome = {"test": "native-request-dedup-after-host-process-restart", "before": before, "after": after, "result": result, "passed": before == after == 1 and result.get("ok") is True}
(cache / "native-replay-probe.json").write_text(json.dumps(outcome, indent=2))
print(json.dumps(outcome, indent=2))
assert outcome["passed"], "Native prompt dedup did not survive Host restart"
