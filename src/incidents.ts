import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logEvent } from './state.js';

export type Incident = {
  id: string;
  ts: string;
  fingerprint: string;
  source: string;
  summary: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  issueFiled?: boolean;
};

const stateDir = path.resolve('state');
const incidentsFile = path.join(stateDir, 'incidents.jsonl');

async function ensureIncidentState() {
  await mkdir(stateDir, { recursive: true });
}

export async function readIncidents(file = incidentsFile): Promise<Incident[]> {
  await ensureIncidentState();
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Incident);
  } catch {
    return [];
  }
}

function stableId() {
  return `inc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function withinDays(ts: string, now: Date, days: number) {
  const t = Date.parse(ts);
  return Number.isFinite(t) && now.getTime() - t <= days * 24 * 60 * 60 * 1000;
}

export async function appendIncident(input: Omit<Incident, 'id' | 'ts'> & Partial<Pick<Incident, 'id' | 'ts'>>, file = incidentsFile) {
  await ensureIncidentState();
  const incident: Incident = {
    id: input.id || stableId(),
    ts: input.ts || new Date().toISOString(),
    fingerprint: input.fingerprint,
    source: input.source,
    summary: input.summary,
    severity: input.severity || 'warning',
    issueFiled: input.issueFiled,
  };
  const existing = await readIncidents(file);
  existing.push(incident);
  await writeFile(file, existing.map((item) => JSON.stringify(item)).join('\n') + '\n');
  await logEvent('mi.incident.recorded', incident);
  return incident;
}

export function recurringIncidentReady(incidents: Incident[], fingerprint: string, now = new Date(), threshold = 3, windowDays = 14) {
  const matches = incidents.filter((incident) => incident.fingerprint === fingerprint && withinDays(incident.ts, now, windowDays));
  return matches.length >= threshold && !matches.some((incident) => incident.issueFiled);
}

export async function markIncidentIssueFiled(fingerprint: string, issueUrl: string, file = incidentsFile) {
  const incidents = await readIncidents(file);
  for (const incident of incidents) {
    if (incident.fingerprint === fingerprint) incident.issueFiled = true;
  }
  await writeFile(file, incidents.map((item) => JSON.stringify({ ...item, issueUrl })).join('\n') + (incidents.length ? '\n' : ''));
  await logEvent('mi.incident.issue_filed', { fingerprint, issueUrl });
}
