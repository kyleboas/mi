import type { NextFunction, Request, Response } from 'express';

function normalizeIp(value: string | undefined): string {
  if (!value) return '';
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
  if (value === '::1') return '127.0.0.1';
  return value;
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function isTailscaleIp(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function configuredAllowedIps(): Set<string> {
  return new Set(
    (process.env.TAILNET_ALLOWED_IPS || '')
      .split(',')
      .map((ip) => normalizeIp(ip.trim()))
      .filter(Boolean),
  );
}

export function isAllowedControlSurfaceIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return isLoopback(normalized) || isTailscaleIp(normalized) || configuredAllowedIps().has(normalized);
}

export function requireTailnet(req: Request, res: Response, next: NextFunction) {
  if (process.env.REQUIRE_TAILNET === 'false') return next();

  const remoteIp = normalizeIp(req.socket.remoteAddress || req.ip);
  if (isAllowedControlSurfaceIp(remoteIp)) return next();

  res.status(403).json({ error: 'Mi control surface is Tailnet-only' });
}

export function tailnetStatus(req: Request) {
  const remoteIp = normalizeIp(req.socket.remoteAddress || req.ip);
  return {
    required: process.env.REQUIRE_TAILNET !== 'false',
    remoteIp,
    allowed: isAllowedControlSurfaceIp(remoteIp),
  };
}
