const riskyPermissionValues = new Set(['write', true]);
const riskyPermissionKeys = /write|deploy|merge|delete|mutate|edit_secrets|contents|pull_requests|dns|publish|push/i;
export function permissionValue(permissions, scope, action) {
    return permissions[scope]?.[action];
}
export function isRiskyPermission(scope, action, value) {
    if (value === false || value === 'read' || value === undefined)
        return false;
    return riskyPermissionValues.has(value) || riskyPermissionKeys.test(`${scope}.${action}`);
}
export function assistantHasRiskyPermissions(assistant) {
    for (const [scope, actions] of Object.entries(assistant.permissions || {})) {
        for (const [action, value] of Object.entries(actions)) {
            if (isRiskyPermission(scope, action, value))
                return true;
        }
    }
    return false;
}
export function toolNeedsApproval(tool) {
    return Boolean(tool.permissions?.some((permission) => permission === 'approval_required' || /write|deploy|merge|delete|mutate|edit|pull_requests/i.test(permission)));
}
export function decideToolSafety(assistant, tool) {
    if (toolNeedsApproval(tool)) {
        return { allowed: false, approvalRequired: true, reason: `${tool.name} can perform risky actions and requires approval` };
    }
    if (assistantHasRiskyPermissions(assistant)) {
        return { allowed: false, approvalRequired: true, reason: 'assistant has risky write-like permissions; require approval before action' };
    }
    return { allowed: true, reason: 'read-only/default-safe action' };
}
export function assertRuntimeCannotSelfModify(targetPath) {
    if (/^assistants\/.*\.md$/i.test(targetPath)) {
        return { allowed: false, approvalRequired: true, reason: 'runtime assistants cannot silently rewrite assistant instruction files' };
    }
    return { allowed: true, reason: 'not an assistant instruction file' };
}
