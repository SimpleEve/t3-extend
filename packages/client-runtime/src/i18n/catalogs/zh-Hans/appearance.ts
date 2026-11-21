// Settings → Appearance: language, themes, interface, typography.
export default {
  Language: "语言",
  "Choose the language of menus, settings, and labels.": "选择菜单、设置和标签使用的语言。",
  language: "语言",

  // Colors and themes
  "Colors & themes": "颜色与主题",
  "Color scheme": "配色模式",
  Themes: "主题",
  "Appearance mode": "外观模式",
  "Follow the system appearance": "跟随系统外观",
  "Use light mode": "使用浅色模式",
  "Use dark mode": "使用深色模式",
  "Remove theme": "移除主题",
  "Remove themes": "移除主题",
  "Remove themes from {collection}": "从 {collection} 移除主题",
  "Remove themes from “{collection}”?": "从“{collection}”移除主题？",
  "Select the variants you want to remove. You can restore them by importing the extension again.":
    "选择要移除的变体。可再次导入扩展来恢复。",
  "You can bring it back anytime by importing its JSON file.": "随时可通过导入其 JSON 文件恢复。",
  "Remove selected": "移除所选",
  "Remove selected ({count})": "移除所选（{count}）",
  "Use {theme} theme, currently active": "使用 {theme} 主题，当前正在使用",
  "Use {collection}, {theme} variant, currently active":
    "使用 {collection} 的 {theme} 变体，当前正在使用",
  "Use the first variants for light and dark": "使用第一个浅色和深色变体",
  "Use for both light and dark": "同时用于浅色和深色模式",
  "Use for light mode only": "仅用于浅色模式",
  "Use for dark mode only": "仅用于深色模式",
  "Couldn’t save theme selection": "无法保存主题选择",
  "Couldn’t remove theme": "无法移除主题",

  Interface: "界面",
  Contrast: "对比度",
  contrast: "对比度",
  "Adjust the contrast of colors and borders across the interface.": "调整界面颜色和边框的对比度。",
  "Glass opacity": "毛玻璃不透明度",
  "Higher values make menus, dialogs, and the composer more solid.":
    "数值越高，菜单、对话框和输入框越不透明。",
  "Chat width": "聊天宽度",
  "chat width": "聊天宽度",
  "Set how wide messages and the composer can grow on large screens.":
    "设置大屏幕上消息和输入框的最大宽度。",
  Comfortable: "适中",
  "Comfortable (default)": "适中（默认）",
  Wide: "宽",
  Full: "全宽",
  "Thread details": "对话详情",
  "thread details": "对话详情",
  "Choose what the thread details card shows. You can also right-click the card.":
    "选择对话详情卡片显示的内容，也可以右键点击卡片来设置。",
  "Thread details: {enabled} of {total} on": "对话详情：已启用 {enabled}/{total} 项",
  "Effort display": "推理强度显示",
  "Show reasoning effort in the composer as its name, such as High, or as bars.":
    "在输入框中用名称（如 High）或条形显示推理强度。",
  Word: "文字",
  "Word (default)": "文字（默认）",
  Bars: "条形",
  "Render math": "渲染数学公式",
  "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.":
    "在消息和 Markdown 预览中排版 LaTeX 公式，如 $x^2$ 或 \\[x^2\\]。输入框中仍可编辑 TeX 源码。",
  "Panel animations": "面板动画",
  "Set how fast panels open and close.": "设置面板展开与收起的速度。",
  "Panel animation duration": "面板动画时长",
  "Replay panel animation preview": "重播面板动画预览",
  "Environment identification": "环境标识",
  "Choose how Dev and Nightly environments are identified.":
    "选择开发版与 Nightly 环境的标识方式。",
  "Show Dev or Nightly artwork in the sidebar header.": "在侧边栏顶部显示开发版或 Nightly 背景图。",
  "Only built-in themes show artwork.": "仅内置主题支持背景图。",
  "Only built-in themes show artwork, so this theme shows the version pill.":
    "仅内置主题支持背景图，因此当前主题显示版本标签。",
  Artwork: "背景图",
  "Nightly artwork": "Nightly 背景图",
  "Dev artwork": "开发版背景图",
  "Version pill": "版本标签",
  None: "无",
  "Composer context": "输入框上下文",
  "Keep branch and worktree controls below the composer after a thread starts.":
    "对话开始后，仍在输入框下方显示分支和 worktree 控件。",
  "Keep composer context visible in active threads": "在活跃对话中保持输入框上下文可见",

  Typography: "字体排版",
  "Interface font": "界面字体",
  "Everything outside code blocks and the terminal.": "代码块和终端以外的界面。",
  "Interface font size": "界面字号",
  "Prompt font": "提示词字体",
  "Only the box you write prompts in. Mono works well here.":
    "仅用于输入提示词的文本框，适合使用等宽字体。",
  "Prompt font size": "提示词字号",
  "Code font": "代码字体",
  "Code blocks, diffs, and file previews.": "代码块、差异和文件预览。",
  "Code font size": "代码字号",
  "Terminal font": "终端字体",
  "Terminal output, independent from code blocks and diffs.":
    "终端输出，与代码块和差异视图独立设置。",
  "Terminal font size": "终端字号",
  "Monospace font": "等宽字体",
  "Code blocks, diffs, file previews, and the terminal.": "代码块、差异、文件预览和终端。",
  "{title} family": "{title} 字体",
  "Separate fonts": "分别设置字体",
  "Set the prompt, code, and terminal fonts separately instead of one monospace font.":
    "分别设置提示词、代码和终端字体，而非共用一种等宽字体。",
  "Font smoothing": "字体平滑",
  "Use thinner grayscale text smoothing instead of the macOS default.":
    "使用更细的灰度文字平滑，替代 macOS 默认效果。",
  "Word wrap": "自动换行",
  "Wrap long lines in code blocks, diffs, and file previews by default.":
    "默认对代码块、差异和文件预览中的长行自动换行。",
  "Wrap code, diffs, and file previews by default": "默认对代码、差异和文件预览自动换行",

  // Theme cards and variant pickers
  "Light and dark theme variants": "浅色与深色主题变体",
  "Use {theme} for light mode, currently active": "浅色模式使用 {theme}，当前正在使用",
  "Use {theme} for dark mode, currently active": "深色模式使用 {theme}，当前正在使用",
  "Prompt font preview": "提示词字体预览",
  "Terminal font preview": "终端字体预览",
} satisfies Record<string, string>;
