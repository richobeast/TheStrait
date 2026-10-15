// Generates desktop/icon.png and desktop/icon.ico (PNG-in-ICO) with no image libraries.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const S = 256;
const px = Buffer.alloc(S * S * 4);
const mix = (a, b, t) => a + (b - a) * t;
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const i = (y * S + x) * 4, cx = x - S / 2 + 0.5, cy = y - S / 2 + 0.5, r = Math.hypot(cx, cy);
  // rounded-square plate
  const q = Math.max(Math.abs(cx), Math.abs(cy)) - 96, corner = Math.hypot(Math.max(Math.abs(cx) - 96, 0), Math.max(Math.abs(cy) - 96, 0));
  const inside = q < 0 || corner < 28;
  if (!inside && corner > 28) { px[i + 3] = 0; continue; }
  // sky to dune gradient
  const t = y / S;
  let c = [mix(0xe6, 0xc9, t), mix(0xd2, 0xa2, t), mix(0xa8, 0x6a, t)];
  const dune = 170 + Math.sin(x / 30) * 10;
  if (y > dune) c = [0xb8, 0x8e, 0x58];
  // reticle
  const ring = Math.abs(r - 70) < 7, tick = (Math.abs(cx) < 5 && Math.abs(cy) > 30 && Math.abs(cy) < 104) || (Math.abs(cy) < 5 && Math.abs(cx) > 30 && Math.abs(cx) < 104);
  if (ring || tick || r < 8) c = [0x26, 0x1b, 0x10];
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
}
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head[8] = 0; head[9] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([head, png]));
console.log('icon written', png.length, 'bytes');
