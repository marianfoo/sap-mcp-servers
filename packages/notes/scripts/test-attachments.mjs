#!/usr/bin/env node
/**
 * Live check for fetch_attachment.
 *
 * Scans candidate SAP Notes for an "Attachments" section, then downloads one
 * attachment from each of the first N notes that have any, verifying that real
 * bytes come back rather than the HTML login stub.
 *
 *   node scripts/test-attachments.mjs [targetNoteCount]
 */
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const { SapNotesApiClient } = await import('../dist/sap-notes-api.js');
const { createNotesAuthenticator } = await import('../dist/auth.js');

const TARGET = Number(process.argv[2] || 10);

// Candidate notes drawn from several components so the sample is not all KBAs
// of one kind. Attachment presence is discovered, not assumed.
const CANDIDATES = [
  '3137004', '2388483', '1587566', '3606053', '2311166', '2075073', '1749142',
  '1897372', '2098954', '2501703', '2309060', '3191095', '1705730', '3570638',
  '1431751', '2370780', '2119087', '2399996', '3743709', '1984422', '2551720',
  '2265085', '2544831', '2532380', '3504340', '2025528', '1746967', '1375378',
  '2191612', '3467895', '3481355', '3439136', '2934135', '1872170', '2593571',
  '2100040', '1969700', '1438410', '2222218', '1999997', '2000003', '2114710',
  '2380176', '2600030', '1999993', '2154870', '3346306', '2187425', '2543372',
  '2499947', '2576306', '2632375', '1856748', '2640978', '2489468', '40850',
  '2509738', '1710320', '1869240', '1990193', '2098954', '16083', '2190119'
];

function magic(buf) {
  const b = buf.subarray(0, 8);
  if (b[0] === 0x89 && b[1] === 0x50) return 'PNG';
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG';
  if (b.toString('utf8', 0, 4) === '%PDF') return 'PDF';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'ZIP/OOXML';
  if (b.toString('utf8', 0, 5).toLowerCase().includes('<html')) return 'HTML(!)';
  if (b.toString('utf8', 0, 6) === 'GIF89a' || b.toString('utf8', 0, 6) === 'GIF87a') return 'GIF';
  return 'other';
}

const cfg = {
  sapUsername: process.env.SAP_USERNAME,
  sapPassword: process.env.SAP_PASSWORD,
  authMethod: process.env.AUTH_METHOD,
  pfxPath: process.env.PFX_PATH,
  pfxPassphrase: process.env.PFX_PASSPHRASE,
  headless: true
};

const auth = createNotesAuthenticator(cfg);
const client = new SapNotesApiClient(cfg);
const { cookieHeader: token } = await auth.ensureSession();

const outDir = mkdtempSync(join(tmpdir(), 'sapatt-'));
console.log(`output dir: ${outDir}\n`);

// Attachments are not common, so widen the pool with search hits when the
// seed list is exhausted. Queries chosen to surface screenshot-heavy KBAs.
const SEARCH_QUERIES = [
  'how to configure step by step screenshot',
  'SAP GUI installation error screenshot',
  'transaction configuration guide',
  'troubleshooting guide error message',
  'how to download install package',
  'security audit log configuration',
  'HANA cockpit configuration',
  'Fiori launchpad setup',
  'transport management configuration',
  'user authorization trace analysis'
];

async function candidateIds() {
  const seen = new Set();
  const ids = [];
  for (const id of CANDIDATES) { if (!seen.has(id)) { seen.add(id); ids.push(id); } }
  for (const q of SEARCH_QUERIES) {
    try {
      const r = await client.searchNotes(q, token, 10);
      for (const n of r.results ?? []) {
        if (n.id && !seen.has(n.id)) { seen.add(n.id); ids.push(n.id); }
      }
    } catch { /* search failure just means fewer candidates */ }
  }
  return ids;
}

const withAttachments = [];
const pool = await candidateIds();
console.log(`scanning up to ${pool.length} notes for an Attachments section…\n`);

let scanned = 0;
for (const id of pool) {
  if (withAttachments.length >= TARGET) break;
  scanned++;
  await new Promise(r => setTimeout(r, 600)); // be polite: the Detail endpoint rate-limits
  try {
    const note = await client.getNote(id, token);
    const atts = note?.attachments ?? [];
    if (atts.length) {
      withAttachments.push({ id, title: (note.title || '').slice(0, 58), atts });
      console.log(`  ✓ ${id}  ${String(atts.length).padStart(3)} attachment(s)  ${(note.title || '').slice(0, 52)}`);
    }
  } catch (e) {
    // a note we cannot read is not a test failure — just skip it
  }
}
console.log(`\n(scanned ${scanned} notes)`);

console.log(`\nfound ${withAttachments.length} notes with attachments\n`);
console.log('downloading one attachment from each…\n');

let pass = 0, fail = 0;
const results = [];

for (const { id, atts } of withAttachments) {
  const a = atts[0];
  try {
    const { body, contentType, bytes } = await client.fetchAttachment(a.url, token);
    const sha = createHash('sha256').update(body).digest('hex');
    const kind = magic(body);
    const ok = kind !== 'HTML(!)' && bytes > 0;
    ok ? pass++ : fail++;
    results.push({ id, name: a.filename, contentType, bytes, kind, sha: sha.slice(0, 12), ok });
    console.log(
      `  ${ok ? '✓' : '✗'} note ${id.padEnd(8)} ${String(bytes).padStart(9)} B  ` +
      `${contentType.padEnd(26)} ${kind.padEnd(10)} ${sha.slice(0, 12)}  ${(a.filename || '').slice(0, 24)}`
    );
  } catch (e) {
    fail++;
    results.push({ id, name: a.filename, error: String(e.message || e).slice(0, 90), ok: false });
    console.log(`  ✗ note ${id.padEnd(8)} ERROR  ${String(e.message || e).slice(0, 90)}`);
  }
}

console.log('\n── guard checks ──');
for (const [label, url] of [
  ['non-SAP host rejected     ', 'https://example.com/evil.png'],
  ['http (not https) rejected ', 'http://documents.support.sap.com/customerkba/x'],
  ['malformed URL rejected    ', 'not-a-url']
]) {
  try {
    await client.fetchAttachment(url, token);
    console.log(`  ✗ ${label} — NOT rejected`);
    fail++;
  } catch (e) {
    console.log(`  ✓ ${label} — ${String(e.message).slice(0, 62)}`);
    pass++;
  }
}

const hosts = [...new Set(withAttachments.map(w => { try { return new URL(w.atts[0].url).hostname; } catch { return '?'; } }))];
console.log(`\nattachment hosts seen    : ${hosts.join(', ')}`);
const types = [...new Set(results.filter(r => r.contentType).map(r => r.contentType))];
console.log(`\n── summary ──`);
console.log(`notes with attachments : ${withAttachments.length}`);
console.log(`downloads passed       : ${pass}`);
console.log(`downloads failed       : ${fail}`);
console.log(`distinct content types : ${types.join(', ') || '(none)'}`);

rmSync(outDir, { recursive: true, force: true });
await auth.destroy?.().catch?.(() => {});
process.exit(fail > 0 ? 1 : 0);
