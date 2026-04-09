```markdown
# Design System Specification: The Lucid Archive

## 1. Overview & Creative North Star
**Creative North Star: "The Digital Curator"**

This design system is engineered to solve the "Knowledge Fatigue" inherent in data-heavy, Wikipedia-style environments. Rather than a rigid, spreadsheet-like interface, we treat information as a curated exhibition. We move beyond the "template" look by utilizing **intentional asymmetry** and **atmospheric layering**. 

The system achieves "High Density with Grace" through a meticulous balance of high-end editorial typography and translucent architectural layers. It is not just a dashboard; it is a breathable, light-filled space where data floats on sheets of frosted glass, allowing the user to navigate complex information without cognitive overload.

---

## 2. Colors & Surface Philosophy
The palette balances the authority of `primary` (Electric Blue) with the organic calm of `secondary` (Soft Teal) and the urgent precision of `tertiary` (Coral).

### The "No-Line" Rule
**Explicit Instruction:** Designers are prohibited from using 1px solid borders to define sections.
Boundaries must be defined exclusively through **Background Color Shifts** or **Tonal Transitions**. For example, a `surface-container-low` side panel sits flush against a `background` workspace. The eye perceives the edge through the shift in luminance, not a mechanical line.

### Surface Hierarchy & Nesting
Treat the UI as a physical stack of semi-transparent materials.
*   **Base Layer:** `background` (#f7f9fb) – The canvas.
*   **The Atmospheric Layer:** `surface-container-low` – Used for large architectural groupings.
*   **The Interactive Layer:** `surface-container-lowest` (#ffffff) – Used for primary content cards to create a "lifted" feel.
*   **The Glass Overlay:** Use `surface` colors at 70% opacity with a `backdrop-filter: blur(12px)` for navigation bars and floating inspectors.

### The "Glass & Gradient" Rule
To inject "soul" into the data, use subtle linear gradients for high-impact elements. 
*   **Primary CTA:** Transition from `primary` (#0040e0) to `primary_container` (#2e5bff) at a 135-degree angle.
*   **Data Highlights:** Use a 5% opacity gradient of `secondary` behind critical data visualizations to anchor them to the glass surface.

---

## 3. Typography: Editorial Authority
We utilize a dual-font strategy to distinguish between "Reading" and "Operating."

*   **Display & Headlines (Manrope):** Chosen for its geometric precision and modern "editorial" feel. High-contrast scales (e.g., `display-lg` at 3.5rem) should be used to create clear entry points in dense articles.
*   **Body & Labels (Inter):** The workhorse. Inter provides maximum legibility at small scales in tables and metadata.

**Hierarchy as Identity:**
Use `headline-md` for section headers, but pair them with `label-sm` in `primary` color (all caps, tracked out +5%) as a "super-header" to provide a sophisticated, magazine-style hierarchy.

---

## 4. Elevation & Depth: Tonal Layering
Traditional drop shadows are discarded in favor of **Natural Light Physics**.

*   **The Layering Principle:** Depth is achieved by stacking. A `surface-container-highest` element should only ever sit on a `surface-container-low` base.
*   **Ambient Shadows:** For floating glass modals, use a "Double-Diffusion" shadow:
    *   *Shadow 1:* 0px 4px 20px rgba(25, 28, 30, 0.04)
    *   *Shadow 2:* 0px 12px 40px rgba(18, 74, 240, 0.06) (Note the `surface_tint` influence).
*   **The Ghost Border Fallback:** If accessibility requires a container edge, use `outline_variant` (#c4c5d9) at **15% opacity**. Never 100%.
*   **Backdrop Blur:** All glass elements must utilize a `20px` to `32px` blur radius to ensure text readability over background data.

---

## 5. Components

### Cards & Data Lists
*   **Rule:** Forbid divider lines. 
*   **Execution:** Separate list items using `8px` of vertical whitespace and a hover state that transitions the background to `surface-container-high`.
*   **Card Style:** `xl` (1.5rem) corner radius. Use `surface-container-lowest` with a subtle `primary` tint in the shadow.

### Buttons
*   **Primary:** `primary` background, `on_primary` text. `full` (9999px) roundedness for a modern, tactile feel.
*   **Secondary (Glass):** `surface_variant` at 40% opacity + backdrop blur. No border.
*   **Tertiary:** No background. `primary` text with a `primary_fixed` underline on hover only.

### Input Fields
*   **Style:** `surface-container-low` background with a `md` (0.75rem) corner radius.
*   **Focus State:** Transition background to `surface-container-lowest` and add a 2px `surface_tint` "glow" (ambient shadow), rather than a heavy border.

### Interactive Chips
*   **Filter Chips:** `secondary_container` background with `on_secondary_container` text. Use for data categories (e.g., "History," "Science").
*   **Action Chips:** `tertiary_fixed` background. Use for high-priority alerts or "Edit" states.

### Modern Data Tables
*   **Header:** `label-md` typography, `outline` color, 0% background.
*   **Rows:** Alternating background shifts are forbidden. Use whitespace and `title-sm` for the primary key in each row to create a vertical rhythm.

---

## 6. Do’s and Don’ts

### Do
*   **Do** use `xl` rounding for large containers and `sm` rounding for small inputs to create a "nested" visual language.
*   **Do** allow background colors from charts to "bleed" through the glass navigation bars.
*   **Do** use `tertiary` (Coral) sparingly—only for "Live" status indicators or critical error actions.
*   **Do** prioritize `primary_fixed` for background washes behind secondary information.

### Don't
*   **Don't** use pure black (#000000) for text. Always use `on_surface` (#191c1e) to maintain the soft, premium feel.
*   **Don't** use 1px dividers between table rows. Use `16px` of padding instead.
*   **Don't** use standard shadows. If it looks like a default "Material Design" shadow, it is too heavy.
*   **Don't** clutter the "Glass" layers. Keep the background behind glass elements simple to maintain legibility.

---

## 7. Signature Interaction: The "Frost" Transition
When a user scrolls, the header should transition from 0% opacity to a "Glassmorphic" state (70% `surface` + `blur`). This creates a sense of the data passing underneath a physical lens, reinforcing the "Curator" metaphor.