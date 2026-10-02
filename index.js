// Fake Toolcall Fix
// Detects fake image tool calls printed as plain text in an AI message:
//   {"action":"GenerateImage","action_input":"{\"prompt\":\"...\"}"}
//   { "prompt": "..." }
// Strips them (plus a bracketed description right before) and runs /sd.

const TOOL_NAMES = ['GenerateImage', 'generate_image'];
const START_RE = new RegExp(
    `\\{\\s*"(?:action"\\s*:\\s*"(?:${TOOL_NAMES.join('|')})"|prompt"\\s*:)`,
    'g',
);

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
    let input = obj.action_input ?? obj;
    if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { return input.trim(); }
    }
    return (input?.prompt ?? '').toString().trim();
}

function processText(text) {
    START_RE.lastIndex = 0;
    let m;
    while ((m = START_RE.exec(text))) {
        const start = m.index;
        const end = findObjectEnd(text, start);
        if (end < 0) continue;

        let obj;
        try { obj = JSON.parse(text.slice(start, end)); } catch { continue; }
        const prompt = getPrompt(obj);
        if (!prompt) continue;

        let s = start, e = end;

        // Swallow surrounding ``` fences if present
        const before = text.slice(0, s).match(/```(?:json)?\s*$/);
        const after = text.slice(e).match(/^\s*```/);
        if (before && after) { s -= before[0].length; e += after[0].length; }

        // Swallow a bracketed description right before the JSON
        // (works even if it has typos / differs slightly from the prompt)
        const bracket = text.slice(0, s).match(/\[[^\]\n]*\]\s*$/);
        if (bracket) s -= bracket[0].length;

        const cleaned = (text.slice(0, s) + text.slice(e)).trim();
        return { cleaned, prompt };
    }
    return null;
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
