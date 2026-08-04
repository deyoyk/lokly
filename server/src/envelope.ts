export function encodeEnvelope(json: object, body: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(4 + jsonBytes.byteLength + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, jsonBytes.byteLength, false);
  out.set(jsonBytes, 4);
  out.set(body, 4 + jsonBytes.byteLength);
  return out;
}

export function decodeEnvelope(data: Uint8Array): { json: any; body: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const jsonLen = view.getUint32(0, false);
  const json = JSON.parse(
    new TextDecoder().decode(data.subarray(4, 4 + jsonLen))
  );
  return { json, body: data.subarray(4 + jsonLen) };
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
