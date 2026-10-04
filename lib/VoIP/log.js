export function makeCallLog(sock) {
    return (...args) => {
        const line = args
            .map((a) => (typeof a === 'string' ? a : String((a && a.stack) || a)))
            .join(' ');
        console.log(line);
    };
}
