# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Language

Choose **Settings → General → Language** to show the interface in English, Simplified Chinese
(简体中文), or one of the other listed languages. The change applies right away, including the
desktop app's menus. **System default** uses your system language when it is one of these, and
English otherwise. Each device or browser keeps its own choice.

Features only T3 Extend has are translated into Simplified Chinese and show in English in the other
languages. Your threads, project names, and agent replies are never translated.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Theme studio

On web and desktop, open **Settings → Theme studio**, or choose **Open theme studio** in the command
palette (**Cmd+Option+Shift+T** on macOS, **Ctrl+Alt+Shift+T** on Windows/Linux). It changes more than
colors: a theme can also set fonts, corner radius, spacing, shadows, chat width and see-through
panels. The two pages split the work: **Settings → Appearance** is where you choose which theme to
use, and the studio is where themes are made and changed. Appearance's **Edit in Theme Studio**
button and the **Edit** and **Duplicate** buttons on a theme card open the studio, and the studio
links back to Appearance.

The page goes from top to bottom: **Presets**, **My schemes**, **Colors**, **Fonts**, **Layout**,
**Background** and **Custom CSS**. Hover a preset to preview it and click to use it. Changes you make
preview live as you drag a slider or pick a color.

Most presets are whole looks, not just palettes: type, borders, message shapes and decoration come
with them. Broadsheet (newsprint and rules), Swiss grid, Brutalist, Blueprint, Manuscript, Retro
windows, Ink wash and Neon each carry their own fonts, borders and message shapes, and Terminal does the
same in green on black. Docs and Quiet page are plain reading layouts and have a dark
version. Editor, One Dark, Solarized, GitHub and Nord are plain editor-style palettes with no
decoration, each with a light and a dark half. Mochi is a soft cream-and-pink look with round
corners, with a plum dark half. omp copies the look of the omp terminal agent: a monospace font,
your message as a full-width block, thinking in dim italics, and each tool call as a small bordered
card whose color shows whether it is running, done or failed. Its dark half is omp's titanium theme
and its light half is omp's light theme. Presets only use fonts already installed on your device, so on a machine without them
(Windows or Linux, for example) a close fallback shows instead. Some presets add small text to the
chat, such as the label above your message. It is in Chinese when the interface is in Chinese, and in
English in every other language. That text is decoration: copying a message does not include it and
screen readers skip it.

Change anything about a preset and it becomes an unsaved draft; the preset itself never changes.
Choose **Save as my scheme…**, give it a name, and it is kept in **My schemes** and in Appearance. Every
save is a new scheme, so you can keep several versions of one preset side by side; a preset card says
how many versions of yours it has. When you change a scheme you already saved, **Save** writes over it
and **Save as new scheme…** keeps the original and makes another. **Revert unsaved changes** drops the
edits, and **Restore to preset** puts a scheme's colors, fonts and layout back to its preset. **Reset
theme to default** goes back to the standard T3 theme without deleting your schemes. If you pick
another theme with unsaved changes, the studio asks whether to save, discard or keep editing. If a
preset a scheme was made from is ever retired, the scheme keeps working and only **Restore to preset**
goes away.

If you set a different theme for light and dark in Appearance, the studio edits the one in use and
leaves the other alone. Picking a preset or **Reset theme to default** replaces both, and the studio
says so above the presets.

**All colors** under **Colors** lists every color role the app paints. To find the color of a part
of the app, choose **Pick from the app**. Settings hides for a moment so you can see the whole app; click
that part and Settings comes back with **All colors** open at the role it uses, and where the app
uses that color is highlighted. **Esc** cancels. **My schemes** lists your
schemes: use, rename, duplicate, export as JSON or delete one, or **Import** a T3 Code or VS Code theme.
Importing a theme happens here, not in Appearance.
**Duplicate** on a theme card makes an independent copy to edit.

### Fonts and layout

