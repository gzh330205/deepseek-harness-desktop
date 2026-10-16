package com.dshdesktop.pocket;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * What the app remembers between runs: where the computer is, and — only when the user asked for it
 * — the password.
 *
 * Addresses live in ordinary preferences; the password does not. If the device's keystore cannot be
 * used, the password is simply never persisted (the app says so) rather than being written in the
 * clear "so that it works": remembering a credential is a convenience, not a reason to store it
 * insecurely.
 */
public final class PocketStore {

  private static final String PLAIN_NAME = "pocket";
  private static final String SECRET_NAME = "pocket_secret";
  private static final String KEY_ADDRESSES = "addresses";
  private static final String KEY_PASSWORD = "password";
  private static final String KEY_REMEMBER = "rememberPassword";
  private static final String SEPARATOR = "\n";
  /** Enough for a few networks; more than that is a list nobody reads. */
  private static final int MAX_ADDRESSES = 5;

  private final SharedPreferences plain;
  private SharedPreferences secret;

  public PocketStore(Context context) {
    this.plain = context.getApplicationContext().getSharedPreferences(PLAIN_NAME, Context.MODE_PRIVATE);
    try {
      MasterKey key = new MasterKey.Builder(context.getApplicationContext())
          .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
          .build();
      this.secret = EncryptedSharedPreferences.create(
          context.getApplicationContext(),
          SECRET_NAME,
          key,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    } catch (Exception error) {
      // A device with a broken keystore still gets a working app — it just has to retype the
      // password after the desktop restarts.
      this.secret = null;
    }
  }

  /** Whether this device can keep a password at all. */
  public boolean canRememberPassword() {
    return secret != null;
  }

  /** Saved addresses, newest first, deduplicated. */
  public List<String> addresses() {
    String stored = plain.getString(KEY_ADDRESSES, "");
    if (stored == null || stored.isEmpty()) {
      return new ArrayList<>();
    }
    LinkedHashSet<String> unique = new LinkedHashSet<>(Arrays.asList(stored.split(SEPARATOR)));
    unique.remove("");
    return new ArrayList<>(unique);
  }

  /**
   * Remember an address, most recent first.
   *
   * @param address a normalised base URL
   */
  public void rememberAddress(String address) {
    LinkedHashSet<String> unique = new LinkedHashSet<>();
    unique.add(address);
    unique.addAll(addresses());
    List<String> kept = new ArrayList<>(unique);
    while (kept.size() > MAX_ADDRESSES) {
      kept.remove(kept.size() - 1);
    }
    plain.edit().putString(KEY_ADDRESSES, String.join(SEPARATOR, kept)).apply();
  }

  /**
   * Drop one address.
   *
   * Used when a probe proves it is not a DSH gateway at all: keeping a stranger's URL in the list
   * means every launch tries it again, which is exactly the trap a user reported.
   *
   * @param address a normalised base URL
   */
  public void forgetAddress(String address) {
    List<String> kept = addresses();
    if (!kept.remove(address)) {
      return;
    }
    plain.edit().putString(KEY_ADDRESSES, String.join(SEPARATOR, kept)).apply();
  }

  /** Forget the computer entirely: addresses, password and the remember flag. */
  public void forget() {
    plain.edit().remove(KEY_ADDRESSES).remove(KEY_REMEMBER).apply();
    if (secret != null) {
      secret.edit().remove(KEY_PASSWORD).apply();
    }
  }

  /** The remembered password, or null. */
  public String password() {
    if (secret == null) {
      return null;
    }
    return secret.getString(KEY_PASSWORD, null);
  }

  public boolean rememberPassword() {
    return plain.getBoolean(KEY_REMEMBER, false);
  }

  /**
   * Store (or drop) the password.
   *
   * @param password the password to keep, or null to forget it
   * @return whether it could be stored; false means this device cannot keep it
   */
  public boolean savePassword(String password) {
    if (secret == null) {
      return false;
    }
    if (password == null || password.isEmpty()) {
      secret.edit().remove(KEY_PASSWORD).apply();
      plain.edit().putBoolean(KEY_REMEMBER, false).apply();
      return true;
    }
    secret.edit().putString(KEY_PASSWORD, password).apply();
    plain.edit().putBoolean(KEY_REMEMBER, true).apply();
    return true;
  }
}
