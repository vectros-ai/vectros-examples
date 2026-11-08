package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.core.ObjectMappers;
import ai.vectros.resources.inference.requests.ChatRequest;
import ai.vectros.resources.inference.requests.DocumentAskRequest;
import ai.vectros.resources.inference.requests.RagRequest;
import ai.vectros.types.ChatMessage;
import ai.vectros.types.ChatMessageRole;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * What the SDK's stream decoder does with an event or field it does not know.
 *
 * <p>The API adds event types and fields over time, and a client written today must keep working
 * when the stream carries one it has never seen. This replays raw server-sent-event streams
 * (fixtures/sse-tolerance/scenarios.json, shared with the TypeScript and Python SDK suites) through
 * the REAL generated decoder of the installed SDK and pins the outcome: which events are delivered,
 * whether an unknown field survives on a known event, and whether the call throws. The decoder is
 * generated code, so a generator or SDK upgrade can change this silently; a change here is a change
 * customers will see.
 *
 * <p>Offline: a loopback server stands in for the API, so it needs no credentials and no network.
 *
 * <p>To re-measure after an intended change, run with -Dtolerance.record=true: it prints the actual
 * outcome of every scenario as JSON instead of asserting, and the result is pasted into the fixture
 * file's {@code expect.java} entries.
 *
 * <p>An event is described by serializing it with the SDK's own JSON mapper, so a delivered event
 * is named by its {@code type} and an event the SDK has no class for (which it delivers as an
 * opaque value that serializes to {@code null}) is named {@code "?"}. Whether an unknown field
 * survived is read from the typed event's {@code getAdditionalProperties()}.
 */
class StreamToleranceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final boolean RECORD = Boolean.getBoolean("tolerance.record");
    private static final Map<String, Map<String, Object>> RECORDED = new LinkedHashMap<>();
    private static final Map<String, String> ROUTES =
            Map.of("chat", "/v1/chat", "rag", "/v1/rag", "document-ask", "/v1/documents/doc-1/ask");

    /**
     * One test per scenario. The shared fixtures live beside this suite in the repository. A checkout
     * that carries only this module (the published examples) has none: the suite then reports one skipped
     * test saying so. Inside the repository (recognised by the example assembler beside the smoke tests)
     * a missing fixture is a failure.
     */
    @TestFactory
    Stream<DynamicTest> streamTolerance() throws IOException {
        Path file = Path.of("..", "fixtures", "sse-tolerance", "scenarios.json");
        if (!Files.exists(file)) {
            boolean inRepository = Files.exists(Path.of("..", "..", "pipelines", "examples-assemble.sh"));
            return Stream.of(DynamicTest.dynamicTest("fixtures", () -> {
                if (inRepository) fail("the shared stream fixtures are missing from this repository checkout: " + file);
                assumeTrue(false, "the shared stream fixtures are not part of this checkout, so there is nothing to replay");
            }));
        }
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode scenario : JSON.readTree(Files.readString(file)).get("scenarios")) {
            String id = scenario.get("id").asText();
            tests.add(DynamicTest.dynamicTest(id, () -> {
                Map<String, Object> actual = run(scenario);
                if (RECORD) {
                    RECORDED.put(id, actual);
                    return;
                }
                JsonNode expected = scenario.get("expect").get("java");
                if (expected == null || expected.isNull()) {
                    fail(id + ": no pinned outcome; record one with -Dtolerance.record=true");
                }
                assertEquals(expected, JSON.valueToTree(actual), id);
            }));
        }
        return tests.stream();
    }

    @AfterAll
    static void printRecording() throws Exception {
        if (RECORD) System.out.println("TOLERANCE_RECORD java " + JSON.writeValueAsString(RECORDED));
    }

    // -----------------------------------------------------------------------------------------

    /** Whether any write boundary falls inside a multi-byte UTF-8 character (on a continuation byte). */
    private static boolean splitsInsideCharacter(byte[] raw, int size) {
        for (int i = size; i < raw.length; i += size) if ((raw[i] & 0xC0) == 0x80) return true;
        return false;
    }

    private static Map<String, Object> run(JsonNode scenario) throws Exception {
        if (scenario.path("splitsMultiByte").asBoolean(false)) {
            // The scenario exists to cut a character across writes: fail loudly if its chunking does not.
            StringBuilder all = new StringBuilder();
            scenario.get("chunks").forEach(c -> all.append(c.asText()));
            byte[] raw = all.toString().getBytes(StandardCharsets.UTF_8);
            assertTrue(splitsInsideCharacter(raw, scenario.path("chunkBytes").asInt(raw.length)), "chunking cuts no multi-byte character");
        }
        try (LoopbackServer server = new LoopbackServer(scenario)) {
            // maxRetries 0: this suite measures the decoder, not the SDK's retry policy.
            VectrosApiClient client = VectrosApiClient.builder()
                    .url("http://127.0.0.1:" + server.port())
                    .token("unused")
                    .maxRetries(0)
                    .build();
            List<String> delivered = new ArrayList<>();
            List<Object> events = new ArrayList<>();
            StringBuilder text = new StringBuilder();
            String error = null;
            try {
                for (Object ev : open(client, scenario.get("route").asText())) {
                    JsonNode node = JSON.readTree(ev == null ? "null" : ObjectMappers.JSON_MAPPER.writeValueAsString(ev));
                    delivered.add(ev == null ? "<null>" : node.hasNonNull("type") ? node.get("type").asText() : "?");
                    if (node.hasNonNull("type") && "content_delta".equals(node.get("type").asText())) {
                        text.append(node.path("delta").asText());
                    }
                    events.add(ev);
                }
            } catch (Exception e) {
                error = e.getClass().getSimpleName();
            }
            // true or false for whether the field survived on that delivered event; null when none was delivered.
            // An unknown member has no type to match, so a probe never selects it.
            List<Boolean> probes = new ArrayList<>();
            if (scenario.has("probes")) {
                for (JsonNode p : scenario.get("probes")) {
                    int seen = 0;
                    Boolean result = null;
                    for (int i = 0; i < events.size() && result == null; i++) {
                        if (!p.get("event").asText().equals(delivered.get(i))) continue;
                        if (seen++ == p.get("nth").asInt()) result = hasAdditionalProperty(events.get(i), p.get("field").asText());
                    }
                    probes.add(result);
                }
            }
            Map<String, Object> outcome = new LinkedHashMap<>();
            outcome.put("delivered", delivered);
            outcome.put("text", text.toString());
            outcome.put("probes", probes);
            outcome.put("error", error);
            return outcome;
        }
    }

    /**
     * Whether the delivered union holds a typed event whose getAdditionalProperties() carries the field.
     * An event the SDK has no class for (an unknown member) holds nothing to read, so it has none.
     */
    private static boolean hasAdditionalProperty(Object union, String field) {
        if (union == null) return false;
        try {
            Method unknown = union.getClass().getMethod("_isUnknown");
            if ((Boolean) unknown.invoke(union)) return false;
            Field wrapper = union.getClass().getDeclaredField("value");
            wrapper.setAccessible(true);
            Object member = wrapper.get(union);
            Field typedField = member.getClass().getDeclaredField("value");
            typedField.setAccessible(true);
            Object typed = typedField.get(member);
            Object extras = typed.getClass().getMethod("getAdditionalProperties").invoke(typed);
            return ((Map<?, ?>) extras).containsKey(field);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("the generated union no longer has the shape this test reads: " + e, e);
        }
    }

    private static Iterable<?> open(VectrosApiClient client, String route) {
        switch (route) {
            case "chat":
                return client.inference().chatInference(ChatRequest.builder()
                        .messages(List.of(ChatMessage.builder().role(ChatMessageRole.USER).content("hi").build()))
                        .build());
            case "rag":
                return client.inference().ragInference(RagRequest.builder().query("q").build());
            default:
                return client.inference().documentAsk("doc-1", DocumentAskRequest.builder().prompt("q").build());
        }
    }

    /** A one-connection HTTP server that answers the scenario's route with its raw, chunked stream. */
    private static final class LoopbackServer implements AutoCloseable {
        private final ServerSocket socket;
        private final Thread thread;

        LoopbackServer(JsonNode scenario) throws IOException {
            this.socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
            this.thread = new Thread(() -> serve(scenario), "stream-tolerance-server");
            this.thread.setDaemon(true);
            this.thread.start();
        }

        int port() {
            return socket.getLocalPort();
        }

        private void serve(JsonNode scenario) {
            try (Socket conn = socket.accept()) {
                InputStream in = conn.getInputStream();
                OutputStream out = conn.getOutputStream();
                String head = readHead(in);
                String requestLine = head.substring(0, head.indexOf("\r\n"));
                int length = 0;
                for (String line : head.split("\r\n")) {
                    if (line.toLowerCase().startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                }
                in.readNBytes(length);
                if (!requestLine.startsWith("POST " + ROUTES.get(scenario.get("route").asText()) + " ")) {
                    byte[] body = "{\"message\":\"unexpected route\"}".getBytes(StandardCharsets.UTF_8);
                    out.write(("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n")
                            .getBytes(StandardCharsets.UTF_8));
                    out.write(body);
                    out.flush();
                    return;
                }
                out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                        .getBytes(StandardCharsets.UTF_8));
                for (byte[] piece : pieces(scenario)) {
                    out.write((Integer.toHexString(piece.length) + "\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(piece);
                    out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    Thread.sleep(2);
                }
                if (!"abrupt".equals(scenario.get("close").asText())) {
                    out.write("0\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
                // Leaving the try closes the socket: for "abrupt" that cuts the response with no terminating chunk.
            } catch (IOException | InterruptedException ignored) {
                // The client may hang up first (an abrupt scenario); nothing to report.
            }
        }

        private static List<byte[]> pieces(JsonNode scenario) {
            List<byte[]> out = new ArrayList<>();
            if (scenario.has("chunkBytes")) {
                StringBuilder all = new StringBuilder();
                scenario.get("chunks").forEach(c -> all.append(c.asText()));
                byte[] raw = all.toString().getBytes(StandardCharsets.UTF_8);
                int size = scenario.get("chunkBytes").asInt();
                for (int i = 0; i < raw.length; i += size) out.add(java.util.Arrays.copyOfRange(raw, i, Math.min(raw.length, i + size)));
            } else {
                scenario.get("chunks").forEach(c -> out.add(c.asText().getBytes(StandardCharsets.UTF_8)));
            }
            return out;
        }

        private static String readHead(InputStream in) throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            int state = 0;
            while (state < 4) {
                int b = in.read();
                if (b < 0) break;
                buf.write(b);
                state = (b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3)) ? state + 1 : (b == '\r' ? 1 : 0);
            }
            return buf.toString(StandardCharsets.UTF_8);
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }
}
