package com.dshdesktop.pocket;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The smallest HTTP server that can stand in for the desktop gateway in a unit test.
 *
 * Not `com.sun.net.httpserver`: Android unit tests compile against `android.jar`, which does not
 * carry the JDK's internal HTTP server. A socket and forty lines of parsing do the job, stay
 * dependency-free, and are small enough to trust — the tests below assert on the bytes this server
 * receives, which is the point.
 *
 * One request per connection, then close: that is all {@link PocketClient} ever does.
 */
final class TestHttpServer implements Closeable {

  /** One parsed request. */
  static final class Request {
    final String method;
    final String path;
    final Map<String, String> headers;
    final String body;

    Request(String method, String path, Map<String, String> headers, String body) {
      this.method = method;
      this.path = path;
      this.headers = headers;
      this.body = body;
    }
  }

  /** What the handler wants to answer. */
  static final class Response {
    int status = 200;
    String body = "";
    final Map<String, String> headers = new LinkedHashMap<>();
  }

  interface Handler {
    void handle(Request request, Response response) throws Exception;
  }

  private final ServerSocket socket;
  private final Thread thread;
  private volatile boolean running = true;

  TestHttpServer(Handler handler) throws IOException {
    socket = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
    thread = new Thread(() -> acceptLoop(handler), "test-http");
    thread.setDaemon(true);
    thread.start();
  }

  int port() {
    return socket.getLocalPort();
  }

  String baseUrl() {
    return "http://127.0.0.1:" + socket.getLocalPort() + "/";
  }

  private void acceptLoop(Handler handler) {
    while (running) {
      try (Socket client = socket.accept()) {
        handleOne(client, handler);
      } catch (IOException closed) {
        return;
      } catch (Exception error) {
        // A handler that throws only fails the connection; the test's assertions decide the verdict.
        return;
      }
    }
  }

  private void handleOne(Socket client, Handler handler) throws Exception {
    InputStream input = client.getInputStream();
    String head = readHead(input);
    if (head == null) {
      return;
    }
    String[] lines = head.split("\r\n");
    String[] requestLine = lines[0].split(" ");
    Map<String, String> headers = new LinkedHashMap<>();
    for (int index = 1; index < lines.length; index++) {
      int at = lines[index].indexOf(':');
      if (at > 0) {
        headers.put(lines[index].substring(0, at).trim().toLowerCase(), lines[index].substring(at + 1).trim());
      }
    }
    int length = 0;
    try {
      length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
    } catch (NumberFormatException ignored) {
      length = 0;
    }
    byte[] body = new byte[length];
    int read = 0;
    while (read < length) {
      int now = input.read(body, read, length - read);
      if (now < 0) {
        break;
      }
      read += now;
    }
    Request request = new Request(
        requestLine.length > 0 ? requestLine[0] : "",
        requestLine.length > 1 ? requestLine[1] : "/",
        headers,
        new String(body, 0, read, StandardCharsets.UTF_8));

    Response response = new Response();
    handler.handle(request, response);
    byte[] payload = response.body.getBytes(StandardCharsets.UTF_8);
    StringBuilder out = new StringBuilder();
    out.append("HTTP/1.1 ").append(response.status).append(" X\r\n");
    for (Map.Entry<String, String> header : response.headers.entrySet()) {
      out.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
    }
    out.append("Content-Length: ").append(payload.length).append("\r\n");
    out.append("Connection: close\r\n\r\n");
    OutputStream output = client.getOutputStream();
    output.write(out.toString().getBytes(StandardCharsets.UTF_8));
    output.write(payload);
    output.flush();
  }

  /** Read until the blank line that ends the headers. */
  private static String readHead(InputStream input) throws IOException {
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    int state = 0;
    int value;
    while ((value = input.read()) != -1) {
      buffer.write(value);
      // Looking for \r\n\r\n without a BufferedReader, whose buffering would swallow the body.
      if ((state == 0 || state == 2) && value == '\r') {
        state++;
      } else if ((state == 1 || state == 3) && value == '\n') {
        state++;
        if (state == 4) {
          break;
        }
      } else {
        state = value == '\r' ? 1 : 0;
      }
    }
    String text = buffer.toString(StandardCharsets.UTF_8);
    return text.isEmpty() ? null : text.substring(0, text.length() - 4);
  }

  @Override
  public void close() throws IOException {
    running = false;
    socket.close();
  }
}
