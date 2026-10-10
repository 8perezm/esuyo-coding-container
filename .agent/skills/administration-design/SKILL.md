---
name: administration-skill
description: Build professional web administration interfaces (admin panels, dashboards, back-office UIs). Use when the user asks for an admin panel, admin dashboard, back-office UI, management interface, or any internal tool with navigation, data tables, and user controls.
---

# Administration Interface Skill

Build professional, accessible web administration interfaces following the layout, typography, theming, and component conventions defined below.

Style all interfaces with **Tailwind CSS** and **shadcn**: use utility classes in markup backed by the design tokens in this skill (see § 4.0), and build interactive components (buttons, dialogs, dropdowns, tabs, tables, forms) from shadcn primitives styled with those tokens. Do not write ad-hoc hardcoded values when a token-backed utility exists.

---

## 1. Layout Specification

The layout consists of three zones:

### 1.1 Top Header Bar

- A fixed-height (typically 56–64 px) horizontal bar spanning the full viewport width at the top of the page.
- Contains the **brand logo / brand name** on the left side, rendered in the **brand font**.
- Optional right-side elements: theme toggle button, notification icon, breadcrumbs.
- Background is a solid surface colour from the current theme; a subtle bottom border separates it from the rest of the page.

### 1.2 Left Sidebar Navigation

- A vertical column pinned to the left side of the viewport, typically 240–280 px wide.
- Extends from below the header bar to the bottom of the viewport.
- Contains a list of navigation items (links), each with an optional icon and label.
- One item is always marked as the **active state**, highlighted with the accent colour.
- The sidebar background is a slightly different surface shade than the main content area to create visual separation.

### 1.3 Profile Block (Bottom of Sidebar)

- Pinned to the **bottom** of the left sidebar using flexbox (`margin-top: auto` or `position: sticky`).
- Displays the **user's email address** as the visible trigger.
- When the user **hovers** over the email, **focuses it via keyboard** (Tab), or **clicks** it, a dropdown menu appears below/right of the email showing actions such as:
  - **Edit profile**
  - **Preferences**
  - **Log off**
- The dropdown uses `aria-expanded`, `aria-haspopup="menu"`, and proper keyboard handling (Escape to close, arrow keys to navigate).
- The profile block sits above any scrollable content in the sidebar so it remains visible.

### 1.4 Main Content Area

- Occupies the remaining viewport space to the right of the sidebar and below the header.
- Scrollable; contains whatever pages/widgets the admin application needs (stat cards, data tables, forms, charts, etc.).
- Padding typically 24–32 px on all sides.

---

## 2. Typography Specification

#### Brand Text Size

The brand text (logo / brand name in the header) renders at `--font-size-brand: 30px` — about 50% larger than the previous 20 px baseline. On very narrow screens the brand text may scale down slightly but must stay clearly larger than body text.

Use exactly **three Google Fonts**, each with a defined fallback stack:

| Role | Font Family | Weights & Usage | Fallback Stack |
|------|-------------|-----------------|----------------|
| **Brand** (logo / brand text in header) | **Patua One** | 400 only (single weight on Google Fonts) | `Patua One, Georgia, 'Times New Roman', serif` |
| **Headings** (`h1`–`h6`) | **Space Grotesk** | 700 for h1/h2; 600 for h3/h4; 500 for h5/h6 | `Space Grotesk, system-ui, -apple-system, sans-serif` |
| **Body** (default / paragraph text) | **Manrope** | 400/500/600/700 | `Manrope, system-ui, -apple-system, sans-serif` |

### Loading

Import via `@import` in CSS or `<link>` in HTML:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Patua+One&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### CSS Custom Properties for Fonts

```css
--font-size-brand: 30px;
--font-brand: 'Patua One', Georgia, 'Times New Roman', serif;
--font-heading: 'Space Grotesk', system-ui, -apple-system, sans-serif;
--font-body: 'Manrope', system-ui, -apple-system, sans-serif;
```

---

## 3. Theming Specification

