# Northstar design system (matched to sentient-os.ai, measured from the live site)

The goal is to look and feel like Sentient OS: pure black, cinematic, glowing, minimal. We match the visual language but use our own copy, logo and imagery, never Sentient's text, logo, screenshots or videos.

## Tokens (CSS vars in styles.css → Tailwind classes)

| Role | Value | Tailwind |
|---|---|---|
| Page bg | `#000000` | `bg-bg` |
| Window/card surface | `#0B0B0D` | `bg-surface` |
| Raised surface | `#141416` | `bg-raised` |
| Text | `#FFFFFF` | `text-ink` |
| Warm text (inside windows) | `#E8E5DF` | `text-warm` |
| Muted text | `#A5A5AD` | `text-muted` |
| Faint text | `#6E6E76` | `text-faint` |
| Hairline | `rgba(255,255,255,0.118)` | `border-line` |
| Glass fill | `rgba(255,255,255,0.05)` | `bg-glass` |
| Accent (one only) | `#E26D45` | `text-accent`, `bg-accent`, `border-accent` |
| Selected (warm gold) | bg `rgba(195,161,106,0.075)`, text `#F0E4D0`, inset ring `rgba(210,177,122,0.08)` | `.selected` utility |

## Type
- **Headings:** Cabinet Grotesk 500 (`font-display`), letter-spacing **-0.045em**, line-height 1.08. Hero 56–60px, section 40px, card title 22–26px. Two-line headings with a hard `<br/>`.
- **Body:** Satoshi 400/500 (`font-sans`). Lead 18px muted `#A5A5AD`; UI 14–15px; small 12px.
- **Eyebrow:** 12px, uppercase, letter-spacing 0.14em, faint. Numbered style "01 · SIDEKICK".
- Warm gradient word for emphasis: the last word of a headline can use `.text-glow` (white → `#F3C27A` → `#E26D45`).

## Components (all in `src/renderer/src/components/ui.tsx`)
- **GlassPill**: rounded-full, `bg-glass`, 0.8px border `#373737`, `backdrop-blur-[12px]`, padding 9.5px. Used for the top nav and segmented controls.
- **PrimaryButton**: white pill, black text, Satoshi 500 14–15px, padding 14px 20px, with a **rainbow glow** behind it (blurred conic gradient: orange, pink, purple, blue) that breathes slowly. One per screen.
- **SecondaryButton**: pill, `bg-white/6`, border `white/38`, white text.
- **Window**: the macOS-style app window from Sentient's Knowledge demo. 18px radius, `bg-surface`, hairline border, shadow `0 24px 80px rgba(0,0,0,.33)` + inset top highlight `inset 0 1px 0 rgba(255,255,255,.02)`. Optional title bar with three dim dots, an icon + title, a small "EXAMPLE"-style tag, and right-aligned meta.
- **GlowCard**: the "Proactive intelligence" card. Dark card with a soft orange/gold glowing border (box-shadow 0 0 0 1px rgba(226,109,69,.35), 0 0 40px rgba(226,109,69,.25)). Used for the most important item.
- **AppChip**: rounded-xl dark tile with an icon square + label (like the Notes / Emails / Calendar chips).
- **NumberedList**: rows "01 Finish applications"; the active row has a 1px accent left border, white text, and a number in accent; inactive rows are muted.
- **Stripes**: a diagonal-hatch divider band (repeating-linear-gradient 45deg, `rgba(255,255,255,.06)` 1px lines every 10px, with top and bottom hairlines).
- **AmbientGlow**: fixed background radial blooms at the top corners (blue `#3B5BFF`, pink `#FF3DA5`, orange `#FF8A3D`) at about 0.18 opacity, heavily blurred.

## 3D (Three.js, `src/renderer/src/three/`)
- **Orb.tsx**: the iridescent particle blob. About 12–20k points on a sphere, displaced by animated 3D noise in the vertex shader. The color comes from position: an orange → pink → purple → blue → cyan gradient that slowly rotates. Uses additive blending, small round points, and a soft bloom (a CSS radial glow behind the canvas is fine). It responds to `intensity` (0–1) and `speed` props, rotates slowly, is transparent, renders DPR ≤ 2, and pauses when hidden. `prefers-reduced-motion` gives a static frame.
- **Wormhole.tsx**: a white wireframe funnel (polar grid of rings and spokes, z displaced as 1/r) on black, with the camera slowly tilting. Used behind Focus mode and Onboarding.

## Motion
Framer-motion. Fades and rises take 200–400ms (`easeOut`), and headings stagger in by line. No bouncy springs. Respect `prefers-reduced-motion`.

## Layout
- No left rail. A top bar holds the **logo** on the left (a glowing ring orb plus "Northstar" in Cabinet 24px), a centered **GlassPill nav** (Now · Approve · Inbox · Knowledge, active = white text on `bg-white/10` pill, inactive = muted), and on the right a **PrimaryButton "Hand off a task"** with a `Ctrl Space` kbd hint. The top bar is a drag region, and buttons are no-drag. Leave 140px free on the far right for the Windows titlebar controls.
- Content width max 1120px, generous vertical rhythm (sections 96px apart).
