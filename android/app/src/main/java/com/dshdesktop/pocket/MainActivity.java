package com.dshdesktop.pocket;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AppCompatActivity;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole app: find the computer, sign in once, then show DSH in a WebView.
 *
 * The division of labour is deliberate. This activity owns **finding and signing in** (probe the
 * addresses, exchange the password for a session cookie, keep the cookie fresh); the WebView owns
 * **showing DSH**. Nothing parses or reimplements the DSH UI, so a desktop update cannot break the
 * phone beyond a page reload.
 *
 * The password is typed into this app rather than into the gateway's login page so it can be
 * remembered for the next time the desktop restarts — which is the one case where the phone would
 * otherwise ask for it again.
 */
public final class MainActivity extends AppCompatActivity {

  /** Lets the desktop side tell the app apart from a browser (used by the mobile layout work). */
  private static final String UA_SUFFIX = " DshPocket/1.0";

  /**
   * What the DSH web client needs from the browser engine.
   *
   * Checked at runtime rather than compared against a version number: the WebView on a phone is
   * updated by the store (or not at all), the requirement moves with DSH, and what actually matters is
   * whether these exist. An emulator image with WebView 113 taught us the failure mode — the page
   * loads, the client throws on the first line, and the user sees a blank screen with no explanation.
   */
  private static final String REQUIRED_WEBVIEW_FEATURES =
      "(typeof Promise.withResolvers === 'function')"
          + " && (typeof AbortSignal.any === 'function')"
          + " && (typeof Array.prototype.at === 'function')";

  private final ExecutorService worker = Executors.newSingleThreadExecutor();

  private PocketStore store;
  private WebView webView;
  private View bar;
  private View setupPanel;
  private TextView addressText;
  private TextView statusText;
  private EditText addressInput;
  private EditText passwordInput;
  private CheckBox rememberPassword;
  private ActivityResultLauncher<ScanOptions> scanner;

  /** The address currently loaded, so a session that expires knows where to sign in again. */
  private String current;

  /** When the last connect started, so one Enter press cannot become two logins. */
  private long lastConnectAt;

  /** Whether the browser engine has proven itself capable; connects are refused until it has. */
  private boolean engineChecked;
  private boolean engineTooOld;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    setContentView(R.layout.activity_main);

    store = new PocketStore(this);
    webView = findViewById(R.id.webView);
    bar = findViewById(R.id.bar);
    setupPanel = findViewById(R.id.setupPanel);
    addressText = findViewById(R.id.addressText);
    statusText = findViewById(R.id.statusText);
    addressInput = findViewById(R.id.addressInput);
    passwordInput = findViewById(R.id.passwordInput);
    rememberPassword = findViewById(R.id.rememberPassword);

    configureWebView();

    scanner = registerForActivityResult(new ScanContract(), result -> {
      String contents = result.getContents() == null ? "" : result.getContents().trim();
      if (contents.isEmpty()) {
        return;
      }
      // The desktop's QR codes are `dshpocket://connect?url=…&password=…` deep links now, so one
      // scan can fill both boxes. A plain address (an older code, or another tool's code) still
      // works through the fallback.
      PocketAddress.Connect link = PocketAddress.connectLink(contents);
      String scanned = link != null ? link.address : PocketAddress.normalise(contents);
      if (scanned == null) {
        showSetup();
        // The desktop shows two codes: one opens the app, one is the address. Scanning the wrong one
        // used to produce a nonsense "address" and a saved bad entry; now it says what it is.
        if (contents.toLowerCase(Locale.ROOT).contains(".apk")) {
          status("这是手机 App 的安装包，请用手机相机扫它下载；这台电脑的地址是另一个二维码。");
        } else {
          status("这个二维码里没有可用的电脑地址");
        }
        return;
      }
      addressInput.setText(scanned);
      if (link != null && link.password != null) {
        // Both halves came in the code: connect() reads the password field, so the scan is the
        // whole setup step.
        passwordInput.setText(link.password);
      }
      connect(scanned);
    });

