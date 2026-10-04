import { randomBytes } from 'crypto';

export const CAPABILITY_OFFER = Buffer.from([0x01, 0x05, 0xf7, 0x09, 0xe0, 0x3b, 0x13]);

function genId(bytes) {
    return randomBytes(bytes).toString('hex').toUpperCase();
}

export function formatParticipantId(jid) {
    const bare = (jid || '').split('/')[0].trim();
    const at = bare.lastIndexOf('@');
    if (at <= 0) return bare;
    const user = bare.slice(0, at);
    const domain = bare.slice(at + 1);
    if (domain === 'lid' && !user.includes(':')) return `${user}:0@${domain}`;
    return bare;
}

export async function startOutgoingCall(sock, targetJid, originChatId) {
    const callId = genId(16);
    const wrapperId = genId(8);
    const callCreator = sock?.user?.lid || sock?.user?.id || '';

    if (sock && sock.calls) {
        sock.calls[callId] = {
            callId,
            wrapperId,
            peer: targetJid,
            callCreator,
            originChatId: originChatId || targetJid,
            status: 'offer',
            startedAt: Date.now(),
            selfParticipantId: formatParticipantId(callCreator),
        };
    }

    return { callId, wrapperId, callCreator, encType: 0 };
}

export async function terminateCall(sock, callId, callCreator, to) {
    if (sock && sock.sendNode) {
        await sock.sendNode({
            tag: 'call',
            attrs: { to, id: genId(8) },
            content: [
                { tag: 'terminate', attrs: { 'call-id': callId, 'call-creator': callCreator }, content: [] },
            ],
        }).catch(() => {});
    }
}
