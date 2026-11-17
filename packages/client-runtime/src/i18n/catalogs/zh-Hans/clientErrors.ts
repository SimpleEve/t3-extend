// Fixed English text that client code puts in `new Error(...)`. Toasts and error lines look it up
// when they are shown (see localizeToastOptions in components/ui/toast.tsx and connectionErrorMessage).
export default {
  // Uploads and attachments
  "Upload failed": "上传失败",
  "Upload timed out": "上传超时",
  "Upload cancelled": "上传已取消",
  "Upload rejected ({status})": "上传被拒绝（{status}）",
  "The environment returned an invalid attachment URL.": "环境返回了无效的附件 URL。",
  "This message has an attachment that cannot be restored.": "这条消息的附件无法恢复。",
  "Could not restore attachment: {name}": "无法恢复附件：{name}",
  "The thread has changed. Select a message to rewind again.":
    "对话已变化。请重新选择一条消息来回退。",
  "Timed out waiting for the thread to rewind.": "等待对话回退超时。",
  "The captured window is too large to attach.": "截取的窗口太大，无法添加为附件。",
  "Remove an attachment, then try this capture again.": "请先移除一个附件，然后再试一次截取。",
  "The captured window could not be saved to the draft.": "无法把截取的窗口保存到草稿。",
  // Connections and integrations
  "SSH host or alias is required.": "需要填写 SSH 主机或别名。",
  "SSH port must be between 1 and 65535.": "SSH 端口必须在 1 到 65535 之间。",
  "Enter a backend host.": "输入后端主机。",
  "Browser profile data is not available to clear.": "没有可清除的浏览器资料数据。",
  "This connection cannot change device settings.": "此连接无法更改设备设置。",
  "The pull request is not available in this environment.": "此环境中没有该 PR。",
  "This environment does not support linking this pull request.": "此环境不支持关联该 PR。",
  "Link update interrupted.": "关联更新已中断。",
  "Unable to open link.": "无法打开链接。",
  "Unable to open System Settings.": "无法打开系统设置。",
  "This connection needs permission to view and manage T3 Connect settings.":
    "此连接需要查看和管理 T3 Connect 设置的权限。",
  "Wait until the current T3 Connect settings can be read.":
    "请等到可以读取当前的 T3 Connect 设置。",
  "Sign in to T3 Connect before enabling this.": "启用前请先登录 T3 Connect。",
  // Media
  "This media is unavailable. Try reopening the preview.": "此媒体不可用。请尝试重新打开预览。",
  "Reconnect to this environment and try again.": "请重新连接此环境后再试。",
  "The environment returned an invalid media URL.": "环境返回了无效的媒体 URL。",
  "Image copying is unavailable. Use a secure browser connection or save the image.":
    "无法复制图片。请使用安全的浏览器连接，或保存图片。",
  "Could not read image data.": "无法读取图片数据。",
  "Failed to read image.": "读取图片失败。",
  "Missing data URL payload.": "data URL 缺少内容。",
  "This inline media could not be decoded.": "无法解码此内嵌媒体。",
  "The file could not be fetched. The host may block browser access (CORS), or the connection may be unavailable.":
    "无法获取该文件。托管它的主机可能禁止浏览器访问（CORS），或者连接不可用。",
  "The file could not be fetched. Check the connection and try again.":
    "无法获取该文件。请检查连接后重试。",
  "The file could not be fetched (HTTP {status}).": "无法获取该文件（HTTP {status}）。",
  "This link returned a web page instead of media. Open the original URL.":
    "此链接返回的是网页而不是媒体。请打开原始 URL。",
  "The browser could not decode this image for copying. Try saving it instead.":
    "浏览器无法解码此图片来复制。请尝试保存。",
  "This image is too large or has no usable dimensions. Try saving it instead.":
    "此图片过大或没有可用的尺寸。请尝试保存。",
  "Image copying is unavailable in this browser.": "此浏览器无法复制图片。",
  "The image could not be converted to PNG.": "无法把图片转换为 PNG。",
  "This connection cannot upload attachments.": "无法通过这个连接上传附件。",
  "Uploaded file expired. Remove it and attach it again.": "已上传的文件已过期。请移除后重新添加。",
  "Uploaded file could not be verified. Retry when the server reconnects.":
    "无法验证已上传的文件。服务器重新连接后请重试。",
  "Unsupported image type": "不支持的图片类型",
  "Original file is no longer available": "原始文件已不可用",
  "Upload could not start": "无法开始上传",
  "Uploaded attachment could not be verified. Attach the file again.":
    "无法验证已上传的附件。请重新添加文件。",
  "Uploaded attachment expired. Remove it and attach it again.":
    "已上传的附件已过期。请移除后重新添加。",
  "Uploaded attachment could not be verified. Retry when the server reconnects.":
    "无法验证已上传的附件。服务器重新连接后请重试。",
} satisfies Record<string, string>;
