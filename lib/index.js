console.log('\x1b[1;\x1b[38;5;39m┌────────────────────────────────────────┐\x1b[0m');
console.log('\x1b[1;\x1b[38;5;45m│         \x1b[38;5;208m🤖 \x1b[38;5;118me\x1b[38;5;220m Bot \x1b[38;5;201mAUTOMATION \x1b[38;5;51mv2.0\x1b[38;5;45m         │\x1b[0m');
console.log('\x1b[1;\x1b[38;5;39m└────────────────────────────────────────┘\x1b[0m');
import makeWASocket from './Socket/index.js';
export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export { Dugong } from './Socket/dugong.js';
export * from './Modded/message_builder.js';
export * from './VoIP/index.js';
export { makeWASocket };
export default makeWASocket;
//# sourceMappingURL=index.js.map
