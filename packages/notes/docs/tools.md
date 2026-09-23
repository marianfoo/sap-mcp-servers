# MCP Tools Reference

## `search`

Search the SAP Knowledge Base (SAP Notes) for troubleshooting articles, bug fixes, patches, corrections, and known issues.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query (2-200 chars) |
| `lang` | `'EN'` \| `'DE'` | No | `'EN'` | Language for results |

### Output

```typescript
{
  totalResults: number;
  query: string;
  results: Array<{
    id: string;          // Note ID (e.g., "2744792")
    title: string;       // Note title
    summary: string;     // Brief description
    component: string | null;  // SAP component (e.g., "CA-UI5")
    releaseDate: string; // ISO date
    language: string;    // "EN" or "DE"
    url: string;         // SAP Support Portal URL
  }>;
}
```

### Query Tips

Effective queries follow this formula: `[Error Code/Transaction] + [Module/Component] + [Issue Type]`

**Good queries:**
- `"OData gateway error 415"` - Error code + context
- `"MM02 material master dump"` - Transaction + module + issue
- `"ABAP CX_SY_ZERODIVIDE"` - Specific exception
- `"S/4HANA migration performance"` - Product + issue
- `"2744792"` - Direct note ID lookup

**Bad queries:**
- `"SAP problem"` - Too vague
- `"not working"` - No specifics
- `"help"` - No context

---

## `fetch`

Fetch the complete content and metadata for a specific SAP Note by ID. Returns full cleaned text, enriched metadata (validity, support packages, references, prerequisites, side effects, corrections info), and optionally detailed correction instructions.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | - | Note ID (alphanumeric) |
| `lang` | `'EN'` \| `'DE'` | No | `'EN'` | Language for content |
| `includeCorrections` | boolean | No | `false` | Fetch detailed correction instructions via OData (adds a few seconds) |

### Output

```typescript
{
  // Core fields (always present)
  id: string;
  title: string;
  summary: string;
  component: string | null;
  componentText?: string | null;      // Human-readable component name
  priority: string | null;            // "Very High", "High", "Medium", "Low"
  category: string | null;            // "Correction", "Consulting", etc.
  version?: string | null;            // Note version number
  status?: string | null;             // Release status
  releaseDate: string;
  language: string;
  url: string;
  content: string;                    // Full cleaned text content

  // Enriched metadata (present when available from Detail API)
  validity?: Array<{                  // Software component version ranges
    softwareComponent: string;
    versionFrom: string;
    versionTo: string;
  }>;
  supportPackages?: Array<{           // Support Packages containing the fix
    softwareComponent: string;
    name: string;
    level?: string;
  }>;
  supportPackagePatches?: Array<{      // Support Package patches containing the fix
    softwareComponent: string;
    name: string;
    level?: string;
  }>;
  references?: {                      // Cross-references
    referencesTo?: Array<{ noteNumber: string; title: string; noteType?: string }>;
    referencedBy?: Array<{ noteNumber: string; title: string; noteType?: string }>;
  };
  prerequisites?: Array<{             // Notes that must be applied first
    noteNumber: string;
    title: string;
  }>;
  sideEffects?: {                     // Related side effect notes
    causing?: Array<{ noteNumber: string; title: string }>;
    solving?: Array<{ noteNumber: string; title: string }>;
  };
  correctionsInfo?: {                 // Summary counts
    totalCorrections?: number;
    totalManualActivities?: number;
    totalPrerequisites?: number;
  };
  correctionsSummary?: Array<{        // Per-component correction summary
    softwareComponent: string;
    pakId: string;
    count?: number;
  }>;
  manualActions?: string;             // Manual activity instructions (HTML)
  attachments?: Array<{               // File attachments
    filename: string;
    url?: string;
  }>;
  downloadUrl?: string;               // SNOTE download URL

  // Detailed corrections (only when includeCorrections=true)
  correctionDetails?: Array<{
    softwareComponent: string;
    versionFrom: string;
    versionTo: string;
    sapNotesNumber: string;
    sapNotesTitle: string;
    objects?: Array<{                 // Affected ABAP repository objects
      objectName: string;
      objectType: string;
    }>;
    prerequisites?: Array<{           // Per-correction prerequisites
      noteNumber: string;
      title: string;
    }>;
    downloadUrl?: string;             // TCI only: HTTPS transport package URL
  }>;

**Correction instructions vs. TCI.** Each entry in `correctionDetails` is one correction instruction,
bound to a software component and a release range (e.g. `SAP_BASIS 700-700`) — a note with 11 corrections
returns 11 entries, typically one per release. `downloadUrl` is populated **only** for
Transport-Based Correction Instructions (TCI) and points at the transport package; it is absent for
classic correction instructions, so it is a reliable way to tell the two apart without parsing note text.
The package itself is behind SAP SSO and must be downloaded interactively — the validated HTTPS URL
is provided for navigation, not for automated fetching.
}
```

