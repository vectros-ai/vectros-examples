/**
 * Stream tolerance: what the SDK's stream decoder does with an event or field it does not know.
 *
 * The API adds event types and fields over time, and a client written today must keep working when
 * the stream carries one it has never seen. This spec replays raw server-sent-event streams
 * (fixtures/sse-tolerance/scenarios.json, shared with the Python and Java SDK suites) through the
 * REAL generated decoder of the installed SDK and pins the outcome: which events are delivered,
 * whether an unknown field survives on a known event, and whether the call throws. The SDK
 * decoder is generated code, so a generator or SDK upgrade can change this silently; a change here
 * is a change customers will see.
 *
 * Offline: a loopback server stands in for the API, so it needs no credentials and no network.
 *
 * To re-measure after an intended change, run with TOLERANCE_RECORD=1: it prints the actual outcome
 * of every scenario as JSON instead of asserting, and the result is pasted into the fixture file's
 * `expect.typescript` entries.
 */
import { readFileSync } from 'fs';
import * as http from 'http';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { VectrosClient } from '@vectros-ai/sdk';

interface Probe {
    /** The `type` of the delivered event to look at, and which occurrence of it (0 is the first). */
    event: string;
    nth: number;
    field: string;
}
interface Outcome {
    /** The `type` of each event the SDK delivered, in order. */
    delivered: string[];
    /** The `delta` text of the delivered content_delta events, joined: shows the bytes survived intact. */
    text: string;
    /** For each probe, whether the field survived on that delivered event; null when no such event was delivered. */
    probes: Array<boolean | null>;
    /** The error class thrown while consuming the stream, or null. */
    error: string | null;
}
interface Scenario {
    id: string;
    route: 'chat' | 'rag' | 'document-ask';
    description: string;
    close: 'clean' | 'abrupt';
    chunks: string[];
    chunkBytes?: number;
    splitsMultiByte?: boolean;
    probes?: Probe[];
    expect: { typescript: Outcome | null };
}

const FIXTURES: { scenarios: Scenario[] } = JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'sse-tolerance', 'scenarios.json'), 'utf8'),
);
const RECORD = process.env.TOLERANCE_RECORD === '1';

const ROUTES: Record<Scenario['route'], string> = {
    chat: '/v1/chat',
    rag: '/v1/rag',
    'document-ask': '/v1/documents/doc-1/ask',
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A loopback server that answers the scenario's route with its raw stream. */
function serve(scenario: Scenario): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', async () => {
            if (req.method !== 'POST' || req.url !== ROUTES[scenario.route]) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end('{"message":"unexpected route"}');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            const pieces: Buffer[] = scenario.chunkBytes
                ? splitBytes(Buffer.from(scenario.chunks.join(''), 'utf8'), scenario.chunkBytes)
                : scenario.chunks.map((c) => Buffer.from(c, 'utf8'));
            for (const piece of pieces) {
                res.write(piece);
                await sleep(2);
            }
            if (scenario.close === 'abrupt') {
                res.socket?.destroy();
            } else {
                res.end();
            }
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Whether any write boundary falls inside a multi-byte UTF-8 character (on a continuation byte). */
function splitsInsideCharacter(all: Buffer, size: number): boolean {
    for (let i = size; i < all.length; i += size) if ((all[i] & 0xc0) === 0x80) return true;
    return false;
}

function splitBytes(all: Buffer, size: number): Buffer[] {
    const out: Buffer[] = [];
    for (let i = 0; i < all.length; i += size) out.push(all.subarray(i, i + size));
    return out;
}

async function openStream(client: VectrosClient, route: Scenario['route']): Promise<AsyncIterable<unknown>> {
    switch (route) {
        case 'chat':
            return client.inference.chatInference({ messages: [{ role: 'user', content: 'hi' }] });
        case 'rag':
            return client.inference.ragInference({ query: 'q' });
        case 'document-ask':
            return client.inference.documentAsk({ id: 'doc-1', prompt: 'q' });
    }
}

function isObject(e: unknown): e is Record<string, unknown> {
    return typeof e === 'object' && e !== null && !Array.isArray(e);
}

/** The SDK hands over whatever JSON the frame held, so a delivered "event" may not be an object at all. */
function nameOf(e: unknown): string {
    if (isObject(e)) return String(e.type);
    return e === null ? '<null>' : Array.isArray(e) ? '<array>' : `<${typeof e}>`;
}

async function run(scenario: Scenario): Promise<Outcome> {
    if (scenario.splitsMultiByte) {
        // The scenario exists to cut a character across writes: fail loudly if its chunking does not.
        const all = Buffer.from(scenario.chunks.join(''), 'utf8');
        expect(splitsInsideCharacter(all, scenario.chunkBytes ?? all.length)).toBe(true);
    }
    const server = await serve(scenario);
    const { port } = server.address() as AddressInfo;
    // maxRetries 0: this suite measures the decoder, not the SDK's retry policy.
    const client = new VectrosClient({ environment: `http://127.0.0.1:${port}`, token: 'unused', maxRetries: 0 });
    const events: unknown[] = [];
    let error: string | null = null;
    try {
        for await (const ev of await openStream(client, scenario.route)) events.push(ev);
    } catch (e) {
        error = (e as Error)?.constructor?.name ?? 'unknown';
    } finally {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return {
        delivered: events.map(nameOf),
        text: events.filter((e) => isObject(e) && e.type === 'content_delta').map((e) => String((e as Record<string, unknown>).delta)).join(''),
        probes: (scenario.probes ?? []).map((p) => {
            const hits = events.filter((e) => isObject(e) && e.type === p.event);
            return hits.length > p.nth ? p.field in (hits[p.nth] as object) : null;
        }),
        error,
    };
}

describe('SDK stream tolerance (TypeScript)', () => {
    const recorded: Record<string, Outcome> = {};

    afterAll(() => {
        if (RECORD) console.log(`TOLERANCE_RECORD typescript ${JSON.stringify(recorded)}`);
    });

    for (const scenario of FIXTURES.scenarios) {
        it(`${scenario.id}: ${scenario.description}`, async () => {
            const actual = await run(scenario);
            if (RECORD) {
                recorded[scenario.id] = actual;
                return;
            }
            expect(scenario.expect.typescript).not.toBeNull();
            expect(actual).toEqual(scenario.expect.typescript);
        });
    }
});
