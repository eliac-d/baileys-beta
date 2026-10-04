import { randomBytes } from 'crypto';
import { proto } from '../../WAProto/index.js';
import { encodeWAMessage, encodeSignedDeviceIdentity, unpadRandomMax16 } from '../Utils/index.js';
import { jidDecode, jidEncode, isLidUser } from '../WABinary/index.js';
import { CAPABILITY_OFFER, formatParticipantId } from './voip.js';
import { findRelayNode, parseRelayData, getMediaRelayEndpoint, getPrimaryIpv4Address } from './relayParse.js';
import { attemptDataChannelConnect } from './relayDial.js';
import { makeCallLog } from './log.js';

const OFFER_ACK_TIMEOUT_MS = 12_000;
const GROUP_AUDIO_RATE = '16000';
export const MAX_REMOTE_PARTICIPANTS = 31;

function toNonAd(jid) {
    const decoded = jidDecode(jid);
    if (!decoded) return jid;
    return jidEncode(decoded.user, decoded.server);
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

function waitForAck(sock, wrapperId) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), OFFER_ACK_TIMEOUT_MS);
        sock.ws.once(`TAG:${wrapperId}`, (ackNode) => {
            clearTimeout(timer);
            resolve(ackNode);
        });
    });
}

function findChild(node, tag) {
    const kids = Array.isArray(node?.content) ? node.content : [];
    return kids.find((c) => c.tag === tag) || null;
}

function nodeToLoggable(node) {
    if (node == null) return node;
    if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
        const buf = Buffer.isBuffer(node) ? node : Buffer.from(node);
        return `<${buf.length} byte(s)>`;
    }
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(nodeToLoggable);
    if (typeof node === 'object' && node.tag) {
        return { tag: node.tag, attrs: node.attrs || {}, content: nodeToLoggable(node.content) };
    }
    return node;
}

async function participantLidOf(sock, p) {
    if (!p) return null;
    if (isLidUser(p.id)) return p.id;
    if (p.lid && isLidUser(p.lid)) return p.lid;
    const mapping = sock.signalRepository && sock.signalRepository.lidMapping;
    if (mapping && typeof mapping.getLIDForPN === 'function' && p.id) {
        try {
            const lid = await mapping.getLIDForPN(p.id);
            if (lid && isLidUser(lid)) return lid;
        } catch (_) {}
    }
    return null;
}

export async function buildGroupInfoUsers(sock, selfLid, participantLids) {
    const allLids = [selfLid, ...participantLids];
    const devices = await sock.getUSyncDevices(allLids, false, false);
    const selfUser = jidDecode(selfLid)?.user;

    const byUser = new Map();
    for (const d of devices) {
        const decoded = jidDecode(d.jid);
        const userKey = decoded ? decoded.user : d.user;
        if (!userKey) continue;
        const normalizedJid = formatParticipantId(d.jid);
        if (!byUser.has(userKey)) byUser.set(userKey, []);
        const list = byUser.get(userKey);
        if (!list.includes(normalizedJid)) list.push(normalizedJid);
    }

    const users = [];
    const remoteDeviceJids = [];
    for (const lid of allLids) {
        const userKey = jidDecode(lid)?.user;
        let deviceJids = (userKey && byUser.get(userKey)) || [];
        if (userKey === selfUser) {
            const selfDeviceJid = formatParticipantId(selfLid);
            if (!deviceJids.includes(selfDeviceJid)) deviceJids = [selfDeviceJid, ...deviceJids];
        }
        if (deviceJids.length === 0) deviceJids = [formatParticipantId(lid)];

        const isSelf = userKey === selfUser;
        users.push({
            tag: 'user',
            attrs: { jid: toNonAd(lid) },
            content: deviceJids.map((djid) => ({
                tag: 'device',
                attrs: { jid: djid },
                content: isSelf ? [{ tag: 'capability', attrs: { ver: '1' }, content: CAPABILITY_OFFER }] : [],
            })),
        });

        if (!isSelf) remoteDeviceJids.push(...deviceJids);
    }

    return { users, remoteDeviceJids };
}

export function remoteConnectedFromGroupInfoUsers(users, selfBareId) {
    const connectedBareIds = new Set();
    const remoteDeviceJids = [];
    for (const user of Array.isArray(users) ? users : []) {
        if (user.tag !== 'user' || !user.attrs || user.attrs.state !== 'connected') continue;
        const userBareId = (user.attrs.jid || '').split('@')[0].split(':')[0];
        if (selfBareId && userBareId === selfBareId) continue;
        connectedBareIds.add(userBareId);
        const devices = Array.isArray(user.content) ? user.content : [];
        for (const device of devices) {
            if (device.tag === 'device' && device.attrs && device.attrs.jid) remoteDeviceJids.push(device.attrs.jid);
        }
    }
    return { connectedBareIds, remoteDeviceJids };
}