    findViewById(R.id.scanButton).setOnClickListener(view -> launchScanner());
    findViewById(R.id.rescanButton).setOnClickListener(view -> {
      showSetup();
      launchScanner();
    });
    findViewById(R.id.reconnectButton).setOnClickListener(view -> connect(addressInput.getText().toString()));
    // Always available, even while a page is on screen: without it the only way back to the editor was
    // "scan again", which is how a wrong address became a trap.
    findViewById(R.id.editAddressButton).setOnClickListener(view -> {
      if (current != null) {
        addressInput.setText(current);
      }
      showSetup();
      addressInput.requestFocus();
      status("改好地址后点「连接」。");
    });
    findViewById(R.id.connectButton).setOnClickListener(view -> connect(addressInput.getText().toString()));

    if (state != null) {
      // A rotation keeps the WebView's own state; the setup screen is re-derived below.
      String restored = state.getString("current");
      if (restored != null) {
        addressInput.setText(restored);
      }
    }

    findViewById(R.id.webViewUpdateButton).setOnClickListener(view -> openWebViewStore());
    // `about:blank` gives the engine something to run the capability check on; the result arrives in
    // onPageFinished below.
    webView.loadUrl("about:blank");

    rememberPassword.setChecked(store.rememberPassword());

    // The password field is the only thing left to type once an address arrives by link, so Enter there
    // means "connect" instead of dismissing the keyboard. Two details matter: a raw Enter arrives as
    // IME_NULL *and* as a key event (acting on both fires two logins, which the rate limiter then
    // counts), and a multi-line field would swallow Enter as a newline instead of an action.
    passwordInput.setSingleLine(true);
    passwordInput.setOnEditorActionListener((view, actionId, event) -> {
      // 一次回车可能既来 key event 又来 IME action，两边都处理就会发两次登录（日志里那对相隔 7ms 的
      // 401 就是这么来的），于是去抖一道。
      if (System.currentTimeMillis() - lastConnectAt < 1000) {
        return true;
      }
      final boolean enter = event != null
          && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
          && event.getAction() == KeyEvent.ACTION_DOWN;
      if (!enter && actionId != EditorInfo.IME_ACTION_DONE) {
        return false;
      }
      android.util.Log.i("DshPocket", "回车连接 actionId=" + actionId + " event=" + (event != null));
      connect(addressInput.getText().toString());
      return true;
    });

    String remembered = store.password();
    if (remembered != null) {
      passwordInput.setText(remembered);
    }

    // A deep link wins over the remembered address list: filling both boxes and then replacing them
    // with the last-used address is how the link used to be ignored on a cold start.
    if (!handleConnectLink(getIntent())) {
      List<String> saved = store.addresses();
      if (saved.isEmpty()) {
        showSetup();
        status(getString(R.string.setup_hint));
      } else {
        addressInput.setText(saved.get(0));
        connect(null);
      }
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle state) {
    super.onSaveInstanceState(state);
    if (current != null) {
      state.putString("current", current);
    }
  }

  @Override
  public void onBackPressed() {
    if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    worker.shutdownNow();
    if (webView != null) {
      webView.destroy();
    }
    super.onDestroy();
  }

  /** The installed WebView's version, for the message and for support. */
  private String webViewVersion() {
    try {
      android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
      return info == null || info.versionName == null ? "未知版本" : info.versionName;
    } catch (Exception error) {
      return "未知版本";
    }
  }

