import { z } from 'zod';

/**
 * ============================================
 * SAP NOTE SCHEMAS
 * ============================================
 *
 * Tool names: "search" and "fetch"
 * Zod schemas with descriptions for MCP SDK tool registration.
 */

// ─── SEARCH ────────────────────────────────────────────────────────────────

/**
 * Input schema for the "search" tool
 */
export const NoteSearchInputSchema = {
  q: z
    .string()
    .min(2, "Query must be at least 2 characters")
    .max(200, "Query must be less than 200 characters")
    .describe(
      `Search query for SAP Notes. Use specific SAP terminology: error codes, transaction codes, component names, or concise issue descriptions (2-6 words).

Examples:
• "OData gateway error 415"
• "MM02 material master dump"
• "ABAP CX_SY_ZERODIVIDE"
• "S/4HANA migration performance"
• "2744792" — direct note ID lookup
• "Fiori launchpad not loading"

Formula: [Error/Transaction] + [Module] + [Issue]
Avoid vague queries like "SAP problem" or "not working".`
    ),

  lang: z
    .enum(['EN', 'DE'])
    .default('EN')
    .describe(
      `Language for results. EN (default, broadest coverage) or DE (German).`
    ),
};

/**
 * Output schema — single search result
 */
export const NoteSearchResultSchema = {
  id: z
    .string()
    .min(1)
    .describe('SAP Note ID. Pass to fetch() for full content.'),

  title: z.string().describe('Note title summarizing the issue or topic.'),

  summary: z.string().describe('1-3 sentence overview of the note.'),

  component: z
    .string()
    .nullable()
    .describe('SAP component (e.g. "CA-UI5", "MM-IM"). null if unspecified.'),

  releaseDate: z.string().describe('Publication or last-update date (ISO 8601).'),

  language: z.string().describe('Content language: EN or DE.'),

  url: z
    .string()
    .url()
    .describe('URL to view the note on SAP Support Portal (S-user required).'),
};

/**
 * Output schema — complete search response
 */
export const NoteSearchOutputSchema = {
  totalResults: z
    .number()
    .int()
    .min(0)
    .describe('Total matching notes. 0 → try different terms.'),

  query: z.string().describe('Executed search query (for reference).'),

  results: z
    .array(z.object(NoteSearchResultSchema))
    .describe('Matching notes ranked by relevance. Fetch the top 2-3, not all.'),
};

// ─── FETCH ─────────────────────────────────────────────────────────────────

/**
 * Input schema for the "fetch" tool
 */
export const NoteGetInputSchema = {
  id: z
    .string()
    .min(1, "Note ID cannot be empty")
    .regex(/^[0-9A-Za-z]+$/, "Note ID must be alphanumeric")
    .describe(
      `SAP Note ID (digits, e.g. "2744792"). Extract from user text if needed ("Note 2744792" → "2744792").`
    ),

  lang: z
    .enum(['EN', 'DE'])
    .default('EN')
    .describe('Language for content. EN (default) or DE.'),

  includeCorrections: z
    .boolean()
    .default(false)
    .describe(
      `When true, fetches detailed correction instructions via an additional OData call (software components, ABAP objects modified, prerequisites per correction). This adds a few seconds. Use when the user asks about patches, SNOTE corrections, or which objects a note changes.`
    ),
};

/**
 * Output schema for the "fetch" tool
 */