export async function fanOutGroupRekey(sock, callId, callCreator, callKey, remoteDeviceJids, transactionId, log) {
    if (!remoteDeviceJids.length) {
        log(`[CALL] Nenhum dispositivo remoto pra distribuir a chave de ${callId}.`);
        return;
    }
    if (typeof sock.assertSessions === 'function') {
        try {
            await sock.assertSessions(remoteDeviceJids);
        } catch (e) {
            log(`[CALL] erro em assertSessions pra ${callId}:`, e.message);
        }
    }

    const messageProto = proto.Message.fromObject({ call: { callKey } });
    const encoded = encodeWAMessage(messageProto);

    let sent = 0;
    for (const deviceJid of remoteDeviceJids) {
        try {
            const { type, ciphertext } = await sock.signalRepository.encryptMessage({ jid: deviceJid, data: encoded });
            const children = [
                { tag: 'encopt', attrs: { keygen: '2' }, content: [] },
                { tag: 'enc', attrs: { v: '2', type, count: '0' }, content: ciphertext },
            ];
            if (type === 'pkmsg') {
                children.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: encodeSignedDeviceIdentity(sock.authState.creds.account, true),
                });
            }
            await sock.sendNode({
                tag: 'call',
                attrs: { to: deviceJid, id: genWrapperId() },
                content: [
                    {
                        tag: 'enc_rekey',
                        attrs: { 'call-id': callId, 'call-creator': callCreator, 'transaction-id': String(transactionId || 1) },
                        content: children,
                    },
                ],
            });
            sent++;
        } catch (e) {
            log(`[CALL] erro mandando enc_rekey pra ${deviceJid} em ${callId}:`, e.message);
        }
    }
    log(`[CALL] Chave da chamada de grupo ${callId} distribuída pra ${sent}/${remoteDeviceJids.length} dispositivo(s).`);
}

export async function decryptGroupEpoch(sock, senderDeviceJid, encType, ciphertext) {
    const plaintext = await sock.signalRepository.decryptMessage({ jid: senderDeviceJid, type: encType, ciphertext });
    const unpadded = unpadRandomMax16(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext));
    const message = proto.Message.decode(unpadded);
    const rawEpoch = message && message.call && message.call.callKey;
    if (!rawEpoch || rawEpoch.length !== 32) {
        throw new Error('mensagem decifrada não trouxe um callKey de 32 bytes');
    }
    return Buffer.isBuffer(rawEpoch) ? rawEpoch : Buffer.from(rawEpoch);
}

function findSelfPhashFromError(ackNode, selfBareJid) {
    const groupInfo = findChild(ackNode, 'group_info');
    const kids = Array.isArray(groupInfo?.content) ? groupInfo.content : [];
    const failedSelf = kids.find((c) => c.tag === 'user' && c.attrs?.jid === selfBareJid && c.attrs?.phash);
    return failedSelf ? failedSelf.attrs.phash : null;
}

async function handleGroupOfferAck(sock, callId, callCreator, callKey, remoteDeviceJids, ackNode, retryCtx, log) {
    if (!ackNode) {
        log(`[CALL] Nenhum ack recebido pro offer de grupo ${callId} (timeout de ${OFFER_ACK_TIMEOUT_MS}ms).`);
        if (sock.calls) delete sock.calls[callId];
        return;
    }
    log(`[CALL] Ack do offer de grupo ${callId} recebido: tag=${ackNode.tag}, attrs=${JSON.stringify(ackNode.attrs || {})}`);
    log(`[CALL] Ack COMPLETO de ${callId}: ${JSON.stringify(nodeToLoggable(ackNode))}`);

    if (ackNode.attrs && ackNode.attrs.error) {
        if (ackNode.attrs.error === '411' && retryCtx && retryCtx.attemptsLeft > 0) {
            const selfBareJid = toNonAd(callCreator);
            const phash = findSelfPhashFromError(ackNode, selfBareJid);
            if (phash) {
                log(`[CALL] Offer de grupo ${callId} levou 411, tentando de novo com phash=${phash}...`);
                const selfUserNode = retryCtx.users.find((u) => u.attrs.jid === selfBareJid);
                if (selfUserNode) selfUserNode.attrs.phash = phash;
                const retryAck = await sendGroupOfferAndWaitAck(sock, {
                    callId, selfLid: callCreator, groupJid: retryCtx.groupJid, users: retryCtx.users,
                }, log);
                return handleGroupOfferAck(sock, callId, callCreator, callKey, remoteDeviceJids, retryAck, {
                    ...retryCtx, attemptsLeft: retryCtx.attemptsLeft - 1,
                }, log);
            }
        }

        if (!findRelayNode(ackNode)) {
            log(`[CALL] Servidor rejeitou o offer de grupo ${callId} com erro ${ackNode.attrs.error} — não vai ter relay nem conexão.`);
            if (sock.calls) delete sock.calls[callId];
            return;
        }
        log(`[CALL] Ack de grupo ${callId} veio com erro ${ackNode.attrs.error}, mas trouxe relay/group_info junto — seguindo normalmente.`);
    }

    const groupInfo = findChild(ackNode, 'group_info');
    const transactionId = groupInfo?.attrs?.['transaction-id'];
    log(`[CALL] group_info de ${callId}: ${groupInfo ? JSON.stringify(groupInfo.attrs) : 'ausente'}`);

    const relayNode = findRelayNode(ackNode);
    if (!relayNode) {
        log(`[CALL] Ack de grupo ${callId} não trouxe <relay> nenhum.`);
        return;
    }
    const relayData = parseRelayData(relayNode);
    const entry = sock.calls && sock.calls[callId];
    if (entry) entry.relay = relayData;

    log(
        `[CALL] Relay de grupo ${callId}: ${relayData.endpoints.length} endpoint(s), ` +
        `${relayData.relayTokens.length} token(s), ${relayData.authTokens.length} auth_token(s), ` +
        `hbh_key=${relayData.hbhKey ? relayData.hbhKey.length + 'B' : 'ausente'}, ` +
        `key=${relayData.relayKey ? relayData.relayKey.length + 'B' : 'ausente'}, ` +
        `warp_mi_tag_len=${relayData.warpMiTagLen}`
    );

    const media = getMediaRelayEndpoint(relayData);
    if (!media) {
        log(`[CALL] Nenhum endpoint de mídia utilizável em ${callId} (sem IPv4 ou sem token correspondente).`);
        return;
    }
    const addr = getPrimaryIpv4Address(media);
    if (!addr) {
        log(`[CALL] Endpoint ${media.relayName} de ${callId} não tem IPv4.`);
        return;
    }
    log(`[CALL] Endpoint de mídia escolhido pra grupo ${callId}: ${media.relayName} (${addr.ip}:${addr.port})`);

    attemptDataChannelConnect(callId, formatParticipantId(callCreator), relayData, media, addr, callKey, { calls: sock.calls, log });

    fanOutGroupRekey(sock, callId, callCreator, callKey, remoteDeviceJids, transactionId, log)
        .catch((e) => log(`[CALL] erro distribuindo a chave da chamada de grupo ${callId}:`, e.message));
}

