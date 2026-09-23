package dev.ohmydiff.bridge;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class BridgeClient implements AutoCloseable {
    public static final class Application {
        private final String id;
        private final String adapter;
        private final String versionSha256;
        private final String reproductionId;

        public Application(String id, String adapter, String versionSha256, String reproductionId) {
            this.id = id;
            this.adapter = adapter;
            this.versionSha256 = versionSha256;
            this.reproductionId = reproductionId;
        }

        public String id() { return id; }
        public String adapter() { return adapter; }
        public String versionSha256() { return versionSha256; }
        public String reproductionId() { return reproductionId; }
    }

    private static final Pattern URL = Pattern.compile("\\\"url\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
    private static final Pattern TOKEN = Pattern.compile("\\\"token\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
    private static final Pattern INSTANCE = Pattern.compile("\\\"instance_id\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
    private static final Pattern COMMAND = Pattern.compile("\\{\\\"type\\\":\\\"state\\\",\\\"request_id\\\":\\\"([^\\\"]+)\\\",\\\"name\\\":\\\"([^\\\"]+)\\\"\\}");
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final String url;
    private final String token;
    private final Application application;
    private final Map<String, Supplier<String>> handlers = new LinkedHashMap<>();
    private String instanceId;
    private volatile boolean stopping;
    private Thread polling;

    public BridgeClient(Path connectionFile, Application application) throws IOException {
        String connection = Files.readString(connectionFile, StandardCharsets.UTF_8);
        this.url = extract(URL, connection, "url");
        this.token = extract(TOKEN, connection, "token");
        this.application = application;
    }

    public BridgeClient expose(String name, Supplier<String> handler) {
        if (instanceId != null) throw new IllegalStateException("state handlers must be exposed before connect");
        handlers.put(name, handler);
        return this;
    }

    public String connect() throws IOException, InterruptedException {
        if (instanceId == null) {
            String states = handlers.keySet().stream().map(BridgeClient::quote).reduce((a, b) -> a + "," + b).orElse("");
            instanceId = extract(INSTANCE, post("/v1/register", base() + ",\"exposed_state\":[" + states + "]}"), "instance_id");
        }
        return instanceId;
    }

    public void event(String kind, String level, String message, String dataJson) throws IOException, InterruptedException {
        requireConnected();
        post("/v1/event", body() + ",\"kind\":" + quote(kind) + ",\"level\":" + nullable(level) + ",\"message\":" + quote(message) + ",\"data\":" + (dataJson == null ? "null" : dataJson) + "}");
    }

    public void poll() throws IOException, InterruptedException {
        requireConnected();
        String response = post("/v1/poll", body() + "}");
        Matcher matcher = COMMAND.matcher(response);
        while (matcher.find()) {
            Supplier<String> handler = handlers.get(matcher.group(2));
            String result;
            try {
                result = handler == null ? ",\"error\":\"state handler unavailable\"" : ",\"value\":" + handler.get();
            } catch (RuntimeException error) {
                result = ",\"error\":" + quote(error.getMessage());
            }
            post("/v1/state", body() + ",\"request_id\":" + quote(matcher.group(1)) + result + "}");
        }
    }

    public void startPolling(Duration interval) {
        requireConnected();
        if (polling != null) return;
        stopping = false;
        polling = new Thread(() -> {
            while (!stopping) {
                try { poll(); } catch (Exception ignored) {}
                try { Thread.sleep(Math.max(1, interval.toMillis())); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
            }
        }, "omd-bridge");
        polling.setDaemon(true);
        polling.start();
    }

    @Override
    public void close() throws IOException, InterruptedException {
        stopping = true;
        if (polling != null) {
            polling.interrupt();
            polling.join(2000);
            polling = null;
        }
        if (instanceId != null) {
            post("/v1/disconnect", body() + "}");
            instanceId = null;
        }
    }

    private String post(String route, String body) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url + route)).timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) throw new IOException(response.body());
        return response.body();
    }

    private String base() {
        return "{\"token\":" + quote(token) + ",\"app_id\":" + quote(application.id()) + ",\"adapter\":" + quote(application.adapter()) + ",\"version_sha256\":" + quote(application.versionSha256()) + ",\"reproduction_id\":" + quote(application.reproductionId());
    }

    private String body() {
        return base() + ",\"instance_id\":" + quote(instanceId);
    }

    private void requireConnected() {
        if (instanceId == null) throw new IllegalStateException("bridge client is not connected");
    }

    private static String extract(Pattern pattern, String text, String field) throws IOException {
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) throw new IOException("bridge response omitted " + field);
        return matcher.group(1);
    }

    private static String nullable(String value) {
        return value == null ? "null" : quote(value);
    }

    private static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (char character : value.toCharArray()) {
            switch (character) {
                case '\\': result.append("\\\\"); break;
                case '"': result.append("\\\""); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default: result.append(character < 0x20 ? String.format("\\u%04x", (int) character) : character);
            }
        }
        return result.append('"').toString();
    }
}
