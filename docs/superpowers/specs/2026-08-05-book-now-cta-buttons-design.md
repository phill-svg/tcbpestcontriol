# "Get a Quote" → "Book Now" CTA change — design

## Purpose

The site's `/book` widget was upgraded (2026-08-05) from a lead-capture form into a real ServiceM8-calendar-backed booking flow for 5 specific services. Most "Get a Quote" buttons already link to `/book`, but the label still promises a quote/callback rather than the instant self-serve booking that's actually available. Update the label — and, where needed, the link — to "Book Now" on the pages where that promise is concretely true.

## Scope

**In scope** (button text → "Book Now"):

| Page | Notes |
|---|---|
| `index.html` (homepage) | Hero CTA + bottom-CTA band. Both currently link to `contact`, **not** `/book` — href must be corrected to `/book` alongside the label change, or "Book Now" would be false. |
| `general-pest-control/index.html` | Hero, feature-banner, bottom-CTA buttons. `href="/book"` already correct. |
| `ant-control/index.html` | Same pattern (part of the `ants-spiders-roaches` bookable service). |
| `spider-control/index.html` | Same pattern (part of the `ants-spiders-roaches` bookable service). |
| `cockroach-control/index.html` | Same pattern (part of the `ants-spiders-roaches` bookable service). |
| `rodent-control/index.html` | Same pattern. |
| `bees/index.html` | Same pattern (`wasps-bees` bookable service). |
| `mud-wasp-control/index.html` | Same pattern (bundled under `wasps-bees`). |
| `termite-treatment/index.html` | Same pattern (`termite-inspection` bookable service — page titled "Termite Treatment & Inspections"). |

On every in-scope page except the homepage, each page has three "Get a Quote" instances to change: the hero button, the feature-banner button, and the bottom-CTA-band button. The homepage has two (hero + bottom-CTA band; it has no feature-banner-style mid-page CTA).

**Also on each in-scope page's bottom-CTA band:** remove the adjacent smaller "Or book online directly" link (→ `/book`) — it becomes redundant once the main button in that same section already says "Book Now" and goes to the same place.

**Explicitly NOT changed:**
- The shared header/mobile-nav "Get a Quote" button — present identically on every page site-wide (including in-scope ones). Changing it only on some pages would make the header inconsistent depending on which page a visitor is on.
- `commercial/index.html`, `pre-purchase-inspection/index.html`, `termite-treatment`'s sibling `pre-purchase-inspection` page (kept as "Get a Quote" per the termite-mapping decision), all ~70 `locations-pest-control-*` suburb pages, `residential/index.html`, `pests-we-treat/index.html`, blog posts, and all other pages not listed above.
- No changes to `/book` itself, `wrangler.jsonc`, or any backend/booking code — this is a content/copy change only.

## Verification

For each touched file:
1. Before editing: confirm the exact known-good baseline count of "Get a Quote" instances (2 for the homepage, 5 for each of the 8 service pages, from prior exploration).
2. After editing: `grep` to confirm exactly 2 "Get a Quote" instances remain (the header/mobile-nav pair, untouched) and the expected number of "Book Now" instances appear (2 on the homepage, 3 on each of the 8 service pages).
3. For the homepage specifically: confirm both edited buttons now have `href="/book"` (not `contact`).
4. Confirm the "Or book online directly" link no longer appears on any of the 9 touched pages.
5. `git diff` review across all touched files before committing, to catch any unintended change.

## Rollout

Commit directly to `main` (explicit instruction — this is a low-risk content/copy change, not application logic). Push, then confirm the Cloudflare Workers Build for `main` succeeds and deploys, the same way the booking-widget merge was verified earlier.

## Out of scope

- Any change to which services are bookable, the booking flow itself, or `/book`'s backend.
- Any change to the office-pest-control page idea (tracked separately in `2026-08-01-office-pest-control-page-design.md`).
- Broader CTA copy changes beyond this specific "Get a Quote" → "Book Now" swap (e.g., rewording the phone-call CTAs, the header, or location pages) — not requested.
