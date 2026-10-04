export function makeCallLog(sock) {
    return (...args) => {
        const logger = sock && sock.logger;
        if (!logger || typeof logger.debug !== 'function') return;
        const text = args
            .map((a) => (typeof a === 'string' ? a : String((a && a.stack) || a)))
            .join(' ');
        logger.debug(text);
    };
}
