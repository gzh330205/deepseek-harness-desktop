package com.dshdesktop.pocket;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

/**
 * The address rules, tested where they cost nothing to test.
 *
 * These are the inputs that actually show up: the QR code the desktop shows, a person typing an
 * address from memory, a phone that used to be on the home WiFi holding a LAN address that is now
 * unreachable, and a public tunnel hostname next to it.
 */
public final class PocketAddressTest {

  @Test
  public void aScannedUrlLosesItsPathAndKeepsItsPort() {
    assertEquals("http://192.168.1.7:41730/", PocketAddress.normalise("http://192.168.1.7:41730/"));
    assertEquals("http://192.168.1.7:41730/", PocketAddress.normalise("http://192.168.1.7:41730/?next=%2F"));
    assertEquals("http://192.168.1.7:41730/", PocketAddress.normalise("  http://192.168.1.7:41730/  "));
  }

  @Test
  public void aTypedAddressGetsASchemeAndTheGatewayPort() {
    assertEquals("http://192.168.1.7:41730/", PocketAddress.normalise("192.168.1.7:41730"));
    assertEquals("http://10.0.0.9:41730/", PocketAddress.normalise("10.0.0.9"));
    assertEquals("http://pocket.local:41730/", PocketAddress.normalise("pocket.local"));
  }

  @Test
  public void aTunnelAddressKeepsHttpsAndItsOwnPort() {
    assertEquals("https://pocket.example.com:443/", PocketAddress.normalise("https://pocket.example.com"));
    assertEquals("https://pocket.example.com:8443/", PocketAddress.normalise("https://pocket.example.com:8443"));
  }

  @Test
  public void anIpv6LiteralSurvivesTheRoundTrip() {
    assertEquals("http://[fe80::1]:41730/", PocketAddress.normalise("[fe80::1]:41730"));
    assertEquals("http://[fe80::1]:41730/", PocketAddress.normalise("http://[fe80::1]:41730/"));
  }

  @Test
  public void nonsenseIsRefusedRatherThanGuessed() {
    assertNull(PocketAddress.normalise(null));
    assertNull(PocketAddress.normalise(""));
    assertNull(PocketAddress.normalise("   "));
    assertNull(PocketAddress.normalise("http://"));
    assertNull(PocketAddress.normalise("ftp://192.168.1.7"));
    assertNull(PocketAddress.normalise("http://192.168.1.7:99999"));
    assertNull(PocketAddress.normalise("http://:41730"));
  }

  @Test
  public void privateAndLoopbackAddressesCountAsLan() {
    for (String url : new String[]{
        "http://192.168.1.7:41730/",
        "http://10.1.6.35:41730/",
        "http://172.16.0.1:41730/",
        "http://172.31.255.1:41730/",
        "http://169.254.1.1:41730/",
        "http://127.0.0.1:41730/",
        "http://localhost:41730/",
        "http://[fe80::1]:41730/",
        "http://[fd00::1]:41730/",
    }) {
      assertTrue(url, PocketAddress.isLan(url));
    }
    for (String url : new String[]{
        "http://8.8.8.8:41730/",
        "http://172.32.0.1:41730/",
        "https://pocket.example.com:443/",
        "https://random-words.trycloudflare.com:443/",
    }) {
      assertFalse(url, PocketAddress.isLan(url));
    }
  }

  @Test
  public void lanAddressesAreTriedFirstAndDuplicatesDropped() {
    List<String> ordered = PocketAddress.order(Arrays.asList(
        "https://pocket.example.com",
        "http://192.168.1.7:41730/",
        "192.168.1.7",
        "nonsense without a host"));
    assertEquals(Arrays.asList(
        "http://192.168.1.7:41730/",
        "https://pocket.example.com:443/"), ordered);
  }
}
