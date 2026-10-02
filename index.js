// Fake Toolcall Fix
// Detects {"action":"GenerateImage","action_input":...} printed as plain text
// in an AI message, strips it, and runs /sd with the extracted prompt.

const TOOL_NAMES = ['GenerateImage', 'generate_image'];
const START_RE = new RegExp(`\\{\\s*"action"\\s*:\\s*"(?:${TOOL_NAMES.join('|')})"`, 'g');

// Find the matching closing brace, respecting strings.
function findObjectEnd(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

function getPrompt(obj) {
    let input = obj.action_input;
    if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { return input.trim(); }
    }
    return (input?.prompt ?? '').toString().trim();
}

function processText(text) {
    START_RE.lastIndex = 0;
    const m = START_RE.exec(text);
    if (!m) return null;

    const start = m.index;
    const end = findObjectEnd(text, start);
    if (end < 0) return null;

    let obj;
    try { obj = JSON.parse(text.slice(start, end)); } catch { return null; }
    const prompt = getPrompt(obj);
    if (!prompt) return null;

    // Also swallow surrounding ``` fences if present
    let s = start, e = end;
    const before = text.slice(0, s).match(/```(?:json)?\s*$/);
    const after = text.slice(e).match(/^\s*```/);
    if (before && after) { s -= before[0].length; e += after[0].length; }

    let cleaned = text.slice(0, s) + text.slice(e);

    // Remove the bracketed description if it just repeats the prompt
    const esc = prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`\\[\\s*${esc}\\s*\\]\\s*`, 'i'), '');

    return { cleaned: cleaned.trim(), prompt };
}

async function handleMessage(id) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[id];
    if (!message || message.is_user || message.is_system) return;

    const result = processText(message.mes ?? '');
    if (!result) return;

    message.mes = result.cleaned;
    ctx.updateMessageBlock(id, message);
    await ctx.saveChat();

    const safePrompt = result.prompt.replace(/\|/g, ' ').replace(/\s+/g, ' ');
    await ctx.executeSlashCommandsWithOptions(`/sd ${safePrompt}`);
}

jQuery(() => {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessage);
    console.log('[Fake Toolcall Fix] loaded');
});
