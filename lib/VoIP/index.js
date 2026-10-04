import { startOutgoingCall, terminateCall } from './voip.js';
import { startOutgoingGroupCall } from './groupCall.js';
import { makeCallLog } from './log.js';

// Clases y constantes de soporte para librerías o re-exportaciones externas
export class VoipClient {
    constructor() {}
}

export class ActiveCall {
    constructor() {}
}

export const CallState = {
    IDLE: 'IDLE',
    OFFERING: 'OFFERING',
    ACTIVE: 'ACTIVE',
    ENDED: 'ENDED'
};

export * from './voip.js';

export function setupVoip(sock) {
    sock.calls = sock.calls || {};
    const log = typeof makeCallLog === 'function' ? makeCallLog(sock) : console.log;

    sock.startCall = (targetJid, originChatId) => startOutgoingCall(sock, targetJid, originChatId);
    sock.startGroupCall = (groupJid, originChatId) => startOutgoingGroupCall(sock, groupJid, originChatId);
    sock.joinCallLink = async (tokenOrUrl, originChatId) => ({ success: false, reason: 'Call links disabled' });

    sock.endCall = async (callId) => {
        const entry = sock.calls[callId];
        if (!entry) return false;
        const to = entry.isGroup ? `${callId}@call` : entry.peer;
        await terminateCall(sock, callId, entry.callCreator, to).catch((e) => log(`[CALL] erro terminando ${callId}:`, e.message));
        if (entry.pc) { try { entry.pc.close(); } catch (_) {} }
        delete sock.calls[callId];
        return true;
    };

    sock.playCallAudio = (callId, pcmBuffer) => {
        const entry = sock.calls[callId];
        if (!entry || !entry.audio) return false;
        entry.audio.playPcm(pcmBuffer);
        return true;
    };

    sock.stopCallAudio = (callId) => {
        const entry = sock.calls[callId];
        if (!entry || !entry.audio) return false;
        entry.audio.stopTrack();
        return true;
    };

    return () => {
        for (const callId of Object.keys(sock.calls)) {
            const entry = sock.calls[callId];
            if (entry && entry.pc) { try { entry.pc.close(); } catch (_) {} }
        }
    };
}
