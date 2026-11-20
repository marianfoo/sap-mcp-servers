import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SapNotesApiClient } from './sap-notes-api.js';
import { DEFAULT_MAX_NOTES, MAX_PACKAGE_NOTES, formatSupportPackageContent } from './support-package-backend.js';
import { logger } from './logger.js';

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export const SUPPORT_PACKAGE_TOOL_NAME = 'support_package_notes';

export const SUPPORT_PACKAGE_DESCRIPTION = `List everything delivered with an SAP Support Package, as shown in SAP for Me → Software Downloads → package details ("SAP-Hinweise", "Lösungen für Nebeneffekte", "Paketbedingungen", "Objektliste").

Use when the user asks which SAP Notes / corrections are contained in a Support Package (SP), what an SP changes for a component, which side effects are known, or which SPs must be imported first.

Input: the package name as shown in the download center, e.g. "SAPKE608G4" (SAP_HR 608 SP 164), "SAPK-60899INSAPHRCDE", "SAPKB75031" — or the numeric download object key.
Tip: use 'component' to narrow large packages (e.g. "PY-DE" for German payroll, "PT" for time management). Pass individual note IDs to fetch() for full content.`;

export const SupportPackageInputSchema = {
  package: z
    .string()
    .trim()
    .min(4)
    .max(40)
    .regex(/^[A-Za-z0-9_\-\/]+$/, 'Package name may only contain letters, digits, _, - and /')
    .describe('Support package name (e.g. "SAPKE608G4") or numeric download object key.'),
  include: z
    .array(z.enum(['notes', 'sideEffects', 'conditions', 'objects']))
    .default(['notes'])
    .describe('Sections to load. notes = delivered SAP Notes (default); sideEffects = side-effect solutions; conditions = import prerequisites; objects = object list (can be long).'),
  component: z
    .string()
    .max(40)
    .optional()
    .describe('Optional application component prefix to filter notes, e.g. "PY-DE", "PA-PA", "BC-BMT-OM".'),
  maxNotes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PACKAGE_NOTES)
    .default(DEFAULT_MAX_NOTES)
    .describe('Maximum matching notes to return (default 100). Component searches scan up to 5000 notes.'),
  maxObjects: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(300)
    .describe('Upper bound for object list entries when "objects" is included.'),
  lang: z
    .enum(['EN', 'DE'])
    .default('EN')
    .describe('Language for priority/category/component texts.')
};

export const SupportPackageInputMcpSchema = z.object(SupportPackageInputSchema).meta({ $schema: JSON_SCHEMA_2020_12 });

type WithAuthRetry = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

export function registerSupportPackageTool(
  mcp: McpServer,
  client: SapNotesApiClient,
  withAuthRetry: WithAuthRetry
): void {
  mcp.registerTool(
    SUPPORT_PACKAGE_TOOL_NAME,
    {
      title: 'SAP Support Package content',
      description: SUPPORT_PACKAGE_DESCRIPTION,
      inputSchema: SupportPackageInputMcpSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ package: pkg, include, component, maxNotes, maxObjects, lang }) => {
      logger.info(`📦 [${SUPPORT_PACKAGE_TOOL_NAME}] ${pkg} include=${include.join(',')} component=${component ?? '-'}`);
      try {
        const content = await withAuthRetry(token =>
          client.getSupportPackageContent(pkg, token, {
            include,
            component,
            maxNotes,
            maxObjects,
            language: lang
          })
        );
        return {
          content: [{ type: 'text' as const, text: formatSupportPackageContent(content, component) }],
          structuredContent: content as unknown as Record<string, unknown>
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`❌ [${SUPPORT_PACKAGE_TOOL_NAME}] failed for ${pkg}: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Failed to load support package ${pkg}: ${message}` }],
          isError: true
        };
      }
    }
  );
}
