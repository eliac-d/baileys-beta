const MAX_BUFFER = 600;
const FLUSH_MS = 4000;
const CHUNK_SIZE = 3500;

function getState(sock) {
    if (!sock.__callLog) {
        sock.__callLog = { buffer: [], pending: [], timer: null, chat: null, sending: false };
    }
    return sock.__callLog;
}

function stamp() {
    return new Date().toTimeString().slice(0, 8);
}

function splitIntoChunks(lines) {
    const chunks = [];
    let current = '';
    for (const rawLine of lines) {
        let line = rawLine;
        while (line.length > CHUNK_SIZE) {
            if (current) { chunks.push(current); current = ''; }
            chunks.push(line.slice(0, CHUNK_SIZE));
            line = line.slice(CHUNK_SIZE);
        }
        if (current.length + line.length + 1 > CHUNK_SIZE) {
            chunks.push(current);
            current = '';
        }
        current += (current ? '\n' : '') + line;
    }
    if (current) chunks.push(current);
    return chunks;
}

export async function sendLinesToChat(sock, jid, lines) {
    for (const chunk of splitIntoChunks(lines)) {
        try {
            await sock.sendMessage(jid, { text: chunk });
        } catch (e) {
            console.log(`[CALL] erro mandando log pro chat: ${e.message}`);
        }
    }
}

export async function flushCallLog(sock) {
    const state = getState(sock);
    if (!state.chat || state.sending || state.pending.length === 0) return;
    state.sending = true;
    const lines = state.pending.splice(0, state.pending.length);
    try {
        await sendLinesToChat(sock, state.chat, lines);
    } finally {
        state.sending = false;
    }
}

export function setCallLogChat(sock, jid) {
    const state = getState(sock);
    state.chat = jid || null;
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
    if (state.chat) {
        state.timer = setInterval(() => { flushCallLog(sock); }, FLUSH_MS);
    } else {
        state.pending.length = 0;
    }
}

export function getCallLogChat(sock) {
    return getState(sock).chat;
}

export function getCallLogBuffer(sock, lastN = 80) {
    const state = getState(sock);
    return state.buffer.slice(-Math.max(1, lastN));
}

export function makeCallLog(sock) {
    return (...args) => {
        const text = args
            .map((a) => (typeof a === 'string' ? a : String((a && a.stack) || a)))
            .join(' ');
        const line = `${stamp()} ${text}`;
        console.log(text);
        const state = getState(sock);
        state.buffer.push(line);
        if (state.buffer.length > MAX_BUFFER) state.buffer.splice(0, state.buffer.length - MAX_BUFFER);
        if (state.chat) state.pending.push(line);
    };
}
