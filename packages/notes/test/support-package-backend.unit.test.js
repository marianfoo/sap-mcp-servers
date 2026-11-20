import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPageParams,
  buildSearchParams,
  filterNotesByComponent,
  formatSupportPackageContent,
  isObjectKey,
  mapCondition,
  mapHeader,
  mapNote,
  mapSearchCandidates,
  mapSideEffect,
  normalizePackageInput,
  objectPath,
  pickCandidate,
  readODataPage,
  summarizeByComponent
} from '../dist/support-package-backend.js';

test('package input: object keys stay numeric, names are upper-cased', () => {
  assert.equal(isObjectKey('0010000001004222026'), true);
  assert.equal(isObjectKey('SAPKE608G4'), false);
  assert.equal(normalizePackageInput(' sapke608g4 '), 'SAPKE608G4');
  assert.equal(normalizePackageInput('0010000001004222026'), '0010000001004222026');
});

test('objectPath escapes keys and appends navigations', () => {
  assert.equal(
    objectPath('0010000001004222026', 'ObjectSAPNotes'),
    "/backend/raw/core/W7LegacyProxyVerticle/odata/svt/swdcuisap4mesrv/ObjectSet('0010000001004222026')/ObjectSAPNotes"
  );
  assert.match(objectPath("a'b"), /ObjectSet\('a''b'\)$/);
});

test('page params always carry an explicit $top (the service returns nothing without it)', () => {
  const p = buildPageParams(400, 100, 'DE');
  assert.equal(p.$skip, '400');
  assert.equal(p.$top, '100');
  assert.equal(p.$inlinecount, 'allpages');
  assert.equal(p['sap-language'], 'DE');
  assert.equal(buildSearchParams('SAPKE608G4').SEARCH_STRING, 'SAPKE608G4');
});

test('search candidates resolve only unique exact package names', () => {
  const candidates = mapSearchCandidates({ d: { results: [
    { Id: '000001', Title: 'SAPKE608G4', Description: 'SAP_HR 608: SP 0164', Infotype: 'Support Package', Fastkey: '0010000001004222026' },
    { Id: '000002', Title: 'SAPKE608G3', Description: 'SAP_HR 608: SP 0163', Infotype: 'Support Package', Fastkey: '0010000001004222025' }
  ] } });
  assert.equal(pickCandidate(candidates, 'SAPKE608G4').objectKey, '0010000001004222026');
  assert.equal(pickCandidate(candidates, 'SAPKE608'), null);
  assert.equal(pickCandidate(candidates.slice(0, 1), 'SAPKE608G'), null);
  assert.equal(pickCandidate([candidates[0], candidates[0]], 'SAPKE608G4'), candidates[0]);
  assert.equal(pickCandidate([candidates[0], { ...candidates[0], objectKey: 'other' }], 'SAPKE608G4'), null);
});

test('readODataPage parses counts and rejects malformed payloads', () => {
  assert.deepEqual(readODataPage({ d: { __count: '462', results: [{ a: 1 }] } }), { rows: [{ a: 1 }], count: 462 });
  assert.equal(readODataPage({ d: { results: [] } }).count, null);
  assert.throws(() => readODataPage({ error: {} }), /d\.results/);
});

test('note, side-effect, condition and header rows map to stable shapes', () => {
  const note = mapNote({
    ObjectKey: '0010000001004222026', Number: '3758752', Version: '3', VersionInSP: '3', LanguageKey: 'E',
    Title: 'PPOME: Column Attachment, GOS for empty icon', Component: 'BC-BMT-OM',
    ComponentName: 'Organisationsmanagement', Priority: 'Korrektur mit mittlerer Priorität',
    Category: 'Programmfehler', Unread: true, CountryCode: ''
  });
  assert.equal(note.id, '3758752');
  assert.equal(note.countryCode, null);
  assert.equal(note.url, 'https://me.sap.com/notes/3758752');

  const se = mapSideEffect({ CauseNumber: '0003806161', CauseComponent: 'PY-FR', SolveNumber: '0003854975', SolveTitle: 'DSN fix', SolvePackageName: 'SAPKE608G5' });
  assert.equal(se.causingNote, '3806161');
  assert.equal(se.solvingNote, '3854975');

  const cond = mapCondition({ ConditionSet: '01', ComponentCategory: '01', ComponentCategoryDescr: 'Software Component', SoftwareComponent: 'SAP_HR', Release: '608', PackageCategory: 'SP', Package: 'SAPKE608G3' });
  assert.equal(cond.softwareComponent, 'SAP_HR');
  assert.equal(cond.package, 'SAPKE608G3');

  const header = mapHeader({ d: { Title: 'SAP_HR 608: SP 0164', FileName: 'SAPKE608G4', Status: 'AVAILABLE', FileType: 'SAR' } }, '0010000001004222026');
  assert.equal(header.name, 'SAPKE608G4');
  assert.equal(header.title, 'SAP_HR 608: SP 0164');
});

