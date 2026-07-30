# University Repository Downloader — Complete Documentation

This document describes the architecture, workflow, DSpace integration, filtering, selection, download pipeline, configuration, troubleshooting, and extension strategy of the Chuka University Repository Downloader.

## 1. Overview

The application is an interactive Node.js CLI for navigating the Chuka University repository from the **Examination Past Papers** community through faculties/communities and collections until individual papers can be selected and downloaded.

```text
Examination Past Papers
        ↓
Faculty / Community
        ↓
Collection
        ↓
Papers
        ↓
Filter / Search
        ↓
Select
        ↓
Download PDFs
```

## 2. Main Features

- Hierarchical community → collection navigation
- Manual community/collection UUID entry
- DSpace Discovery pagination
- Collection-wide discovery
- Individual paper selection
- Range selection (`1-10`)
- Multi-selection (`1,3,7`)
- Select-all
- Course/unit-code filtering
- Course-name filtering
- Year filtering
- Year-level filtering
- Exam-type filtering
- Free-text search
- Multiple filters
- PDF validation
- Retry handling
- Resumable downloads
- Download manifest
- Failed-download log
- Debug response capture
- Safe Windows filenames
- Conservative request concurrency

## 3. Repository Model

```text
Community
 ├── Subcommunities
 └── Collections
      └── Items
           └── Bundles
                └── ORIGINAL
                     └── Bitstreams
                          └── PDF content
```

The configured root is:

`https://repository.chuka.ac.ke/communities/ea404f68-df7a-4d01-9c96-e4912b94ba96`

## 4. DSpace Discovery

Collection discovery uses the DSpace Discovery endpoint:

```text
GET /server/api/discover/search/objects
    ?query=
    &scope={COLLECTION_UUID}
    &page={PAGE}
    &size=20
```

The response is not assumed to have one fixed shape. The program recursively searches nested HAL/Discovery structures for actual item objects and UUIDs.

This prevents the original failure where the application repeatedly saw response objects but could not find UUIDs.

## 5. Download Pipeline

```text
Collection
  ↓
Discovery pages
  ↓
Item UUID
  ↓
Bundles
  ↓
ORIGINAL bundle
  ↓
Bitstreams
  ↓
PDF bitstream
  ↓
Content endpoint
  ↓
Temporary .part file
  ↓
%PDF- validation
  ↓
Final PDF
```

## 6. Metadata

The application uses several metadata fallbacks:

- `dc.title`
- `dc.title.alternative`
- `title`
- `name`
- `dc.date.issued`
- `dc.date.created`
- `dc.date`

Course codes are inferred from title-like text. Years are extracted from date metadata or titles. Exam type is inferred from terms such as `resit`, `supplementary`, `special`, and `retake`.

Year level is heuristic and should not be treated as authoritative repository metadata.

## 7. Filtering

Available filters:

1. Course/unit code
2. Course name
3. Year
4. Year level
5. Exam type
6. Free-text search
7. Multiple filters

Filters are applied locally after discovery.

## 8. Selection

Examples:

```text
1,3,7
```

selects individual results.

```text
1-10
```

selects a range.

```text
A
```

selects all.

```text
N
```

clears selection.

## 9. Download Organization

Files are stored approximately as:

```text
downloads/
└── Collection/
    └── COURSE CODE/
        └── YEAR/
            └── EXAM TYPE/
                └── PAPER.pdf
```

Duplicate filenames receive `[2]`, `[3]`, etc.

## 10. Persistence

`download-manifest.json` records download state.

`failed-downloads.json` records failures.

`debug/` stores unexpected API responses and fatal debugging information.

Existing files are not blindly trusted: a candidate PDF must pass `%PDF-` signature validation.

## 11. Configuration

Main configuration includes:

```js
pageSize: 20,
maxRetries: 4,
requestTimeout: 30000,
delayMin: 300,
delayMax: 700,
downloadConcurrency: 4
```

Keep concurrency and request rates conservative.

## 12. Installation

Requires Node.js 18+.

```bash
npm install
```

## 13. Running

```bash
node scraper.js
```

or:

```bash
npm start
```

## 14. Main Menu

```text
1. Browse Examination Past Papers
2. Enter Community / Collection UUID
3. Resume / View Download Status
4. Exit
```

## 15. Collection Menu

```text
1. Browse / download papers
2. Download all papers
3. Filter papers
4. Search papers
B. Back
Q. Quit
```

## 16. Troubleshooting

### No items discovered

Inspect `debug/`. The Discovery response may have changed.

### HTTP 429

The repository is rate-limiting requests. Reduce concurrency and increase delays.

### Invalid PDF

The server may have returned HTML/JSON instead of a PDF. Inspect failure/debug information.

### Interrupted download

Run the same collection again. Valid PDFs and manifest records are skipped.

### Incorrect year level

Year level is inferred from course-code structure and may require adjustment for specific Chuka coding conventions.

## 17. Responsible Use

Use the downloader only for publicly available materials and in accordance with repository policies and copyright restrictions. Do not bypass access controls, modify repository content, or deliberately overload the service.

## 18. Future Development

Potential next steps include:

- TypeScript
- SQLite metadata database
- Strong API response schemas
- Download queue
- Better statistics
- CSV export
- Hash-based duplicate detection
- Automated tests
- Configurable repositories
- Web dashboard

## 19. Developer Architecture

The code is logically divided into:

- configuration
- HTTP/retry layer
- repository navigation
- Discovery parsing
- metadata extraction
- filtering
- selection
- download
- persistence
- CLI presentation

The repository and download layers should remain independent from the CLI so that a future web interface can reuse them.
