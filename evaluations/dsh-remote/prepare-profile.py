"""Write ONLY an explicitly isolated profile patch, after official plugin install."""
import os
from pathlib import Path

cache = Path(os.environ["EVAL_CACHE"]).resolve()
profile = cache / "dsh-home/profiles/dogo-eval"
if not (profile / "package.json").exists():
    raise SystemExit("Create the isolated dogo-eval profile and install the pinned plugin first")
fixture = Path(__file__).resolve().with_name("fixture-model.mjs")
(profile / "cordis.patch.yml").write_text(f"""- id: ds-harness-remote
  config:
    enabled: true
    role: host
    serverUrl: http://127.0.0.1:18180
    deviceName: DogO Evaluation Host
    forceRelay: true
    codex: {{enabled: false}}
    cursor: {{enabled: false}}
    acp: {{enabled: false}}
    terminal: {{enabled: false}}
- id: agent-default-model
  config: {{provider: dogo-eval, model: fixture}}
- id: session-title-llm
  disabled: true
- insert:
    - id: dogo-evaluation-model
      name: '{fixture}'
""")
print("Prepared isolated evaluation profile")
