// Deterministic ZIP writer for store packages.
//
// Why this exists: Windows PowerShell 5.1's Compress-Archive writes backslash-separated entry names, which the
// Chrome Web Store rejects, and the external `zip` binary is not installed everywhere. This writer uses only
// Node (zlib deflateRaw), always emits forward-slash entry names, walks the tree in sorted order and repeats
// byte-for-byte for identical files and timestamps.
//
//   import { zipDirectory } from './zip.mjs'; zipDirectory('dist', 'release/cinedrape-0.1.1.zip');
//   node tools/zip.mjs <dir> <out.zip>
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = /* @__PURE__ */ (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS date/time pair from a Date, clamped to the ZIP epoch (1980-01-01). */
function dosDateTime(date) {
  const d = new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 1)));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    day: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Every regular file under `dir`, sorted per directory, entry names joined with '/'. */
function walk(dir, base = dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push({ full, entry: relative(base, full).split(sep).join('/') });
  }
  return out;
}

/**
 * Zips the whole `dir` tree into `outFile` and returns `{entries, bytes}`. Throws on any I/O or parse problem.
 * @param {string} dir
 * @param {string} outFile
 * @param {{level?: number}} [opts] deflate level (default 9)
 */
export function zipDirectory(dir, outFile, { level = 9 } = {}) {
  const root = resolve(dir);
  const files = walk(root);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(f.full);
    const deflated = deflateRawSync(data, { level });
    const useDeflate = deflated.length < data.length;
    const store = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const { time, day } = dosDateTime(statSync(f.full).mtime);
    const name = Buffer.from(f.entry, 'utf8');
    const flags = 0x0800; // names are UTF-8

    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed (deflate)
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(day, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(store.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);           // extra field length
    name.copy(lh, 30);

    const ch = Buffer.alloc(46 + name.length);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory header signature
    ch.writeUInt16LE(0x031e, 4);       // version made by (unix, zip 3.0)
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(day, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(store.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);           // extra length
    ch.writeUInt16LE(0, 32);           // comment length
    ch.writeUInt16LE(0, 34);           // disk number start
    ch.writeUInt16LE(0, 36);           // internal attributes
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: unix regular file, 0644
    ch.writeUInt32LE(offset, 42);      // local header offset
    name.copy(ch, 46);

    locals.push(lh, store);
    centrals.push(ch);
    offset += lh.length + store.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);          // comment length

  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  const zip = Buffer.concat([...locals, cd, eocd]);
  writeFileSync(outFile, zip);
  return { entries: files.length, bytes: zip.length };
}

// CLI: node tools/zip.mjs <dir> <out.zip>
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    console.error('zip: usage: node tools/zip.mjs <dir> <out.zip>');
    process.exit(2);
  }
  const res = zipDirectory(dir, out);
  console.log(`zip: wrote ${out} (${(res.bytes / 1024).toFixed(1)} KB, ${res.entries} entries)`);
}
