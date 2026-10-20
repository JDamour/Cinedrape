// Tests for tools/zip.mjs — the deterministic ZIP writer that replaced PowerShell Compress-Archive for store
// packages (backslash entry names get rejected by the Chrome Web Store).
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { zipDirectory } from '../../tools/zip.mjs';

/** Reads the central directory of a zip buffer: [{name, method, crc, csize, usize, localOffset}] plus raw stores. */
function readCentralDirectory(zip) {
  assert.ok(zip.length >= 22, 'zip is at least the EOCD size');
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'end of central directory found');
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, `central header ${n} signature`);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    // The stored bytes this entry points at (local header + payload).
    const lhNameLen = zip.readUInt16LE(localOffset + 26);
    const lhExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    entries.push({
      name, method, crc, csize, usize, localOffset,
      stored: zip.subarray(dataStart, dataStart + csize),
      localName: zip.toString('utf8', localOffset + 30, localOffset + 30 + lhNameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, eocd, 'central directory ends exactly where the EOCD says');
  return entries;
}

function inflateEntry(e) {
  return e.method === 8 ? inflateRawSync(e.stored) : Buffer.from(e.stored);
}

function makeTree(dir, fixedTime) {
  mkdirSync(join(dir, 'manifest'), { recursive: true });
  mkdirSync(join(dir, 'icons'), { recursive: true });
  mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Cinedrape' }),
    'manifest/content.js': 'console.log("hello");\n'.repeat(50),
    'icons/icon-16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]),
    'nested/deeper/file.txt': 'some nested content',
    'z-last.txt': 'z',
    'a-first.txt': 'a',
    'ünïcode-名前.txt': 'unicode entry name',
    'random.bin': (() => { const b = Buffer.alloc(2048); for (let i = 0; i < b.length; i++) b[i] = (i * 131 + 17) & 0xff; return b; })(),
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'));
    writeFileSync(full, content);
    if (fixedTime) utimesSync(full, fixedTime, fixedTime);
  }
  return files;
}

test('zip: entry names use forward slashes, cover every file, and round-trip exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cinedrape-zip-'));
  try {
    const files = makeTree(dir);
    const out = join(dir, 'out.zip');
    const res = zipDirectory(dir, out);
    const zip = readFileSync(out);
    const entries = readCentralDirectory(zip);
    assert.equal(res.entries, Object.keys(files).length);
    assert.equal(entries.length, Object.keys(files).length);
    const byName = new Map(entries.map((e) => [e.name, e]));
    for (const [rel, content] of Object.entries(files)) {
      const e = byName.get(rel);
      assert.ok(e, `entry ${rel} present`);
      assert.ok(!e.name.includes('\\'), `entry ${rel} has no backslash`);
      assert.equal(e.localName, rel, 'local header name matches the central directory name');
      assert.equal(e.usize, Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content));
      const round = inflateEntry(e);
      assert.deepEqual(round, Buffer.isBuffer(content) ? content : Buffer.from(content), `${rel} round-trips`);
      assert.ok(e.csize <= e.usize || e.method === 0, `${rel} stored only when deflate does not help`);
    }
    assert.ok(byName.get('manifest/content.js').method === 8, 'compressible content is deflated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zip: identical trees with fixed timestamps produce byte-identical archives (determinism)', () => {
  const fixed = new Date(Date.UTC(2026, 9, 20, 12, 30, 40));
  const a = mkdtempSync(join(tmpdir(), 'cinedrape-zip-a-'));
  const b = mkdtempSync(join(tmpdir(), 'cinedrape-zip-b-'));
  try {
    makeTree(a, fixed);
    makeTree(b, fixed);
    const za = join(a, 'out.zip');
    const zb = join(b, 'out.zip');
    zipDirectory(a, za);
    zipDirectory(b, zb);
    assert.deepEqual(readFileSync(za), readFileSync(zb), 'two runs over the same tree are byte-identical');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('zip: an empty directory produces a valid empty archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cinedrape-zip-empty-'));
  try {
    const out = join(dir, 'out.zip');
    const res = zipDirectory(dir, out);
    assert.equal(res.entries, 0);
    assert.deepEqual(readCentralDirectory(readFileSync(out)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
