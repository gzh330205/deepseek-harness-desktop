package com.dshdesktop.pocket;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
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
      if (result.getContents() == null) {
        return;
      }
      String scanned = PocketAddress.normalise(result.getContents());
      if (scanned == null) {
        showSetup();
        status("这个二维码里没有可用的地址");
        return;
      }
      addressInput.setText(scanned);
      connect(scanned);
    });

    findViewById(R.id.scanButton).setOnClickListener(view -> launchScanner());
    findViewById(R.id.rescanButton).setOnClickListener(view -> {
      showSetup();
      launchScanner();
    });
    findViewById(R.id.reconnectButton).setOnClickListener(view -> connect(addressInput.getText().toString()));
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
    String remembered = store.password();
    if (remembered != null) {
      passwordInput.setText(remembered);
    }

    List<String> saved = store.addresses();
    if (saved.isEmpty()) {
      showSetup();
      status(getString(R.string.setup_hint));
    } else {
      addressInput.setText(saved.get(0));
      connect(null);
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

  private void launchScanner() {
    ScanOptions options = new ScanOptions();
    options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
    options.setPrompt("对准电脑设置页上的二维码");
    options.setBeepEnabled(false);
    options.setOrientationLocked(true);
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
