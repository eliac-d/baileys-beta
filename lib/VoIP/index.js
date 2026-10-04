import { startOutgoingCall, terminateCall } from './voip.js';
import { startOutgoingGroupCall } from './voipGroup.js';
import { joinCallLink } from './voipCallLink.js';
import { setupCallOrchestration } from './orchestrate.js';
import { makeCallLog } from './log.js';

export * from './voip.js';
export * from './relayParse.js';
export * from './relayDial.js';
export * from './log.js';

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

export { startOutgoingCall, startOutgoingGroupCall, terminateCall, joinCallLink };

export function setupVoip(sock) {
    if (!sock) return () => {};
    
    sock.calls = sock.calls || {};
    const log = typeof makeCallLog === 'function' ? makeCallLog(sock) : console.log;
    const stopOrchestration = typeof setupCallOrchestration === 'function' ? setupCallOrchestration(sock) : () => {};

    sock.startCall = (targetJid, originChatId) => startOutgoingCall(sock, targetJid, originChatId);
    sock.startGroupCall = (groupJid, originChatId) => startOutgoingGroupCall(sock, groupJid, originChatId);
    sock.joinCallLink = (tokenOrUrl, originChatId) => typeof joinCallLink === 'function' ? joinCallLink(sock, tokenOrUrl, originChatId) : null;

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
        stopOrchestration();
        for (const callId of Object.keys(sock.calls)) {
            const entry = sock.calls[callId];
            if (entry && entry.pc) { try { entry.pc.close(); } catch (_) {} }
        }
    };
}