test('component filter is a case-insensitive prefix and summary counts per component', () => {
  const notes = ['PY-DE-PS', 'PY-DE-NT', 'PA-PA', 'PY-FR'].map((component, i) => mapNote({ Number: String(i + 1), Component: component }));
  assert.equal(filterNotesByComponent(notes, 'py-de').length, 2);
  assert.equal(filterNotesByComponent(notes).length, 4);
  const summary = summarizeByComponent([...notes, notes[0]]);
  assert.deepEqual(summary[0], { component: 'PY-DE-PS', componentName: '', count: 2 });
});

test('formatter renders header, notes and truncation hint', () => {
  const notes = [mapNote({ Number: '3758752', Version: '3', Component: 'BC-BMT-OM', Title: 'PPOME', Category: 'Programmfehler', Priority: 'mittel' })];
  const text = formatSupportPackageContent({
    package: { objectKey: '1', name: 'SAPKE608G4', title: 'SAP_HR 608: SP 0164' },
    noteCount: 462, notes, notesByComponent: summarizeByComponent(notes),
    truncated: { notes: true }, url: 'https://me.sap.com/softwarecenter/object/1'
  }, 'BC');
  assert.match(text, /SAPKE608G4 — SAP_HR 608: SP 0164/);
  assert.match(text, /462 in package, 1 matching component "BC"/);
  assert.match(text, /- 3758752 v3 \[BC-BMT-OM\] PPOME/);
  assert.match(text, /partial list/);
});

test('an omitted total is reported honestly and a component beyond the output limit is still found', async () => {
  const { SapNotesApiClient } = await import('../dist/sap-notes-api.js');
  const client = Object.create(SapNotesApiClient.prototype);
  const key = '0010000001004222026';
  const input = [{ Number: '1', Component: 'BC' }, { Number: '2', Component: 'PY' }];
  client.fetchBackendJson = async (path, token, params) => path.endsWith('/ObjectSAPNotes')
    ? { d: { results: input.slice(+params.$skip, +params.$skip + +params.$top) } }
    : { d: { Title: 'Package' } };
  const partial = await client.getSupportPackageContent(key, 'test', { maxNotes: 1 });
  assert.equal(partial.notes.length, 1);
  assert.equal(partial.truncated.notes, true);
  assert.equal(partial.noteCount, undefined);
  assert.match(formatSupportPackageContent(partial, 'PY'), /total unknown/);
  const full = await client.getSupportPackageContent(key, 'test', { component: 'PY', maxNotes: 1 });
  assert.equal(full.noteCount, 2);
  assert.equal(full.notes.length, 1);
  assert.equal(full.truncated, undefined);
});

test('paged collections respect the reported count, the caller limit, and short server pages', async () => {
  const { SapNotesApiClient } = await import('../dist/sap-notes-api.js');
  const client = Object.create(SapNotesApiClient.prototype);
  for (const [limit, counted, expectedOffsets] of [
    [2000, true, [0, 500, 1000]], [600, true, [0, 500]], [750, false, [0, 300, 600]]
  ]) {
    const offsets = [];
    client.fetchBackendJson = async (_path, _token, params) => {
      const skip = Number(params.$skip);
      const length = Math.min(Number(params.$top), counted ? 500 : 300, 1200 - skip);
      offsets.push(skip);
      return { d: { results: Array.from({ length }, () => ({})), ...(counted ? { __count: '1200' } : { __next: 'more' }) } };
    };
    const result = await client.fetchSwdcCollection('123', 'ObjectSAPNotes', 'test', limit);
    assert.deepEqual(offsets, expectedOffsets);
    assert.equal(result.rows.length, Math.min(1200, limit));
    assert.equal(result.truncated, limit < 1200);
    assert.equal(result.count, counted ? 1200 : null);
  }
});

test('component filters follow SAP hierarchy boundaries', () => {
  const notes = ['FI', 'FI-GL', 'FIN-FSCM'].map(Component => mapNote({ Component }));
  assert.deepEqual(filterNotesByComponent(notes, 'fi').map(n => n.component), ['FI', 'FI-GL']);
});

test('package names resolve through search before fetching the selected object', async () => {
  const { SapNotesApiClient } = await import('../dist/sap-notes-api.js');
  const client = Object.create(SapNotesApiClient.prototype);
  const key = '0010000001004222026';
  let candidates = [{ Title: 'SAPKE608G4', Fastkey: key }];
  client.fetchBackendJson = async (path, _token, params) => {
    if (path.endsWith('/SearchResultSet')) {
      assert.equal(params.SEARCH_STRING, 'SAPKE608G4');
      return { d: { results: candidates } };
    }
    assert.ok(path.includes(key));
    return path.endsWith('/ObjectSAPNotes') ? { d: { results: [] } } : { d: { FileName: 'SAPKE608G4' } };
  };
  assert.equal((await client.getSupportPackageContent(' sapke608g4 ', 'test')).package.objectKey, key);
  candidates = [...candidates, { Title: 'SAPKE608G4', Fastkey: '0010000001004222027' }];
  await assert.rejects(client.resolveSupportPackage('SAPKE608G4','test'), /No unique exact match/);
  candidates = [];
  await assert.rejects(client.resolveSupportPackage('SAPKE608G4','test'), /softwarecenter\/object/);
  assert.throws(() => mapHeader({ d: {} }, key), /package header/);
});
