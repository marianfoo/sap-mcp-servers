import assert from 'node:assert/strict';
import test from 'node:test';
import { SapNoteS3Cache } from '../dist/note-s3-cache.js';

const NOTE = {
  id: '3096734',
  title: 'Fixture note',
  summary: 'Fixture summary',
  content: 'Fixture content',
  language: 'EN',
  releaseDate: '2024-01-15',
  url: 'https://me.sap.com/notes/3096734'
};

const ORIGINAL_BUCKET = process.env.SAP_NOTES_CACHE_BUCKET;

function withBucket(value, fn) {
  process.env.SAP_NOTES_CACHE_BUCKET = value;
  return fn().finally(() => {
    if (ORIGINAL_BUCKET === undefined) delete process.env.SAP_NOTES_CACHE_BUCKET;
    else process.env.SAP_NOTES_CACHE_BUCKET = ORIGINAL_BUCKET;
  });
}

test('get() and set() are no-ops when SAP_NOTES_CACHE_BUCKET is unset', async () => {
  delete process.env.SAP_NOTES_CACHE_BUCKET;
  const cache = new SapNoteS3Cache({ send: async () => { throw new Error('S3 must not be called when caching is disabled'); } });

  assert.equal(await cache.get(NOTE.id), null);
  await cache.set(NOTE.id, NOTE);

  if (ORIGINAL_BUCKET === undefined) delete process.env.SAP_NOTES_CACHE_BUCKET;
  else process.env.SAP_NOTES_CACHE_BUCKET = ORIGINAL_BUCKET;
});

test('get() returns the cached note on a hit, keyed by notes/{id}/{id}.json', () => withBucket('test-bucket', async () => {
  let capturedInput;
  const cache = new SapNoteS3Cache({
    send: async (command) => {
      capturedInput = command.input;
      return { Body: { transformToString: async () => JSON.stringify(NOTE) } };
    }
  });

  const result = await cache.get(NOTE.id);

  assert.deepEqual(result, NOTE);
  assert.equal(capturedInput.Bucket, 'test-bucket');
  assert.equal(capturedInput.Key, 'notes/3096734/3096734.json');
}));

test('get() returns null on NoSuchKey without throwing (cache miss)', () => withBucket('test-bucket', async () => {
  const cache = new SapNoteS3Cache({
    send: async () => {
      const error = new Error('not found');
      error.name = 'NoSuchKey';
      throw error;
    }
  });

  assert.equal(await cache.get(NOTE.id), null);
}));

test('get() treats an unexpected S3 error as a miss rather than failing the caller', () => withBucket('test-bucket', async () => {
  const cache = new SapNoteS3Cache({ send: async () => { throw new Error('S3 unreachable'); } });

  assert.equal(await cache.get(NOTE.id), null);
}));

test('set() writes a conditional PutObject (IfNoneMatch) at notes/{id}/{id}.json', () => withBucket('test-bucket', async () => {
  let capturedInput;
  const cache = new SapNoteS3Cache({
    send: async (command) => {
      capturedInput = command.input;
      return {};
    }
  });

  await cache.set(NOTE.id, NOTE);

  assert.equal(capturedInput.Bucket, 'test-bucket');
  assert.equal(capturedInput.Key, 'notes/3096734/3096734.json');
  assert.equal(capturedInput.IfNoneMatch, '*');
  assert.equal(capturedInput.Body, JSON.stringify(NOTE));
  assert.equal(capturedInput.ContentType, 'application/json');
}));

test('set() silently no-ops when the note is already cached (PreconditionFailed)', () => withBucket('test-bucket', async () => {
  const cache = new SapNoteS3Cache({
    send: async () => {
      const error = new Error('At least one of the pre-conditions you specified did not hold');
      error.name = 'PreconditionFailed';
      throw error;
    }
  });

  await assert.doesNotReject(cache.set(NOTE.id, NOTE));
}));

test('set() swallows an unexpected write failure rather than throwing', () => withBucket('test-bucket', async () => {
  const cache = new SapNoteS3Cache({ send: async () => { throw new Error('S3 unreachable'); } });

  await assert.doesNotReject(cache.set(NOTE.id, NOTE));
}));
