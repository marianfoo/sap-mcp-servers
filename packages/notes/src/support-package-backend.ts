/**
 * SAP for Me Software Download Center (swdcuisap4mesrv) helpers for support packages.
 *
 * The "SAP-Hinweise" tab on https://me.sap.com/softwarecenter/object/<ObjectKey> loads:
 *   ObjectSet('<ObjectKey>')/ObjectSAPNotes      → notes delivered with the package
 *   ObjectSet('<ObjectKey>')/ObjectSideEffects   → "Lösungen für Nebeneffekte"
 *   ObjectSet('<ObjectKey>')/ObjectConditions    → "Paketbedingungen" (import prerequisites)
 *   ObjectSet('<ObjectKey>')/ObjectList          → "Objektliste" (TADIR objects in the package)
 *   ObjectSet('<ObjectKey>')                     → package header
 * A package name such as SAPKE608G4 is resolved to its ObjectKey via SearchResultSet.
 *
 * Note: the navigation collections return no rows unless $top is given explicitly,
 * so callers must always page with $skip/$top.
 */

export const SWDC_SERVICE_PATH = '/backend/raw/core/W7LegacyProxyVerticle/odata/svt/swdcuisap4mesrv';
export const SWDC_PAGE_SIZE = 500;
export const DEFAULT_MAX_NOTES = 100;
export const MAX_PACKAGE_NOTES = 5000;

export type SupportPackageSection = 'notes' | 'sideEffects' | 'conditions' | 'objects';

