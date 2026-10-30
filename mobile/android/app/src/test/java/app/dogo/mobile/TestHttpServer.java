package app.dogo.mobile;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/** Tiny loopback HTTP fixture, independent of Android's compile-time boot modules. */
final class TestHttpServer implements AutoCloseable {
    interface Handler { void handle(Exchange exchange) throws Exception; }
    static class Headers extends TreeMap<String, String> {
        Headers() { super(String.CASE_INSENSITIVE_ORDER); }
        String getFirst(String name) { return get(name); }
        void set(String name, String value) { put(name, value); }
    }
    static class Exchange {
        final Headers request = new Headers(), response = new Headers();
        final Socket socket;
        final byte[] body;
        final String path;
        Exchange(Socket socket) throws IOException {
            this.socket = socket;
            InputStream input = socket.getInputStream();
            path = line(input).split(" ")[1];
            String line;
            while (!(line = line(input)).isEmpty()) {
                int colon = line.indexOf(':');
                request.set(line.substring(0, colon), line.substring(colon + 1).trim());
            }
            int size = Integer.parseInt(request.getOrDefault("Content-Length", "0"));
            body = new byte[size];
            new DataInputStream(input).readFully(body);
        }
        Headers getRequestHeaders() { return request; }
        Headers getResponseHeaders() { return response; }
        InputStream getRequestBody() { return new ByteArrayInputStream(body); }
        void respond(int code, String text) throws IOException {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            StringBuilder head = new StringBuilder("HTTP/1.1 " + code + " Result\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + bytes.length + "\r\n");
            response.forEach((k, v) -> head.append(k).append(": ").append(v).append("\r\n"));
            OutputStream output = socket.getOutputStream();
            output.write((head + "\r\n").getBytes(StandardCharsets.UTF_8));
            output.write(bytes); output.flush();
        }
        static String line(InputStream input) throws IOException {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            int value;
            while ((value = input.read()) != '\n') {
                if (value == -1) throw new EOFException();
                if (value != '\r') bytes.write(value);
            }
            return bytes.toString("UTF-8");
        }
    }
    private final ServerSocket socket;
    private final Thread thread;
    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();
    private volatile Throwable failure;
    TestHttpServer() throws IOException {
        socket = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
        thread = new Thread(() -> {
            while (!socket.isClosed()) {
                try (Socket client = socket.accept()) {
                    client.setSoTimeout(3000);
                    Exchange exchange = new Exchange(client);
                    Handler handler = handlers.get(exchange.path);
                    if (handler == null) exchange.respond(404, "{}"); else handler.handle(exchange);
                } catch (Throwable error) { if (!socket.isClosed()) failure = error; }
            }
        }, "test-http");
        thread.setDaemon(true); thread.start();
    }
    String origin() { return "http://127.0.0.1:" + socket.getLocalPort(); }
    void createContext(String path, Handler handler) { handlers.put(path, handler); }
    public void close() throws Exception {
        socket.close(); thread.join(2000);
        if (failure != null) throw new AssertionError("HTTP fixture failed", failure);
    }
}
