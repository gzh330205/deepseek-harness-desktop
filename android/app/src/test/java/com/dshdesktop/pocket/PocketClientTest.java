package com.dshdesktop.pocket;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicReference;

/**
 * The client against a real HTTP server.
 *
 * The gateway's behaviour that matters here is small and exact — 401 means "reachable, sign in",
 * 403 means "refused", 303 plus `Set-Cookie` means "here is your session" — and a stubbed client
 * would only test this class against itself. A real socket on loopback runs it for real without a
 * device, and the assertions include what the server actually received.
 */
public final class PocketClientTest {

  private TestHttpServer server;

  @After
  public void stop() throws Exception {
    if (server != null) {
      server.close();
      server = null;
    }
  }

  private String serve(TestHttpServer.Handler handler) throws Exception {
    server = new TestHttpServer(handler);
    return server.baseUrl();
  }

  @Test
  public void aSignedInGatewayAnswers200AndNeedsNoLogin() throws Exception {
    String base = serve((request, response) -> {
      response.status = 200;
      response.body = "<html>dsh</html>";
    });
    PocketClient.Probe probe = PocketClient.probe(base);
    assertTrue(probe.reachable);
    assertFalse(probe.needsLogin);
    assertEquals(200, probe.status);
    assertNull(probe.error);
  }

  @Test
  public void a401MeansReachableButSignInRequired() throws Exception {
    String base = serve((request, response) -> {
      response.status = 401;
      response.body = "<html>需要访问密码</html>";
    });
    PocketClient.Probe probe = PocketClient.probe(base);
    assertTrue(probe.reachable);
    assertTrue(probe.needsLogin);
    assertEquals(401, probe.status);
  }

  @Test
  public void a403IsReportedAsARefusalNotAsUnreachable() throws Exception {
    String base = serve((request, response) -> response.status = 403);
    PocketClient.Probe probe = PocketClient.probe(base);
    assertTrue(probe.reachable);
    assertFalse(probe.needsLogin);
    assertEquals(403, probe.status);
    assertNotNull(probe.error);
  }

  @Test
  public void nothingListeningIsExplainedRatherThanThrown() throws Exception {
    // A port that was open a moment ago and now is not: "the desktop app was closed".
    String base = serve((request, response) -> response.status = 200);
    server.close();
    server = null;
    PocketClient.Probe probe = PocketClient.probe(base);
    assertFalse(probe.reachable);
    assertNotNull(probe.error);
    assertTrue(probe.error, probe.error.contains("连不上"));
  }

  @Test
  public void theProbeIsAPlainGetToTheRoot() throws Exception {
    AtomicReference<String> method = new AtomicReference<>();
    AtomicReference<String> path = new AtomicReference<>();
    String base = serve((request, response) -> {
      method.set(request.method);
      path.set(request.path);
      response.status = 401;
    });
    PocketClient.probe(base);
    assertEquals("GET", method.get());
    assertEquals("/", path.get());
  }

  @Test
  public void thePasswordIsPostedAndTheSessionCookieComesBack() throws Exception {
    AtomicReference<String> receivedBody = new AtomicReference<>();
    AtomicReference<String> receivedMethod = new AtomicReference<>();
    AtomicReference<String> receivedPath = new AtomicReference<>();
    AtomicReference<String> receivedContentType = new AtomicReference<>();
    String base = serve((request, response) -> {
      receivedMethod.set(request.method);
      receivedPath.set(request.path);
      receivedBody.set(request.body);
      receivedContentType.set(request.headers.get("content-type"));
      response.status = 303;
      response.headers.put("Set-Cookie", "dsh_pocket=abc123; Path=/; HttpOnly; SameSite=Strict");
    });

    PocketClient.Login login = PocketClient.login(base, "Kf7mQ2xp");
    assertTrue(login.error, login.ok);
    assertEquals("dsh_pocket=abc123", login.cookie);
    assertEquals("POST", receivedMethod.get());
    assertEquals("/__pocket/login?next=%2F", receivedPath.get());
    // The password is form-encoded, and it is the only thing in the body.
    assertEquals("password=Kf7mQ2xp", receivedBody.get());
    assertEquals("application/x-www-form-urlencoded", receivedContentType.get());
  }

  @Test
  public void aPasswordWithCharactersThatNeedEncodingSurvives() throws Exception {
    AtomicReference<String> receivedBody = new AtomicReference<>();
    String base = serve((request, response) -> {
      receivedBody.set(request.body);
      response.status = 303;
      response.headers.put("Set-Cookie", "dsh_pocket=x");
    });
    PocketClient.login(base, "a+b&c=1");
    assertEquals("password=a%2Bb%26c%3D1", receivedBody.get());
  }

  @Test
  public void aWrongPasswordAndALockoutReadDifferently() throws Exception {
    String refused = serve((request, response) -> {
      response.status = 401;
      response.body = "密码不正确";
    });
    PocketClient.Login wrong = PocketClient.login(refused, "nope");
    assertFalse(wrong.ok);
    assertEquals("密码不正确", wrong.error);
    assertNull(wrong.cookie);

    server.close();
    String locked = serve((request, response) -> response.status = 429);
    PocketClient.Login lockedOut = PocketClient.login(locked, "nope");
    assertFalse(lockedOut.ok);
    assertTrue(lockedOut.error, lockedOut.error.contains("失败次数过多"));
  }

  @Test
  public void a303WithoutASetCookieIsNotTreatedAsASession() throws Exception {
    String base = serve((request, response) -> response.status = 303);
    PocketClient.Login login = PocketClient.login(base, "whatever");
    assertFalse(login.ok);
    assertNotNull(login.error);
  }
}
