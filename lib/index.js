import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

console.log('\x1b[36m%s\x1b[0m', '╔══════════════════════════════════════╗');
console.log('\x1b[36m%s\x1b[0m', '║           YO SOY YO BAILEYS v2.0    ║');
console.log('\x1b[36m%s\x1b[0m', '╚══════════════════════════════════════╝');

// --- AUTO-FIX: Descommentar WAProto automáticamente en memoria/disco ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const waProtoPath = resolve(__dirname, '../WAProto/index.js');

if (existsSync(waProtoPath)) {
    try {
        let content = readFileSync(waProtoPath, 'utf8');
        let trimmed = content.trim();

        if (trimmed.startsWith('/*') && trimmed.endsWith('*/')) {
            console.log('\x1b[33m%s\x1b[0m', '[AUTO-FIX] Limpiando comentarios de WAProto/index.js...');
            let uncommented = trimmed.slice(2, -2);
            writeFileSync(waProtoPath, uncommented, 'utf8');
            console.log('\x1b[32m%s\x1b[0m', '[AUTO-FIX] WAProto descommentado con éxito.');
        }
    } catch (err) {
        console.error('Error procesando auto-fix de WAProto:', err.message);
    }
}

// --- IMPORTACIONES Y EXPORTACIONES DINÁMICAS ---
import makeWASocket from './Socket/index.js';

const WAProto = await import('../WAProto/index.js');
const Utils = await import('./Utils/index.js');
const Types = await import('./Types/index.js');
const Defaults = await import('./Defaults/index.js');
const WABinary = await import('./WABinary/index.js');
const WAM = await import('./WAM/index.js');
const WAUSync = await import('./WAUSync/index.js');
const Modded = await import('./Modded/message_builder.js');

export { Dugong } from './Socket/dugong.js';
export { VoipClient, ActiveCall, CallState } from './VoIP/index.js';

export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export * from './Modded/message_builder.js';

export { makeWASocket };
export default makeWASocket;