  /** Send the user to the store page for whichever WebView provider this phone uses. */
  private void openWebViewStore() {
    String packageName = "com.google.android.webview";
    try {
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
        if (info != null && info.packageName != null) {
          packageName = info.packageName;
        }
      }
    } catch (Exception ignored) {
      // Fall back to the common provider.
    }
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + packageName)));
    } catch (Exception noStore) {
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + packageName)));
      } catch (Exception ignored) {
        status("没有找到应用商店，请手动更新「Android System WebView」。");
      }
    }
  }

  /**
   * Pick up a connection from `dshpocket://connect?url=…&password=…`.
   *
   * The desktop's QR codes carry the password too, so a link can fill both fields and the user only
   * has to press 「连接」. An older link (address only) keeps working: the password box is cleared and
   * focused as before. Focus matters because at `onCreate` the tree is not laid out yet, so that
   * request is posted rather than made directly.
   *
   * @param intent - The intent that started or resumed this activity.
   * @return Whether a link was handled, so a cold start does not replace it with a saved address.
   */
  private boolean handleConnectLink(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
      return false;
    }
    PocketAddress.Connect link = PocketAddress.connectLink(intent.getDataString());
    if (link == null) {
      status("这个链接里没有可用的电脑地址。");
      return true;
    }
    android.util.Log.i("DshPocket", "深链接 → " + link.address);
    addressInput.setText(link.address);
    if (link.password != null) {
      // Both halves arrived with the link; the field is already filled, so the user only confirms.
      passwordInput.setText(link.password);
      showSetup();
      passwordInput.post(() -> status("地址和密码已从链接填入，点「连接」即可。"));
      return true;
    }
    if (store.rememberPassword() && store.password() != null) {
      connect(link.address);
      return true;
    }
    // A stale value from the last session must not look like the password the link expects.
    passwordInput.setText("");
    showSetup();
    passwordInput.post(() -> {
      passwordInput.requestFocus();
      status("地址已从链接填入，输入电脑上显示的访问密码即可。");
    });
    return true;
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleConnectLink(intent);
  }

  private void launchScanner() {
    ScanOptions options = new ScanOptions();
    options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
    options.setPrompt("对准电脑上「手机访问」页面的二维码");
    options.setBeepEnabled(false);
    options.setOrientationLocked(true);
    // Portrait: our own subclass is declared upright in the manifest (the library's is landscape).
    options.setCaptureActivity(PocketCaptureActivity.class);
    scanner.launch(options);
  }

  private void configureWebView() {
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    // The page is a remote document; it has no business reading local files.
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setUserAgentString(settings.getUserAgentString() + UA_SUFFIX);
    CookieManager.getInstance().setAcceptCookie(true);

    webView.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (scheme.equals("http") || scheme.equals("https")) {
          return false;
        }
        // tel:, mailto:, intent: and friends belong to the system, not to this WebView.
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
          // Nothing on this phone can open it; refusing silently beats crashing.
        }
        return true;
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        if (engineChecked || !"about:blank".equals(url)) {
          return;
        }
        engineChecked = true;
        view.evaluateJavascript(REQUIRED_WEBVIEW_FEATURES, value -> {
          if ("true".equals(value)) {
            return;
          }
          engineTooOld = true;
          String version = webViewVersion();
          findViewById(R.id.connectButton).setEnabled(false);
          findViewById(R.id.scanButton).setEnabled(false);
          findViewById(R.id.webViewUpdateButton).setVisibility(View.VISIBLE);
          showSetup();
          status("这台手机的系统 WebView 太旧（" + version + "），DSH 的界面起不来，连上也是白屏。"
              + "请在应用商店更新「Android System WebView」或 Chrome，然后重新打开本应用。");
        });
      }

      @Override
      public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (errorResponse.getStatusCode() != 401 || !request.isForMainFrame() || current == null) {
          return;
        }
        // DSH restarted and the session died with it: sign in again, silently when the password was
        // remembered.
        reauthenticate();
      }
    });
  }

  /**
   * Look for the computer and sign in.
   *
   * @param typed an address the user typed or scanned, or null to use the saved ones
   */
  private void connect(String typed) {
    if (engineTooOld) {
      showSetup();
      status("这台手机的浏览器内核太旧，装不了 DSH 的界面；请先按上面的提示更新 WebView。");
      return;
    }
    String raw = typed == null ? "" : typed.trim();
    String base = raw.isEmpty() ? null : PocketAddress.normalise(raw);
    if (!raw.isEmpty() && base == null) {
      showSetup();
      status("地址看不出来，试试 192.168.1.7:41730 这样的格式");
      return;
    }

    List<String> candidates = new ArrayList<>();
    if (base != null) {
      candidates.add(base);
    }
    candidates.addAll(store.addresses());
    if (candidates.isEmpty()) {
      showSetup();
      status("还没有地址：扫描电脑上的二维码，或手动填写");
      return;
    }

    String typedPassword = passwordInput.getText().toString().trim();
    boolean remember = rememberPassword.isChecked();
    lastConnectAt = System.currentTimeMillis();
    // 只记长度与地址：排查「为什么登录被拒」时，这两项足够区分「发送内容不对」和「凭据不对」。
    android.util.Log.i("DshPocket", "连接 " + raw + " 密码长度=" + typedPassword.length() + " 记住=" + remember);
    showSetup();
    status(getString(R.string.probing));
    worker.execute(() -> attempt(candidates, typedPassword, remember));
  }

  /** Runs off the main thread; every path posts its outcome back. */
  private void attempt(List<String> candidates, String typedPassword, boolean remember) {
    String lastError = null;
    for (String url : PocketAddress.order(candidates)) {
      PocketClient.Probe probe = PocketClient.probe(url);
      if (!probe.reachable) {
        lastError = probe.error;
        // Something answered that is not a gateway (a web server, a captive portal): stop offering it.
        if (probe.error != null && probe.error.contains("不是 DSH")) {
          store.forgetAddress(url);
        }
        continue;
      }
      if (!probe.needsLogin) {
        // Already signed in (or no password is required on this network).
        post(() -> open(url, null));
        return;
      }
      String password = !typedPassword.isEmpty() ? typedPassword : store.password();
      if (password == null || password.isEmpty()) {
        post(() -> askForPassword(url, null));
        return;
      }
      PocketClient.Login login = PocketClient.login(url, password);
      if (!login.ok) {
        post(() -> askForPassword(url, login.error));
        return;
      }
      String toRemember = !typedPassword.isEmpty() && remember ? typedPassword : null;
      String finalUrl = url;
      post(() -> {
        if (toRemember != null && !store.savePassword(toRemember)) {
          status("这台设备无法安全保存密码，下次需要重新输入");
        }
        open(finalUrl, login.cookie);
      });
      return;
    }
    String message = lastError == null ? "没有可用的地址" : lastError;
    post(() -> {
      showSetup();
      status(message);
    });
  }

  /** The session expired (or the desktop restarted): sign in again with the remembered password. */
  private void reauthenticate() {
    String url = current;
    String password = store.password();
    if (url == null || password == null || password.isEmpty()) {
      post(() -> askForPassword(url, "登录已过期，请重新输入密码"));
      return;
    }
    worker.execute(() -> {
      PocketClient.Login login = PocketClient.login(url, password);
      if (!login.ok) {
        post(() -> askForPassword(url, login.error));
        return;
      }
      post(() -> {
        CookieManager.getInstance().setCookie(url, login.cookie);
        webView.loadUrl(url);
      });
    });
  }

  private void open(String url, String cookie) {
    if (cookie != null) {
      CookieManager.getInstance().setCookie(url, cookie);
    }
    current = url;
    store.rememberAddress(url);
    addressText.setText(url);
    bar.setVisibility(View.VISIBLE);
    setupPanel.setVisibility(View.GONE);
    webView.setVisibility(View.VISIBLE);
    webView.loadUrl(url);
  }

  private void askForPassword(String url, String reason) {
    showSetup();
    if (url != null) {
      addressInput.setText(url);
    }
    status(reason == null ? "请输入电脑上「手机访问」里显示的密码" : reason);
    passwordInput.requestFocus();
  }

  private void showSetup() {
    setupPanel.setVisibility(View.VISIBLE);
  }

  private void status(String message) {
    statusText.setText(message == null ? "" : message);
  }

  private void post(Runnable action) {
    runOnUiThread(action);
  }
}
