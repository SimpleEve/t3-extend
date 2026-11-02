package expo.modules.t3xunifiedpush

import android.net.Uri
import org.json.JSONObject

/** One alert as the environment sent it: data only, formatted here in the phone's language. */
internal data class PushAlert(
  val id: String,
  val kind: String,
  val environmentId: String,
  val environmentLabel: String,
  val threadId: String,
  val threadTitle: String,
  val projectTitle: String
)

internal data class RenderedAlert(val title: String, val body: String)

internal object PushPresentation {
  const val APP_NAME = "T3 Extend"

  private val KINDS = setOf("approval", "input", "completed", "failed", "test")

  /** Used until the JS side has handed over its translated templates. */
  private val DEFAULT_TEMPLATES = mapOf(
    "approval" to ("{thread}" to "Approval needed · {project} · {environment}"),
    "input" to ("{thread}" to "Question for you · {project} · {environment}"),
    "completed" to ("{thread}" to "Finished · {project} · {environment}"),
    "failed" to ("{thread}" to "Failed · {project} · {environment}"),
    "test" to ("$APP_NAME test notification" to "Push notifications from {environment} work.")
  )
  const val DEFAULT_CHANNEL_NAME = "Agent alerts"

  fun parse(bytes: ByteArray): PushAlert? = try {
    val json = JSONObject(String(bytes, Charsets.UTF_8))
    val kind = json.optString("kind")
    val id = json.optString("id")
    if (json.optInt("v") != 1 || kind !in KINDS || id.isBlank()) {
      null
    } else {
      PushAlert(
        id = id,
        kind = kind,
        environmentId = json.optString("environmentId"),
        environmentLabel = json.optString("environmentLabel"),
        threadId = json.optString("threadId"),
        threadTitle = json.optString("threadTitle"),
        projectTitle = json.optString("projectTitle")
      )
    }
  } catch (_: Exception) {
    null
  }

  fun render(alert: PushAlert, templatesJson: String?): RenderedAlert {
    val templates = templatesJson?.let { runCatching { JSONObject(it) }.getOrNull() }
    val template = templates?.optJSONObject(alert.kind)
    val fallback = DEFAULT_TEMPLATES.getValue(alert.kind)
    val titleTemplate = template?.optString("title").orEmpty().ifBlank { fallback.first }
    val bodyTemplate = template?.optString("body").orEmpty().ifBlank { fallback.second }
    val title = fill(titleTemplate, alert).ifBlank { alert.projectTitle.ifBlank { APP_NAME } }
    return RenderedAlert(title.take(120), joinSegments(fill(bodyTemplate, alert)).take(240))
  }

  fun channelName(templatesJson: String?): String =
    templatesJson?.let { runCatching { JSONObject(it).optString("channelName") }.getOrNull() }
      .orEmpty().ifBlank { DEFAULT_CHANNEL_NAME }

  /** The same route the relay's notifications open, so one deep-link handler serves both. */
  fun route(alert: PushAlert): String =
    if (alert.kind == "test" || alert.environmentId.isBlank() || alert.threadId.isBlank()) {
      "/"
    } else {
      "/threads/${Uri.encode(alert.environmentId)}/${Uri.encode(alert.threadId)}"
    }

  private fun fill(template: String, alert: PushAlert): String = template
    .replace("{thread}", clean(alert.threadTitle))
    .replace("{project}", clean(alert.projectTitle))
    .replace("{environment}", clean(alert.environmentLabel))
    .trim()

  private fun clean(value: String) = value.replace(Regex("\\s+"), " ").trim()

  /** A missing project or environment leaves an empty segment; drop it instead of showing " ·  · ". */
  private fun joinSegments(text: String) =
    text.split(" · ").map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" · ")
}
