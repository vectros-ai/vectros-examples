package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.types.AppContextPage;
import ai.vectros.resources.auth.requests.ListAccessProfilesRequest;
import ai.vectros.resources.auth.requests.ListAppContextsRequest;
import ai.vectros.resources.records.requests.ListRecordsRequest;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * The paginated list envelope `{data, nextCursor}` and the list-shape guards. A
 * list endpoint that regresses to a bare array (or wraps/renames the envelope)
 * crashes every consumer that
 * unwraps `.data` / pages on `.nextCursor`. The Fern Java SDK deserializes each
 * list response into a typed *Page model, so a contract drift surfaces here as a
 * deserialization failure or a missing accessor, on the real wire.
 */
class EnvelopeSmokeTest {

    @Test
    void appContextsListEnvelope() {
        AppContextPage page = Smoke.live().auth().listAppContexts(
            ListAppContextsRequest.builder().limit(5L).build());
        assertNotNull(page);
        // getData()/getNextCursor() are the envelope accessors; both must exist.
        assertNotNull(page.getData());
        assertNotNull(page.getNextCursor());
    }

    @Test
    void scopedKeysListEnvelope() {
        var page = Smoke.live().auth().listScopedKeys();
        assertNotNull(page);
        assertNotNull(page.getData());
        assertNotNull(page.getNextCursor());
    }

    @Test
    void recordsListEnvelope() {
        var page = Smoke.live().records().listRecords(
            ListRecordsRequest.builder().type("any").limit(5L).build());
        assertNotNull(page);
        assertNotNull(page.getData());
        assertNotNull(page.getNextCursor());
    }

    @Test
    void accessProfilesListEnvelope() {
        // access profiles are listed per-context; the default context always exists.
        var page = Smoke.live().auth().listAccessProfiles("default",
            ListAccessProfilesRequest.builder().limit(5L).build());
        assertNotNull(page);
        assertNotNull(page.getData());
        assertNotNull(page.getNextCursor());
    }

    @Test
    void nextCursorPaginatesWhenPresent() {
        VectrosApiClient c = Smoke.live();
        AppContextPage first = c.auth().listAppContexts(ListAppContextsRequest.builder().limit(1L).build());
        if (first.getNextCursor().isPresent()) {
            AppContextPage second = c.auth().listAppContexts(
                ListAppContextsRequest.builder().limit(1L).startFrom(first.getNextCursor().get()).build());
            assertNotNull(second.getData());
        }
    }
}
