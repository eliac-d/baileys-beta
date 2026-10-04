import { randomBytes } from 'crypto';

const OFFER_ACK_TIMEOUT_MS = 12_000;
const GROUP_AUDIO_RATE = '16000';
export const MAX_REMOTE_PARTICIPANTS = 31;

export const CAPABILITY_OFFER = Buffer.from([0x01, 0x05, 0xf7, 0x09, 0xe0, 0x3b, 0x13]);

function formatParticipantId(jid) {
    const bare = (jid || '').split('/')[0].trim();
    const at = bare.lastIndexOf('@');
    if (at <= 0) return bare;
    const user = bare.slice(0, at);
    const domain = bare.slice(at + 1);
    if (domain === 'lid' && !user.includes(':')) return `${user}:0@${domain}`;
    return bare;
}

function genHex(bytes) {
    return randomBytes(bytes).toString('hex');
}

function genCallId() {
    return '00' + genHex(15);
}

function genWrapperId() {
    return genHex(8).toUpperCase();
}

export async function buildGroupInfoUsers(sock, selfLid, participantLids) {
    const allLids = [selfLid, ...participantLids];
    const users = [];
    const remoteDeviceJids = [];

    for (const lid of allLids) {
        const djid = formatParticipantId(lid);
        users.push({
            tag: 'user',
            attrs: { jid: lid },
            content: [{ tag: 'device', attrs: { jid: djid }, content: [] }]
        });
        if (lid !== selfLid) remoteDeviceJids.push(djid);
    }

    return { users, remoteDeviceJids };
}

export function remoteConnectedFromGroupInfoUsers(users, selfBareId) {
    const connectedBareIds = new Set();
    const remoteDeviceJids = [];
    return { connectedBareIds, remoteDeviceJids };
}

export async function fanOutGroupRekey(sock, callId, callCreator, callKey, remoteDeviceJids, transactionId, log) {
    return;
}

export async function decryptGroupEpoch(sock, senderDeviceJid, encType, ciphertext) {
    return Buffer.alloc(32);
}

export async function startOutgoingGroupCall(sock, groupJid, originChatId) {
    const selfLid = sock?.user?.lid || sock?.user?.id || '';
    const callId = genCallId();
    const callKey = randomBytes(32);

    if (sock && sock.calls) {
        sock.calls[callId] = {
            callId,
            peer: groupJid,
            callCreator: selfLid,
            originChatId: originChatId || groupJid,
            status: 'offer',
            isGroup: true,
            startedAt: Date.now(),
            callKey,
            selfParticipantId: formatParticipantId(selfLid),
            epochReady: true,
        };
    }

    return { callId, callCreator: selfLid, participantCount: 0 };
}
