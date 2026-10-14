package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.resources.inference.requests.ChatRequest;
import ai.vectros.types.ChatMessage;
import ai.vectros.types.ChatMessageRole;
import ai.vectros.types.ChatStreamEvent;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;
import okio.Okio;
import okio.Source;
import okio.Timeout;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * The streaming inference routes may interleave SSE comment lines (a line that
 * starts with a colon) with events. A comment never dispatches an event, so a
 * reader must yield exactly the same events with and without them.
 *
 * Needs no credentials and no network: a local HTTP server serves a canned event
 * stream and the real SDK stream reader is driven against it, with comment
 * frames before the first event, between events, and right before {@code done}.
 */
class SseCommentFramesTest {

    private static final String COMMENT = ": keepalive\n\n";

    private static String frame(String type, String fields) {
        return "event: " + type + "\ndata: {\"type\":\"" + type + "\",\"event\":\"" + type + "\"" + fields + "}\n\n";
    }

    private static final List<String> EVENT_FRAMES = List.of(
        frame("content_delta", ",\"delta\":\"Hello, \""),
        frame("content_delta", ",\"delta\":\"world\""),
        frame("done", ",\"inputTokens\":11,\"outputTokens\":7,\"model\":\"m\","
            + "\"platformCreditsCharged\":0,\"inferenceBalanceCentsCharged\":0"));

    private static final List<String> WITH_COMMENTS = List.of(
        COMMENT, EVENT_FRAMES.get(0), COMMENT, COMMENT, EVENT_FRAMES.get(1), COMMENT, EVENT_FRAMES.get(2));

    /** Serves {@code chunks} as one SSE response, runs the real SDK reader over it, returns the event kinds and text. */
    private static List<String> summarize(List<String> chunks) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.getResponseHeaders().set("Cache-Control", "no-cache");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                for (String chunk : chunks) {
                    out.write(chunk.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
            }
        });
        server.start();
        try {
            VectrosApiClient client = VectrosApiClient.builder()
                .token("sk_test").url("http://127.0.0.1:" + server.getAddress().getPort()).maxRetries(0).build();
            return summarize(client);
        } finally {
            server.stop(0);
        }
    }

    private static List<String> summarize(VectrosApiClient client) {
        List<String> seen = new ArrayList<>();
        for (ChatStreamEvent e : client.inference().chatInference(ChatRequest.builder()
                .messages(List.of(ChatMessage.builder().role(ChatMessageRole.USER).content("hi").build()))
                .maxTokens(16).build())) {
            if (e.isContentDelta()) seen.add("content_delta:" + e.getContentDelta().get().getDelta());
            else if (e.isDone()) seen.add("done");
            else if (e.isError()) seen.add("error");
            else seen.add("other");
        }
        return seen;
    }

    /** The stream delivered as exactly these reads (no socket), so a split lands where the test says. */
    private static List<String> summarizeInPieces(List<String> pieces) {
        Source source = new Source() {
            private int next = 0;
            @Override public long read(Buffer sink, long byteCount) {
                if (next >= pieces.size()) return -1;
                byte[] bytes = pieces.get(next++).getBytes(StandardCharsets.UTF_8);
                sink.write(bytes);
                return bytes.length;
            }
            @Override public Timeout timeout() { return Timeout.NONE; }
            @Override public void close() { }
        };
        BufferedSource buffered = Okio.buffer(source);
        OkHttpClient http = new OkHttpClient.Builder().addInterceptor(chain -> new Response.Builder()
            .request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .header("Content-Type", "text/event-stream")
            .body(ResponseBody.create(MediaType.get("text/event-stream"), -1, buffered)).build()).build();
        VectrosApiClient client = VectrosApiClient.builder()
            .token("sk_test").url("http://stub.invalid").maxRetries(0).httpClient(http).build();
        return summarize(client);
    }

    private static List<String> inPiecesOf(int size, String text) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < text.length(); i += size) out.add(text.substring(i, Math.min(text.length(), i + size)));
        return out;
    }

    @Test
    void commentFramesDoNotChangeTheEventSequence() throws IOException {
        List<String> baseline = summarize(EVENT_FRAMES);
        assertEquals(List.of("content_delta:Hello, ", "content_delta:world", "done"), baseline);
        assertEquals(baseline, summarize(WITH_COMMENTS));
    }

    @Test
    void aStreamOfCommentsThenDoneCompletes() throws IOException {
        assertEquals(List.of("done"), summarize(List.of(COMMENT, COMMENT, EVENT_FRAMES.get(2))));
    }

    @Test
    void commentFramesSplitAcrossReadsAtAnyByteAreStillIgnored() throws IOException {
        List<String> baseline = summarizeInPieces(EVENT_FRAMES);
        assertEquals(List.of("content_delta:Hello, ", "content_delta:world", "done"), baseline);
        String wire = String.join("", WITH_COMMENTS);
        // size 1 puts the colon, the text and each newline of a comment in separate reads; 13 is the comment's own length
        for (int size : new int[] {1, 2, 3, 7, 13}) {
            assertEquals(baseline, summarizeInPieces(inPiecesOf(size, wire)), "read size " + size);
        }
        // the blank line that ends a comment arriving on its own, after the comment text
        assertEquals(baseline, summarizeInPieces(List.of(": keepalive\n", "\n", EVENT_FRAMES.get(0), EVENT_FRAMES.get(1),
            ": keep", "alive\n\n", EVENT_FRAMES.get(2))));
    }
}
