package com.dshdesktop.pocket;

import java.net.URI;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * Address rules for the phone client: what a scan or a typed address may contain, and which of the
 * saved addresses to try first.
 *
 * Plain Java with no Android types on purpose: these rules are the part most likely to be wrong (a
 * QR code with a trailing path, an IPv6 literal, a tunnel hostname next to a LAN address), and here
 * they can be tested on a JVM instead of only on a phone.
 */
public final class PocketAddress {

  private PocketAddress() {
  }

  /**
   * Turn whatever the user scanned or typed into a base URL.
   *
   * Accepts `http(s)://host:port/anything`, a bare `host:port`, and a bare host (where the gateway's
   * default port is assumed). Everything is reduced to `scheme://host:port/`, because the gateway
   * serves DSH at its root and a path from a scan would only be a leftover.
   *
   * @param raw scanned or typed text
   * @return the base URL, or null when nothing usable can be made of it
   */
  public static String normalise(String raw) {
    return normalise(raw, 41730);
  }

  public static String normalise(String raw, int defaultPort) {
    if (raw == null) {
      return null;
    }
    String value = raw.trim();
    if (value.isEmpty()) {
      return null;
    }
    // A scanned QR carries the full URL; people type "192.168.1.7:41730" or just "192.168.1.7".
    if (!value.contains("://")) {
      value = "http://" + value;
    }
    URI uri;
    try {
      uri = new URI(value);
    } catch (Exception error) {
      return null;
    }
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    if (!scheme.equals("http") && !scheme.equals("https")) {
      return null;
    }
    String host = uri.getHost();
    if (host == null || host.isEmpty()) {
      return null;
    }
    // `URI.getHost()` may hand back an IPv6 literal with its brackets; the helper below re-adds them.
    host = bareHost(host);
    int port = uri.getPort();
    if (port == -1) {
      // A bare host means the gateway's default port; a bare https host is a tunnel (443).
      port = scheme.equals("https") ? 443 : defaultPort;
    }
    if (port < 1 || port > 65535) {
      return null;
    }
    return scheme + "://" + hostForUrl(host) + ":" + port + "/";
  }

  /**
   * Read the address out of a `dshpocket://connect?url=…` link.
   *
   * This is what makes the desktop's QR code usable by the **system camera**: any scanning app hands
   * the URL to the browser, the browser hands our scheme to us, and the address arrives filled in with
   * only the password left to type. The in-app scanner keeps working with plain addresses.
   *
   * @param link - The whole intent URI, or null.
   * @returns The normalised address, or null when this is not a usable connect link.
   */
  static String fromConnectLink(String link) {
    if (link == null) {
      return null;
    }
    try {
      URI uri = new URI(link.trim());
      if (!"dshpocket".equalsIgnoreCase(uri.getScheme())) {
        return null;
      }
      String raw = uri.getRawQuery();
      if (raw == null) {
        return null;
      }
      for (String pair : raw.split("&")) {
        int equals = pair.indexOf('=');
        if (equals <= 0) {
          continue;
        }
        if ("url".equals(pair.substring(0, equals))) {
          String value = URLDecoder.decode(pair.substring(equals + 1), "UTF-8");
          return normalise(value);
        }
      }
      return null;
    } catch (Exception error) {
      return null;
    }
  }

  /** Re-add the brackets an IPv6 literal needs inside a URL. */
  static String hostForUrl(String host) {
    return host.indexOf(':') >= 0 ? "[" + host + "]" : host;
  }

  /**
   * Strip the brackets `URI.getHost()` keeps around an IPv6 literal.
   *
   * Both directions matter: a URL needs them back, and the range checks below need them gone — an
   * earlier version tested `startsWith("fe8")` against `[fe80::1]` and quietly called every IPv6
   * link-local address public.
   */
  static String bareHost(String host) {
    return host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
  }

  /**
   * Whether an address is on the local network.
   *
   * Only used to decide the order addresses are tried in: the LAN one is right when the phone is at
   * home and simply fails fast when it is not.
   *
   * @param url a base URL produced by {@link #normalise}
   * @return whether its host is loopback, a private IPv4 range or a private IPv6 range
   */
  public static boolean isLan(String url) {
    URI uri;
    try {
      uri = new URI(url);
    } catch (Exception error) {
      return false;
    }
    String host = uri.getHost();
    if (host == null) {
      return false;
    }
    String name = bareHost(host).toLowerCase(Locale.ROOT);
    if (name.equals("localhost") || name.equals("::1")) {
      return true;
    }
    if (name.contains(":")) {
      // Unique local (fc00::/7) and link-local (fe80::/10) addresses are the LAN equivalents.
      return name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe8")
          || name.startsWith("fe9") || name.startsWith("fea") || name.startsWith("feb");
    }
    String[] parts = name.split("\\.");
    if (parts.length != 4) {
      // A hostname: the tunnel (P3) or, less usefully, something else. Not LAN.
      return false;
    }
    int[] octets = new int[4];
    for (int index = 0; index < 4; index++) {
      try {
        octets[index] = Integer.parseInt(parts[index]);
      } catch (NumberFormatException error) {
        return false;
      }
      if (octets[index] < 0 || octets[index] > 255) {
        return false;
      }
    }
    if (octets[0] == 127 || octets[0] == 10) {
      return true;
    }
    if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) {
      return true;
    }
    if (octets[0] == 192 && octets[1] == 168) {
      return true;
    }
    // Link-local: what a machine falls back to when DHCP failed.
    return octets[0] == 169 && octets[1] == 254;
  }

  /**
   * Order addresses so the most likely one is tried first, and drop duplicates.
   *
   * @param urls addresses in the order they were saved
   * @return LAN addresses first, then the rest, both in their original order
   */
  public static List<String> order(List<String> urls) {
    LinkedHashSet<String> unique = new LinkedHashSet<>();
    for (String url : urls) {
      String normalised = normalise(url);
      if (normalised != null) {
        unique.add(normalised);
      }
    }
    List<String> lan = new ArrayList<>();
    List<String> rest = new ArrayList<>();
    for (String url : unique) {
      (isLan(url) ? lan : rest).add(url);
    }
    lan.addAll(rest);
    return lan;
  }
}