export const SECTION_NAVIGATION: Record<SupportPackageSection, string> = {
  notes: 'ObjectSAPNotes',
  sideEffects: 'ObjectSideEffects',
  conditions: 'ObjectConditions',
  objects: 'ObjectList'
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function noteNumber(value: unknown): string {
  const raw = text(value);
  return raw.replace(/^0+/, '') || raw;
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

/** 19-digit download object key (Fastkey), e.g. 0010000001004222026. */
export function isObjectKey(value: string): boolean {
  return /^\d{10,20}$/.test(value.trim());
}

/** Accept SP names such as SAPKE608G4, SAPK-60899INSAPHRCDE, SAPKB75031 or an object key. */
export function normalizePackageInput(value: string): string {
  const trimmed = value.trim();
  return isObjectKey(trimmed) ? trimmed : trimmed.toUpperCase();
}

export function objectPath(objectKey: string, navigation?: string): string {
  const entity = `${SWDC_SERVICE_PATH}/ObjectSet('${escapeODataString(objectKey)}')`;
  return navigation ? `${entity}/${navigation}` : entity;
}

export function buildPageParams(skip: number, top: number, language?: string): Record<string, string> {
  const params: Record<string, string> = {
    $skip: String(Math.max(0, Math.trunc(skip))),
    $top: String(Math.max(1, Math.trunc(top))),
    $inlinecount: 'allpages',
    $format: 'json'
  };
  if (language) params['sap-language'] = language;
  return params;
}

export function buildSearchParams(query: string, language?: string): Record<string, string> {
  const params: Record<string, string> = {
    SEARCH_MAX_RESULT: '50',
    RESULT_PER_PAGE: '50',
    SEARCH_STRING: query,
    search: 'mode=files',
    $format: 'json'
  };
  if (language) params['sap-language'] = language;
  return params;
}

export interface ODataPage {
  rows: JsonRecord[];
  count: number | null;
  hasNext?: boolean;
}

export function readODataPage(payload: unknown): ODataPage {
  const d = asRecord(asRecord(payload)?.d);
  if (!d || !Array.isArray(d.results)) {
    throw new Error('Software Download Center response did not contain d.results');
  }
  const count = Number.parseInt(text(d.__count), 10);
  return {
    ...(d.__next ? { hasNext: true } : {}),
    rows: d.results.map(asRecord).filter((row): row is JsonRecord => row !== null),
    count: Number.isNaN(count) ? null : count
  };
}

export interface SupportPackageCandidate {
  objectKey: string;
  name: string;
  description: string;
  type: string;
}

export function mapSearchCandidates(payload: unknown): SupportPackageCandidate[] {
  return readODataPage(payload).rows
    .map(row => ({
      objectKey: text(row.Fastkey),
      name: text(row.Title),
      description: text(row.Description),
      type: text(row.Infotype)
    }))
    .filter(candidate => isObjectKey(candidate.objectKey));
}

/** Search is fuzzy. Only a unique exact name identifies the requested package. */
export function pickCandidate(
  candidates: SupportPackageCandidate[],
  name: string
): SupportPackageCandidate | null {
  const exact = candidates.filter(c => c.name.toUpperCase() === name.toUpperCase());
  const unique = new Map(exact.map(c => [c.objectKey, c]));
  return unique.size === 1 ? exact[0] : null;
}

export interface SupportPackageHeader {
  objectKey: string;
  name: string;
  title: string;
  status?: string;
  fileType?: string;
  fileSize?: string;
  fileVersion?: string;
}

export function mapHeader(payload: unknown, objectKey: string): SupportPackageHeader {
  const d = asRecord(asRecord(payload)?.d);
  if (!d || (!text(d.FileName) && !text(d.Title))) throw new Error('Software Download Center did not return a package header for this object key');
  return {
    objectKey,
    name: text(d.FileName) || objectKey,
    title: text(d.Title) || text(d.FileName) || objectKey,
    status: text(d.StatusDescr) || text(d.Status) || undefined,
    fileType: text(d.FileType) || undefined,
    fileSize: text(d.FileSize) || undefined,
    fileVersion: text(d.FileVersion) || undefined
  };
}

export interface SupportPackageNote {
  id: string;
  title: string;
  version: string;
  versionInSP: string;
  component: string;
  componentName: string;
  priority: string;
  category: string;
  countryCode: string | null;
  url: string;
}

export function mapNote(row: JsonRecord): SupportPackageNote {
  const id = noteNumber(row.Number);
  return {
    id,
    title: text(row.Title),
    version: text(row.Version),
    versionInSP: text(row.VersionInSP),
    component: text(row.Component),
    componentName: text(row.ComponentName),
    priority: text(row.Priority),
    category: text(row.Category),
    countryCode: text(row.CountryCode) || null,
    url: `https://me.sap.com/notes/${id}`
  };
}

export interface SupportPackageSideEffect {
  causingNote: string;
  causingTitle: string;
  causingComponent: string;
  causingVersionRange: string;
  solvingNote: string;
  solvingTitle: string;
  solvingComponent: string;
  solvingPriority: string;
  solvingPackage: string;
}

export function mapSideEffect(row: JsonRecord): SupportPackageSideEffect {
  return {
    causingNote: noteNumber(row.CauseNumber),
    causingTitle: text(row.CauseTitle),
    causingComponent: text(row.CauseComponent),
    causingVersionRange: text(row.CauseVersionRange),
    solvingNote: noteNumber(row.SolveNumber),
    solvingTitle: text(row.SolveTitle),
    solvingComponent: text(row.SolveComponent),
    solvingPriority: text(row.SolvePriority),
    solvingPackage: text(row.SolvePackageName)
  };
}

export interface SupportPackageCondition {
  conditionSet: string;
  type: string;
  softwareComponent: string;
  release: string;
  packageType: string;
  package: string;
}

export function mapCondition(row: JsonRecord): SupportPackageCondition {
  return {
    conditionSet: text(row.ConditionSet),
    type: text(row.ComponentCategoryDescr) || text(row.ComponentCategory),
    softwareComponent: text(row.SoftwareComponent),
    release: text(row.Release),
    packageType: text(row.PackageCategoryDescr) || text(row.PackageCategory),
    package: text(row.Package)
  };
}

export interface SupportPackageObject {
  pgmId: string;
  objectType: string;
  objectName: string;
}

export function mapObject(row: JsonRecord): SupportPackageObject {
  return {
    pgmId: text(row.PgmId),
    objectType: text(row.ObjectType),
    objectName: text(row.ObjectName)
  };
}

/** Case-insensitive prefix filter on application component, e.g. "PY-DE" matches "PY-DE-PS". */
export function filterNotesByComponent(
  notes: SupportPackageNote[],
  componentPrefix?: string
): SupportPackageNote[] {
  const prefix = componentPrefix?.trim().toUpperCase().replace(/-+$/, '');
  if (!prefix) return notes;
  return notes.filter(note => {
    const component = note.component.toUpperCase();
    return component === prefix || component.startsWith(prefix + '-');
  });
}

export interface SupportPackageContent {
  package: SupportPackageHeader;
  noteCount?: number;
  notes?: SupportPackageNote[];
  notesByComponent?: Array<{ component: string; componentName: string; count: number }>;
  sideEffects?: SupportPackageSideEffect[];
  conditions?: SupportPackageCondition[];
  objectCount?: number;
  objects?: SupportPackageObject[];
  truncated?: Partial<Record<SupportPackageSection, boolean>>;
  url: string;
}

export function summarizeByComponent(
  notes: SupportPackageNote[]
): Array<{ component: string; componentName: string; count: number }> {
  const groups = new Map<string, { component: string; componentName: string; count: number }>();
  for (const note of notes) {
    const key = note.component || '(none)';
    const group = groups.get(key) ?? { component: key, componentName: note.componentName, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.component.localeCompare(b.component));
}

/** Compact Markdown rendering for the MCP text channel. */
export function formatSupportPackageContent(content: SupportPackageContent, componentFilter?: string): string {
  const pkg = content.package;
  const lines: string[] = [
    `**${pkg.name} — ${pkg.title}**`,
    `Object key: ${pkg.objectKey}${pkg.status ? ` | ${pkg.status}` : ''}`,
    `URL: ${content.url}`,
    ''
  ];

  if (content.notes) {
    const shown = content.notes.length;
    lines.push(`**SAP Notes: ${content.noteCount === undefined ? "total unknown" : `${content.noteCount} in package`}${componentFilter ? `, ${shown} matching component "${componentFilter}"` : ''}**`);
    if (content.notesByComponent?.length) {
      lines.push('By component: ' + content.notesByComponent
        .slice(0, 15)
        .map(group => `${group.component} (${group.count})`)
        .join(', ') + (content.notesByComponent.length > 15 ? ', …' : ''));
    }
    lines.push('');
    for (const note of content.notes) {
      lines.push(`- ${note.id} v${note.version} [${note.component}] ${note.title} — ${note.category}; ${note.priority}`);
    }
    if (content.truncated?.notes) lines.push('_(partial list — component counts describe the returned notes. Narrow the component or increase maxNotes, up to 5000.)_');
    lines.push('');
  }

  if (content.sideEffects) {
    lines.push(`**Side effects (${content.sideEffects.length}${content.truncated?.sideEffects ? ", partial" : ""})**`);
    for (const se of content.sideEffects) {
      lines.push(`- Note ${se.causingNote} (${se.causingComponent}) → solved by ${se.solvingNote}: ${se.solvingTitle}${se.solvingPackage ? ` [${se.solvingPackage}]` : ''}`);
    }
    lines.push('');
  }

  if (content.conditions) {
    lines.push(`**Import conditions (${content.conditions.length}${content.truncated?.conditions ? ", partial" : ""})**`);
    for (const c of content.conditions) {
      lines.push(`- Set ${c.conditionSet}: ${c.softwareComponent} ${c.release} ${c.type}${c.package ? ` — requires ${c.packageType} ${c.package}` : ''}`);
    }
    lines.push('');
  }

  if (content.objects) {
    lines.push(`**Object list (${content.objectCount ?? "unknown total"} objects${content.truncated?.objects ? `, first ${content.objects.length} shown` : ''})**`);
    for (const o of content.objects) lines.push(`- ${o.pgmId} ${o.objectType} ${o.objectName}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
