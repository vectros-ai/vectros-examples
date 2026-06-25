package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.core.VectrosApiApiException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

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

    /** A VectrosApiClient bound to `token` and the configured base URL. */
    static VectrosApiClient client(String token) {
        return VectrosApiClient.builder().token(token).url(baseUrl()).build();
    }

    /** The LIVE-tenant root client most tests use. */
    static VectrosApiClient live() {
        return client(env("VECTROS_API_KEY"));
    }

    static String uniqueTag() {
        String rnd = Long.toString(Math.abs(ThreadLocalRandom.current().nextLong()), 36);
        return "smoke-" + System.currentTimeMillis() + "-" + rnd.substring(0, Math.min(5, rnd.length()));
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