Implement **light theme** and **dark theme** using CSS custom properties scoped to a root selector (e.g., `[data-theme="light"]` and `[data-theme="dark"]`, or a `.theme-light` / `.theme-dark` class on `<html>`).

### 3.1 Palette Philosophy

- The core palette is **black, white, and greys only**.
- A **small accent palette (2–3 hues)** is allowed for key interactive elements: primary buttons, active navigation state, focus rings, and selected states.
- All other UI elements (cards, tables, dividers, backgrounds) use grayscale values.

### 3.2 Grayscale Ramp

Define a 10-step grayscale ramp from `--gray-50` (near-white) to `--gray-900` (near-black):

| Token | Light Theme | Dark Theme | Purpose |
|-------|-------------|------------|---------|
| `--gray-50` | `#FAFAFA` | `#18181B` | Page background (light) / main surface (dark) |
| `--gray-100` | `#F4F4F5` | `#27272A` | Card background / sidebar surface |
| `--gray-200` | `#E4E4E7` | `#3F3F46` | Borders, dividers |
| `--gray-300` | `#D4D4D8` | `#52525B` | Disabled borders, subtle lines |
| `--gray-400` | `#A1A1AA` | `#71717A` | Placeholder text, secondary labels |
| `--gray-500` | `#71717A` | `#A1A1AA` | Muted text |
| `--gray-600` | `#52525B` | `#D4D4D8` | Body text (light theme) |
| `--gray-700` | `#3F3F46` | `#E4E4E7` | Heading text (light theme) |
| `--gray-800` | `#27272A` | `#FAFAFA` | Strong emphasis (dark theme body) |
| `--gray-900` | `#18181B` | `#FFFFFF` | Brand text, high contrast (dark theme heading) |

### 3.3 Accent Colours (Palette)

Use a small accent palette (2–3 hues) with variants. The primary accent is mandatory; secondary/tertiary accents are optional but must each ship a full variant set.

#### Primary Accent (Blue)

| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#2563EB` (blue-600) | Primary buttons, active nav, focus rings |
| `--accent-hover` | `#1D4ED8` (blue-700) | Hover state on accent elements |
| `--accent-active` | `#1E40AF` (blue-800) | Active / pressed state |
| `--accent-light` | `#DBEAFE` (blue-100) | Subtle backgrounds for selected items |
| `--accent-focus-ring` | `rgba(37, 99, 235, 0.4)` | Focus ring shadow |

#### Secondary Accent (Violet)

| Token | Value | Usage |
|-------|-------|-------|
| `--accent-secondary` | `#7C3AED` (violet-600) | Secondary primary buttons, secondary active nav |
| `--accent-secondary-hover` | `#6D28D9` (violet-700) | Hover state on secondary accent elements |
| `--accent-secondary-active` | `#5B21B6` (violet-800) | Active / pressed state on secondary accent |
| `--accent-secondary-light` | `#EDE9FE` (violet-100) | Subtle backgrounds for secondary selected items |
| `--accent-secondary-focus-ring` | `rgba(124, 58, 237, 0.4)` | Focus ring shadow for secondary accent |

> The accent palette (max 3 hues) is the **only** hue family permitted on the page. All other colours must come from the grayscale ramp.

> Every accent hue must meet WCAG AA (≥4.5:1) for text/foreground use on the surfaces it appears against.

> **Accent discipline — what counts as a "key interactive element"**:
> - ✅ Allowed: primary buttons, active navigation state, focus rings, selected states.
> - ❌ Not allowed: avatar circles, status badges, stat-change indicators, decorative elements.
>   These must use grayscale tokens or purpose-built contrast-safe colours.

> **Important**: Do not set `color: var(--accent)` on global `<a>` selectors, as this will override component-specific link colors (e.g., nav links should use `--text-secondary`, not the accent). Set link colors per-component instead.

### 3.4 Semantic Tokens

Derive semantic tokens from the palette. **Important**: `--text-muted` is adjusted per-theme to meet WCAG AA (≥4.5:1) contrast against its background — it does NOT directly map to `--gray-400` in the raw ramp.

