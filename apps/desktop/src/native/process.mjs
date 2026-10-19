import { spawn } from 'node:child_process';

/** Bounded subprocess with cancellation of its local process group; never invokes a local shell. */
export function runProcess(command, args, { cwd, input = '', signal, timeout = 120000, limit = 2 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let stdout = '', stderr = '', bytes = 0, stopped = false, reason = '', killTimer;
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = value => {
      if (stopped) return; stopped = true; reason = value;
      const send = name => { try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); } catch {} };
      send('SIGTERM'); killTimer = setTimeout(() => send('SIGKILL'), 2000); killTimer.unref?.();
    };
    const abort = () => kill('cancelled'); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => kill('timeout'), timeout); timer.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const collect = (chunk, channel) => { bytes += Buffer.byteLength(chunk); if (bytes > limit) { kill('output-limit'); return; } if (channel === 'stdout') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', c => collect(c, 'stdout')); child.stderr.on('data', c => collect(c, 'stderr'));
    const finish = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (stopped && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    child.once('error', error => { finish(); reject(error); });
    child.once('close', (code, exitSignal) => { finish(); resolve({ code, signal: exitSignal, stdout, stderr, reason, truncated: reason === 'output-limit' }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
