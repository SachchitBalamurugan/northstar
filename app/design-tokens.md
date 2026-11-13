# Northstar design tokens (from sentient-os.ai, fetched 2026-11-13)

## Fonts
- Sentient headings: Cabinet Grotesk (most used). Body: Satoshi. Both come from Fontshare, not Google Fonts.
- Also loaded there: Inter, Instrument Serif, Geist, IBM Plex Mono, Arimo.
- Northstar keeps Inter (sans) + Instrument Serif (serif accents). Both are on Sentient's font list and on Google Fonts, so no font change.

## Palette (Sentient is dark-first: --background #000, --foreground #fff)
| Role | Light | Dark | Source |
|---|---|---|---|
| bg | #FAFAF9 | #0B0B0E | site uses #000 / #0b0b0e |
| surface | #FFFFFF | #121316 | #121316 |
| soft | #F2F2F3 | #16171B | between #141722 and #121316 |
| ink | #0B0B0E | #F5F5F7 | #f5f5f7 / #fff |
| muted | #5F616D (~5.9:1 on bg) | #8A8D98 (~5.9:1 on bg) | --muted #8a8d98, #5f616d |
| line | #E6E6E6 | #20232B | #e6e6e6, #20232b |
| accent | #E26D45 | #E26D45 | --primary #e26d45 |
| accent-ink | #0B0B0E (~6.5:1 on accent) | #0B0B0E | white on #e26d45 is only ~3.2:1 |

Decorative only, not tokens: the brand gradient (#fde2a3 -> #ff8e3c ...) and the multi-hue graphic colors (#ff4646, #9b48d4, #4a90e2, #e8388f).

## Radii
- Sentient values: 999px pills (buttons/chips), 5px, 9px, 12px, 18px.
- Token: --radius 12px for cards. Use rounded-full for buttons and chips.

## Type
- Sizes scale with the viewport (vw-based --textN). Tailwind defaults: xs 12 / sm 14 / base 16.
- Headings are tightly tracked: -0.025em to -0.045em (most often -0.035em). Uppercase labels use +0.08em to +0.1em.
- Mono labels: IBM Plex Mono.

## Notes
- The look is restrained: near-black, one warm orange accent, hairline borders, lots of negative space.
- Put dark text on the accent, not white.
