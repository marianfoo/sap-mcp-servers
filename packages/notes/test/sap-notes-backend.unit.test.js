import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSapNotesSearchParams,
  extractSapNotePayload,
  extractSapNotesBackendError,
  isAuthenticationBootstrapResponse,
  mapSapNotesSearchResponse,
  parseODataDate
} from '../dist/sap-notes-backend.js';

test('buildSapNotesSearchParams escapes OData apostrophes and bounds the result count', () => {
  const params = buildSapNotesSearchParams("kernel's patch", 2.9);

  assert.equal(params.get('$top'), '2');
  assert.equal(params.get('$inlinecount'), 'allpages');
  assert.equal(params.get('$orderby'), 'Relevance desc');
  assert.equal(params.get('$filter'), "FilterKeywordsFuzzy eq 'kernel''s patch'");
  assert.equal(buildSapNotesSearchParams('query', 500).get('$top'), '100');
});

test('parseODataDate normalizes valid literals and rejects invalid values', () => {
  assert.equal(parseODataDate('/Date(1427382729000)/'), '2015-03-26');
  assert.equal(parseODataDate('2015-03-26'), null);
  assert.equal(parseODataDate('/Date(not-a-number)/'), null);
});

test('mapSapNotesSearchResponse maps IDs, dates, counts, and site-relative URLs', () => {
  const result = mapSapNotesSearchResponse({
    d: {
      __count: '341',
      results: [{
        Number: '0002137318',
        Title: 'SYB: Start and stop database ASE with HADR',
        Component: 'BC-DB-SYB',
        ComponentName: 'SAP ASE Database',
        ReleasedOn: '/Date(1427382729000)/',
        URL: '/#/notes/0002137318'
      }]
    }
  }, 'SYB ASE');

  assert.deepEqual(result, {
    query: 'SYB ASE',
    totalResults: 341,
    results: [{
      id: '2137318',
      title: 'SYB: Start and stop database ASE with HADR',
      summary: 'SAP ASE Database',
      language: 'EN',
      releaseDate: '2015-03-26',
      component: 'BC-DB-SYB',
      url: 'https://me.sap.com/#/notes/0002137318'
    }]
  });
});

test('mapSapNotesSearchResponse rejects a malformed backend payload', () => {
  assert.throws(
    () => mapSapNotesSearchResponse({ d: {} }, 'query'),
    /did not contain d\.results/
  );
});

test('extractSapNotePayload reads the real Response.SAPNote shape', () => {
  const sapNote = { Header: { Number: { value: '2744792' } } };
  assert.equal(extractSapNotePayload({ Response: { SAPNote: sapNote } }), sapNote);
  assert.equal(extractSapNotePayload({ SapNote: sapNote }), null);
  assert.equal(extractSapNotePayload({ Response: { SAPNote: {} } }), null);
});

test('extractSapNotesBackendError reads structured Detail errors', () => {
  assert.deepEqual(
    extractSapNotesBackendError({
      Response: {
        Error: {
          Code: 'DOES_NOT_EXIST',
          Message: 'No document found with given parameter'
        }
      }
    }),
    {
      code: 'DOES_NOT_EXIST',
      message: 'No document found with given parameter'
    }
  );
  assert.equal(extractSapNotesBackendError({ Response: { Error: {} } }), null);
});

test('isAuthenticationBootstrapResponse recognizes auth status and SAP HTML stubs', () => {
  assert.equal(isAuthenticationBootstrapResponse(401, 'application/json', '{}'), true);
  assert.equal(
    isAuthenticationBootstrapResponse(200, 'text/html', '<script>fragmentAfterLogin = true</script>'),
    true
  );
  assert.equal(isAuthenticationBootstrapResponse(200, 'application/json', '{}'), false);
  assert.equal(isAuthenticationBootstrapResponse(500, 'text/html', '<h1>Backend error</h1>'), false);
});
