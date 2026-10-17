const { withAndroidManifest } = require("expo/config-plugins");

// Extends app.json. Android blocks plain http:// in installed builds by
// default, which would stop the "local" APK (eas.json) from reaching a
// backend running on a laptop over Wi-Fi/hotspot.
//
// APP_VARIANT=backup builds a second, separately installable app (own
// package id and name) so the Railway-backed backup APK can sit on the same
// phone as the local one. Unset = the normal app, unchanged.
module.exports = ({ config }) => {
  const isBackup = process.env.APP_VARIANT === "backup";
  const appConfig = isBackup
    ? {
        ...config,
        name: `${config.name} (Backup)`,
        android: { ...config.android, package: `${config.android.package}.backup` },
      }
    : config;

  return withAndroidManifest(appConfig, (manifestConfig) => {
    manifestConfig.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
    return manifestConfig;
  });
};
