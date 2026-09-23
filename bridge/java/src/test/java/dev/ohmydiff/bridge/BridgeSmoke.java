package dev.ohmydiff.bridge;

import java.nio.file.Path;
import java.time.Duration;

public final class BridgeSmoke {
    public static void main(String[] arguments) throws Exception {
        try (BridgeClient client = new BridgeClient(
                Path.of(arguments[0]),
                new BridgeClient.Application("java", "java", "1".repeat(64), "repro-1"))) {
            client.expose("health", () -> "{\"ready\":true,\"secret\":\"java-secret\"}");
            client.connect();
            client.event("error", "error", "java-fixture", "{\"token\":\"java-token\"}");
            client.startPolling(Duration.ofMillis(20));
            Thread.sleep(5000);
        }
    }
}
