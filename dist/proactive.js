import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
function flueCmd() {
    if (process.env.FLUE_CMD)
        return process.env.FLUE_CMD;
    const local = path.join(process.cwd(), 'node_modules', '.bin', 'flue');
    return existsSync(local) ? local : 'flue';
}
function redact(text) {
    return text
        .replace(/\b[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+/gi, '[redacted]')
        .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]');
}
export async function runFlueProactive(agent, payload) {
    if (process.env.FLUE_ENABLED === 'false')
        return { ok: false, error: 'FLUE_ENABLED=false' };
    const timeoutMs = Number(process.env.FLUE_TIMEOUT_MS || 30_000);
    const args = [
        'run',
        agent,
        '--target',
        'node',
        '--id',
        agent,
        '--payload',
        JSON.stringify(payload || {}),
        '--workspace',
        path.join(process.cwd(), '.flue'),
        '--output',
        path.join(process.cwd(), 'state', 'flue-node'),
    ];
    return await new Promise((resolve) => {
        const child = spawn(flueCmd(), args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (result.error)
                result.error = redact(result.error);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish({ ok: false, error: `Flue proactive agent ${agent} timed out after ${timeoutMs}ms` });
        }, timeoutMs);
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => finish({ ok: false, error: e.message }));
        child.on('close', (code) => {
            if (settled)
                return;
            const raw = stdout.trim();
            if (code !== 0 || !raw)
                return finish({ ok: false, error: stderr.trim() || `Flue exited ${code}` });
            try {
                finish({ ok: true, result: JSON.parse(raw) });
            }
            catch {
                finish({ ok: true, result: raw });
            }
        });
    });
}
