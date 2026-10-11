# screen-peek

A Claude Code mod that shows **what the model sees while it works**: every screenshot it receives (from Playwright, Chrome DevTools, or any MCP tool that returns images), and every image it opens with `Read`, appears live in a side panel.

Useful when Claude is working on another server (SSH, remote code) and taking screenshots you can't see.

<img width="1200" height="657" alt="Screen Recording 2026-10-10 at 2 20 33 PM" src="https://github.com/user-attachments/assets/fc901410-27f3-4694-88ae-42154905fe88" />

## Installation

In a Claude Code terminal session, type:

```
/plugin install screen-peek --marketplace gxrco/screen-peek
```

1. Enter `y` to add the `github:gxrco/screen-peek` marketplace.
2. Press Enter to install it at user scope (it will be active in all your sessions).
3. You'll see `Installed screen-peek. Plugin is now active.` It works right away, without a restart.

> The installation command works in the terminal. If you later use the desktop app, the mod installed there will also load.

## Usage

| Action | How |
| --- | --- |
| Open the panel | `/peek` (opens automatically with the first screenshot if the terminal is ≥ 144 columns wide) |
| Previous / next screenshot | `p` / `n` |
| Return to the latest screenshot | `l` |
| Open the screenshot in the system viewer | `o` |
| Collapse / expand browser activity | `a` |
| Refresh the displayed image | `r` |

While a screenshot is being taken, the panel shows an amber `◌ CAPTURING` indicator and the status bar shows `📸 capturing…`. Below the image is a log of browser activity (navigation, clicks, Playwright scripts).

The panel uses theme colors and a rounded preview frame, with a live/history indicator and image dimensions. The preview and activity list adapt to the panel size; collapse activity to give screenshots more room. Click the panel to use its keyboard shortcuts.

## Requirements and limitations

- Claude Code 2.1.296 or later (older versions don't load hook modules and show `Failed to load hooks … expected record`).
- **Viewing images in the panel** requires a terminal with the kitty graphics protocol: **Ghostty** or **kitty**. In other terminals (Warp, iTerm2, Terminal.app), the panel shows a notice, and you can open each screenshot in the system viewer with `o`.
- The panel renders **PNG files up to 2 MiB**. JPEG screenshots are listed but not rendered (request `type: "png"` when taking them).
- “Open” uses the macOS `open` command.
- Only images that reach the model appear. If Claude takes a screenshot with a script but never opens it, the model doesn't see it either.
- Each screenshot and its gallery index are saved in `/tmp/screen-peek/<session-id>/` (the latest 30 per session, across the 5 most recently used sessions in the plugin store; older screenshots and sessions are deleted from disk). The panel recovers saved screenshots when it is recreated or a session resumes, including when switching between local and installed copies of the mod. It also remembers the selected screenshot and activity visibility. Older screenshots without an index are recovered from their files. macOS periodically cleans `/tmp`.
- If the image goes blank after switching views, press `r` in the panel or run `/peek` to refresh it.

## Development

```
claude --plugin-dir ./screen-peek      # session with the mod loaded from this folder
claude plugin validate ./screen-peek   # validate the manifest, marketplace, and hooks
claude plugin test ./screen-peek       # run tests/*.test.ts
```

Structure:

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   enables installation with /plugin install
hooks/hooks.json                  points to the hooks module
hooks/register.tsx                logic: image capture and panel
types/index.d.ts                  mod state types
tests/screen-peek.test.ts         tests
```
