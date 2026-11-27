# Mobile notifications

Get push alerts, Live Activities, and home-screen widgets on iOS and Android when agents finish, fail, or need your approval or input.

## Prerequisites

- Sign in to **T3 Connect** on both your phone and host machine (direct/Tailscale connections alone do not deliver background push notifications). On Android you can use [your own push server](#push-without-google) instead.
- Enable **Publish agent activity** in **Settings → Sharing & access** on the host.
- Enable **Device Notifications** in **Settings → Notifications** on mobile (Android requires Android 7.0+ and Google Play services).

## Live updates and widgets

- **Live progress**: Enable **Live Activity Updates** (iOS), **Agent Live Updates** (Android 16+, check **Live Update Settings** if missing), or **Ongoing Agent Activity** (older Android). Finished results stay visible for up to 15 minutes.
- **Silent live updates (Android 8+)**: Keep **Ongoing agent activity** on and disable **Agent alerts** in Android system notification settings.
- **iOS widget**: Add the **Agent Activity** widget to your Home Screen or Lock Screen (refreshes when you open T3; marks unfinished work stale after 10 minutes).

## Notes

- Ordinary alerts are muted while the mobile app is in the foreground, though viewing a thread on another device does not silence your phone.
- Force-stopping T3 Extend in Android system Settings pauses push delivery until you reopen the app.

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
