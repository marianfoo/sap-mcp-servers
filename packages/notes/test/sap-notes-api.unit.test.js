import assert from 'node:assert/strict';
import test from 'node:test';
import { SapNotesApiClient } from '../dist/sap-notes-api.js';
import { NoteGetOutputSchema } from '../dist/schemas/sap-notes.js';

function createClient() {
  return new SapNotesApiClient({});
}

function buildDetail(client, sapNote, noteId = '3096734') {
  return client.buildNoteDetail(sapNote, noteId);
}

test('Detail metadata extraction maps the real plain table shapes', () => {
  const client = createClient();
  const detail = buildDetail(client, {
    Header: {
      Number: { value: '3096734' },
      Type: { value: 'SAP Note' },
      Language: { value: 'EN' },
      ReleasedOn: { value: '2024-01-15' }
    },
    Title: { value: 'Metadata fixture' },
    LongText: { value: '<p>Fixture content</p>' },
    Validity: {
      Items: [{ SoftwareComponent: 'SAP_BASIS', From: '700', To: '702' }]
    },
    SupportPackage: {
      Items: [{
        SoftwareComponentVersion: 'SAP_BASIS 700',
        SupportPackage: 'SAPKB70041',
        URL: '/supportpackage/SAPKB70041'
      }]
    },
    SupportPackagePatch: {
      Items: [{ SoftwareComponentVersion: 'SAP_BASIS 700', SupportPackagePatch: 'PATCH-1', Level: 2 }]
    },
    References: {
      RefTo: {
        Items: [{ RefNumber: ' 123456 ', RefTitle: ' Referenced note ', RefComponent: 'BC-TEST' }]
      },
      RefBy: {
        Items: [{ RefNumber: '654321', RefTitle: 'Referencing note' }]
      }
    },
    Preconditions: {
      Items: [
        { Number: ' 3439654 ', Title: 'Prerequisite', Component: 'CA-MDG-AF-HP', ValidFrom: '803', ValidTo: '803' },
        { Number: '3439654 ', Title: 'Prerequisite', Component: 'CA-MDG-AF-HP', ValidFrom: '804', ValidTo: '804' }
      ]
    },
    SideEffects: {
      SideEffectsCausing: {
        Items: [{ RefNumber: '987591', RefTitle: 'Causing note' }]
      },
      SideEffectsSolving: {
        Items: [{ RefNumber: '998760', RefTitle: 'Solving note' }]
      }
    },
    CorrectionInstructions: {
      Items: [{ SoftwareComponent: 'SAP_BASIS', NumberOfCorrin: 11, URL: '/corrins/0003096734/41' }]
    },
    CorrectionsInfo: {
      Corrections: { value: 11 },
      ManualActivities: { value: 0 },
      Prerequisites: { value: 0 }
    },
    ManualActions: { value: '<p>Run the report</p>' },
    Attachments: {
      Items: [{ FileName: 'steps.pdf', URL: 'https://example.test/steps.pdf' }]
    },
    Actions: {
      Download: { url: 'https://example.test/snote' },
      Print: { url: 'https://example.test/print?token=secret' }
    }
  });

  assert.deepEqual(detail.validity, [{
    softwareComponent: 'SAP_BASIS',
    versionFrom: '700',
    versionTo: '702'
  }]);
  assert.deepEqual(detail.supportPackages, [{
    softwareComponent: 'SAP_BASIS 700',
    name: 'SAPKB70041',
    level: undefined
  }]);
  assert.deepEqual(detail.supportPackagePatches, [{
    softwareComponent: 'SAP_BASIS 700',
    name: 'PATCH-1',
    level: '2'
  }]);
  assert.deepEqual(detail.references, {
    referencesTo: [{ noteNumber: '123456', title: 'Referenced note', noteType: 'BC-TEST' }],
    referencedBy: [{ noteNumber: '654321', title: 'Referencing note', noteType: undefined }]
  });
  assert.deepEqual(detail.prerequisites, [{ noteNumber: '3439654', title: 'Prerequisite' }]);
  assert.deepEqual(detail.sideEffects, {
    causing: [{ noteNumber: '987591', title: 'Causing note', noteType: undefined }],
    solving: [{ noteNumber: '998760', title: 'Solving note', noteType: undefined }]
  });
  assert.deepEqual(detail.correctionsSummary, [{
    softwareComponent: 'SAP_BASIS',
    pakId: '41',
    count: 11
  }]);
  assert.deepEqual(detail.correctionsInfo, {
    totalCorrections: 11,
    totalManualActivities: 0,
    totalPrerequisites: 0
  });
  assert.equal(detail.manualActions, '<p>Run the report</p>');
  assert.deepEqual(detail.attachments, [{
    filename: 'steps.pdf',
    url: 'https://example.test/steps.pdf'
  }]);
  assert.equal(detail.downloadUrl, 'https://example.test/snote');
  assert.equal('pdfUrl' in detail, false, 'token-bearing PDF URLs must not be exposed');
});

