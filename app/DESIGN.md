# Northstar design system v2 — "Star chart"

Northstar = navigation. The look is a calm instrument panel / star chart: precise, technical, human.
NOT the Sentient-OS look (no pure-black + rainbow glows + Cabinet Grotesk), and nothing that reads as "generic AI"
(no purple/pink, no rainbow conic glows, no gradient-text headlines, no glowing blobs, no sparkle emoji).
Exception: the floating desktop orb bubble (Bubble.tsx) keeps its current look.

## Color tokens
| Token | Value | Use |
|---|---|---|
| `--bg` | `#070B0F` | page background (deep ink navy, not pure black) |
| `--surface` | `#0D1318` | cards / windows |
| `--raised` | `#131B21` | inputs, nested blocks |
| `--line` | `rgba(148,180,200,0.12)` | hairlines, borders |
| `--line-strong` | `rgba(148,180,200,0.22)` | hover borders, dividers |
| `--ink` | `#EAF2F2` | primary text |
| `--warm` | `#C9D6DA` | secondary text (kept the token name for compatibility) |
| `--muted` | `#8C9DA7` | muted text |
| `--faint` | `#5B6B75` | labels, metadata |
| `--accent` | `#3DDC97` | **mint green** — primary actions, active states, "north star" |
| `--accent-ink` | `#04140D` | text on accent |
| `--blue` | `#4C9AFF` | secondary accent — links, calendar, info |
| `--cyan` | `#2BC3D8` | sparing tertiary (charts, network links) |
| `--warn` | `#F2B84B` | due soon / needs attention (amber, small doses) |
| `--danger` | `#F06464` | destructive only |

Rules: one accent per view (mint). Blue for info/links. Gradients only as very subtle background vignettes
(mint/blue at ≤6% opacity), never on text or buttons. Emphasis words in headlines = solid mint, not gradient.

## Type
- Headings: **Manrope** 600/700, letter-spacing -0.025em, line-height 1.1.
- Body: **Inter** 400/500, 15–17px, line-height 1.6.
- Labels / eyebrows / metadata / numbers: **JetBrains Mono** 500, 11–12px, uppercase, letter-spacing 0.08em.
- Google Fonts: `https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap`

## Shapes & surfaces
- Radius: cards 14px, inputs 10px, buttons 10px (not pills). Small chips 6px.
- Borders: 1px `--line`; hover `--line-strong`. Shadows minimal (`0 1px 0 rgba(255,255,255,.03) inset`, `0 12px 32px rgba(0,0,0,.35)`).
- Background texture: faint 48px grid (`rgba(148,180,200,0.04)` lines) + optional crosshair "+" marks at section corners.
- Window chrome: title row with a small mono label left (e.g. `INBOX / BRIEFING`) instead of macOS traffic-light dots.

## Components
- **Primary button**: solid mint bg, `--accent-ink` text, 10px radius, 600 weight, subtle hover lift; no glow.
- **Secondary button**: transparent, 1px `--line-strong` border, `--ink` text; hover bg `rgba(255,255,255,.04)`.
- **Focus ring**: 2px mint at 40% opacity.
- **Active nav item**: mint text + 2px mint underline/dot, not a glowing pill.
- **Status colors**: mint = done/good, amber = due soon, blue = info, red = destructive.

## Motion
Short and functional: 150–250ms ease-out fades/translates. No breathing glows. Respect prefers-reduced-motion.

## Hero / brand visual
Three.js **constellation network**: ~120–220 nodes in a slowly rotating 3D cloud, links drawn between near neighbours
(thin lines, opacity by distance), nodes mint/blue/cyan at low alpha, a handful of brighter "stars" softly twinkling,
and ONE brighter mint "north star" node. Mouse moves it gently (parallax). Pauses offscreen; static for reduced motion.
