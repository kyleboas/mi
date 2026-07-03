import path from 'node:path';
import { type CapabilityGrant, type Principal, fileGrant, urlGrant } from './capabilities.js';

export type ResourceReference = {
  kind: 'url' | 'file';
  value: string;
  grant: CapabilityGrant;
};

export function extractUrls(text: string): string[] {
  return Array.from(String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi), (match) => match[0].replace(/[).,;!?]+$/g, ''));
}

export function isBareUrlMessage(text: string) {
  const value = String(text || '').trim();
  return Boolean(value && /^(?:https?:\/\/\S+\s*)+$/i.test(value));
}

export function extractExplicitFilePaths(text: string): string[] {
  const matches = String(text || '').matchAll(/(?:^|\s)(?:file:\/\/)?((?:~|\.|\/)[^\s<>"']+)/g);
  return Array.from(matches, (match) => match[1].replace(/[).,;!?]+$/g, ''));
}

function expandHome(value: string) {
  if (value === '~') return process.env.HOME || value;
  if (value.startsWith('~/')) return path.join(process.env.HOME || '~', value.slice(2));
  return value;
}

export function referencesFromText(text: string, options: { principal?: Principal; cwd?: string; includeBareUrls?: boolean } = {}): ResourceReference[] {
  const refs: ResourceReference[] = [];
  if (options.includeBareUrls || !isBareUrlMessage(text)) {
    for (const url of extractUrls(text)) {
      refs.push({ kind: 'url', value: url, grant: urlGrant(url, { principal: options.principal }) });
    }
  }
  for (const filePath of extractExplicitFilePaths(text)) {
    const expanded = expandHome(filePath);
    refs.push({
      kind: 'file',
      value: expanded,
      grant: fileGrant(expanded, ['read'], { cwd: options.cwd, principal: options.principal, recursive: !path.extname(expanded) }),
    });
  }
  return refs;
}