```css
/* Light theme */
[data-theme="light"] {
  --bg-surface:     var(--gray-50);
  --bg-card:        var(--gray-100);
  --bg-sidebar:     var(--gray-100);
  --bg-header:      #FFFFFF;
  --text-primary:   var(--gray-800);
  --text-secondary: var(--gray-600);
  --text-muted:     #404047;          /* 9.85:1 on #FAFAFA ✓ */
  --border-color:   var(--gray-200);
  --shadow-sm:      0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md:      0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
}

/* Dark theme */
[data-theme="dark"] {
  --bg-surface:     #121212;
  --bg-card:        #1E1E1E;
  --bg-sidebar:     #181818;
  --bg-header:      #181818;
  --text-primary:   #E4E4E7;
  --text-secondary: #D4D4D8;
  --text-muted:     #A8A29E;          /* 6.61:1 on #1E1E1E ✓ */
  --border-color:   #3F3F46;
  --shadow-sm:      0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md:      0 4px 6px -1px rgba(0, 0, 0, 0.45), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
}
```

> **Note**: The raw grayscale ramp (`--gray-400` = `#A1A1AA`, `--gray-500` = `#71717A`) remains in `:root` for reference, but semantic tokens (`--text-muted`, `--text-secondary`) use adjusted values when the raw ramp fails WCAG AA against the surface it sits on.

---

## 4. Design Guidelines

### 4.0 Styling with Tailwind CSS and shadcn

All styling **MUST use Tailwind CSS**, and interactive components **MUST use shadcn**. Utility classes are the primary styling mechanism; the CSS custom properties in this skill remain the single source of truth for token values.

- **Map tokens into the Tailwind theme** so utilities resolve to them. Extend `fontFamily`, `fontSize`, `colors`, `spacing`, `borderRadius`, and `boxShadow` from the tokens defined in § 2–§ 4.3:

```js
// tailwind.config.js — utilities resolve to the skill's design tokens
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        brand: ['var(--font-brand)'],
        heading: ['var(--font-heading)'],
        body: ['var(--font-body)'],
      },
      colors: {
        surface: 'var(--bg-surface)',
        card: 'var(--bg-card)',
        sidebar: 'var(--bg-sidebar)',
        header: 'var(--bg-header)',
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
        border: 'var(--border-color)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          active: 'var(--accent-active)',
          soft: 'var(--accent-soft)',
        },
      },
    },
  },
}
```

- **Prefer utilities over custom CSS**: layout, spacing, typography, and colour in markup should use Tailwind classes (e.g. `bg-card text-primary font-body`) instead of one-off stylesheets or inline styles.
- **Reusable components** (buttons, cards, nav items, tables — see § 5) belong in `@layer components` in the main stylesheet, composed from utilities with `@apply` where the build supports it.
- **Use shadcn primitives** for interactive components: button, dialog/modal, dropdown-menu (profile menu), tabs, table, input, label, badge, and theme toggle. shadcn components MUST consume this skill's token-backed theme (§ 4.0 mapping) — never shadcn's default theme values. Behavioural requirements (keyboard handling, ARIA, focus management in § 4.5; touch targets in § 4.6) still apply on top of shadcn's built-in accessibility.
- **No hardcoded values** for colours, fonts, spacing, radii, or shadows when a token-backed utility exists. Arbitrary values (e.g. `text-[#ff0000]`) are not allowed.
- Keep the `[data-theme="light"]` / `[data-theme="dark"]` token scoping from § 3; with the `darkMode` selector above, `dark:` variants follow the same toggle (persisted via `localStorage`).

### 4.1 Spacing Scale

Use an 8 px base grid. Common values:

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | 4 px | Tight spacing, icon padding |
| `--space-sm` | 8 px | Small gaps, button padding |
| `--space-md` | 16 px | Standard gap between elements |
| `--space-lg` | 24 px | Section padding, card padding |
| `--space-xl` | 32 px | Page padding, large gaps |
| `--space-2xl` | 48 px | Major section separation |

