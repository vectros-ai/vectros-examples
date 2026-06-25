package ai.vectros.smoke;

import ai.vectros.VectrosApiClient;
import ai.vectros.types.ChatMessage;
import ai.vectros.types.ChatMessageRole;
import ai.vectros.types.ChatStreamEvent;
import ai.vectros.types.DoneEvent;
import ai.vectros.types.RagSearch;
import ai.vectros.types.RagSearchMode;
import ai.vectros.types.RagStreamEvent;
import ai.vectros.types.ScopeRequest;
import ai.vectros.resources.inference.requests.ChatRequest;
import ai.vectros.resources.inference.requests.RagRequest;
import ai.vectros.resources.auth.requests.TokenRequest;

import java.util.List;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/**
 * POST /v1/chat streaming inference plus a RAG round-trip. Verifies the streamed
 * event sequence (content_delta+ then exactly one done), the split-billing fields
 * on the done payload, and
 * scope enforcement. The Fern Java SDK exposes streaming as an Iterable of
 * discriminated-union events (Stream.fromSseWithEventDiscrimination).
 */
class ChatSmokeTest {

    private static ChatMessage msg(ChatMessageRole role, String content) {
        return ChatMessage.builder().role(role).content(content).build();
    }

    private static String joinDeltas(Iterable<ChatStreamEvent> events) {
        StringBuilder sb = new StringBuilder();
        for (ChatStreamEvent e : events) {
            if (e.isContentDelta()) sb.append(e.getContentDelta().get().getDelta());
        }
        return sb.toString();
    }

    // ANCHOR — streaming chat returns deltas then a done event with billing fields.
    @Test
    void chatStreamDeltasThenDoneWithBilling() {
        int deltas = 0, dones = 0, errors = 0;
        DoneEvent done = null;
        for (ChatStreamEvent e : Smoke.live().inference().chatInference(ChatRequest.builder()
                .messages(List.of(msg(ChatMessageRole.USER, "Say \"hello smoke test\" exactly, no more.")))
                .maxTokens(32).build())) {
            if (e.isContentDelta()) deltas++;
            else if (e.isDone()) { dones++; done = e.getDone().get(); }
            else if (e.isError()) errors++;
        }
        assertTrue(deltas > 0, "expected >=1 content_delta");
        assertEquals(1, dones, "expected exactly one done event");
        assertEquals(0, errors);
        assertNotNull(done);
        assertTrue(done.getInputTokens() > 0);
        assertTrue(done.getOutputTokens() > 0);
        assertNotNull(done.getModel());
        assertTrue(done.getPlatformCreditsCharged() > 0);
    }

    @Test
    void chatSystemMessageIsHonored() {
        String marker = "SMOKE_SYS_PROBE";
        var events = collect(Smoke.live().inference().chatInference(ChatRequest.builder()
            .messages(List.of(
                msg(ChatMessageRole.SYSTEM, "Always begin your response with the literal string \"" + marker + "\"."),
                msg(ChatMessageRole.USER, "Briefly state today is a good day.")))
            .maxTokens(60).build()));
        assertEquals(1, count(events, ChatStreamEvent::isDone));
        assertTrue(joinDeltas(events).contains(marker));
    }

    @Test
    void chatExplicitModelRoutes() {
        var events = collect(Smoke.live().inference().chatInference(ChatRequest.builder()
            .messages(List.of(msg(ChatMessageRole.USER, "Reply with one word: ok")))
            .model("claude-haiku-4-5").maxTokens(8).build()));
        var dones = events.stream().filter(ChatStreamEvent::isDone).toList();
        assertEquals(1, dones.size());
        assertTrue(dones.get(0).getDone().get().getModel().contains("haiku"));
    }

    @Test
    void chatWithoutInferenceScopeIs403() {
        var minted = Smoke.live().auth().mintToken(TokenRequest.builder()
            .scope(ScopeRequest.builder().allowedActions(List.of("records:r")).build()).build());
        VectrosApiClient scoped = Smoke.client(minted.getToken());
        Smoke.expectStatus(() -> {
            for (ChatStreamEvent ignored : scoped.inference().chatInference(ChatRequest.builder()
                    .messages(List.of(msg(ChatMessageRole.USER, "hi"))).maxTokens(8).build())) {
                // force the stream to open
            }
        }, 403);
    }

    @Test
    void ragRoundTrip() {
        int deltas = 0, dones = 0, errors = 0;
        for (RagStreamEvent e : Smoke.live().inference().ragInference(RagRequest.builder()
                .query("What is a smoke test?")
                .search(RagSearch.builder().mode(RagSearchMode.HYBRID).limit(3).build())
                .maxTokens(48).build())) {
            if (e.isContentDelta()) deltas++;
            else if (e.isDone()) dones++;
            else if (e.isError()) errors++;
        }
        assertEquals(0, errors);
        assertEquals(1, dones);
        assertTrue(deltas > 0, "RAG must stream at least one content_delta");
    }

    private static List<ChatStreamEvent> collect(Iterable<ChatStreamEvent> it) {
        var l = new java.util.ArrayList<ChatStreamEvent>();
        for (ChatStreamEvent e : it) l.add(e);
        return l;
    }

    private static long count(List<ChatStreamEvent> events, java.util.function.Predicate<ChatStreamEvent> p) {
        return events.stream().filter(p).count();
    }
}
