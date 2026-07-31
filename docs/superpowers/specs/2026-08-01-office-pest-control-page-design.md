# Office Pest Control landing page — design

## Purpose

Add a standalone SEO landing page targeting "office pest control Canberra" style searches. The existing `/commercial` page already mentions offices as one of six sectors, so this page must carry enough office-specific content to avoid being thin/duplicate: office-specific pests as the core body, with after-hours scheduling and discretion as supporting trust points (not the whole page).

## Routing

- New file: `office-pest-control/index.html`
- Live URL: `/office-pest-control`
- Nested under Commercial in the breadcrumb (Home → Commercial Pest Control → Office Pest Control) for topical/SEO silo structure, matching how pest pages already sit under their category.

## Page shell

Reuse the exact shared shell every other service page uses — no new layout:

- Same `<head>` boilerplate: deferred chat/GTM/Meta Pixel script, favicon links, shared `assets/css/style.css`, inlined critical CSS block.
- `ProfessionalService` JSON-LD (same organization data as other pages).
- `BreadcrumbList` JSON-LD: Home → Commercial Pest Control → Office Pest Control.
- `FAQPage` JSON-LD (see FAQ section below), matching the pattern used on `ant-control` and `general-pest-control`.
- Standard `<header>` nav, `<footer>` — unchanged, no new nav/footer links added (see "Out of scope").

Title/meta: `Office Pest Control Canberra | TCB Pest Control Canberra`, meta description covering after-hours, discreet, ACT businesses, canonical `https://www.tcbpestcontrolcanberra.com.au/office-pest-control`.

## Content sections

1. **Hero** (`hero simple`) — eyebrow "TCB · Office Pest Control", H1 "Office pest control for Canberra businesses.", lead line covering after-hours/discreet servicing and written reporting. Standard `Get a Quote` + phone CTA.

2. **[01] Office-specific pests** — grid-cards section, "The pests that turn up in Canberra offices." One card per pest, each linking to the matching existing pest page for internal linking equity:
   - Cockroaches — kitchens/break rooms → `/cockroach-control`
   - Ants — desks/food storage areas → `/ant-control`
   - Rodents — ceiling voids, gnawed cabling, noise → `/rodent-control`
   - Silverfish — paper/archive/file storage → `/silverfish-control`
   - Spiders — stairwells, loading docks, external entries → `/spider-control`

3. **[02] Built around your trading day** — grid-cards section (3 cards, matching `/commercial`'s "Why TCB for business" pattern), office-specific trust points:
   - After-hours/weekend scheduling so treatment never interrupts a work day
   - Low-tox product safe to use around occupied workstations
   - Minimal disruption to open-plan space — no lingering odour, no closed-off zones next morning
   - Written report each visit, framed for facilities managers / building compliance (WHS/duty-of-care angle: pest issues in a shared office are an employee-welfare matter for the employer, not just a nuisance)

4. **[03] Process** — same four-step band used on `ant-control`/`general-pest-control` (Inspect → Treat → Report → Ongoing cover), reworded for the office context.

5. **[04] FAQ** — office-specific questions, matching `FAQPage` schema pattern:
   - Can you treat while staff are still at their desks?
   - Do you provide a report we can give our facilities manager or building compliance?
   - Do you service shared office buildings, or only single-tenant floors?
   - How often should an office get pest control?

6. **Related services link-strip + final CTA band + footer** — same shared components as `/commercial`, linking to `/commercial`, `/general-pest-control`, and the pest pages referenced above.

## Integration changes to existing pages

- `/commercial`: the "Retail & Offices" grid-card currently links to `/contact`. Point it at `/office-pest-control` instead so there's a real internal link into the new page from its parent category.
- `sitemap.xml`: add `/office-pest-control` entry.

## Out of scope

- No changes to the global header/footer nav link lists — those stay as-is. Discovery into this page is via `/commercial`, the linked pest pages, and sitemap/search, not a new nav entry.
- No pricing details (matches existing pattern of directing to `/book` / phone for a quote rather than publishing commercial pricing).
- No new images — reuse existing asset library (e.g. cockroach macro banner already used on `/commercial`) rather than sourcing new photography.
