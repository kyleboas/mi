import { defineTool } from '../../src/primitives.js';
function unavailable(name) {
    return {
        ok: false,
        tool: name,
        summary: 'GitHub local package is installed, but real GitHub API wiring is a later phase.',
        needsConfig: ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
    };
}
export const githubGetLatestFailedRun = defineTool({
    name: 'github.getLatestFailedRun',
    description: 'Read the latest failed GitHub Actions run.',
    permissions: ['actions:read'],
    async run() {
        return unavailable('github.getLatestFailedRun');
    },
});
export const githubOpenPullRequest = defineTool({
    name: 'github.openPullRequest',
    description: 'Open a pull request for an approved branch.',
    permissions: ['pull_requests:write', 'approval_required'],
    async run(input) {
        return { ...unavailable('github.openPullRequest'), requested: input };
    },
});
export const tools = [githubGetLatestFailedRun, githubOpenPullRequest];
