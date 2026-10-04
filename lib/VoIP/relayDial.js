import crypto from 'crypto';
import { createRequire } from 'module';
import * as stun from './stun.js';
import * as demux from './demux.js';
import * as rtcp from './rtcp.js';
import { createAudioSession } from './audioStream.js';

const require = createRequire(import.meta.url);

let cachedClientCert = null;

async function getClientCertificate() {
    if (cachedClientCert) return cachedClientCert;
    const { webcrypto } = await import('crypto');
    const { X509CertificateGenerator } = await import('@peculiar/x509');
    const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({
        serialNumber: '01',
        name: 'CN=systemzero',
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        signingAlgorithm: alg,
        keys,
    });
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
    const b64 = Buffer.from(pkcs8).toString('base64');
    const keyPem = '-----BEGIN PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
    cachedClientCert = { certPem: cert.toString('pem'), keyPem, signatureHash: { hash: 4, signature: 1 } };
    return cachedClientCert;
}

const AUDIO_CLOCK_RATE = 16000;
const SCTP_PORT = 5000;
const ALLOCATE_KEEPALIVE_MS = 1_000;
const TRANSPORT_TIMEOUT_MS = 15_000;
const OVERALL_GIVE_UP_MS = 45_000;
const DIAG_INTERVAL_MS = 5_000;
const ALLOCATE_WARN_MS = 8_000;
const DATACHANNEL_STREAM_ID = 0;
const ATTR_ERROR_CODE = 0x0009;

function createDcShim(log) {
    const handlers = { open: [], message: [], error: [], closed: [] };
    let isOpenFlag = false;
    let openFired = false;
    let closedFired = false;
    let sendImpl = () => { throw new Error('sendMessageBinary chamado antes do transporte conectar'); };
    const guard = (name, cb, arg) => {
        try {
            cb(arg);
        } catch (e) {
            if (log) log(`[CALL] [DC] erro no handler ${name}:`, e && e.stack ? e.stack : e);
        }
    };
    return {
        onOpen(cb) { handlers.open.push(cb); if (openFired) guard('open', cb); },
        onMessage(cb) { handlers.message.push(cb); },
        onError(cb) { handlers.error.push(cb); },
        onClosed(cb) { handlers.closed.push(cb); if (closedFired) guard('closed', cb); },
        isOpen() { return isOpenFlag; },
        sendMessageBinary(buf) { sendImpl(buf); },
        _setSend(fn) { sendImpl = fn; },
        _fireOpen() { if (openFired) return; openFired = true; isOpenFlag = true; handlers.open.forEach((cb) => guard('open', cb)); },
        _fireMessage(buf) { handlers.message.forEach((cb) => guard('message', cb, buf)); },
        _fireError(e) { handlers.error.forEach((cb) => guard('error', cb, e)); },
        _fireClosed() { if (closedFired) return; closedFired = true; isOpenFlag = false; handlers.closed.forEach((cb) => guard('closed', cb)); },
    };
}

function createPcShim() {
    const handlers = { state: [], iceState: [] };
    const data = { state: 'new', bytesSent: 0, bytesReceived: 0, rttMs: 0 };
    let onCloseFn = () => {};
    return {
        state() { return data.state; },
        iceState() { return data.state; },
        bytesSent() { return data.bytesSent; },
        bytesReceived() { return data.bytesReceived; },
        rtt() { return data.rttMs / 1000; },
        close() { try { onCloseFn(); } catch (_) {} },
        onStateChange(cb) { handlers.state.push(cb); },
        onIceStateChange(cb) { handlers.iceState.push(cb); },
        onGatheringStateChange() {},
        _setState(s) { data.state = s; handlers.state.forEach((cb) => cb(s)); handlers.iceState.forEach((cb) => cb(s)); },
        _addBytesSent(n) { data.bytesSent += n; },
        _addBytesReceived(n) { data.bytesReceived += n; },
        _setRtt(ms) { data.rttMs = ms; },
        _onClose(fn) { onCloseFn = fn; },
    };
}

function safeCall(fn) {
    try { return fn(); } catch { return '?'; }
}

function describeStunError(attrs) {
    const errAttr = attrs.find((a) => a.attrType === ATTR_ERROR_CODE);
    if (!errAttr || errAttr.value.length < 4) return 'sem ERROR-CODE';
    const code = errAttr.value[2] * 100 + errAttr.value[3];
    const reason = errAttr.value.length > 4 ? errAttr.value.subarray(4).toString('utf-8') : '';
    return `código=${code}${reason ? ` motivo="${reason}"` : ''}`;
}

