---
name: Vesper
description: Self-hosted, end-to-end encrypted messaging and voice for communities
colors:
  midnight-base: "#0d0f1a"
  twilight-primary: "#141625"
  twilight-secondary: "#1c1f33"
  twilight-tertiary: "#262a42"
  star-light: "#e8e6f0"
  star-dim: "#b8b5c8"
  star-muted: "#9490a8"
  star-faint: "#817d93"
  evening-gold: "#c8a24e"
  evening-gold-press: "#b8922e"
  evening-gold-dim: "#5c4d2a"
  dusk-violet: "#8b7ec8"
  dusk-violet-press: "#7b6eb8"
  signal-error: "#f87171"
  signal-success: "#34d399"
typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.2rem, 4vw, 3.3rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "normal"
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.9rem"
    fontWeight: 750
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.06em"
rounded:
  xs: "3px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "18px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.evening-gold}"
    textColor: "{colors.midnight-base}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.evening-gold-press}"
  button-primary-disabled:
    backgroundColor: "{colors.evening-gold-dim}"
    textColor: "{colors.star-faint}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.star-light}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost-hover:
    backgroundColor: "{colors.twilight-secondary}"
  button-destructive:
    backgroundColor: "{colors.signal-error}"
    textColor: "{colors.midnight-base}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  input-default:
    backgroundColor: "{colors.twilight-secondary}"
    textColor: "{colors.star-light}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  input-focus:
    backgroundColor: "{colors.twilight-secondary}"
    textColor: "{colors.star-light}"
  chip-unread:
    backgroundColor: "{colors.evening-gold}"
    textColor: "{colors.midnight-base}"
    rounded: "{rounded.pill}"
    padding: "2px 6px"
---

# Design System: Vesper

## 1. Overview

**Creative North Star: "The Evening Star"**

Vesper is named for Venus at dusk: the reliable point of warm light that appears before full dark. The visual system answers to that name. The palette is not dark-for-dark's-sake; it is midnight navy warmed by gold, a sky that happens to be private. Every surface decision should be explicable by that scene: this is where trustworthy conversations happen, after the noise has settled.

The density is Discord-familiar but notched up. Tighter hierarchy, more deliberate color, cleaner component geometry. A Discord user should feel immediately oriented, then notice after a minute that everything looks a bit more considered. The product never foregrounds encryption or security in its visual layer — that confidence is expressed through calm and precision, not through lock icons and warning copy.

This system rejects three failure modes by name: the clinical austerity of Signal and Telegram (institutional gray, zero warmth, every surface screaming "security tool"); the noise of Discord itself (saturated color everywhere, cartoonish roundness, badge overload); and the generic dark-mode SaaS aesthetic (purple gradient backgrounds, glass stacked on glass, glow for the sake of glow).

**Key Characteristics:**
- Two-accent palette: Evening Gold (primary) and Dusk Violet (secondary) against deep navy neutrals
- Restrained elevation: flat tonal layering by default; glass and glow reserved for primary moments only
- System UI font stack; hierarchy through weight and scale contrast, not typeface personality
- Precise and restrained interactive feel: state changes signal without performing
- Ghost borders at 8% white opacity as the default surface boundary
- Encryption is infrastructure, not UI; the interface never waves its security credentials

## 2. Colors: The Evening Palette

A two-accent palette: warm gold as the primary signal, soft violet as harmonic secondary, against a deep navy field that runs from near-black to dark blue-gray. The palette is warm where it counts and controlled everywhere else.

### Primary
- **Evening Gold** (`#c8a24e`): The accent. Primary buttons, active channel indicators, unread badges, focus rings, and hover-state text links. Never decorative; always functional. Its rarity is its meaning.
- **Evening Gold (Press)** (`#b8922e`): Hover and active state for gold elements. Deepens on interaction; never lightens.
- **Evening Gold (Disabled)** (`#5c4d2a`): Disabled primary elements. Same hue, collapsed chroma; readable as the same color family without implying availability.

### Secondary
- **Dusk Violet** (`#8b7ec8`): Secondary accent. Mention highlights, system-generated states (incoming call ring, notification pulse), and harmonic presence in landing-page gradients. Never competes with gold in the same component.
- **Dusk Violet (Press)** (`#7b6eb8`): Hover state for violet elements.

