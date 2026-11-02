package expo.modules.t3xunifiedpush

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

/** Persistent, non-secret state. The endpoint and keys are never written here. */
internal object PushStore {
  private const val NAME = "t3x-unified-push"
  fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
}

/** Shows pushes natively, so they arrive with the JS runtime stopped. */
internal object PushNotifications {
  const val ALERT_CHANNEL = "agent-alerts"
  private const val TAG = "t3x-push"
  private const val TEST_ID = 73101
  private const val SEEN_LIMIT = 64
  private const val DEFAULT_SCHEME = "t3extend"

  @Volatile var threadOnScreen: String? = null

  @Synchronized
  fun receive(context: Context, content: ByteArray) {
    val prefs = PushStore.prefs(context)
    if (!prefs.getBoolean("enabled", false)) return
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val alert = PushPresentation.parse(content) ?: return

    // A retried push carries the same id and must not show twice.
    val seen = prefs.getString("seen", null)?.split('\n').orEmpty()
    if (alert.id in seen) return
    prefs.edit().putString("seen", (seen.takeLast(SEEN_LIMIT - 1) + alert.id).joinToString("\n"))
      .apply()

    val route = PushPresentation.route(alert)
    val resumed = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(
      Lifecycle.State.RESUMED
    )
    // The thread is already in front of the user, as with the relay's alerts.
    if (alert.kind != "test" && resumed && threadOnScreen == route) return

    val templates = prefs.getString("templates", null)
    val rendered = PushPresentation.render(alert, templates)
    ensureChannel(context, PushPresentation.channelName(templates), replaceName = false)
    val id = if (alert.kind == "test") TEST_ID else "${alert.environmentId}/${alert.threadId}".hashCode()
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    val notification = NotificationCompat.Builder(context, ALERT_CHANNEL)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_info)
      .setContentTitle(rendered.title)
      .setContentText(rendered.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(rendered.body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setDefaults(Notification.DEFAULT_ALL)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setShowWhen(true)
      .setWhen(System.currentTimeMillis())
      .setAutoCancel(true)
      // One notification per thread: a newer state replaces the older one.
      .setGroup(if (alert.kind == "test") TAG else "$TAG:${alert.environmentId}/${alert.threadId}")
      .setContentIntent(
        contentIntent(context, prefs.getString("scheme", null) ?: DEFAULT_SCHEME, route, id)
      )
      .build()
    context.getSystemService(NotificationManager::class.java).notify(TAG, id, notification)
  }

  /** Creates the channel, or renames it when the interface language changed. */
  fun ensureChannel(context: Context, name: String, replaceName: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(ALERT_CHANNEL)
    if (existing == null || (replaceName && existing.name?.toString() != name)) {
      manager.createNotificationChannel(
        NotificationChannel(ALERT_CHANNEL, name, NotificationManager.IMPORTANCE_HIGH)
      )
    }
  }

  fun clear(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.activeNotifications.filter { it.tag == TAG }.forEach { manager.cancel(it.tag, it.id) }
  }

  private fun contentIntent(
    context: Context,
    scheme: String,
    route: String,
    id: Int
  ): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: return null
    intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$scheme:/$route"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
