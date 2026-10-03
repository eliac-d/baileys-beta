

import { randomBytes } from 'crypto';
import { findRelayNode, parseRelayData, getMediaRelayEndpoint, getPrimaryIpv4Address } from './relayParse.js';
import { attemptDataChannelConnect } from './relayDial.js';
import { CAPABILITY_OFFER, formatParticipantId } from './voip.js';
import { remoteConnectedFromGroupInfoUsers, fanOutGroupRekey } from './voipGroup.js';
import { makeCallLog } from './log.js';

const LINK_JOIN_ACK_TIMEOUT_MS = 12_000;

function genId(bytes) {
    return randomBytes(bytes).toString('hex').toUpperCase();
}

export function normalizeCallLinkToken(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return null;
    if (!trimmed.includes('/')) return trimmed;
    const withoutQuery = trimmed.split(/[?#]/)[0];
    const parts = withoutQuery.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
}

function waitForAck(sock, wrapperId, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        sock.ws.once(`TAG:${wrapperId}`, (ackNode) => {
            clearTimeout(timer);
            resolve(ackNode);
        });
    });
}

function findNodeByTag(node, tag) {
    if (!node) return null;
    if (node.tag === tag) return node;
    const kids = Array.isArray(node.content) ? node.content : [];
    for (const kid of kids) {
        const found = findNodeByTag(kid, tag);
        if (found) return found;
    }
    return null;
}

function buildLinkJoinNode(token, wrapperId) {
    return {
        tag: 'call',
        attrs: { to: '@call', id: wrapperId },
        content: [
            {
                tag: 'link_join',
                attrs: { token, media: 'audio' },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                    { tag: 'net', attrs: { medium: '2' } },
                    { tag: 'capability', attrs: { ver: '1' }, content: CAPABILITY_OFFER },
                ],
            },
        ],
    };
}

function nodeToLoggable(n) {
    if (n == null) return n;
    if (Buffer.isBuffer(n) || n instanceof Uint8Array) return `<${n.length} byte(s)>`;
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(nodeToLoggable);
    if (typeof n === 'object' && n.tag) return { tag: n.tag, attrs: n.attrs || {}, content: nodeToLoggable(n.content) };
    return n;
}

