package expo.modules.t3xunifiedpush

import org.unifiedpush.android.connector.data.PushEndpoint

/** The endpoint is a credential, so it lives in memory only; registering again returns it. */
internal object PushSubscription {
  data class Current(val endpoint: String, val p256dh: String?, val auth: String?)

  @Volatile var current: Current? = null
    private set
  @Volatile var failure: String? = null
    private set

  fun update(endpoint: PushEndpoint) {
    // A temporary endpoint belongs to a fallback distributor; wait for the primary one.
    if (endpoint.temporary) return
    current = Current(endpoint.url, endpoint.pubKeySet?.pubKey, endpoint.pubKeySet?.auth)
    failure = null
  }

  fun fail(reason: String) {
    current = null
    failure = reason
  }

  fun clear() {
    current = null
    failure = null
  }

  fun host(): String? = current?.endpoint?.let { runCatching { android.net.Uri.parse(it).authority }.getOrNull() }
}

/** Lets the service wake the JS side, when JS is the one watching. */
internal object PushEvents {
  @Volatile var listener: (() -> Unit)? = null
  fun changed() {
    listener?.invoke()
  }
}