### Neutral
- **Midnight Base** (`#0d0f1a`): The deepest surface. The app frame: the column behind sidebars, the space behind everything.
- **Twilight Primary** (`#141625`): Primary panel surface. Main content column, sidebar background, settings panels.
- **Twilight Secondary** (`#1c1f33`): Secondary surface. Input backgrounds, hovered channel rows, message group hover.
- **Twilight Tertiary** (`#262a42`): Raised surface. Selected states, active list items, drag targets.
- **Star Light** (`#e8e6f0`): Primary text. Warm off-white; not pure white. Body copy, primary labels.
- **Star Dim** (`#b8b5c8`): Secondary text. Timestamps, metadata, helper text.
- **Star Muted** (`#9490a8`): Muted text. Placeholder copy, tertiary labels, unfocused channel names.
- **Star Faint** (`#817d93`): Faint text. Disabled labels, system annotations, secondary timestamps.
- **Ghost Border** (`rgba(255,255,255,0.08)`): Default border. Implies boundary without weight. The system's quietest line.

### Status
- **Signal Error** (`#f87171`): Destructive actions, error messages, failed states.
- **Signal Success** (`#34d399`): Confirmed actions, online presence, positive system feedback.

### Named Rules

**The Evening Star Rule.** Evening Gold appears on no more than 10% of any given screen. Primary buttons, active channel indicators, unread badges, focus rings. That is the complete list. Gold used for decoration, hover backgrounds, or emphasis outside this list is wrong. Its rarity is the point.

**The Ghost Border Rule.** Default borders are `rgba(255,255,255,0.08)`. They divide without interrupting. If a boundary needs to be more visible, reach for a background-color shift (twilight-secondary), not a higher-opacity border.

**The Violet Harmony Rule.** Dusk Violet is a supporting color, not a second primary. It should not appear in interactive states that already use gold. The two accents operate in different contexts: gold for action and status; violet for mention, ring, and pulse.

## 3. Typography

**Font Stack:** System UI (`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`)

The product runs system fonts. This is deliberate: Vesper is infrastructure, not a magazine. System fonts feel native to the operating system, eliminate FOUT, and reinforce that the interface is a tool that gets out of the way. Hierarchy comes from weight and scale contrast, not from typeface personality.

**Character:** Sober, functional, precise. Headlines are heavy; body is regular; labels use the uppercase-with-tracking register as a categorization layer. Type does not perform; it organizes.

### Hierarchy
- **Display** (800 weight, `clamp(2.2rem, 4vw, 3.3rem)`, line-height 1.02): Voice room headers, modal titles at maximum scale. Appears rarely; each instance must earn it.
- **Headline** (750 weight, 1.9rem, line-height 1.1, letter-spacing -0.01em): Auth shell welcome text, settings page section titles, large confirmation dialogs.
- **Title** (700 weight, 1.15rem, line-height 1.4): Panel headers, server names, channel group titles in expanded view.
- **Body** (400 weight, 0.95rem, line-height 1.6): Message content, form helper text, descriptive copy. Line length capped at 65-75ch in reading contexts.
- **Label** (700 weight, 0.72rem, letter-spacing 0.06em, uppercase): Channel category headers, section dividers, badge text, compact form labels. The app's annotation layer.

### Named Rules

**The System Font Rule.** No display or decorative typefaces in the product surface. The landing page uses Bebas Neue and Barlow; that is a different register for a different surface. The app is system-native by design and must stay that way.

**The Label Register Rule.** Anything that categorizes or divides uses the label register: uppercase, 700 weight, 0.72-0.76rem, 0.04-0.08em letter-spacing. This register is consistent across channel headers, section labels, status chips, and badge text. Mixing sentence-case body copy into this role reads as an error.

**The Weight Contrast Rule.** Adjacent typographic levels must differ by at least one full weight step (400 to 600, or 600 to 700/800) and a minimum 1.25x size ratio. Flat type scales are prohibited.

## 4. Elevation

This system is **flat by default**. Depth is conveyed through tonal layering: midnight-base as the deepest layer, twilight-primary as the panel layer, twilight-secondary as the raised layer, twilight-tertiary as the selected/active layer. Each step is visibly lighter. Surfaces lift tonally; they do not lift with shadows at rest.

Glass (backdrop-blur + semi-transparent dark background) and glow (gold ambient box-shadow) are reserved for exactly two categories:

1. **Overlay moments**: The auth shell, modals, and the floating call overlay. These exist above the interface plane and earn the visual treatment that signals that.
2. **Primary action signal**: The primary gold button carries an ambient gold glow. It is the one surface in the product that glows, because that is how the eye finds the primary action.

