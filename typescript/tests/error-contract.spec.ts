/**
 * error-contract.spec.ts — Vectros API error response contract.
 *
 * A malformed request body must produce a clean, JSON-parseable error — never
 * a 5xx with a leaked stack trace. A representative failure mode this guards
 * against:
 *
 *   POST /v1/schemas
 *   {"recordType":"task","displayName":"Task","lookupFields":["externalId"]}
 *   →  HTTP 500
 *      body: {"message":"...MismatchedInputException:
 *             ...from String value ('externalId')⏎ at [Source: ...]"}
 *
 * That response is structurally broken on three axes: wrong status (should
 * be 4xx, not 5xx), invalid JSON (literal newline in the string value), and
 * leaked internal class names. Generated SDKs choke with a downstream
 * "Bad control character in string literal in JSON" instead of surfacing
 * the real error. This spec catches any regression of that behavior.
 *
 * Approach: every test uses raw `fetch` (NOT the SDK). The SDK's TypeScript
 * types would reject the deliberately malformed bodies at compile time —
 * but the failure happens at the WIRE level regardless of how a buggy client
 * constructs its request. The backend contract has to hold against any
 * well-formed HTTP request with a malformed JSON body. Raw fetch is how we
 * get there from a typed SDK harness.
 */

const ERR_REF = 'Vectros API error contract';

/** A malformed request body that reproduces the failure mode. */
const MALFORMED_REPRO_BODY = JSON.stringify({
    recordType: 'task',
    displayName: 'Task',
    lookupFields: ['externalId'], // should be [{fieldName: ..., unique: ...}]
});

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function apiKey(): string {
    const k = process.env.VECTROS_API_KEY;
    if (!k) throw new Error('VECTROS_API_KEY required');
    return k;
}

async function rawPost(path: string, body: string): Promise<{
    status: number;
    rawBody: string;
    parsed: unknown;
}> {
    const resp = await fetch(`${baseUrl()}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey()}`,
        },
        body,
    });
    const rawBody = await resp.text();
    // Parse separately so the test can ASSERT on parseability — JSON.parse
    // throwing IS the bug class we're guarding against (the pre-fix body
    // contained a raw \n inside a string and refused to parse).
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch (e) {
        // Surface a clear failure message — the test below will catch this
        // by asserting `parsed !== undefined`.
        throw new Error(
            `${ERR_REF}: response body is not valid JSON. ` +
                `Status=${resp.status}, body=${JSON.stringify(rawBody)}, ` +
                `parse error=${(e as Error).message}`
        );
    }
    return { status: resp.status, rawBody, parsed };
}

interface ErrorBody {
    message: string;
    requestId?: string;
    [k: string]: unknown;
}

describe('Vectros API error contract', () => {
    test('malformed request body → 4xx, NEVER 5xx', async () => {
        const { status, parsed } = await rawPost('/v1/schemas', MALFORMED_REPRO_BODY);

        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);

        const body = parsed as ErrorBody;
        expect(typeof body.message).toBe('string');
        expect(body.message.length).toBeGreaterThan(0);
    });

    test('response body parses as JSON without control-char failures', async () => {
        // Stand-alone re-statement of the bug class — even if a future change
        // re-routes the malformed body through a different status code, the
        // body MUST remain JSON-parseable. This test will fail loudly the
        // moment the hand-built-with-raw-getMessage anti-pattern returns.
        const { rawBody } = await rawPost('/v1/schemas', MALFORMED_REPRO_BODY);
        expect(() => JSON.parse(rawBody)).not.toThrow();

        // Defense-in-depth: scan for raw control chars in the wire bytes.
        for (let i = 0; i < rawBody.length; i++) {
            const code = rawBody.charCodeAt(i);
            expect(code).toBeGreaterThanOrEqual(0x20);
        }
    });

    test('error body carries a friendly message + requestId', async () => {
        const { parsed } = await rawPost('/v1/schemas', MALFORMED_REPRO_BODY);
        const body = parsed as ErrorBody;

        expect(typeof body.message).toBe('string');
        // requestId is your hook for asking support to look up logs.
        // If request-context isn't populated (test infra weirdness), the field
        // can be omitted — but on a real live request it MUST be present.
        expect(typeof body.requestId).toBe('string');
        expect(body.requestId).toBeTruthy();
    });

    test('error body does NOT leak parser internals or stack traces', async () => {
        // A broken implementation can ship raw JSON-parser exception text in
        // the response body. Verify none of the common leak markers show up.
        const { rawBody } = await rawPost('/v1/schemas', MALFORMED_REPRO_BODY);

        expect(rawBody).not.toMatch(/com\.fasterxml/);
        expect(rawBody).not.toMatch(/MismatchedInput/);
        expect(rawBody).not.toMatch(/JsonMappingException/);
        expect(rawBody).not.toMatch(/\[Source:/); // parser source-position marker
        expect(rawBody).not.toMatch(/\tat [\w$.]+\(/); // JVM stack frame
    });

    test('completely broken JSON body → still a clean 4xx (not 5xx)', async () => {
        // Lexer-level parse failure (a different parser path than the
        // type-mismatch case). A broken implementation can surface this as 500.
        const { status, parsed } = await rawPost(
            '/v1/schemas',
            '{this is not even close to valid JSON'
        );
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(500);
        const body = parsed as ErrorBody;
        expect(typeof body.message).toBe('string');
    });
});
