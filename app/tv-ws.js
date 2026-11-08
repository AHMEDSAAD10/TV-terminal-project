// Minimal RFC 6455 frame codec + TradingView `~m~` message codec.
// Used by wsproxy.js so it can inspect/rewrite the chart protocol.
'use strict';

const crypto = require('crypto');

class FrameReader {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame; // (opcode, payload) => void
    this.fragOpcode = null;
    this.fragParts = [];
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const big = this.buf.readBigUInt64BE(off);
        off += 8;
        if (big > 0x7fffffffn) throw new Error('ws frame too large');
        len = Number(big);
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.slice(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (mask) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this._deliver(fin, opcode, payload);
    }
  }

  _deliver(fin, opcode, payload) {
    if (opcode === 0x8 || opcode === 0x9 || opcode === 0xa) {
      this.onFrame(opcode, payload);
      return;
    }
    if (opcode === 0x0) {
      this.fragParts.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragParts);
        const op = this.fragOpcode == null ? 0x1 : this.fragOpcode;
        this.fragParts = [];
        this.fragOpcode = null;
        this.onFrame(op, full);
      }
      return;
    }
    if (!fin) {
      this.fragOpcode = opcode;
      this.fragParts = [payload];
      return;
    }
    this.onFrame(opcode, payload);
  }
}

function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, body]);
}

// --- TradingView `~m~<byteLen>~m~<json>` codec -----------------------------

function parseMessages(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x7e && buf.slice(i, i + 3).toString('latin1') === '~h~') {
      let j = i + 3;
      while (j < buf.length && buf[j] !== 0x7e) j++;
      out.push({ kind: 'heartbeat', raw: buf.slice(i, j).toString('latin1') });
      i = j;
      continue;
    }
    if (buf.slice(i, i + 3).toString('latin1') === '~m~') {
      let j = i + 3;
      while (j < buf.length && buf[j] !== 0x7e) j++;
      if (buf.slice(j, j + 3).toString('latin1') !== '~m~') {
        i = Math.max(j, i + 1);
        continue;
      }
      const len = parseInt(buf.slice(i + 3, j).toString('latin1'), 10);
      const start = j + 3;
      if (!Number.isFinite(len) || len < 0) {
        i = start;
        continue;
      }
      if (start + len > buf.length) {
        out.push({ kind: 'incomplete', raw: buf.slice(i).toString('latin1') });
        break;
      }
      const text = buf.slice(start, start + len).toString('utf8');
      let obj = null;
      try { obj = JSON.parse(text); } catch { /* keep raw */ }
      out.push({ kind: 'json', text, obj });
      i = start + len;
      continue;
    }
    // Unknown byte (e.g. trailing whitespace); skip it.
    i++;
  }
  return out;
}

function serializeMessages(parts) {
  const bufs = [];
  for (const part of parts) {
    if (part.kind === 'heartbeat' || part.kind === 'incomplete') {
      bufs.push(Buffer.from(part.raw, 'latin1'));
    } else if (part.obj === undefined || part.obj === null) {
      const body = Buffer.from(String(part.text), 'utf8');
      bufs.push(Buffer.from('~m~' + body.length + '~m~', 'latin1'), body);
    } else {
      const body = Buffer.from(JSON.stringify(part.obj), 'utf8');
      bufs.push(Buffer.from('~m~' + body.length + '~m~', 'latin1'), body);
    }
  }
  return Buffer.concat(bufs);
}

module.exports = { FrameReader, encodeFrame, parseMessages, serializeMessages };