### Content Structure

SAP Note content typically includes these sections:
- **Symptom** - Problem description
- **Reason and Prerequisites** - Root cause
- **Solution** - Step-by-step fix instructions
- **Affected Releases** - Impacted SAP versions
- **Related Notes** - Cross-references

### Retrieval Strategy

1. **Playwright Raw Notes API** - Browser-based extraction (primary)
2. **HTTP Raw Notes API** - Direct HTTP fetch (fallback)
3. **Correction Instructions OData** - Optional additional call when `includeCorrections=true`

---

## `fetch_attachment`

Downloads a file attached to an SAP Note and saves it to disk.

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string (URL) | yes | Attachment URL taken **verbatim** from the `attachments` array of `fetch()`. These URLs are opaque — do not construct them. |
| `outputDir` | string | no | Directory to write into. Defaults to the OS temp directory; must already exist. |
| `filename` | string | no | Name to save as. Defaults to the attachment's filename. Path separators are stripped. |

### Output

| Field | Type | Description |
|---|---|---|
| `path` | string | Absolute path of the saved file |
| `filename` | string | Name it was saved as |
| `contentType` | string | Content-Type reported by SAP |
| `bytes` | number | Size on disk |
| `sha256` | string | SHA-256 of the bytes |

### Notes

Attachments are served from SAP's support document hosts — observed:
`documents.support.sap.com` and `userapps.support.sap.com`. Both are needed; several
notes use one and several use the other. Downloads are restricted to an allowlist of
SAP hosts so the tool cannot be used as a general-purpose fetcher.

**Authentication differs from the JSON backend.** The me.sap.com storage state alone is
not sufficient for the document hosts. Where `PFX_PATH` is configured the client
certificate is presented for those origins, which is what authenticates them; session
cookies are still supplied so cookie-authenticated hosts keep working.

**An unauthenticated request answers `HTTP 200` with a ~1.8 KB HTML login stub**, not an
error status. Saving that blindly would produce a file named `something.png` containing
JavaScript. The tool checks the content type and rejects the stub, so a successful result
means real bytes.

### Example

```
fetch(id="2187425")
  → attachments: [{ filename: "TCI_for_Customer.pdf", url: "https://userapps.support.sap.com/..." }]

fetch_attachment(url="https://userapps.support.sap.com/...", outputDir="/tmp")
  → { path: "/tmp/TCI_for_Customer.pdf", contentType: "application/pdf",
      bytes: 878422, sha256: "6f64e07c7903..." }
```

Verified live against 10 notes carrying attachments, yielding `image/png`,
`application/pdf`, `application/vnd.ms-excel`, `application/x-zip-compressed` and
`application/x-tika-msoffice` across both hosts.

## Recommended Workflow

For best results, chain search and fetch:

```
1. search(q="OData 415 error CAP")
   → Returns: [{id: "2744792", title: "..."}, {id: "438342", ...}]

2. fetch(id="2744792")
   → Returns: Full note with solution steps + enriched metadata

3. fetch(id="2744792", includeCorrections=true)
   → Returns: Above + detailed correction instructions with ABAP objects

4. Synthesize answer from note content
```

- Review first 2-5 search results
- Fetch details for top 2-3 most relevant notes
- Use `includeCorrections=true` only when user asks about patches/corrections/objects
- Do NOT fetch all results
