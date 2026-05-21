import { assistantPath } from './assistant.js';
function inferName(description) {
    const lower = description.toLowerCase();
    if (lower.includes('production'))
        return 'production';
    if (lower.includes('repo'))
        return 'repo-maintenance';
    if (lower.includes('calendar'))
        return 'calendar';
    if (lower.includes('inbox') || lower.includes('email'))
        return 'inbox';
    return 'assistant';
}
export function draftAssistant(request) {
    const name = request.name || inferName(request.description);
    const path = assistantPath(name);
    const markdown = `---
name: ${name}
triggers:
  - manual: true
tools: []
permissions: {}
---
# ${name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Assistant

Goal:
${request.description.trim()}

Rules:
- Read first.
- Use the smallest useful context.
- Ask for approval before risky actions.
- Do not deploy, merge, edit secrets, or change production settings unless explicitly approved.
`;
    return { name, path, markdown };
}
export function explainBuilderLayer() {
    return 'Assistant Builder creates, edits, and explains assistants/*.md files. Builder changes are reviewable file changes; runtime assistants do not silently rewrite themselves.';
}
export function proposeAssistantEdit(request) {
    return {
        name: request.name,
        path: assistantPath(request.name),
        markdown: `${request.currentMarkdown.trim()}\n\n<!-- Proposed builder change: ${request.change.trim()} -->\n`,
    };
}
