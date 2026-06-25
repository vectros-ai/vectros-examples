/**
 * Fixture data used by smoke tests. Real files (e.g. sample.pdf) live in
 * ../fixtures/; this module exports paths and known content markers.
 */
import * as path from 'path';

/** Path to the sample PDF used by documents-upload.spec.ts. */
export const SAMPLE_PDF_PATH = path.join(__dirname, '..', 'fixtures', 'sample.pdf');

/**
 * A phrase known to appear in sample.pdf exactly. Used by TEXT-mode search
 * assertions in documents-upload.spec.ts. Update this when the fixture changes.
 */
export const SAMPLE_PDF_KNOWN_PHRASE = 'systolic blood pressure';

/**
 * A phrase semantically related to sample.pdf content but NOT appearing
 * literally. Used by SEMANTIC-mode search assertions. Should retrieve the
 * fixture via vector similarity even though no exact words match.
 */
export const SAMPLE_PDF_SEMANTIC_PHRASE = 'elevated arterial pressure medication';