### Shadow Vocabulary
- **Glass Surface** (`background: rgba(28,31,51,0.8); backdrop-filter: blur(16px); box-shadow: 0 8px 32px rgba(0,0,0,0.3)`): Auth shell panels, modals. Signals that this surface is above the product plane.
- **Modal Drop** (`box-shadow: 0 14px 36px rgba(8,9,20,0.52)`): Dialogs appearing over the main surface. Grounding shadow; deeper and tighter than glass.
- **Gold Ambient** (`box-shadow: 0 0 20px rgba(200,162,78,0.3)`): Primary button at rest. The one instance of decorative glow; it is functional because it draws the eye to the primary action.
- **Gold Ambient (Hover)** (`box-shadow: 0 0 28px rgba(200,162,78,0.45)`): Primary button hovered. Intensifies; the bloom grows toward the hand.
- **Focus Ring** (`box-shadow: 0 0 0 2px rgba(200,162,78,0.15)`): Keyboard focus on interactive elements. Tight, barely-visible gold outline. Not a glow; a signal.

### Named Rules

**The Flat-By-Default Rule.** Surfaces at rest carry no shadow. Depth is tonal. Glass appears only when a surface is genuinely above the interface plane (auth shell, modals, call overlay). Glow appears only on the primary action button. A glowing card that is not a primary action is a mistake.

**The One Glow Rule.** At most one element on any given screen carries the gold ambient glow: the primary action button. If a second glowing element appears, one of them is wrong.

## 5. Components

### Buttons

Precise and restrained. State changes communicate readiness; they do not perform. The primary button's gold glow is the single theatrical element; everything else is clean.

- **Shape:** Gently rounded (8px / `rounded.md`). Not pill-shaped; not square. Primary buttons do not round up to match panel curves.
- **Primary:** Evening Gold background (`#c8a24e`), near-black text (`#0d0f1a`), `10px 20px` padding, 700 weight. Gold ambient glow at rest (`0 0 20px rgba(200,162,78,0.3)`). Hover: gold deepens to `#b8922e`, glow intensifies to `0 0 28px rgba(200,162,78,0.45)`. Transition: `background 0.2s ease-out, box-shadow 0.2s ease-out`.
- **Ghost / Secondary:** Transparent background, `star-light` text, `twilight-secondary` background on hover. Same radius and padding. 1px ghost border in auth contexts.
- **Destructive:** `signal-error` background or `signal-error` text on ghost variant, depending on context severity.
- **Disabled:** `evening-gold-dim` background for primary; `star-faint` text; no glow, no hover response. `cursor: not-allowed`.

### Inputs / Fields

- **Style:** `twilight-secondary` background, 1px ghost border (`rgba(255,255,255,0.08)`), `rounded.md` (8px), body text size (0.95rem), `star-light` text.
- **Focus:** Border shifts to `evening-gold`; focus ring appears (`0 0 0 2px rgba(200,162,78,0.15)`). Transition `border-color 0.2s ease-out, box-shadow 0.2s ease-out`.
- **Error:** Border shifts to `signal-error`; error copy appears below in `label` register at `signal-error` color.
- **Disabled:** `star-faint` text, opacity reduced, `cursor: not-allowed`, no focus response.
- **Placeholder:** `star-muted` color. Never `star-faint`; placeholders must be readable.

### Cards / Containers

- **Panels** (sidebar, main column, settings): `twilight-primary` background, no border at rest, no shadow. The darker `midnight-base` frame behind them implies the boundary.
- **Elevated containers** (message group hover, list item focus): `twilight-secondary` background. Background shift is the hover signal; no border is added.
- **Selected containers:** `twilight-tertiary` background. No accent color unless unread (then gold badge only).
- **Glass modal:** `rgba(28,31,51,0.8)` background, `backdrop-filter: blur(16px)`, `box-shadow: 0 8px 32px rgba(0,0,0,0.3)`, `rounded.xl` (16px). Reserved for auth shell, modals, call overlay.
- **Never** nest rounded cards inside rounded cards.

### Navigation (Server Rail)

The leftmost column. Server avatars at 40x40px: `rounded.xl` (16px) at rest, transitioning to `rounded.lg` (12px, squircle effect) on hover and active (`border-radius 0.18s ease`). Active server carries a 2px gold pill indicator centered on the left edge (`evening-gold` fill, `rounded.pill`). This left-edge pill is the single controlled exception to the no-side-stripe rule: it is geometric, sized, and carries precise intent.

