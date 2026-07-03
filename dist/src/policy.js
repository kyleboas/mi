import { alwaysAskReason, matchDelegation, readDelegations } from './delegations.js';
const risky = [
    /\bedit\b/i,
    /\bchange\b/i,
    /\bmodify\b/i,
    /\bfix\b/i,
    /\bdelete\b/i,
    /\bremove\b/i,
    /\bdeploy\b/i,
    /\bpublish\b/i,
    /\bmerge\b/i,
    /\bcommit\b/i,
    /\bpush\b/i,
    /\bcreate pr\b/i,
    /\bopen pr\b/i,
    /\bsecret\b/i,
    /\btoken\b/i,
    /\bpassword\b/i,
    /\bapi key\b/i,
];
const localTargets = [
    /\brepo\b/i,
    /\brepository\b/i,
    /\bservice\b/i,
    /\bservices\b/i,
    /\bwiki\b/i,
    /\bfile\b/i,
    /\bfiles\b/i,
    /\blog\b/i,
    /\blogs\b/i,
    /\bprocess\b/i,
    /\bprocesses\b/i,
    /\bhealth\b/i,
    /\bserver\b/i,
    /\bapp\b/i,
    /\bproject\b/i,
];
const inspectionActions = [
    /\bcheck\b/i,
    /\binspect\b/i,
    /\bread\b/i,
    /\bsearch\b/i,
    /\bstatus\b/i,
    /\bsummarize\b/i,
    /\bsummary\b/i,
    /\bfind\b/i,
    /\blook up\b/i,
    /\blist\b/i,
    /\bshow\b/i,
];
function matchesAny(prompt, patterns) {
    return patterns.find((r) => r.test(prompt));
}
export async function classifyWithDelegations(prompt) {
    const askReason = alwaysAskReason(prompt);
    if (askReason)
        return { mode: 'approval-required', reason: askReason };
    const delegation = matchDelegation(prompt, await readDelegations());
    if (delegation)
        return { mode: 'delegated', reason: `Matched standing delegation: ${delegation.id}`, delegationId: delegation.id };
    return classify(prompt);
}
export function classify(prompt) {
    const askReason = alwaysAskReason(prompt);
    if (askReason)
        return { mode: 'approval-required', reason: askReason };
    const riskyHit = matchesAny(prompt, risky);
    if (riskyHit)
        return { mode: 'approval-required', reason: `Matched risky action pattern: ${riskyHit}` };
    const targetHit = matchesAny(prompt, localTargets);
    const actionHit = matchesAny(prompt, inspectionActions);
    if (targetHit && actionHit) {
        return { mode: 'pi-read-only', reason: `Matched local inspection patterns: ${actionHit} + ${targetHit}` };
    }
    return { mode: 'flue-chat', reason: 'No risky action or local inspection target/action pair matched.' };
}
