/**
 * vectros-version-header.spec.ts — the `Vectros-Version` request header
 * (new in 0.38.0): pin the response shape your client expects (fields,
 * envelope, pagination, enum values, error bodies). It never affects
 * behavior — authorization, tenant isolation, and quota enforcement are
 * identical under every version.
 *
 * Sending nothing changes nothing: requests without the header are served
 * exactly as before. The generated SDKs do not send this header themselves
 * yet, so using it means passing it explicitly via `requestOptions`, as
 * shown here — any SDK call accepts it the same way.
 */
import { client } from '../src/client';

describe('Vectros-Version request header', () => {
    // '2026-08-01' is the currently published version — check the API
    // changelog for the current list if this starts failing; it isn't tied
    // to this file mechanically.
    test('a supported version is echoed back in the response', async () => {
        const { rawResponse } = await client.auth.ping({
            headers: { 'Vectros-Version': '2026-08-01' },
        }).withRawResponse();
        expect(rawResponse.headers.get('vectros-version')).toBe('2026-08-01');
    });

    test('an unrecognized version is rejected with 400 UNSUPPORTED_WIRE_VERSION', async () => {
        try {
            await client.auth.ping({ headers: { 'Vectros-Version': '1999-01-01' } });
            throw new Error('expected the call to reject, but it resolved successfully');
        } catch (e) {
            const err = e as { statusCode?: number; body?: { errorCode?: string } };
            if (err.statusCode === undefined) throw e; // not an API error — surface it
            expect(err.statusCode).toBe(400);
            expect(err.body?.errorCode).toBe('UNSUPPORTED_WIRE_VERSION');
        }
    });
});
