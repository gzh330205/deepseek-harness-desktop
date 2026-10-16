package com.dshdesktop.pocket;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;

/**
 * The two questions the app asks the desktop gateway: "are you there?" and "do you accept this
 * password?".
 *
 * Plain {@link HttpURLConnection} rather than an HTTP library, for two reasons: the app needs exactly
 * two requests, and this class then has no Android dependencies — which is what lets the network
 * behaviour be tested on a JVM (and it is tested, against a real HTTP server).
 *
 * Both methods are blocking by design; callers run them off the main thread.
 */
public final class PocketClient {

  /** Long enough for a busy WiFi, short enough that a wrong address does not feel like a hang. */
  private static final int PROBE_TIMEOUT_MS = 4000;
  private static final int LOGIN_TIMEOUT_MS = 8000;

  private PocketClient() {
  }

  /** What one address answered. */
  public static final class Probe {
    /** Whether something answered at all. */
    public final boolean reachable;
    /** The gateway's login page is the answer to "reachable but you are not signed in". */
    public final boolean needsLogin;
    public final int status;
    /** Why it failed, in words the user can act on. */
    public final String error;

    Probe(boolean reachable, boolean needsLogin, int status, String error) {
      this.reachable = reachable;
      this.needsLogin = needsLogin;
      this.status = status;
      this.error = error;
    }
  }

  /** The outcome of a login attempt. */
  public static final class Login {
    public final boolean ok;
    /** The `name=value` session cookie, when the login succeeded. */
    public final String cookie;
    public final String error;

    Login(boolean ok, String cookie, String error) {
      this.ok = ok;
      this.cookie = cookie;
      this.error = error;
    }
  }

  /**
   * Ask an address whether the gateway lives there.
   *
   * @param baseUrl a base URL from {@link PocketAddress#normalise}
   * @return the probe result; never throws
   */
  public static Probe probe(String baseUrl) {
    try {
      HttpURLConnection connection = open(baseUrl, "GET", PROBE_TIMEOUT_MS);
      int status = connection.getResponseCode();
      drain(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
      connection.disconnect();
      if (status == 401) {
        // The gateway's own login page: reachable, and it wants the password.
        return new Probe(true, true, 401, null);
      }
      if (status == 200) {
        return new Probe(true, false, 200, null);
      }
      if (status == 403) {
        // Our Host allowlist: this address does not serve the name we asked for.
        return new Probe(true, false, 403, "电脑拒绝了这次访问（换一个地址试试）");
      }
      return new Probe(true, false, status, "电脑返回了 HTTP " + status);
    } catch (Exception error) {
      return new Probe(false, false, 0, describe(error));
    }
  }

  /**
   * Exchange the password for a session cookie.
   *
   * @param baseUrl a base URL from {@link PocketAddress#normalise}
   * @param password what the desktop settings page showed
   * @return the cookie, or the reason it failed
   */
  public static Login login(String baseUrl, String password) {
    try {
      HttpURLConnection connection = open(baseUrl + "__pocket/login?next=%2F", "POST", LOGIN_TIMEOUT_MS);
      connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
      connection.setDoOutput(true);
      byte[] body = ("password=" + URLEncoder.encode(password, "UTF-8")).getBytes(StandardCharsets.UTF_8);
      connection.setFixedLengthStreamingMode(body.length);
      try (OutputStream out = connection.getOutputStream()) {
        out.write(body);
      }
      int status = connection.getResponseCode();
      drain(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
      String setCookie = connection.getHeaderField("Set-Cookie");
      connection.disconnect();
      if (status == 401) {
        return new Login(false, null, "密码不正确");
      }
      if (status == 429) {
        return new Login(false, null, "失败次数过多，请等一分钟再试");
      }
      if (status != 303 && status != 302 && status != 200) {
        return new Login(false, null, "电脑返回了 HTTP " + status);
      }
      if (setCookie == null) {
        return new Login(false, null, "登录成功但电脑没有发出会话 cookie");
      }
      // Only the name=value pair: the attributes belong to the WebView's cookie jar.
      return new Login(true, setCookie.split(";", 2)[0].trim(), null);
    } catch (Exception error) {
      return new Login(false, null, describe(error));
    }
  }

  private static HttpURLConnection open(String url, String method, int timeoutMs) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod(method);
    connection.setConnectTimeout(timeoutMs);
    connection.setReadTimeout(timeoutMs);
    // The login answers with a 303 to the page; the caller decides what to do about it, and Java's
    // automatic redirect would turn a refused login into a confusing 200 of the login page.
    connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("Accept", "text/html,application/xhtml+xml");
    return connection;
  }

  private static void drain(InputStream stream) {
    if (stream == null) {
      return;
    }
    try (InputStream input = stream) {
      ByteArrayOutputStream sink = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      int read;
      while ((read = input.read(buffer)) != -1) {
        sink.write(buffer, 0, read);
        // The bodies here are small pages; stop after a sane bound rather than trusting the peer.
        if (sink.size() > 256 * 1024) {
          break;
        }
      }
    } catch (Exception ignored) {
      // Reading the body is only about letting the connection finish; nothing depends on it.
    }
  }

  /**
   * Turn an exception into something a user can act on.
   *
   * "它没反应" is worth nothing; "不在同一个 WiFi" is worth a fix.
   *
   * @param error the failure
   * @return a Chinese explanation with a likely cause
   */
  static String describe(Exception error) {
    if (error instanceof SocketTimeoutException) {
      return "连接超时：手机和电脑不在同一个 WiFi，或者电脑上的公网隧道没开";
    }
    if (error instanceof ConnectException) {
      return "连不上：电脑上的「手机访问」关着，或者地址变了（重新扫一次二维码）";
    }
    if (error instanceof UnknownHostException) {
      return "找不到这个地址：请检查是否输错了";
    }
    String message = error.getMessage();
    return "连不上：" + (message == null || message.isEmpty() ? error.getClass().getSimpleName() : message);
  }
}
