# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Live Activity Updates** on iOS, **Agent Live Updates** on Android 16 and newer, or **Ongoing Agent Activity** on older Android versions to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off the same switch to stop future cards.

For activity without ordinary alerts on Android 8 or newer, leave **Ongoing agent activity** enabled and turn off **Agent alerts** in Android's notification settings for T3 Code. Activity updates continue, and the same card shows the finished result without a separate alert. On Android 16 and newer, the finished result remains a Live Update until dismissed or expired. Keep app-wide notification permission and **Live updates** enabled so Android can display it.

On iOS you can also add the **Agent Activity** widget to your Home Screen or Lock Screen. It shows the same agents as the Live Activity, using your T3 Connect sign-in. The widget refreshes when you open T3 and shows unfinished work as out of date after 10 minutes.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. If Live Updates don't appear on Android 16 or newer, check **Live Update Settings** in T3 Code's **Settings → Notifications**. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect, or on Android your own push server (see [Push without Google](#push-without-google)); a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Push without Google

On Android, T3 Extend can deliver the same alerts without T3 Connect, Firebase or Google Play services. Each environment sends its notifications to a push server you run, and a push app on your phone hands them to T3 Extend. You get an alert when an agent finishes, fails, needs approval, or asks for input, and tapping it opens the thread.

You need three things:

1. **A push server** that is reachable at a public address. [ntfy](https://ntfy.sh) works well and runs on the same server as your [self-hosted connection](../../infra/self-host/README.md), on its own address. Environments only push to public addresses: a push server on your LAN, on this machine or on your tailnet is refused, and so is a name that resolves to one.
2. **A push app on the phone** that speaks UnifiedPush. Install **ntfy** from F-Droid, open it, and in its settings set the default server to yours and sign in with the account you created for the phone.
3. **T3 Extend's setting.** Open **Settings → Notifications**, turn on **Push notifications**, and allow notifications. If one push app is installed it is chosen for you; if several are, pick one.

Once the push server answers, the screen shows the push app and the server's address (never the full endpoint), and each paired environment lists whether this phone is registered. Use **Send test notification** under an environment to check the whole path; the notification should arrive within a few seconds. If an environment shows **Not registered**, the line says why (it can't be reached, didn't answer, or refused the registration); an environment that can't be reached or doesn't answer is tried again automatically, and if one refused, turn **Push notifications** off and on again.

Some Android systems cut a push app's connection once it leaves the screen, so alerts stop arriving or the screen keeps waiting for the push server. On OPPO's ColorOS, open **Settings → Apps**, pick ntfy and then T3 Extend in turn, open **Battery management** and choose **Allow full background activity**.

How it works: the phone gives its endpoint and encryption keys to every environment it is paired with. An environment encrypts each alert for your phone before sending it, so the push server only ever sees ciphertext, and your phone decrypts it and shows it in its own language. A phone can only receive alerts for environments it is paired with, and each environment only alerts for its own threads.

Alerts follow the same rules as T3 Connect alerts: the thread already on screen stays quiet, and a finished run is announced once it stays finished. Removing an environment from the phone, switching it off, or revoking the phone's session in **Connections** stops its alerts. A push server that no longer knows the phone makes the environment forget it; turn **Push notifications** off and on again to register afresh.

If no push app is installed, the screen explains how to set one up. Notification permission and the alert channel are controlled in system Settings, and force-stopping the app in system Settings pauses delivery until you open it again.
