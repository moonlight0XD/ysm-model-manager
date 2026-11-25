package tw.ysmmanager.ysmshot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.commands.SharedSuggestionProvider;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.loading.FMLPaths;
import org.slf4j.Logger;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * 只監聽 127.0.0.1 的小型 HTTP 伺服器，給 YSM 模型管理器呼叫。
 * 連線資訊（埠號與隨機 token）寫在 config/ysmshot.json，只有本機程式讀得到。
 *
 * GET  /status  → {"ok":true,"inWorld":..,"paused":..,"player":..,"mc":..}
 * POST /shot    {"command":"ysm model set @s xxx - true","waitTicks":40,"size":768,"zoom":1,"yaw":0}
 *               → image/png（透明背景，只有玩家角色）
 */
final class ClientBridge {
    private static final Logger LOG = LogUtils.getLogger();
    private static final int MAX_BODY = 64 * 1024;
    private static boolean started;
    private static String token;
    private static Path configFile;
    private static final List<String> MESSAGES = new ArrayList<>();
    private static volatile boolean COLLECTING;

    private ClientBridge() {}

    static synchronized void start() {
        if (started) return;
        started = true;
        MinecraftForge.EVENT_BUS.addListener(ClientBridge::onChat);
        try {
            // 明確用 IPv4 127.0.0.1（Minecraft 啟動時偏好 IPv6，getLoopbackAddress() 會變成 ::1）
            ServerSocket server = new ServerSocket(0, 8, InetAddress.getByAddress(new byte[]{127, 0, 0, 1}));
            byte[] raw = new byte[24];
            new SecureRandom().nextBytes(raw);
            token = HexFormat.of().formatHex(raw);

            configFile = FMLPaths.CONFIGDIR.get().resolve("ysmshot.json");
            JsonObject info = new JsonObject();
            info.addProperty("port", server.getLocalPort());
            info.addProperty("token", token);
            info.addProperty("pid", ProcessHandle.current().pid());
            info.addProperty("protocol", 1);
            Files.createDirectories(configFile.getParent());
            Files.writeString(configFile, info.toString(), StandardCharsets.UTF_8);

            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try {
                    // 只刪除自己寫的檔案（避免刪掉另一個同時開著的遊戲寫的）
                    if (Files.readString(configFile).contains(token)) Files.deleteIfExists(configFile);
                } catch (IOException ignored) {
                }
            }, "YsmShot-Cleanup"));

            Thread t = new Thread(() -> acceptLoop(server), "YsmShot-Bridge");
            t.setDaemon(true);
            t.start();
            LOG.info("[YSM Shot] bridge listening on 127.0.0.1:{}", server.getLocalPort());
        } catch (Exception e) {
            LOG.error("[YSM Shot] failed to start bridge", e);
        }
    }

    private static void acceptLoop(ServerSocket server) {
        while (!server.isClosed()) {
            try (Socket s = server.accept()) {
                // 一次處理一個請求：截圖本來就必須依序進行
                s.setSoTimeout(15000);
                handle(s);
            } catch (Exception e) {
                LOG.warn("[YSM Shot] request failed: {}", e.toString());
            }
        }
    }

    private static void handle(Socket s) throws IOException {
        InputStream in = new BufferedInputStream(s.getInputStream());
        OutputStream out = s.getOutputStream();
        String requestLine = readLine(in);
        if (requestLine == null || requestLine.isEmpty()) return;
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
            sendJson(out, 400, error("bad request"));
            return;
        }
        String method = parts[0].toUpperCase(Locale.ROOT);
        String path = parts[1];
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);

        Map<String, String> headers = new HashMap<>();
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            int c = line.indexOf(':');
            if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.ROOT), line.substring(c + 1).trim());
        }
        int len = 0;
        try {
            len = Integer.parseInt(headers.getOrDefault("content-length", "0"));
        } catch (NumberFormatException ignored) {
        }
        if (len < 0 || len > MAX_BODY) {
            sendJson(out, 413, error("body too large"));
            return;
        }
        byte[] body = in.readNBytes(len);

        String given = headers.getOrDefault("x-ysmshot-token", "");
        if (!MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8))) {
            sendJson(out, 403, error("bad token"));
            return;
        }

        try {
            if ("GET".equals(method) && "/status".equals(path)) {
                sendJson(out, 200, status());
            } else if ("POST".equals(method) && "/shot".equals(path)) {
                shot(out, body);
            } else if ("POST".equals(method) && "/suggest".equals(path)) {
                sendJson(out, 200, suggest(body));
            } else {
                sendJson(out, 404, error("not found"));
            }
        } catch (Exception e) {
            LOG.warn("[YSM Shot] {} {} failed", method, path, e);
            sendJson(out, 500, error(e.toString()));
        }
    }

    private static JsonObject status() throws Exception {
        Minecraft mc = Minecraft.getInstance();
        return mc.submit(() -> {
            JsonObject o = new JsonObject();
            o.addProperty("ok", true);
            o.addProperty("mod", YsmShot.MOD_ID);
            o.addProperty("protocol", 1);
            o.addProperty("mc", SharedConstants.getCurrentVersion().getName());
            o.addProperty("inWorld", mc.player != null && mc.level != null);
            o.addProperty("paused", mc.isPaused());
            o.addProperty("pauseOnLostFocus", mc.options.pauseOnLostFocus);
            o.addProperty("singleplayer", mc.hasSingleplayerServer());
            if (mc.player != null) o.addProperty("player", mc.player.getGameProfile().getName());
            return o;
        }).get(5, TimeUnit.SECONDS);
    }

    private static void shot(OutputStream out, byte[] body) throws Exception {
        JsonObject req = body.length == 0 ? new JsonObject()
                : JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
        String command = req.has("command") ? req.get("command").getAsString().trim() : "";
        if (command.startsWith("/")) command = command.substring(1);
        int waitTicks = clamp(req.has("waitTicks") ? req.get("waitTicks").getAsInt() : 40, 0, 600);
        int size = clamp(req.has("size") ? req.get("size").getAsInt() : 768, 64, 2048);
        float zoom = req.has("zoom") ? req.get("zoom").getAsFloat() : 1f;
        zoom = Math.max(0.2f, Math.min(3f, zoom));
        float yaw = req.has("yaw") ? req.get("yaw").getAsFloat() : 0f;

        Minecraft mc = Minecraft.getInstance();
        String cmd = command;
        String problem = mc.submit(() -> {
            if (mc.player == null || mc.level == null) return "not_in_world";
            if (mc.isPaused()) return "paused";
            synchronized (MESSAGES) {
                MESSAGES.clear();
            }
            COLLECTING = true;
            if (!cmd.isEmpty()) mc.player.connection.sendCommand(cmd);
            return null;
        }).get(5, TimeUnit.SECONDS);
        if (problem != null) {
            sendJson(out, 409, error(problem));
            return;
        }

        if (waitTicks > 0) Thread.sleep(waitTicks * 50L);
        COLLECTING = false;
        String messages;
        synchronized (MESSAGES) {
            com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
            MESSAGES.forEach(arr::add);
            MESSAGES.clear();
            messages = Base64.getEncoder().encodeToString(arr.toString().getBytes(StandardCharsets.UTF_8));
        }

        float z = zoom;
        CompletableFuture<byte[]> png = new CompletableFuture<>();
        mc.execute(() -> {
            try {
                png.complete(PlayerSnapshot.capture(mc, size, z, yaw));
            } catch (Throwable t) {
                png.completeExceptionally(t);
            }
        });
        byte[] data = png.get(15, TimeUnit.SECONDS);
        send(out, 200, "image/png", data, "X-YsmShot-Messages: " + messages + "\r\n");
    }

    /** 收集指令執行後遊戲顯示的訊息（例如 YSM 的「找不到模型」），一併回傳給管理器。 */
    static void onChat(ClientChatReceivedEvent event) {
        if (!COLLECTING) return;
        String text = event.getMessage().getString();
        synchronized (MESSAGES) {
            if (MESSAGES.size() < 20 && !text.isBlank()) MESSAGES.add(text.length() > 300 ? text.substring(0, 300) : text);
        }
    }

    /**
     * 取得指令的自動完成建議（和在聊天欄按 Tab 看到的一樣），例如 "ysm model set @s " 會列出所有模型 ID。
     */
    private static JsonObject suggest(byte[] body) throws Exception {
        JsonObject req = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
        String text = req.has("text") ? req.get("text").getAsString() : "";
        if (text.startsWith("/")) text = text.substring(1);
        String input = text;
        Minecraft mc = Minecraft.getInstance();
        CompletableFuture<Suggestions> future = mc.submit(() -> {
            ClientPacketListener conn = mc.getConnection();
            if (conn == null || mc.player == null) return null;
            CommandDispatcher<SharedSuggestionProvider> dispatcher = conn.getCommands();
            ParseResults<SharedSuggestionProvider> parse = dispatcher.parse(new StringReader(input), conn.getSuggestionsProvider());
            return dispatcher.getCompletionSuggestions(parse);
        }).get(5, TimeUnit.SECONDS);
        if (future == null) return error("not_in_world");
        Suggestions s = future.get(15, TimeUnit.SECONDS);
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        JsonArray arr = new JsonArray();
        for (Suggestion sg : s.getList()) {
            JsonObject e = new JsonObject();
            e.addProperty("text", sg.getText());
            if (sg.getTooltip() != null) e.addProperty("tooltip", sg.getTooltip().getString());
            arr.add(e);
        }
        o.add("suggestions", arr);
        return o;
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static JsonObject error(String msg) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.addProperty("error", msg);
        return o;
    }

    private static void sendJson(OutputStream out, int code, JsonObject o) throws IOException {
        send(out, code, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void send(OutputStream out, int code, String type, byte[] data) throws IOException {
        send(out, code, type, data, "");
    }

    private static void send(OutputStream out, int code, String type, byte[] data, String extraHeaders) throws IOException {
        String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "Error") + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + extraHeaders
                + "Content-Length: " + data.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(data);
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') buf.write(b);
            if (buf.size() > 8192) throw new IOException("line too long");
        }
        if (b == -1 && buf.size() == 0) return null;
        return buf.toString(StandardCharsets.ISO_8859_1);
    }
}
