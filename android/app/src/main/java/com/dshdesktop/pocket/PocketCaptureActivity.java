package com.dshdesktop.pocket;

import com.journeyapps.barcodescanner.CaptureActivity;

/**
 * The scanner, locked upright.
 *
 * The library declares its own `CaptureActivity` as `sensorLandscape`, so scanning on a phone forced a
 * sideways view and the user had to turn the device to read the prompt — a real complaint. Declaring a
 * subclass of our own with `android:screenOrientation="portrait"` is the way to get portrait without
 * fighting the manifest merger over the library's own activity.
 */
public class PocketCaptureActivity extends CaptureActivity {
}