### 4.2 Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4 px | Input fields, small badges |
| `--radius-md` | 8 px | Cards, buttons, dropdowns |
| `--radius-lg` | 12 px | Large cards, modals |
| `--radius-full` | 9999 px | Avatar circles, pill badges |

### 4.3 Shadows

Use subtle shadows sparingly:

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
--shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
--shadow-dropdown: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.06);
```

In dark theme, increase shadow opacity to compensate for the darker background.

### 4.4 Interaction States

| State | Behaviour |
|-------|-----------|
| **Hover** | Slightly darken surface (light theme) or lighten surface (dark theme). Accent elements shift to `--accent-hover`. |
| **Focus** | Visible focus ring using `--accent-focus-ring` with `outline: 2px solid var(--accent)` and `outline-offset: 2px`. Use `:focus-visible` to avoid showing rings on mouse clicks. |
| **Active** | Accent elements shift to `--accent-active`; surfaces press down with a subtle inner shadow. |
| **Disabled** | Opacity 0.4–0.5; cursor `not-allowed`; no hover effects. |

> **Profile dropdown tip**: When implementing the profile dropdown, clear any pending hover timers on keyboard interaction (Enter/Space) to prevent race conditions where the hover timer reopens a menu that was just closed via keyboard. Also, use `visibility: hidden` without a CSS transition on it — the visibility property jumps instantly, while opacity/transform transitions provide the smooth fade effect.

### 4.5 Accessibility

- **WCAG AA contrast**: All text must meet at least 4.5:1 contrast ratio against its background in both themes. Verify with the grayscale tokens defined above.
- **Focus management**: The profile dropdown must trap focus while open and return it to the trigger on close.
- **ARIA attributes**:
  - Profile trigger: `role="button"`, `aria-haspopup="menu"`, `aria-expanded="false"` (toggled to `"true"` when open).
  - Dropdown menu: `role="menu"`, each item `role="menuitem"`.
  - Use `aria-label` or `aria-labelledby` for icon-only buttons.
- **Keyboard navigation**:
  - Enter / Space activates the profile trigger.
  - Escape closes the dropdown.
  - Arrow keys navigate between menu items.
  - Tab moves focus out of the dropdown and into the main content.
- **Screen readers**: Ensure all interactive elements have accessible names. Use `aria-current="page"` on the active nav item.

### 4.6 Responsive & Smartphone Requirement

All implementations **MUST be responsive and usable on smartphones**.

On narrow viewports (≤ 768 px):

- The sidebar collapses into a hamburger-triggered overlay drawer.
- The header bar retains the brand text and hamburger toggle.
- The profile block remains inside the drawer at the bottom.
- Main content takes full width with standard padding.
- Navigation items stack vertically in the drawer.

Additional mobile requirements:

- Touch targets must be ≥ 44×44 px on mobile (nav links, buttons, icon buttons, profile trigger).
- No page-level horizontal scrolling — wide tables scroll inside their own container.
- Stat cards collapse to a single column at ≤ 480 px.
- The header retains the brand text and hamburger toggle.

---

## 5. Component Checklist

When building an admin interface, ensure these components are present and styled:

| Component | Requirements |
|-----------|-------------|
| **Nav item** | Icon + label, hover background shift, `aria-current="page"` when active, minimum 44×44 px hit area |
| **Active nav state** | Left accent border (3 px) or full accent background; text colour shifts to `--accent` |
| **Primary button** | Background `--accent`, white text, `--radius-md`, hover → `--accent-hover`, focus ring via `--accent-focus-ring` |
| **Secondary button** | Transparent background, `--text-primary` text, `--border-color` border, hover → subtle surface fill |
| **Card** | `--bg-card` background, `--border-color` border, `--shadow-sm`, `--radius-md`, padding `--space-lg` |
| **Data table** | Header row with `--bg-card` background, alternating row backgrounds (gray-50 / gray-100), bottom border on each row, hover highlight on rows |
| **Profile dropdown** | Trigger shows email + chevron icon; dropdown appears below/right of trigger with `--shadow-dropdown`; items: Edit profile, Preferences, Log off; keyboard and hover support |
| **Theme toggle** | Button in header that switches between light and dark; persists choice in `localStorage`; icon changes (sun/moon) |
| **Touch targets** | All interactive elements must have ≥ 44×44 px hit areas on smartphones (nav links, buttons, icon buttons, profile trigger). |

---

## 6. Verification Checklist

Before considering an admin interface complete, verify every item:

- [ ] **Layout**: Header bar at top, left sidebar navigation, main content area to the right, profile block pinned at bottom-left.
- [ ] **Header**: Brand logo/name rendered in the brand font (Patua One).
- [ ] **Sidebar**: Navigation items present with icons and labels; one item marked active.
- [ ] **Profile block**: Email address visible at bottom of sidebar; hovering or focusing reveals a dropdown menu.
- [ ] **Dropdown menu**: Contains "Edit profile", "Preferences", "Log off"; closes on Escape or click-outside; updates `aria-expanded`.
- [ ] **Typography**: Three distinct Google Fonts applied — Patua One for brand, Space Grotesk for headings, Manrope for body text.
- [ ] **Tailwind CSS**: Styling uses Tailwind utilities mapped to the design tokens (§ 4.0); no hardcoded colours, fonts, spacing, radii, shadows, or arbitrary values.
- [ ] **shadcn**: Interactive components (buttons, dialogs, dropdowns, tabs, tables, forms) are built from shadcn primitives styled with the skill's tokens, not shadcn defaults.
- [ ] **Themes**: Both light and dark themes work; toggle button switches between them; default is light theme; theme persisted via `localStorage`.
- [ ] **Colour discipline**: Page is predominantly black/white/greys; accent palette of ≤3 hues used only on key interactive elements (primary buttons, active nav, focus rings, selected states).
- [ ] **Accessibility**: WCAG AA contrast in both themes; focus-visible rings visible; keyboard navigable; ARIA attributes correct.
- [ ] **Responsive & mobile**: Fully usable on smartphones; ≥44 px touch targets; no page-level horizontal scroll.
- [ ] **Brand text size**: Brand text renders at `--font-size-brand` (≈30 px), ~50% larger than the previous baseline.
- [ ] **Interactions**: Hover, focus, active states all have visual feedback; disabled states are clearly disabled.

---

## 7. Reference Files

When building an admin interface, read and use the following reference files located in the `references/` directory:

| File | Purpose |
|------|---------|
| `references/fonts.css` | Google Fonts `@import` for the three fonts plus utility classes and CSS custom properties for font families. |
| `references/theme.css` | Complete CSS custom property definitions for both light and dark themes — grayscale ramp, accent colour variants, semantic tokens, spacing, radius, and shadows. |
| `references/layout.html` | Semantic HTML skeleton: header bar with logo slot, left sidebar with nav list, and pinned profile block with dropdown menu markup (including ARIA attributes). |
| `references/profile-menu.js` | Vanilla JavaScript for the profile dropdown: hover-to-open, focus-to-open, click-outside / Escape to close, keyboard arrow navigation, and `aria-expanded` toggling. |

### Usage Instructions

1. **Start from `references/layout.html`** as your HTML skeleton.
2. **Import `references/fonts.css`** in your `<head>` or via `@import` in your main stylesheet.
3. **Import `references/theme.css`** after fonts.css; it defines all design tokens.
4. **Configure Tailwind CSS** per § 4.0: set `darkMode: ['selector', '[data-theme="dark"]']`, extend the theme from the tokens, and keep the `@tailwind` directives in your main stylesheet.
5. **Set up shadcn** with the token-backed theme from step 4, and build the § 5 components from shadcn primitives (button, dialog, dropdown-menu, tabs, table, input, label, badge).
6. **Include `references/profile-menu.js`** before the closing `</body>` tag.
7. **Customize content** inside the provided slots (header logo, nav items, main content area) while preserving the structure and ARIA attributes.
8. **Persist theme preference** using `localStorage` — read the stored value on page load and apply `[data-theme="light"]` or `[data-theme="dark"]` accordingly.
9. **Follow the component checklist** (§ 5) and **verification checklist** (§ 6) before considering the interface complete.