package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.core.VectrosApiApiException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

import okhttp3.Interceptor;
import okhttp3.OkHttpClient;
import okhttp3.Response;

import org.junit.jupiter.api.function.Executable;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Shared support for the Java SDK smoke suite — the Java-language analogue of
 * the node SDK smoke. Installs the published `ai.vectros:vectros-sdk` and drives
 * it against the live API, proving the cross-language wire contract that mock
 * unit tests cannot.
 *
 * AUTH MODEL: like the node SDK smoke, the SDK is constructed directly with an
 * API key (sk_*) — how you use the SDK. The suite reads VECTROS_API_KEY /
 * VECTROS_API_BASE_URL / VECTROS_LIVE_TENANT_ID from your environment.
 */
final class Smoke {
    private Smoke() {}

    // -------------------------------------------------------------------
    // Rate-limit visibility (gotcha-sdk-silent-429-retry-masks-load-only-
    // flakes). Same mechanism as smoke-tests/src/rateLimitFetch.ts and its
    // Python port in smoke-tests/sdk-python/support.py: the partner API's
    // rate limiter is a SHARED, per-tenant, 60s fixed-window counter, so a
    // full-suite run can trip it even though no single test is at fault.
    // Left alone, the SDK's own default retry pays the Retry-After wait
    // SILENTLY inside one call — invisible to a test's own assertions, and
    // (measured while porting test_namespaces.py's membership-revocation
    // test to Python) able to shift a request's real send time late enough
    // to observe a state a promptly-sent request wouldn't have. This
    // OkHttp interceptor pays the same wait but VISIBLY (printed, bounded
    // to 3 attempts) instead of the SDK's opaque retry.
    // -------------------------------------------------------------------
    private static final int MAX_RATE_LIMIT_ATTEMPTS = 3;

    private static final Interceptor RATE_LIMIT_AWARE_INTERCEPTOR = chain -> {
        okhttp3.Request request = chain.request();
        Response response = chain.proceed(request);
        for (int attempt = 1; response.code() == 429 && attempt < MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
            String retryAfter = response.header("Retry-After");
            long waitMs;
            try {
                waitMs = retryAfter != null ? Long.parseLong(retryAfter) * 1000L : 60_000L;
            } catch (NumberFormatException nfe) {
                waitMs = 60_000L; // rate limiter's window is 60s — fall back to it, not a guess
            }
            System.out.println("[rate-limit] 429 from " + request.url() + " (attempt " + attempt
                + "/" + MAX_RATE_LIMIT_ATTEMPTS + ") -- waiting " + waitMs + "ms per Retry-After before retrying");
            response.close();
            sleep(waitMs);
            response = chain.proceed(request);
        }
        return response;
    };

    private static OkHttpClient rateLimitAwareHttpClient() {
        return new OkHttpClient.Builder().addInterceptor(RATE_LIMIT_AWARE_INTERCEPTOR).build();
    }

    static String env(String name) {
        String v = System.getenv(name);
        if (v == null || v.isEmpty()) {
            throw new IllegalStateException(name + " is required — set it in your environment");
        }
        return v;
    }

    static String optEnv(String name) {
        String v = System.getenv(name);
        return (v == null || v.isEmpty()) ? null : v;
    }

    static String baseUrl() {
        String u = env("VECTROS_API_BASE_URL");
        return u.endsWith("/") ? u.substring(0, u.length() - 1) : u;
    }

    /**
     * A VectrosApiClient bound to `token` and the configured base URL, with the
     * rate-limit-aware interceptor above and maxRetries(0) — same reasoning as
     * rateLimitFetch.ts's own doc: the latter stops the SDK from retrying again
     * on top of what the interceptor already resolved (or gave up on), which
     * would silently double the wait.
     */
    static VectrosApiClient client(String token) {
        return VectrosApiClient.builder().token(token).url(baseUrl())
            .maxRetries(0).httpClient(rateLimitAwareHttpClient()).build();
    }

    /** The LIVE-tenant root client most tests use. */
    static VectrosApiClient live() {
        return client(env("VECTROS_API_KEY"));
    }

    static String uniqueTag() {
        String rnd = Long.toString(Math.abs(ThreadLocalRandom.current().nextLong()), 36);
        return "smoke-" + System.currentTimeMillis() + "-" + rnd.substring(0, Math.min(5, rnd.length()));
    }

    /** `prefix + uniqueTag()`, truncated to `maxLen` — uniqueTag()'s own length
     * varies (its random suffix is 0-5 chars), so a bare substring(0, maxLen)
     * throws whenever the combined string is SHORTER than maxLen. */
    static String slug(String prefix, int maxLen) {
        String s = prefix + uniqueTag();
        return s.substring(0, Math.min(maxLen, s.length()));
    }

    /** {@link #slug(String, int)} at the 31-char cap most id fields share. */
    static String slug(String prefix) {
        return slug(prefix, 31);
    }

    /** HTTP status from a Fern ApiError, else -1. */
    static int statusOf(Throwable t) {
        return (t instanceof VectrosApiApiException e) ? e.statusCode() : -1;
    }

    /** Asserts `e` throws a Fern ApiError carrying the given HTTP status. */
    static void expectStatus(Executable e, int status) {
        VectrosApiApiException ex = assertThrows(VectrosApiApiException.class, e);
        assertEquals(status, ex.statusCode(),
            "expected HTTP " + status + " but got " + ex.statusCode() + " (" + ex.getMessage() + ")");
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }

    // -----------------------------------------------------------------------
    // Raw HTTP (error-contract spec — deliberately NOT the SDK; the typed
    // surface would reject these malformed bodies at call time).
    // -----------------------------------------------------------------------
    record RawResponse(int status, String body) {}

    static RawResponse rawPost(String path, String body) throws Exception {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build();
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl() + path))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + env("VECTROS_API_KEY"))
            .timeout(Duration.ofSeconds(30))
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
        return new RawResponse(resp.statusCode(), resp.body());
    }
}
