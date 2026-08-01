import type { SapNoteResult, SapNoteSearchResponse } from './sap-notes-api.js';

export const SAP_NOTES_DETAIL_PATH = '/backend/raw/sapnotes/Detail';
export const SAP_NOTES_SEARCH_PATH =
  '/backend/raw/core/W7LegacyProxyVerticle/odata/sfm/snogwsmynotes/SAPNotes';

export interface SapNotesBackendError {
  code?: string;
  message?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function buildSapNotesSearchParams(query: string, maxResults: number): URLSearchParams {
  const top = Number.isFinite(maxResults)
    ? Math.min(100, Math.max(1, Math.trunc(maxResults)))
    : 10;
  const escapedQuery = query.replace(/'/g, "''");

  return new URLSearchParams({
    $top: String(top),
    $inlinecount: 'allpages',
    $orderby: 'Relevance desc',
    $filter: `FilterKeywordsFuzzy eq '${escapedQuery}'`
  });
}

export function parseODataDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/\/Date\((-?\d+)/);
  if (!match) return null;

  const date = new Date(Number.parseInt(match[1], 10));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizeNoteUrl(value: unknown, noteId: string): string {
  const rawUrl = typeof value === 'string' ? value.trim() : '';
  if (!rawUrl) return `https://me.sap.com/notes/${noteId}`;

  try {
    return new URL(rawUrl, 'https://me.sap.com').toString();
  } catch {
    return `https://me.sap.com/notes/${noteId}`;
  }
}

export function mapSapNotesSearchResponse(
  payload: unknown,
  query: string
): SapNoteSearchResponse {
  const root = asRecord(payload);
  const data = asRecord(root?.d);
  if (!data || !Array.isArray(data.results)) {
    throw new Error('SAP Notes search response did not contain d.results');
  }

  const results: SapNoteResult[] = data.results.flatMap(value => {
    const row = asRecord(value);
    if (!row) return [];

    const rawId = asText(row.Number) ?? '';
    const noteId = rawId.replace(/^0+/, '') || rawId;
    if (!noteId) return [];

    return [{
      id: noteId,
      title: asText(row.Title) || `SAP Note ${noteId}`,
      summary: asText(row.ComponentName) || asText(row.Category) || 'SAP Note',
      language: 'EN',
      releaseDate: parseODataDate(row.ReleasedOn) || asText(row.ReleasedOn) || 'Unknown',
      component: asText(row.Component),
      url: normalizeNoteUrl(row.URL, noteId)
    }];
  });

  const parsedTotal = Number.parseInt(asText(data.__count) ?? '', 10);
  return {
    results,
    totalResults: Number.isNaN(parsedTotal) ? results.length : parsedTotal,
    query
  };
}

export function extractSapNotePayload(payload: unknown): JsonRecord | null {
  const root = asRecord(payload);
  const response = asRecord(root?.Response);
  const sapNote = asRecord(response?.SAPNote);
  return sapNote && Object.keys(sapNote).length > 0 ? sapNote : null;
}

export function extractSapNotesBackendError(payload: unknown): SapNotesBackendError | null {
  const root = asRecord(payload);
  const response = asRecord(root?.Response);
  const error = asRecord(response?.Error);
  if (!error) return null;

  const code = asText(error.Code);
  const message = asText(error.Message);
  return code || message ? { code, message } : null;
}

export function isAuthenticationBootstrapResponse(
  status: number,
  contentType: string | undefined,
  body: string
): boolean {
  if (status === 401 || status === 403) return true;

  const normalizedType = contentType?.toLowerCase() ?? '';
  const preview = body.slice(0, 5000).toLowerCase();
  return normalizedType.includes('text/html') && (
    preview.includes('fragmentafterlogin') ||
    preview.includes('document.cookie') ||
    preview.includes('accounts.sap.com') ||
    preview.includes('/saml2/idp/sso')
  );
}