export async function joinCallLink(sock, tokenOrUrl, originChatId) {
    const log = makeCallLog(sock);
    const token = normalizeCallLinkToken(tokenOrUrl);
    if (!token) {
        log('[CALL] token de link de chamada inválido/vazio.');
        return { ok: false, reason: 'token inválido' };
    }
    sock.sendPresenceUpdate('available').catch(() => {});

    const wrapperId = genId(8);
    const node = buildLinkJoinNode(token, wrapperId);
    const ackPromise = waitForAck(sock, wrapperId, LINK_JOIN_ACK_TIMEOUT_MS);
    await sock.sendNode(node);
    log(`[CALL] link_join mandado (token=${token}, wrapperId=${wrapperId}), esperando ack...`);

    const ackNode = await ackPromise;
    if (!ackNode) {
        log(`[CALL] Nenhum ack recebido pro link_join do token ${token} (timeout de ${LINK_JOIN_ACK_TIMEOUT_MS}ms).`);
        return { ok: false, reason: 'timeout' };
    }
    log(`[CALL] ack bruto do link_join (token=${token}): ${JSON.stringify(nodeToLoggable(ackNode))}`);

    const groupInfo = findNodeByTag(ackNode, 'group_info');
    if (!groupInfo || !groupInfo.attrs) {
        const waitingRoom = findNodeByTag(ackNode, 'waiting_room');
        if (waitingRoom) {
            log(`[CALL] link_join do token ${token} caiu numa sala de espera de verdade (sem group_info ainda) — precisa ser admitido por alguém antes de conectar.`);
            return { ok: false, reason: 'sala de espera' };
        }
        log(`[CALL] Ack do link_join (token ${token}) não trouxe group_info nem waiting_room — formato inesperado, olha o log bruto acima.`);
        return { ok: false, reason: 'formato inesperado' };
    }
    const callId = groupInfo.attrs['call-id'];
    const callCreator = groupInfo.attrs['call-creator'];
    if (!callId || !callCreator) {
        log(`[CALL] group_info do link_join (token ${token}) sem call-id/call-creator.`);
        return { ok: false, reason: 'sem call-id' };
    }

    const selfLidRaw = (sock.user && (sock.user.lid || sock.user.id)) || '';
    const selfParticipantId = formatParticipantId(selfLidRaw);
    const selfBareId = selfLidRaw.split('@')[0].split(':')[0];
    const callKey = randomBytes(32);

    sock.calls[callId] = {
        callId,
        peer: callId,
        callCreator,
        originChatId,
        status: 'offer',
        isGroup: true,
        isCallLink: true,
        startedAt: Date.now(),
        callKey,
        selfParticipantId,
        epochReady: false,
    };
    const entry = sock.calls[callId];

    const groupUsers = Array.isArray(groupInfo.content) ? groupInfo.content : [];
    const { connectedBareIds, remoteDeviceJids } = remoteConnectedFromGroupInfoUsers(groupUsers, selfBareId);
    entry.connectedBareIds = connectedBareIds;

    if (groupInfo.attrs && groupInfo.attrs.rekey === '1') {
        const freshEpoch = randomBytes(32);
        entry.callKey = freshEpoch;
        entry.epochReady = true;
        const transactionId = groupInfo.attrs['transaction-id'];
        log(`[CALL] group_info do link_join ${callId} pediu rekey (rekey="1") — gerando epoch de verdade e distribuindo pra ${remoteDeviceJids.length} dispositivo(s).`);
        fanOutGroupRekey(sock, callId, callCreator, freshEpoch, remoteDeviceJids, transactionId, log)
            .catch((e) => log(`[CALL] erro distribuindo epoch do link_join ${callId}:`, e.message));
    } else {
        log(`[CALL] group_info do link_join ${callId} sem rekey="1" — esperando alguém já autorizado (call-creator ou participante conectado) mandar a chave real via enc_rekey.`);
    }

    const relayNode = findRelayNode(ackNode);
    if (!relayNode) {
        log(`[CALL] Ack do link_join de ${callId} não trouxe <relay> — registrado, esperando ele chegar num group_update.`);
        return { ok: true, callId, pending: true };
    }
    const relayData = parseRelayData(relayNode);
    log(
        `[CALL] Relay do link_join ${callId}: ${relayData.endpoints.length} endpoint(s), ` +
        `${relayData.relayTokens.length} token(s), ${relayData.authTokens.length} auth_token(s), ` +
        `hbh_key=${relayData.hbhKey ? relayData.hbhKey.length + 'B' : 'ausente'}, ` +
        `key=${relayData.relayKey ? relayData.relayKey.length + 'B' : 'ausente'}`
    );

    const media = getMediaRelayEndpoint(relayData);
    if (!media) {
        log(`[CALL] Nenhum endpoint de mídia utilizável pro link_join ${callId}.`);
        return { ok: false, reason: 'sem endpoint' };
    }
    const addr = getPrimaryIpv4Address(media);
    if (!addr) {
        log(`[CALL] Endpoint ${media.relayName} do link_join ${callId} sem IPv4.`);
        return { ok: false, reason: 'sem ipv4' };
    }

    entry.relay = relayData;
    if (!entry.epochReady) {
        entry.pendingConnect = { relayData, media, addr };
        log(`[CALL] link_join ${callId}: relay chegou (${media.relayName} ${addr.ip}:${addr.port}) mas ainda esperando a chave real da chamada (epoch) antes de conectar.`);
        return { ok: true, callId, pending: true };
    }
    log(`[CALL] link_join OK — call-id=${callId}, endpoint=${media.relayName} (${addr.ip}:${addr.port}), epoch de verdade já pronta.`);
    attemptDataChannelConnect(callId, selfParticipantId, relayData, media, addr, entry.callKey, { calls: sock.calls, log });
    return { ok: true, callId };
}