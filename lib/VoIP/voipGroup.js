import fs from "fs";
import path from "path";
import os from "os";
import util from "util";
import { execFile as execFileCb } from "child_process";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { setupVoip } from "@whiskeysockets/baileys/lib/VoIP/index.js";

const execFile = util.promisify(execFileCb);

global.llamadasActivas ??= {};

function unwrapMessage(message) {
    while (message) {
        const wrapper = [
            "ephemeralMessage",
            "viewOnceMessage",
            "viewOnceMessageV2",
            "documentWithCaptionMessage"
        ].find(key => message[key]?.message);

        if (!wrapper) break;
        message = message[wrapper].message;
    }

    return message;
}

async function downloadAudio(audioMessage) {
    const stream = await downloadContentFromMessage(audioMessage, "audio");
    const chunks = [];

    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

function ensureVoip(conn) {
    const alreadyReady = typeof conn.startGroupCall === "function"
        && typeof conn.endCall === "function"
        && typeof conn.playCallAudio === "function";

    if (alreadyReady && (!conn.__voipSetupWs || conn.__voipSetupWs === conn.ws)) {
        return true;
    }

    if (conn.__voipSetupWs === conn.ws) {
        return alreadyReady;
    }

    try {
        if (typeof conn.__voipStop === "function") {
            try { conn.__voipStop(); } catch (_) {}
        }
        conn.__voipStop = setupVoip(conn);
        conn.__voipSetupWs = conn.ws;
    } catch (e) {
        console.error("[CALL] error en setupVoip:", e);
        return false;
    }

    return typeof conn.startGroupCall === "function"
        && typeof conn.endCall === "function"
        && typeof conn.playCallAudio === "function";
}

function getActiveCallId(conn, chat) {
    const callId = global.llamadasActivas[chat];
    if (!callId) return null;
    if (!conn.calls || !conn.calls[callId]) {
        delete global.llamadasActivas[chat];
        return null;
    }
    return callId;
}

export const groupCallsModule = {
    category: 'group',
    commands: {
        callgp: {
            name: 'callgp',
            alias: ['callgp'],
            run: async (m, { conn, usedPrefix, command }) => {
                if (!m.isGroup) {
                    return m.reply("> Solo grupos.");
                }

                const chat = m.chat;
                const rawText = m.text || m.body || '';
                const args = rawText.trim().split(/\s+/).slice(1);
                const text = args[0]?.toLowerCase();

                try {
                    if (!text) {
                        return m.reply(
                            `ꕥ Opciones disponibles:\n\n` +
                            `> ● _Iniciar:_ *${usedPrefix + command} start*\n` +
                            `> ● _Finalizar:_ *${usedPrefix + command} end*\n` +
                            `> ● _Reproducir audio:_ *${usedPrefix + command} music*`
                        );
                    }

                    if (!ensureVoip(conn)) {
                        return m.reply("> No se pudo inicializar VoIP. Revisa la consola.");
                    }

                    const callId = getActiveCallId(conn, chat);

                    if (text === "start") {
                        if (callId) {
                            return m.reply("✎ Ya hay una llamada activa en este grupo.");
                        }

                        if (typeof conn.groupMetadata === 'function') {
                            await conn.groupMetadata(chat).catch(() => null);
                        }

                        const result = await conn.startGroupCall(chat, chat);

                        if (result && result.ok === undefined) {
                            if (result.callId) {
                                try { await conn.endCall(result.callId); } catch (_) {}
                            }
                            return m.reply("> voipGroup.js está en la versión vieja. Reemplázalo en lib/VoIP y reinicia el bot.");
                        }

                        if (!result || !result.ok) {
                            return m.reply(`> No se pudo iniciar la llamada. Motivo: ${(result && result.error) || 'desconocido'}.`);
                        }

                        global.llamadasActivas[chat] = result.callId;

                        let reply = `✎ Llamada iniciada. Invitados: ${result.participantCount} de ${result.totalMembers} miembros.`;
                        if (result.skipped > 0) {
                            reply += `\n> ${result.skipped} miembro(s) omitido(s) por no tener ID (LID) resuelto.`;
                        }
                        if (result.participantCount > 31) {
                            reply += `\n> WhatsApp permite máximo 32 conectados a la vez.`;
                        }
                        return m.reply(reply);
                    }

                    if (text === "end") {
                        if (!callId) {
                            return m.reply("✎ No hay una llamada activa en este grupo.");
                        }

                        await conn.endCall(callId);

                        delete global.llamadasActivas[chat];

                        return m.reply("✎ Llamada finalizada correctamente.");
                    }

                    if (text === "music") {
                        if (!callId) {
                            return m.reply("✎ Primero debes iniciar una llamada grupal.");
                        }

                        const message = unwrapMessage(m.message);
                        const contextInfo = message?.extendedTextMessage?.contextInfo;

                        const quotedMessage = unwrapMessage(
                            contextInfo?.quotedMessage
                        );

                        const audioMessage = quotedMessage?.audioMessage;

                        if (!contextInfo || !audioMessage) {
                            return m.reply(
                                `✎ Debes responder a un audio utilizando *${usedPrefix + command} music*.`
                            );
                        }

                        const tempId = `${process.pid}_${Date.now()}`;
                        const audioPath = path.join(os.tmpdir(), `kaede_${tempId}.audio`);
                        const pcmPath = path.join(os.tmpdir(), `kaede_${tempId}.pcm`);

                        try {
                            await m.reply("✎ Descargando audio...");

                            const audioBuffer = await downloadAudio(audioMessage);

                            await fs.promises.writeFile(audioPath, audioBuffer);

                            await execFile("ffmpeg", [
                                "-y",
                                "-i", audioPath,
                                "-f", "s16le",
                                "-acodec", "pcm_s16le",
                                "-ac", "1",
                                "-ar", "16000",
                                pcmPath
                            ]);

                            const pcmBuffer = await fs.promises.readFile(pcmPath);

                            const ok = conn.playCallAudio(callId, pcmBuffer);

                            if (!ok) {
                                return m.reply("✎ El bot aún no está conectado al audio de la llamada.");
                            }

                            return m.reply("✎ Reproduciendo el audio en la llamada. 🎵");

                        } finally {
                            await Promise.all(
                                [audioPath, pcmPath].map(file =>
                                    fs.promises.rm(file, { force: true })
                                )
                            );
                        }
                    }

                    return m.reply(
                        `✿ Opciones disponibles:\n\n` +
                        `> ● _Iniciar:_ *${usedPrefix + command} start*\n` +
                        `> ● _Finalizar:_ *${usedPrefix + command} end*\n` +
                        `> ● _Música:_ *${usedPrefix + command} music*`
                    );

                } catch (e) {
                    console.error("Error en callgp:", e);

                    return m.reply(
                        `> Ocurrió un error al ejecutar *${usedPrefix + command}*.\n` +
                        `> Error: ${e.message}`
                    );
                }
            }
        }
    }
};