async function sendGroupOfferAndWaitAck(sock, { callId, selfLid, groupJid, users }, log) {
    const wrapperId = genWrapperId();
    const ackPromise = waitForAck(sock, wrapperId);

    const offerAttrs = { 'call-id': callId, 'call-creator': selfLid };
    if (groupJid.endsWith('@g.us')) offerAttrs['group-jid'] = groupJid;

    const offerNode = {
        tag: 'call',
        attrs: { to: `${callId}@call`, id: wrapperId },
        content: [
            {
                tag: 'offer',
                attrs: offerAttrs,
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: GROUP_AUDIO_RATE }, content: [] },
                    { tag: 'net', attrs: { medium: '3' }, content: [] },
                    { tag: 'group_info', attrs: {}, content: users },
                ],
            },
        ],
    };
    log(`[CALL] Offer de grupo ${callId} sendo mandado: ${JSON.stringify(nodeToLoggable(offerNode))}`);

    await sock.sendNode(offerNode);
    return ackPromise;
}

export async function startOutgoingGroupCall(sock, groupJid, originChatId) {
    const log = makeCallLog(sock);

    sock.sendPresenceUpdate('available').catch(() => {});

    const meta = await sock.groupMetadata(groupJid);
    const selfLid = sock.user?.lid || sock.user?.id;
    const selfUser = jidDecode(selfLid)?.user;

    const participantLids = [];
    let skipped = 0;
    for (const p of meta.participants || []) {
        const lid = await participantLidOf(sock, p);
        if (!lid) {
            skipped++;
            continue;
        }
        if (jidDecode(lid)?.user === selfUser) continue;
        if (!participantLids.includes(lid)) participantLids.push(lid);
    }
    if (skipped > 0) {
        log(`[CALL] ${skipped} participante(s) do grupo ${groupJid} sem LID resolvido foram ignorados.`);
    }

    if (participantLids.length < 1) {
        throw new Error('Preciso de pelo menos 1 otra persona con LID resuelto en este grupo para iniciar la llamada.');
    }
    if (participantLids.length > MAX_REMOTE_PARTICIPANTS) {
        participantLids.length = MAX_REMOTE_PARTICIPANTS;
    }

    const { users, remoteDeviceJids } = await buildGroupInfoUsers(sock, selfLid, participantLids);

    const callId = genCallId();
    const callKey = randomBytes(32);

    sock.calls ??= {};
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

    const ackPromise = sendGroupOfferAndWaitAck(sock, { callId, selfLid, groupJid, users }, log);

    ackPromise
        .then((ackNode) => handleGroupOfferAck(sock, callId, selfLid, callKey, remoteDeviceJids, ackNode, { groupJid, users, attemptsLeft: 1 }, log))
        .catch((e) => log(`[CALL] erro processando ack/relay de grupo ${callId}:`, e.message));

    return { callId, callCreator: selfLid, participantCount: participantLids.length };
}
