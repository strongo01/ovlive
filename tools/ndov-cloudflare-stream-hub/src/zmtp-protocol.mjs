const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function concatBytes(...arrays) {
  const size = arrays.reduce((n, arr) => n + arr.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function makeGreeting() {
  // ZMTP 3.1 64-byte greeting, NULL security, client role.
  const greeting = new Uint8Array(64);
  greeting[0] = 0xff;
  greeting[9] = 0x7f;
  greeting[10] = 3;
  greeting[11] = 1;
  greeting.set(encoder.encode('NULL'), 12);
  greeting[32] = 0; // client, not server
  return greeting;
}

export function parseGreeting(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) {
    throw new Error(`Invalid ZMTP greeting length: ${bytes?.length ?? 'non-bytes'}`);
  }
  if (bytes[0] !== 0xff || bytes[9] !== 0x7f) {
    throw new Error('Peer did not send a ZMTP 3.x greeting; this probe supports ZMTP 3.x only.');
  }
  const major = bytes[10];
  const minor = bytes[11];
  const mechanism = decoder.decode(bytes.subarray(12, 32)).replace(/\0+$/g, '');
  const asServer = bytes[32] === 1;
  if (major !== 3) throw new Error(`Unsupported ZMTP major version ${major}`);
  if (mechanism !== 'NULL') throw new Error(`Unsupported ZMTP security mechanism: ${mechanism}`);
  return { major, minor, negotiatedMinor: Math.min(minor, 1), mechanism, asServer };
}

function commandBody(name, data) {
  // ZMTP 3.1 (RFC 37) prefixes the command name with a one-byte length.
  // Example peer READY body: 0x05 + "READY" + metadata.
  const nameBytes = encoder.encode(name);
  if (nameBytes.length < 1 || nameBytes.length > 255) {
    throw new Error(`Invalid ZMTP command name length: ${nameBytes.length}`);
  }
  return concatBytes(Uint8Array.of(nameBytes.length), nameBytes, data);
}

export function encodeShortFrame(flags, body) {
  if (body.length > 255) throw new Error(`Short ZMTP frame too large: ${body.length}`);
  return concatBytes(Uint8Array.of(flags, body.length), body);
}

export function makeReadyFrame(minor = 1) {
  const propertyName = encoder.encode('Socket-Type');
  const propertyValue = encoder.encode('SUB');
  const valueLength = new Uint8Array(4);
  new DataView(valueLength.buffer).setUint32(0, propertyValue.length, false);
  const property = concatBytes(
    Uint8Array.of(propertyName.length), propertyName, valueLength, propertyValue,
  );
  return encodeShortFrame(0x04, commandBody('READY', property));
}

export function makeSubscribeFrame(prefix, minor = 1) {
  const prefixBytes = encoder.encode(prefix);
  if (minor >= 1) {
    return encodeShortFrame(0x04, commandBody('SUBSCRIBE', prefixBytes));
  }
  // In ZMTP/3.0 subscriptions are ordinary messages: 0x01 + filter prefix.
  return encodeShortFrame(0x00, concatBytes(Uint8Array.of(1), prefixBytes));
}

export function makePongFrame(context, minor = 1) {
  return encodeShortFrame(0x04, commandBody('PONG', context));
}

export function parseCommandBody(body, _minor = 1) {
  // ZMTP 3.1 command-name grammar is short-size + command-name, not NUL-delimited.
  // Do not confuse the first length byte with part of the command name.
  if (!(body instanceof Uint8Array) || body.length < 2) {
    throw new Error('Malformed ZMTP command body');
  }
  const nameLength = body[0];
  if (!nameLength || body.length < nameLength + 1) {
    throw new Error('Malformed length-prefixed ZMTP command name');
  }
  const nameBytes = body.subarray(1, nameLength + 1);
  for (const byte of nameBytes) {
    if (byte < 0x41 || byte > 0x5a) {
      throw new Error('Malformed ZMTP command name: expected uppercase ASCII letters');
    }
  }
  const name = decoder.decode(nameBytes);
  return { name, data: body.subarray(nameLength + 1) };
}

export function readZmtpFrame(reader) {
  return readZmtpFrameWithBuffer(reader);
}

async function readZmtpFrameWithBuffer(buffered) {
  const flags = (await buffered.readExact(1))[0];
  let size;
  if (flags & 0x02) {
    const len = await buffered.readExact(8);
    const view = new DataView(len.buffer, len.byteOffset, len.byteLength);
    const bigSize = view.getBigUint64(0, false);
    if (bigSize > 16n * 1024n * 1024n) throw new Error(`Refusing oversized ZMTP frame: ${bigSize} bytes`);
    size = Number(bigSize);
  } else {
    size = (await buffered.readExact(1))[0];
  }
  const body = await buffered.readExact(size);
  return { flags, body, more: Boolean(flags & 0x01), command: Boolean(flags & 0x04) };
}

export class BufferedSocketReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array(0);
  }
  async readExact(length) {
    if (!Number.isInteger(length) || length < 0) throw new Error('Invalid read length');
    while (this.buffer.length < length) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('NDOV TCP connection closed while reading a ZMTP frame');
      if (!(value instanceof Uint8Array)) continue;
      this.buffer = concatBytes(this.buffer, value);
    }
    const result = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return result;
  }
  async readFrame() { return readZmtpFrameWithBuffer(this); }
}

export function decodeUtf8(bytes) {
  return decoder.decode(bytes);
}
