const { withAndroidManifest } = require("expo/config-plugins");

// Extends app.json. Android blocks plain http:// in installed builds by
// default, which would stop the "local" APK (eas.json) from reaching a
// backend running on a laptop over Wi-Fi/hotspot.
module.exports = ({ config }) =>
  withAndroidManifest(config, (manifestConfig) => {
    manifestConfig.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
    return manifestConfig;
  });
