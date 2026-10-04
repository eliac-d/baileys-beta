

const FORWARDING_HEADER_LENS = { 2: 8, 4: 12, 7: 18 };

export function unwrapGroupForwardingPacket(data) {
    if (!data || data.length === 0 || data[0] !== 0x09) {
        return { payload: data, groupForwarded: false, forwardingHeaderLen: 0 };
    }
    const forwardingHeaderLen = FORWARDING_HEADER_LENS[data[1]];
    if (forwardingHeaderLen === undefined || data.length < forwardingHeaderLen) return null;
    const payload = data.subarray(forwardingHeaderLen);
    if (payload.length < 12 || (payload[0] >> 6) !== 2) return null;
    return { payload, groupForwarded: true, forwardingHeaderLen };
}