test('Detail metadata extraction keeps wrapped fallbacks and omits empty or invalid values', () => {
  const client = createClient();
  const detail = buildDetail(client, {
    Validity: { Items: [{}] },
    SupportPackage: {
      Items: [{ Name: { value: 'SAP_BASIS' }, SupportPackageName: { value: 'SAPKBTEST' } }]
    },
    References: { RefTo: { Items: [{}] }, RefBy: { Items: [] } },
    SideEffects: { SideEffectsCausing: { Items: [{}] } },
    CorrectionInstructions: {
      Items: [{ SoftwareComponent: 'SAP_BASIS', Count: 'not-a-number', PakId: '41' }]
    },
    CorrectionsInfo: { Corrections: { value: 'not-a-number' } },
    Attachments: { Items: [{}] }
  });

  assert.deepEqual(detail.supportPackages, [{
    softwareComponent: 'SAP_BASIS',
    name: 'SAPKBTEST',
    level: undefined
  }]);
  assert.equal(detail.validity, undefined);
  assert.equal(detail.references, undefined);
  assert.equal(detail.sideEffects, undefined);
  assert.deepEqual(detail.correctionsSummary, [{ softwareComponent: 'SAP_BASIS', pakId: '41' }]);
  assert.equal(detail.correctionsInfo, undefined);
  assert.equal(detail.attachments, undefined);
});

test('CorrIns requests use the authenticated backend context and escape OData strings', async () => {
  const client = createClient();
  const calls = [];
  client.fetchBackendJson = async (path, token, params) => {
    calls.push({ path, token, params });
    return calls.length === 1 ? { d: { results: [{ Aleid: '1' }] } } : { d: { Name: "O'Hare" } };
  };

  assert.deepEqual(
    await client.fetchCorrInsSet('0003096734', "4'1", 'sap-token'),
    [{ Aleid: '1' }]
  );
  assert.deepEqual(
    await client.fetchCorrInsNavigation({
      Aleid: '1',
      PakId: '41',
      Insta: 'A',
      Vernr: '1',
      Name: "O'Hare",
      VerFrom: '700',
      VerTo: '702'
    }, 'TADIR', 'sap-token'),
    [{ Name: "O'Hare" }]
  );

  assert.equal(
    calls[0].params.$filter,
    "SapNotesNumber eq '0003096734' and PakId eq '4''1'"
  );
  assert.match(calls[1].path, /Name='O''Hare'/);
  assert.equal(calls[0].token, 'sap-token');
  assert.equal(calls[1].token, 'sap-token');
});

test('correction-detail lookup propagates session expiry for the auth retry', async () => {
  const client = createClient();
  client.fetchCorrInsSet = async () => {
    throw new Error('SESSION_EXPIRED: fixture');
  };

  await assert.rejects(
    client.getCorrectionDetails('3096734', [{ softwareComponent: 'SAP_BASIS', pakId: '41' }], 'token'),
    /SESSION_EXPIRED/
  );
});

test('the fetch output contract includes support package patches but no token-bearing PDF URL', () => {
  assert.ok(NoteGetOutputSchema.supportPackagePatches);
  assert.equal(NoteGetOutputSchema.pdfUrl, undefined);
});
