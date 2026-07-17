---
name: workbuddy-skin
description: Skin the WorkBuddy desktop app — set a background wallpaper, switch a frosted-glass theme, or drop in a portrait/idol "fan edition" image. Reversible, no official files touched. Use when the user wants to change WorkBuddy's look, wallpaper, background, theme, glass style, or add a custom character/立绘 to WorkBuddy (换肤 / 换背景 / 换壁纸 / 换主题 / 立绘 / 应援皮肤).
argument-hint: "[wallpaper path | theme id | portrait path]"
allowed-tools: Bash(workbuddy-skin:*), Bash(npx:*), Bash(node:*)
---

# WorkBuddy Skin

Drive the `workbuddy-skin` CLI to restyle the WorkBuddy desktop app via loopback CDP
injection. It layers a wallpaper + frosted-glass CSS (and an optional decoration /
portrait layer) on top of the running app. Nothing in WorkBuddy's install is modified;
everything is reversible with `restore`.

This skill is **thin**: it only decides which CLI command to run and explains the
result. All real work lives in the CLI.

## Running the CLI

Pick whichever resolves in the current environment (prefer the first that works):

- Published / linked: `workbuddy-skin <args>`  or  `npx workbuddy-skin <args>`
- From a checkout of the repo: `node bin/workbuddy-skin.mjs <args>`
  (run from the `workbuddy-skin/` project root)

On Windows PowerShell, separate chained commands with `;` (not `&&`).

## First run

```bash
workbuddy-skin install     # locates WorkBuddy + seeds bundled themes
workbuddy-skin apply       # launches (if needed) + injects the current theme
```

If WorkBuddy is already running WITHOUT a debug port, `apply` will ask for `--restart`.

## Common tasks — map the user's ask to one command

| User wants… | Command |
|---|---|
| Just change the background image | `workbuddy-skin bg set "<image>"` |
| Remove the wallpaper (back to gradient) | `workbuddy-skin bg clear` |
| Switch the glass look / color scheme | `workbuddy-skin theme use <id>` |
| List available themes | `workbuddy-skin theme list` |
| Add a portrait / idol image ("fan edition") | `workbuddy-skin theme use portrait-fan` then `workbuddy-skin portrait set "<image>"` |
| Replace the portrait | `workbuddy-skin portrait set "<image>"` |
| Remove the portrait | `workbuddy-skin portrait clear` |
| See current state | `workbuddy-skin status` |
| Undo everything | `workbuddy-skin restore` |

Bundled theme ids include `aurora-glass`, `midnight`, `mono`, `sakura`, and
`portrait-fan` (the decoration/portrait template). Use `theme list` to confirm.

## Image guidance (say this to the user)

- **Wallpaper**: any `jpg/png/webp/gif`. Big files are fine — the CLI auto-compresses
  oversized images on import (wallpaper → JPEG) so the data-URI never exceeds the CSS
  limit. Just hand it the original.
- **Portrait**: use a **transparent-background PNG**, ideally a **vertical** half/full
  body cut-out — the slot is a portrait-orientation card in the bottom-right corner. The
  CLI keeps PNG (preserves alpha) and only downscales if huge.
- A horizontal poster/banner is a **wallpaper**, not a portrait — route it to `bg set`.

## Behavior notes

- Changes to a live session hot-reload (no restart) when a debug port is already up.
- The wallpaper/portrait/theme persist; later `apply` reuses them automatically.
- Decorations (title banner, signature, stickers, portrait) show only on the home
  screen and auto-hide inside a task conversation.
- Legal: ship no celebrity images. `portrait-fan` is a blank template — the user
  supplies their own portrait via `portrait set`.

## Troubleshooting

- **Background looks like the default gradient / didn't take**: the image was likely too
  large before auto-compression landed, or decoding failed. Re-run `bg set`; the CLI now
  warns if an inlined asset is still oversized.
- **"running WITHOUT a debug port"**: re-run `apply --restart`.
- **Verify**: `workbuddy-skin status` shows the active theme, wallpaper, portrait, and
  whether the skin is currently live.