export function attemptDataChannelConnect(callId, selfParticipantId, relayData, media, addr, callKey, { calls, log }) {
    const authToken = relayData.authTokens[media.authTokenId];
    if (!authToken || authToken.length === 0) {
        log(`[CALL] Sem auth_token válido (id ${media.authTokenId}) pra ${callId} — não dá pra montar o Allocate.`);
        return;
    }
    if (!relayData.relayKey || relayData.relayKey.length === 0) {
        log(`[CALL] Sem <key> decodificada pra ${callId}.`);
        return;
    }
    const relayToken = relayData.relayTokens[media.tokenId];
    if (!relayToken || relayToken.length === 0) {
        log(`[CALL] Sem relay_token válido (id ${media.tokenId}) pra ${callId} — não dá pra montar o Allocate.`);
        return;
    }
    if (!relayData.relayKeyAscii) {
        log(`[CALL] Sem <key> em texto (relayKeyAscii) pra ${callId} — não dá pra assinar o Allocate.`);
        return;
    }

    let DtlsClient, UdpTransport, SCTP, WEBRTC_PPID;
    try {
        ({ DtlsClient } = require('werift-dtls/lib/dtls/src/index'));
        ({ UdpTransport } = require('werift-dtls/lib/common/src/index'));
        ({ SCTP, WEBRTC_PPID } = require('werift-sctp'));
    } catch (e) {
        log(`[CALL] werift-dtls/werift-sctp não estão disponíveis pra ${callId}:`, e.message);
        return;
    }

    const entry = calls && calls[callId];
    const inBurst = () => !!(entry && entry.logBurstUntil && Date.now() < entry.logBurstUntil);

    const pc = createPcShim();
    if (entry) entry.pc = pc;

    let settled = false;
    let transportConnected = false;
    let dc = createDcShim(log);

    log(`[CALL] [DC ${callId}] hbh_key=${relayData.hbhKey ? relayData.hbhKey.length + 'B' : 'AUSENTE (RTCP vai usar chave e2e de fallback)'}.`);

    function status() {
        return `pc=${safeCall(() => pc.state())} ice=${safeCall(() => pc.iceState())} dcOpen=${safeCall(() => dc.isOpen())} ` +
            `bytesSent=${safeCall(() => pc.bytesSent())} bytesRecv=${safeCall(() => pc.bytesReceived())} rtt=${safeCall(() => pc.rtt())}`;
    }

    function closeForGood(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(transportTimer);
        clearTimeout(giveUpTimer);
        clearInterval(diagTimer);
        if (audioSession) audioSession.close();
        if (rtcpSession) rtcpSession.close();
        log(`[CALL] [DC ${callId}] ${reason} (${status()})`);
        try { pc.close(); } catch (_) {}
        dc._fireClosed();
        const current = calls && calls[callId];
        if (current && current.pc === pc && !current.reconnecting) delete calls[callId];
    }

    const transportTimer = setTimeout(() => {
        if (transportConnected || settled) return;
        closeForGood(`transporte (DTLS+SCTP) não conectou em ${TRANSPORT_TIMEOUT_MS}ms — desistindo`);
    }, TRANSPORT_TIMEOUT_MS);

    const giveUpMs = OVERALL_GIVE_UP_MS;
    const giveUpTimer = setTimeout(() => {
        closeForGood(`${giveUpMs}ms se passaram sem o DataChannel abrir — desistindo (mas o transporte chegou a conectar: ${transportConnected})`);
    }, giveUpMs);

    const diagTimer = setInterval(() => {
        if (settled) return;
        log(`[CALL] [DC ${callId}] status: ${status()}`);
    }, DIAG_INTERVAL_MS);

    (async () => {
        let udpTransport, dtlsClient, sctp;
        try {
            log(`[CALL] [DC ${callId}] abrindo socket UDP e iniciando DTLS direto com o relay (sem ICE), ${addr.ip}:${addr.port}...`);
            udpTransport = await UdpTransport.init('udp4');
            udpTransport.rinfo = { address: addr.ip, port: addr.port };

            const clientCert = await getClientCertificate();
            dtlsClient = new DtlsClient({
                transport: udpTransport,
                cert: clientCert.certPem,
                key: clientCert.keyPem,
                signatureHash: clientCert.signatureHash,
            });
            dtlsClient.onError.subscribe((e) => {
                log(`[CALL] [DC ${callId}] erro DTLS: ${e && e.stack ? e.stack : e}`);
            });
            dtlsClient.onClose.subscribe(() => {
                if (!settled) closeForGood('transporte DTLS fechou');
            });

            const sctpTransport = {
                send: (buf) => dtlsClient.send(buf),
                onData: undefined,
                close: () => {},
            };
            dtlsClient.onData.subscribe((buf) => {
                if (sctpTransport.onData) sctpTransport.onData(buf);
            });

            pc._setState('connecting');
            dtlsClient.connect();
            await dtlsClient.onConnect.asPromise(TRANSPORT_TIMEOUT_MS);
            if (settled) return;
            transportConnected = true;
            pc._setState('connected');
            log(`[CALL] [DC ${callId}] handshake DTLS completo. Iniciando SCTP...`);

            pc._onClose(() => {
                try { if (sctp) sctp.stop(); } catch (_) {}
                try { udpTransport.close(); } catch (_) {}
                dc._fireClosed();
            });

            sctp = SCTP.client(sctpTransport);
            sctp.onReceive.subscribe((streamId, ppId, data) => {
                if (streamId !== DATACHANNEL_STREAM_ID) return;
                pc._addBytesReceived(data.length);
                dc._fireMessage(data);
            });
            const sctpConnected = sctp.stateChanged.connected.asPromise(TRANSPORT_TIMEOUT_MS);
            await sctp.start(SCTP_PORT);
            await sctpConnected;
            if (settled) return;

            dc._setSend((buf) => {
                pc._addBytesSent(buf.length);
                sctp.send(DATACHANNEL_STREAM_ID, WEBRTC_PPID.BINARY, buf).catch((e) => {
                    log(`[CALL] [DC ${callId}] erro mandando pelo SCTP:`, e.message);
                });
            });

            clearTimeout(transportTimer);
            clearTimeout(giveUpTimer);
            clearInterval(diagTimer);
            log(`[CALL] [DC ${callId}] DATACHANNEL ABERTO (DTLS+SCTP direto) — conexão de mídia estabelecida com o relay! (${status()})`);
            dc._fireOpen();
        } catch (e) {
            if (!settled) closeForGood(`erro conectando transporte cru (DTLS/SCTP): ${e.stack || e.message}`);
        }
    })();

    dc.onOpen(() => {
        const endpointXor = stun.encodeXorRelayEndpoint(addr.ip, addr.port);
        if (!endpointXor) {
            log(`[CALL] [DC ${callId}] IPv4 inválido no endpoint (${addr.ip}), não dá pra montar o Allocate.`);
            return;
        }
        let allocatesSent = 0;
        let lastAllocateKind = null;
        let cachedPacket = null;
        let cachedPidsKey = null;

        const allocateWarnTimer = setTimeout(() => {
            if (!allocated && !settled) {
                log(`[CALL] [DC ${callId}] SEM resposta ao Allocate depois de ${ALLOCATE_WARN_MS}ms (${lastAllocateKind}, ${allocatesSent} envio(s)) (${status()}).`);
            }
        }, ALLOCATE_WARN_MS);

        const sendAllocate = () => {
            try {
                if (!dc.isOpen()) return;
                const liveEntry = calls && calls[callId];
                const livePids = liveEntry && liveEntry.pids ? Array.from(liveEntry.pids) : [];
                const pidsKey = livePids.slice().sort((a, b) => a - b).join(',');
                if (!cachedPacket || pidsKey !== cachedPidsKey) {
                    const tx = crypto.randomBytes(12);
                    if (livePids.length > 0) {
                        lastAllocateKind = 'grupo';
                        const appDataSsrc = stun.deriveWasmParticipantSsrc(callId, selfParticipantId, stun.APP_DATA_SSRC_SLOT_WORD);
                        if (liveEntry && !liveEntry.groupStreamSsrcs) {
                            liveEntry.groupStreamSsrcs = stun.prepareGroupStreamAuxSsrcs(callId, selfParticipantId, appDataSsrc);
                        }
                        const streamSsrcs = (liveEntry && liveEntry.groupStreamSsrcs)
                            || stun.prepareGroupStreamAuxSsrcs(callId, selfParticipantId, appDataSsrc);
                        const hbhFecSsrcs = [
                            stun.deriveWasmParticipantSsrc(callId, selfParticipantId, stun.HBH_FEC_TX_SSRC_SLOT_WORD),
                            stun.deriveWasmParticipantSsrc(callId, selfParticipantId, stun.HBH_FEC_RX_SSRC_SLOT_WORD),
                        ];
                        cachedPacket = stun.buildWasmGroupStunAllocateRequest({
                            transactionId: tx,
                            relayToken,
                            endpointXor,
                            integrityKey: relayData.relayKeyAscii,
                            streamSsrcs,
                            appDataSsrc,
                            hbhFecSsrcs,
                            participantPids: livePids,
                        });
                    } else {
                        lastAllocateKind = '1:1';
                        cachedPacket = stun.buildWasmStunAllocateRequest(tx, relayToken, endpointXor, relayData.relayKeyAscii, callId, selfParticipantId);
                    }
                    cachedPidsKey = pidsKey;
                    log(`[CALL] [DC ${callId}] Allocate (${lastAllocateKind}) NOVO montado (pids mudaram: [${cachedPidsKey}]) — reenviado como keepalive até mudar de novo.`);
                }
                dc.sendMessageBinary(cachedPacket);
                allocatesSent++;
                if (allocatesSent === 1 || allocatesSent % 30 === 0 || inBurst()) {
                    log(`[CALL] [DC ${callId}] Allocate (${lastAllocateKind}) reenviado pelo DataChannel (${cachedPacket.length} bytes, ${allocatesSent}º envio, pids=[${livePids.join(',')}]).`);
                }
                try {
                    const pingTx = crypto.randomBytes(12);
                    const ping = stun.buildWhatsappPing(pingTx);
                    dc.sendMessageBinary(ping);
                    if (allocatesSent === 1 || allocatesSent % 30 === 0 || inBurst()) {
                        log(`[CALL] [DC ${callId}] WhatsApp consent ping mandado (${ping.length} bytes, ${allocatesSent}º envio).`);
                    }
                } catch (e) {
                    log(`[CALL] [DC ${callId}] erro mandando WhatsApp consent ping:`, e.message);
                }
            } catch (e) {
                log(`[CALL] [DC ${callId}] erro montando/mandando Allocate (${lastAllocateKind}):`, e.stack || e.message);
            }
        };
        sendAllocate();
        const keepaliveTimer = setInterval(() => {
            if (!dc.isOpen()) { clearInterval(keepaliveTimer); return; }
            sendAllocate();
        }, ALLOCATE_KEEPALIVE_MS);
        dc.onClosed(() => {
            clearInterval(keepaliveTimer);
            clearTimeout(allocateWarnTimer);
        });
    });

    let audioSession = null;
    let rtcpSession = null;
    let allocated = false;
    let inboundCount = 0;
    let forwardedCount = 0;
    let rtcpInboundCount = 0;
    let droppedEnvelopeCount = 0;
    let rejectedCount = 0;

    dc.onMessage((msg) => {
        const raw = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        const unwrapped = demux.unwrapGroupForwardingPacket(raw);
        if (!unwrapped) {
            droppedEnvelopeCount++;
            log(`[CALL] [DC ${callId}] DESCARTADO: envelope 0x09 malformado ou payload inválido (${droppedEnvelopeCount}º descarte, ${raw.length}B, primeiros bytes=${raw.subarray(0, Math.min(16, raw.length)).toString('hex')}).`);
            return;
        }
        const buf = unwrapped.payload;
        if (unwrapped.groupForwarded) {
            forwardedCount++;
            if (forwardedCount === 1 || forwardedCount % 250 === 0 || inBurst()) {
                log(`[CALL] [DC ${callId}] mídia encaminhada de outro participante (${forwardedCount} pacote(s) até agora, ${buf.length}B, hdrLen=${unwrapped.forwardingHeaderLen}).`);
            }
        }
        if (stun.isStunPacket(buf)) {
            const msgType = stun.stunMessageType(buf);
            if (msgType === stun.MSG_ALLOCATE_SUCCESS) {
                if (!allocated) log(`[CALL] [DC ${callId}] Allocate ACEITO pelo relay! (${buf.length} bytes)`);
                else if (inBurst()) log(`[CALL] [DC ${callId}] Allocate re-confirmado pelo relay (${buf.length} bytes).`);
                if (!allocated && callKey) {
                    allocated = true;
                    if (entry && entry.pids instanceof Set && entry.pids.size > 0) entry.groupModeStartedAt = Date.now();
                    const ssrc = stun.deriveWasmParticipantSsrc(callId, selfParticipantId, 0);
                    const liveCallKey = (entry && entry.callKey) || callKey;
                    const rtpStateToUse = (entry && entry.pendingRtpState && entry.pendingRtpKey === liveCallKey)
                        ? entry.pendingRtpState
                        : null;
                    try {
                        rtcpSession = rtcp.createRtcpSession({
                            callId, localSsrc: ssrc, callKey: liveCallKey, hbhKey: relayData.hbhKey, selfParticipantId,
                            clockRate: AUDIO_CLOCK_RATE,
                            sendRaw: (packet) => dc.sendMessageBinary(packet),
                            log,
                            isBurst: inBurst,
                        });
                        rtcpSession.start();
                    } catch (e) {
                        log(`[CALL] [DC ${callId}] erro criando sessão RTCP:`, e.stack || e.message);
                    }
                    try {
                        audioSession = createAudioSession(callId, dc, {
                            callKey: liveCallKey, ssrc, selfParticipantId,
                            onSent: (payloadLength, timestamp) => { if (rtcpSession) rtcpSession.recordSent(payloadLength, timestamp); },
                            isBurst: inBurst,
                            rtpState: rtpStateToUse,
                            log,
                        });
                        if (entry) entry.audio = audioSession;
                        if (entry && entry.pendingAudioResume && typeof audioSession.resumeTrack === 'function') {
                            const resume = entry.pendingAudioResume;
                            entry.pendingAudioResume = null;
                            audioSession.resumeTrack(resume.track, resume.cursor);
                        }
                    } catch (e) {
                        log(`[CALL] [DC ${callId}] erro criando sessão de áudio:`, e.stack || e.message);
                    }
                    if (entry) {
                        entry.pendingRtpState = null;
                        entry.pendingRtpKey = null;
                    }
                }
            } else if (msgType === stun.MSG_ALLOCATE_ERROR) {
                rejectedCount++;
                const attrs = stun.parseStunAttributes(buf);
                if (rejectedCount === 1 || rejectedCount % 30 === 0) {
                    log(`[CALL] [DC ${callId}] Allocate REJEITADO (${rejectedCount}º). ${describeStunError(attrs)} attrs=${JSON.stringify(attrs.map((a) => ({ type: a.attrType.toString(16), len: a.value.length })))}`);
                }
            } else if (msgType === 0x0802) {
                if (inBurst()) log(`[CALL] [DC ${callId}] WhatsApp consent pong recebido (${buf.length} bytes).`);
            } else {
                log(`[CALL] [DC ${callId}] mensagem STUN recebida, tipo=0x${(msgType || 0).toString(16)}, ${buf.length} bytes`);
            }
        } else if (rtcp.isRtcpPacket(buf)) {
            rtcpInboundCount++;
            if (rtcpInboundCount === 1 || rtcpInboundCount % 250 === 0 || inBurst()) {
                log(`[CALL] [DC ${callId}] RTCP recebido de outro participante (${rtcpInboundCount}º, ${buf.length}B, pt=${buf[1]}).`);
            }
        } else {
            if (rtcpSession) rtcpSession.recordReceived(buf, Date.now());
            inboundCount++;
            if (inboundCount === 1 || inboundCount % 250 === 0) {
                log(`[CALL] [DC ${callId}] recebendo mídia do outro lado (${inboundCount} pacote(s) até agora, ${buf.length}B o último).`);
            } else if (inBurst()) {
                const hdr = rtcp.parseRtpHeaderBasics(buf);
                log(`[CALL] [DC ${callId}] RTP recebido #${inboundCount}: ${buf.length}B ssrc=${hdr ? hdr.ssrc : '?'} seq=${hdr ? hdr.sequenceNumber : '?'} ts=${hdr ? hdr.timestamp : '?'}`);
            }
        }
    });

    dc.onError((e) => closeForGood(`erro no DataChannel: ${e && e.stack ? e.stack : e}`));
    dc.onClosed(() => {
        if (audioSession) audioSession.close();
        if (rtcpSession) rtcpSession.close();
        if (!settled) closeForGood('DataChannel fechou antes de abrir');
    });
}
