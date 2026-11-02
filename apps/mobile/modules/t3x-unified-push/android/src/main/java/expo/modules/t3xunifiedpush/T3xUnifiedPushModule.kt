package expo.modules.t3xunifiedpush

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.unifiedpush.android.connector.UnifiedPush

class T3xUnifiedPushModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("T3xUnifiedPush")

    Events("onChange")

    OnCreate {
      PushEvents.listener = { sendEvent("onChange", mapOf<String, Any?>()) }
    }

    OnDestroy {
      PushEvents.listener = null
    }

    // Everything the settings screen shows. Never includes the endpoint itself, only its host.
    Function("getState") {
      val ctx = context
      val distributors = UnifiedPush.getDistributors(ctx).filter { it != ctx.packageName }
      val subscription = PushSubscription.current
      mapOf(
        "enabled" to PushStore.prefs(ctx).getBoolean("enabled", false),
        "distributors" to distributors.map { mapOf("id" to it, "label" to label(ctx, it)) },
        "distributor" to UnifiedPush.getSavedDistributor(ctx),
        "endpointHost" to PushSubscription.host(),
        "hasKeys" to (subscription?.p256dh != null && subscription.auth != null),
        "failure" to PushSubscription.failure
      )
    }

    // The registration to hand to each environment, or null until the distributor answered.
    Function("getSubscription") {
      PushSubscription.current?.let {
        if (it.p256dh == null || it.auth == null) {
          null
        } else {
          mapOf("endpoint" to it.endpoint, "p256dh" to it.p256dh, "auth" to it.auth)
        }
      }
    }

    Function("setEnabled") { enabled: Boolean ->
      val ctx = context
      PushStore.prefs(ctx).edit().putBoolean("enabled", enabled).apply()
      if (!enabled) PushNotifications.clear(ctx)
    }

    Function("selectDistributor") { distributor: String ->
      UnifiedPush.saveDistributor(context, distributor)
    }

    // Safe to repeat: the distributor answers again with the endpoint, which JS waits for.
    Function("register") {
      val ctx = context
      if (UnifiedPush.getSavedDistributor(ctx) != null) {
        UnifiedPush.register(ctx, "default", PushPresentation.APP_NAME)
      }
    }

    Function("unregister") {
      val ctx = context
      UnifiedPush.unregister(ctx, "default")
      UnifiedPush.removeDistributor(ctx)
      PushSubscription.clear()
    }

    // The translated templates for the current interface language, kept for the receiver.
    Function("setTemplates") { templates: String, scheme: String ->
      val ctx = context
      PushStore.prefs(ctx).edit().putString("templates", templates).putString("scheme", scheme)
        .apply()
      PushNotifications.ensureChannel(ctx, PushPresentation.channelName(templates), true)
    }

    Function("setThreadOnScreen") { path: String? ->
      PushNotifications.threadOnScreen = path
    }
  }

  private fun label(ctx: Context, packageName: String): String = try {
    val manager = ctx.packageManager
    manager.getApplicationLabel(manager.getApplicationInfo(packageName, 0)).toString()
  } catch (_: Exception) {
    packageName
  }
}
