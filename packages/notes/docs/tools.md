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
  }>;
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