### Channel List (Sidebar)

- **Default:** `star-muted` text at label scale. No background.
- **Hover:** `twilight-secondary` background, `star-dim` text.
- **Active / Selected:** `twilight-tertiary` background, `star-light` text. No accent color.
- **Unread:** `star-light` text at 600 weight; gold unread badge (`chip-unread` component, `evening-gold` background, `midnight-base` text, `rounded.pill`).
- **Category headers:** Label register (uppercase, 0.72rem, 700 weight, `star-faint` color). Expand/collapse chevron.

### Message Composer

Full-width, `twilight-secondary` background, `rounded.xl` (16px), 1px ghost border. Slate.js rich-text editor inside; placeholder in `star-muted`. Formatting toolbar and emoji/attachment actions as icon buttons: `star-faint` at rest, `star-light` on hover, `twilight-tertiary` background on hover. Send button uses primary button treatment at compact scale.

### Avatar / Presence

- **Avatars:** Circular (`rounded.pill`, 50%). Colored background with 2-letter initial for servers; photo/custom for users.
- **Presence dot:** 10px, `rounded.pill`. Online: `signal-success`. Offline / invisible: `twilight-tertiary`. The dot has a 2px `midnight-base` ring as separation from underlying surface.

### Signature Component: Active Server Indicator

The gold left-edge pill on the server rail is Vesper's most distinctive UI element. Its geometry: `width: 4px; height: 16px; border-radius: 999px; background: #c8a24e; position: absolute; left: 0; top: 50%; transform: translateY(-50%)`. It expands to `height: 32px` on hover and to `height: 40px` when the server is active. Transition: `height 0.18s ease-out`. This is the one place a side-edge element is intentional and permitted.

## 6. Do's and Don'ts

### Do:
- **Do** keep Evening Gold to no more than 10% of any screen surface. Primary buttons, active states, unread badges, focus rings. That is the list.
- **Do** use tonal layering (midnight-base to twilight-primary to twilight-secondary to twilight-tertiary) as the primary depth signal before reaching for any shadow.
- **Do** use the label register (uppercase, 700 weight, 0.72rem, 0.06em tracking) for anything that categorizes or divides: channel headers, section titles, status chips, badge text.
- **Do** reserve glass for overlay surfaces that are genuinely above the interface plane (auth shell, modals, call overlay), and glow for the primary action button only.
- **Do** use `star-light` (`#e8e6f0`) for primary text. Never pure white (`#ffffff`).
- **Do** signal hover state with a background fill shift (to `twilight-secondary` or `twilight-tertiary`), not a border color change.
- **Do** keep focus rings tight and gold: `box-shadow: 0 0 0 2px rgba(200,162,78,0.15)`. Visible enough to navigate by; unobtrusive enough not to shout.
- **Do** cap message content line length at 65-75ch in reading contexts.
- **Do** pair any color-only state change with a secondary signal (text weight, icon, label) for accessibility.

### Don't:
- **Don't** use gradient text (`background-clip: text` with a linear gradient). The gold-to-violet gradient in landing page contexts is brand register only. It is prohibited inside the product surface.
- **Don't** use glassmorphism as a default card or list item style. Glass is for auth shell, modals, and call overlay. A glass card in the channel list or settings is wrong.
- **Don't** add glow to any element that is not the primary action button. No glowing hover cards, no glowing icons, no ambient gold on containers.
- **Don't** make this look like Signal or Telegram. No institutional grays, no clinical minimalism, no surfaces that feel like a security tool rather than a community space.
- **Don't** make this look like Discord. No blurple, no purple-dominant palettes, no oversaturated accent everywhere, no cartoonish border-radius on primary surfaces, no badge overload.
- **Don't** use any generic dark-mode SaaS pattern: no purple gradient backgrounds, no hero-metric layouts (big number, small label, gradient accent), no identical icon-heading-text card grids.
- **Don't** introduce decorative or display typefaces in the product surface. System UI only. Bebas Neue and Barlow Condensed belong to the landing page.
- **Don't** use `border-left` or `border-right` wider than 1px as a colored accent stripe on cards, list items, or callouts. The server rail's active pill is a controlled exception with specific geometry; nothing else qualifies.
- **Don't** nest rounded cards inside rounded cards.
- **Don't** foreground encryption, security, or privacy in UI copy or visual chrome. The product's trustworthiness is expressed through calm and precision, not through shield icons and "encrypted" labels.
