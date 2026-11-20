// fork: Settings → Theme studio. Presets, schemes, fonts and layout of a theme.
export default {
  "Theme studio": "主题工作室",
  "Open theme studio": "打开主题工作室",
  "My schemes": "我的方案",

  // Presets and font choices (names of our own presets are translated; a person's schemes are not)
  Presets: "预设",
  Preset: "预设",
  Scheme: "方案",
  Published: "已发布",
  Terminal: "终端",
  "OLED Black": "OLED 纯黑",
  Paper: "纸张",
  Fjord: "峡湾",
  Tide: "潮汐",
  Clay: "陶土",
  Graphite: "石墨",
  Frosted: "毛玻璃",
  "Compact layout": "紧凑布局",
  "Humanist sans": "人文无衬线",
  Serif: "衬线",
  Monospace: "等宽",
  "SF Mono and Menlo": "SF Mono 和 Menlo",
  "Needs a background image": "需要背景图",
  "Hover to preview, click to use. Changing a preset afterwards saves your version as a scheme and leaves the preset as it is.":
    "悬停预览，点击使用。之后再改预设，会把你的版本存成一个方案，预设本身不变。",
  "{name} (mine)": "{name}（我的）",
  "{name} copy": "{name}（副本）",
  "Based on {name}": "基于{name}",
  "Saves as a new scheme": "将存为新方案",
  "Saves as a new scheme based on {name}": "将存为基于{name}的新方案",
  "Unsaved changes": "未保存的改动",
  Edited: "已调整",
  "Fonts and layout come from this theme.": "字体和布局来自这个主题。",
  "Fonts and layout come from your own settings.": "字体和布局来自你自己的设置。",
  "Restore to preset": "恢复为预设",
  "Revert unsaved changes": "还原未保存的改动",
  "Reset theme to default": "恢复默认",
  Apply: "应用",
  "Could not save the scheme. Browser storage may be unavailable or full.":
    "无法保存方案。浏览器存储可能不可用或已满。",

  "Light and dark use different themes. Picking or resetting a theme here replaces both. Editing changes only the light theme.":
    "亮色和暗色用的是不同的主题。在这里选择或恢复默认会同时替换两套，编辑只改亮色那一套。",
  "Light and dark use different themes. Picking or resetting a theme here replaces both. Editing changes only the dark theme.":
    "亮色和暗色用的是不同的主题。在这里选择或恢复默认会同时替换两套，编辑只改暗色那一套。",

  "Editing the dark palette": "正在编辑深色配色",
  "Editing the light palette": "正在编辑浅色配色",
  "All colors": "全部颜色",
  "Pick from the app": "从界面取色",
  "Click an area of the app to pick its color. Esc cancels.": "点击界面区域取色，Esc 取消",
  "Highlighting where “{label}” is used. Click anywhere or press Esc to go back.":
    "正在高亮“{label}”用在哪里。点击任意处或按 Esc 回到设置。",
  "Back to Settings": "回到设置",
  "theme color|Input": "输入框",
  "Every role the app paints, grouped. Changing one also updates the roles that follow it.":
    "应用用到的每个颜色角色，已分组。改一个，跟随它的角色也会一起变。",

  Fonts: "字体",
  "Your setting": "你的设置",
  "Overrides your font setting": "覆盖你的字体设置",
  "{title} font names": "{title}的字体名",
  "Georgia, serif": "Georgia, serif",
  "The font for the interface and messages. Fonts must be installed on this device.":
    "界面和消息使用的字体。字体需要已安装在这台设备上。",
  "The font for code blocks and diffs.": "代码块和差异使用的字体。",
  "Font sizes and your own fonts": "字号和你自己的字体",
  "Your own settings apply wherever the theme above leaves a font alone.":
    "主题没有指定字体的地方，使用你自己的设置。",

  Layout: "布局",
  "Corner radius": "圆角",
  Density: "密度",
  Shadow: "阴影",
  "How round corners are. 0 is square.": "圆角有多大。0 是直角。",
  "How much room there is between things. Lower is tighter.": "元素之间留多少空隙。越低越紧凑。",
  "How strong shadows are. 0 is flat.": "阴影有多重。0 是平的。",
  "How wide messages and the composer can grow.": "消息和输入框最宽能到多少。",
  "Overrides your chat width setting": "覆盖你的聊天宽度设置",
  "Set by the theme": "由主题指定",
  "“{theme}” sets the fonts and the chat width, so your own choices below only apply where it leaves them alone.":
    "“{theme}”指定了字体和聊天宽度，下面你自己的选择只在它没指定的地方生效。",
  "“{theme}” sets the fonts, so your own font choices below only apply where it leaves a font alone.":
    "“{theme}”指定了字体，下面你自己的字体选择只在它没指定字体的地方生效。",
  "“{theme}” sets the chat width, so the chat width below does not apply while it is in use.":
    "“{theme}”指定了聊天宽度，使用它期间下面的聊天宽度不生效。",

  "Background image": "背景图",
  "Panel glass": "面板毛玻璃",
  "This theme has a background image.": "这个主题有背景图。",
  "This theme has no background image. Ask an agent to set one with t3_theme_set, or copy a JPEG, PNG or WebP file of up to 16 MB next to the published theme file.":
    "这个主题没有背景图。可以让 agent 用 t3_theme_set 设一张，或把不超过 16 MB 的 JPEG、PNG 或 WebP 文件复制到已发布主题文件旁边。",
  "Makes the sidebar, header and composer see-through and blurs what is behind them. Only with a background image.":
    "让侧边栏、标题栏和输入框半透明，并模糊它们后面的内容。只在有背景图时生效。",

  "Add CSS": "添加 CSS",
  "Show CSS": "显示 CSS",
  "Hide CSS": "收起 CSS",
  "Saved with this scheme and included when you export it. Web and desktop only. Rules that load remote files are ignored.":
    "随这个方案一起保存，导出时也会带上。只在网页和桌面端生效。会加载远程文件的规则会被忽略。",

  "Scheme name": "方案名称",
  "Not applied yet": "尚未应用",
  "Export {name} as JSON": "把 {name} 导出为 JSON",
  "Nothing here yet. Change a preset above and your version is saved here.":
    "这里还没有内容。改一下上面的预设，你的版本就会存到这里。",
};
