package expo.modules.t3xunifiedpush

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * What the distributor tells this app. The process may have been started just for this call, so
 * nothing here may depend on the JS runtime; it tells JS afterwards, if JS is running.
 */
class T3xPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    PushSubscription.update(endpoint)
    PushEvents.changed()
  }

  override fun onMessage(message: PushMessage, instance: String) {
    // Only messages the connector decrypted with this device's Web Push key are trusted content.
    if (message.decrypted) PushNotifications.receive(this, message.content)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    PushSubscription.fail(reason.name)
    PushEvents.changed()
  }

  override fun onUnregistered(instance: String) {
    PushSubscription.clear()
    PushEvents.changed()
  }
}
