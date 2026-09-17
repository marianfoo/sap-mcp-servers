import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { logger } from './logger.js';
import type { SapNoteDetail } from './types.js';

/**
 * Caches fetched SAP Note details in S3, keyed by note ID, so a repeated
 * lookup for the same note skips SAP's fallback chain (backend OData,
 * Playwright, raw HTTP, OData fallbacks) entirely.
 *
 * Disabled (both methods are a no-op) unless SAP_NOTES_CACHE_BUCKET is set —
 * caching is opt-in and never required to fetch a note. Notes are cached
 * indefinitely; there is no TTL, since SAP Note IDs are effectively
 * immutable content once published.
 *
 * Credentials/region come from the AWS default provider chain
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION, or a named
 * AWS_PROFILE for SSO / IAM role credentials). Note: the JS SDK reads
 * AWS_REGION, not AWS_DEFAULT_REGION — the latter is a CLI/other-SDK
 * convention only.
 */
export class SapNoteS3Cache {
  private readonly bucket = process.env.SAP_NOTES_CACHE_BUCKET;
  private client: S3Client | null = null;

  /** @param client - Injectable for tests; defaults to a real S3Client. */
  constructor(private readonly clientOverride?: Pick<S3Client, 'send'>) {}

  private getClient(): Pick<S3Client, 'send'> {
    if (this.clientOverride) return this.clientOverride;
    if (!this.client) this.client = new S3Client();
    return this.client;
  }

  private keyFor(noteId: string): string {
    return `notes/${noteId}/${noteId}.json`;
  }

  /**
   * Returns the cached note, or null on a cache miss (including when
   * caching is disabled or S3 is unreachable — a cache-read failure must
   * never block a real fetch).
   */
  async get(noteId: string): Promise<SapNoteDetail | null> {
    if (!this.bucket) return null;

    try {
      const response = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(noteId) })
      );
      const body = await response.Body?.transformToString();
      if (!body) return null;

      logger.info(`✅ Retrieved SAP Note ${noteId} from S3 cache`);
      return JSON.parse(body) as SapNoteDetail;
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name !== 'NoSuchKey' && name !== 'NotFound') {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`⚠️ SAP Note cache read failed for ${noteId}, fetching normally: ${message}`);
      }
      return null;
    }
  }

  /**
   * Stores the note for future lookups. Best-effort — a write failure is
   * logged and swallowed so it never fails the caller's fetch.
   *
   * Uses a conditional write (IfNoneMatch: '*') so a concurrent fetch of the
   * same not-yet-cached note can never overwrite whichever write lands
   * first — the loser's PreconditionFailed is treated as a normal no-op,
   * not an error.
   */
  async set(noteId: string, note: SapNoteDetail): Promise<void> {
    if (!this.bucket) return;

    try {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(noteId),
          Body: JSON.stringify(note),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        })
      );
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'PreconditionFailed') return; // already cached — not an error

      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ SAP Note cache write failed for ${noteId}: ${message}`);
    }
  }
}
