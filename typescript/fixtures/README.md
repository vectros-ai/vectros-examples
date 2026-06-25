# Smoke test fixtures

This directory holds binary fixtures used by smoke tests. Keep files small
(< 100 KB each) so the repo stays light.

## Expected files

- `sample.pdf` — ~10 KB synthetic clinical-note PDF used by
  `documents-upload.spec.ts`. Must contain:
  - At least one exact phrase matching `SAMPLE_PDF_KNOWN_PHRASE` in
    `src/fixtures.ts` (currently `"systolic blood pressure"`).
  - Content semantically related to medical/clinical topics (so SEMANTIC-mode
    queries via `SAMPLE_PDF_SEMANTIC_PHRASE` retrieve it via vector
    similarity).
  - At least 500 words of body text so the indexer produces multiple chunks
    (exercises chunk-level scoring).

Generate with any PDF writer — LibreOffice, pandoc, or a Python script.
Commit the binary; do not generate at test time (test environments may not
have the tooling, and generation introduces nondeterminism).

## Why these aren't generated dynamically

The full document-indexing flow (text extraction + embedding + index ingest)
is the most expensive smoke test path. Variation in the input PDF would
change chunk boundaries and similarity scores, making assertions fragile.
A committed binary keeps the search assertions stable across runs.
