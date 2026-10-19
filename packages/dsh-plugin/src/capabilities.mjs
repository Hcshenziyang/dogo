/** Model tools can invoke capabilities, never change their trusted desktop policy. */
export function registerCapabilities(ctx) {
  const url = process.env.DOGO_CAPABILITY_URL, token = process.env.DOGO_CAPABILITY_TOKEN;
  if (!url || !token || new URL(url).hostname !== '127.0.0.1') return;
  const operations = [
    ['dogo_capabilities', 'status', 'List explicitly authorized DogO device capabilities and project IDs. This never grants permissions.', {}],
    ['dogo_computer', 'computer', 'Observe the Mac screen or click/type using global screen coordinates. First take a screenshot and use read_image; do not guess unseen controls. Requires DogO computer permission and macOS screen/accessibility permission.', {
      action: { type: 'string', enum: ['status', 'screenshot', 'click', 'type', 'key', 'scroll', 'activate'] }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, key: { type: 'string' },
      modifiers: { type: 'array', items: { type: 'string' } }, button: { type: 'string', enum: ['left', 'right'] }, count: { type: 'integer' }, amount: { type: 'integer' }, bundleId: { type: 'string' },
    }],
    ['dogo_codex', 'codex', 'Delegate a coding task to the already signed-in local Codex CLI in one explicitly registered project. Returns final response, executed command exit codes and durable result. Uses workspace-write sandbox, never bypasses it. Do not repeat an uncertain or cancelled execution.', { projectId: { type: 'string' }, prompt: { type: 'string' } }],
    ['dogo_ssh', 'ssh', 'Execute a shell script on a user-authorized local SSH Host alias. Uses existing keys, strict host verification and noninteractive authentication. Returns stdout, stderr and exit status. A disconnect is not evidence of rollback; never automatically repeat uncertain writes.', { host: { type: 'string' }, command: { type: 'string' }, timeoutSeconds: { type: 'integer' } }],
  ];
  for (const [name, kind, description, properties] of operations) ctx.tools.register({ name, description,
    parameters: { type: 'object', properties, required: kind === 'status' ? [] : kind === 'computer' ? ['action'] : kind === 'codex' ? ['projectId', 'prompt'] : ['host', 'command'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, args }), redirect: 'error', signal: exec.signal });
      const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '设备能力调用失败'); return JSON.stringify(value);
    },
  });
}