export const NoteGetOutputSchema = {
  id: z.string().describe('SAP Note ID.'),

  title: z.string().describe('Full note title.'),

  summary: z.string().describe('High-level overview of problem and solution.'),

  component: z
    .string()
    .nullable()
    .describe('SAP component code (e.g. "FI-GL-GL"). null if unspecified.'),

  componentText: z
    .string()
    .nullable()
    .optional()
    .describe('Human-readable component description.'),

  priority: z
    .string()
    .nullable()
    .describe('Priority: Very High / High / Medium / Low / Recommendation. null if unset.'),

  category: z
    .string()
    .nullable()
    .describe('Category: Correction, Consulting, Performance, Security, etc. null if unset.'),

  version: z
    .string()
    .nullable()
    .optional()
    .describe('Note version number.'),

  status: z
    .string()
    .nullable()
    .optional()
    .describe('Release status of the note.'),

  releaseDate: z.string().describe('Publication / last-update date (ISO 8601).'),

  language: z.string().describe('Content language: EN or DE.'),

  url: z
    .string()
    .url()
    .describe('SAP Support Portal URL. Share with users.'),

  content: z
    .string()
    .describe(
      `Full note content (cleaned text). Contains sections like Symptom, Reason, Solution, Affected Releases. Summarize Symptom + Solution for the user; preserve code snippets and config steps.`
    ),

  // Enriched metadata (all optional — available when the Detail API returns them)
  validity: z
    .array(z.object({
      softwareComponent: z.string(),
      versionFrom: z.string(),
      versionTo: z.string(),
    }))
    .optional()
    .describe('Software component version ranges this note applies to.'),

  supportPackages: z
    .array(z.object({
      softwareComponent: z.string(),
      name: z.string(),
      level: z.string().optional(),
    }))
    .optional()
    .describe('Support Packages that include this fix.'),

  references: z
    .object({
      referencesTo: z.array(z.object({
        noteNumber: z.string(),
        title: z.string(),
        noteType: z.string().optional(),
      })).optional(),
      referencedBy: z.array(z.object({
        noteNumber: z.string(),
        title: z.string(),
        noteType: z.string().optional(),
      })).optional(),
    })
    .optional()
    .describe('Cross-references to/from other SAP Notes.'),

  prerequisites: z
    .array(z.object({
      noteNumber: z.string(),
      title: z.string(),
    }))
    .optional()
    .describe('Prerequisite notes that must be applied first.'),

  sideEffects: z
    .object({
      causing: z.array(z.object({ noteNumber: z.string(), title: z.string() })).optional(),
      solving: z.array(z.object({ noteNumber: z.string(), title: z.string() })).optional(),
    })
    .optional()
    .describe('Notes causing or solving side effects related to this note.'),

  correctionsInfo: z
    .object({
      totalCorrections: z.number().optional(),
      totalManualActivities: z.number().optional(),
      totalPrerequisites: z.number().optional(),
    })
    .optional()
    .describe('Summary counts: corrections, manual activities, prerequisites.'),

  correctionsSummary: z
    .array(z.object({
      softwareComponent: z.string(),
      pakId: z.string(),
      count: z.number().optional(),
    }))
    .optional()
    .describe('Per-software-component correction instruction summary.'),

  correctionDetails: z
    .array(z.object({
      softwareComponent: z.string(),
      versionFrom: z.string(),
      versionTo: z.string(),
      sapNotesNumber: z.string(),
      sapNotesTitle: z.string(),
      objects: z.array(z.object({
        objectName: z.string(),
        objectType: z.string(),
      })).optional(),
      prerequisites: z.array(z.object({
        noteNumber: z.string(),
        title: z.string(),
      })).optional(),
    }))
    .optional()
    .describe('Detailed correction instructions (only when includeCorrections=true). Lists affected ABAP objects and per-correction prerequisites.'),

  manualActions: z
    .string()
    .optional()
    .describe('Manual activity instructions (HTML) if the note requires manual steps.'),

  attachments: z
    .array(z.object({
      filename: z.string(),
      url: z.string().optional(),
    }))
    .optional()
    .describe('File attachments included with the note.'),

  downloadUrl: z
    .string()
    .optional()
    .describe('SNOTE download URL for automatic correction import.'),

  pdfUrl: z
    .string()
    .optional()
    .describe('Ready-to-use PDF version URL of the note, when SAP for Me provides one.'),
};

// ─── TOOL DESCRIPTIONS ─────────────────────────────────────────────────────

export const SAP_NOTE_SEARCH_DESCRIPTION = `Search the SAP Knowledge Base for SAP Notes — official articles documenting bugs, fixes, patches, corrections, security vulnerabilities, and known issues.

USE WHEN the user mentions errors, bugs, fixes, patches, dumps, unexpected behavior, or references a specific SAP Note number.

DO NOT USE for "how to configure/set up" questions (use sap_help_search), tutorials, or general "what is" questions.

WORKFLOW:
1. search(q="OData 415 error CAP") → ranked results
2. fetch(id="2744792") → full content with solution
3. Synthesize answer

QUERY TIPS — be specific:
  Good: "error 415 CAP action", "CX_SY_ZERODIVIDE ABAP", "S/4HANA migration performance"
  Bad: "SAP problem", "not working", "help"`;

export const SAP_NOTE_GET_DESCRIPTION = `Fetch the complete content and metadata of a specific SAP Note by its ID. Returns the full note text (Symptom, Solution, Affected Releases), plus enriched metadata: validity ranges, support packages, references, prerequisites, side effects, correction instruction summaries, and attachments.

Set includeCorrections=true to also retrieve detailed correction instructions via an additional OData call — this lists every affected ABAP object (TADIR entries) and per-correction prerequisites. Adds a few seconds; use when the user asks about SNOTE corrections, patching, or which objects are changed.

USE AFTER search() returns relevant note IDs. Fetch only the top 2-3 results, not all.

PARAMETER: id — alphanumeric Note ID only (e.g. "2744792"). Strip any "Note" or "SAP Note" prefix.`;

// ─── TYPE EXPORTS ──────────────────────────────────────────────────────────

export type NoteSearchInput = z.infer<z.ZodObject<typeof NoteSearchInputSchema>>;
export type NoteSearchOutput = z.infer<z.ZodObject<typeof NoteSearchOutputSchema>>;
export type NoteSearchResult = z.infer<z.ZodObject<typeof NoteSearchResultSchema>>;
export type NoteGetInput = z.infer<z.ZodObject<typeof NoteGetInputSchema>>;
export type NoteGetOutput = z.infer<z.ZodObject<typeof NoteGetOutputSchema>>;