A theme's fonts and chat width win over your own settings while that theme is in use, and the
studio and Appearance say so. Where a theme leaves a font or the chat width alone, your own
settings apply: the first choice in each font list is **Follow Appearance setting**. The lists
show your installed fonts, each in its own face, and you can type to search them. The first time you
open one, your browser may ask to see your installed fonts. If it does not, or cannot, the list
shows the common fonts your device has. The code font list only has fixed-width fonts. Fonts have to
be installed on your device; a theme never downloads one. Font sizes are not part of a theme: they
stay in **Settings → Appearance → Typography**, and the studio links there. **Panel glass** makes the sidebar, header and composer see-through and blurs what is behind them. It only
has an effect while the theme has a [background image](#background-image).

### Custom CSS

For a change that colors and the layout controls cannot make, open **Custom CSS** in the theme studio.
The CSS is saved with the theme, applies after T3 Code's own styles on web and desktop, and is
included in exports. Use
`.dark` or `:root:not(.dark)` to target one appearance.

Custom CSS cannot load files. `@import`, `image-set()`, and `url()` are ignored, except `url()`
with a `data:` address or an `#id`. This keeps an imported theme from sending what is on your screen
to another site. For a full-size image, use a [background image](#background-image).

Class names in the app change between releases. For rules that keep working, target `data-slot`
and other `data-` attributes, such as `[data-chat-header]` or `[data-slot="button"]`.

If a rule hides something you need, run `t3 theme set t3-chat` on the server to switch to a
built-in theme, or press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to pick
another theme.

### Ask an agent

An agent on the same machine as the server can restyle T3 Code for you. Ask it to change the look,
for example "make T3 Code's chat header taller" or "give T3 Code a solarized theme". It publishes
an [environment theme](#environment-themes) with colors, CSS and a look, and web and desktop clients of that
server switch to it. It can also switch them to light, dark, or system mode. The thread must run
in Full access. Ask the agent to set a built-in theme to undo it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. With the desktop app's local environment off, they come from the
[background service](./background-service.md) on the same machine while the app is connected to
it. app.t3.codes and other connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette and look as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, T3 Code falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from T3 Code into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3 Code
generates the rest. The optional `colors` overrides use the names in the theme studio's **All colors**
view. An optional `css` string adds [custom CSS](#custom-css). An optional `look` object sets what
the studio's **Fonts** and **Layout** sections set:

```json
{
  "look": {
    "fontUi": "\"Iowan Old Style\", Georgia, serif",
    "fontCode": "Menlo, monospace",
    "radius": 4,
    "density": 95,
    "shadow": 50,
    "chatWidth": "wide",
    "glass": 40
  }
}
```

Every field is optional, and the numeric fields are whole numbers: `radius` 0 to 24 (px), `density` 80 to 120 (% of normal
spacing), `shadow` 0 to 200 (% of normal), `glass` 0 to 100 (% see-through, with a background
image) and `chatWidth` `comfortable`, `wide` or `full`. `background` is the 64-digit hash of an
image stored with the studio's **Choose image…**; leave it to the studio. Font names are separated by commas and may
not contain `;`, `(`, `{` or `/`. Mobile ignores a look. A theme file with an out-of-range value is
not published.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

### Background image

A theme can have a full-size background image. In the theme studio, open **Background** and choose
**Choose image…**: a JPEG, PNG, or WebP file of up to 16 MB. The server keeps the image, so the
other browsers and desktop apps connected to the same server show it too once they have the
scheme. **Remove** takes it off the scheme. The server keeps the file, because other schemes may
use the same picture. Up to 64 images are kept; to free space, delete files from the `backgrounds`
folder inside the server's `themes` directory.

An exported scheme records the image's name, a hash of its bytes, but does not contain the picture.
Importing it on a browser connected to the same server shows the image; on another server the
image is missing until you choose it again. Mobile ignores a theme's look, background included.

A published theme can also have a background image by file: save a JPEG, PNG, or WebP file of up to
16 MB beside the theme file, `nightfall.jpg` beside `nightfall.json`, or ask an agent, for example
"use ~/Pictures/wallpaper.jpg as T3 Code's background". The theme's CSS decides where the image
shows:

```css
[data-workspace-area="conversation"] {
  background: var(--theme-background-image) center / cover no-repeat;
}
```

Delete the image file to remove it. An image chosen in the studio wins over a file beside the theme.
