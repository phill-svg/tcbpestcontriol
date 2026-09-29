# Notes for Claude

This file is the memory. When the owner says "remember this", add it here and
commit it — cloud sessions don't keep anything else between runs.

- **The HTML files in this repo are the source of truth.** The live site also
  applies wording edits from the `content_edits` table in the `tcb-booking-db`
  D1 database, but the repo wins. See `EDITING-GUIDE.md` for how the overlay works.
- **Labels are sentence case now** (2026-09-29, PR #176). The old ALL-CAPS
  "[03] WHY TCB" style labels and the mono font were removed site-wide as part of
  the "less AI" work, which replaces the earlier "ALL-CAPS labels are deliberate" rule.
- Folders stay flat: the folder path is the live URL. See `.navigation/README.md`.
- Owner preference: sweet and quick to the point.
- **Owner:** Phill Johnston, ACT pest licence no. 5098997. Name and licence can
  go on the site; no photo of his face. Main line 02 6105 9771; mobile for the
  Text button 0485 034 869.
- **Making the site read less AI-generated** (PR #176). Keep to these:
  - Plain, local headings. No slogans ("done right.", "The quiet damage. Caught
    early.", "Get a quote today. Pest-free tomorrow."). Few em dashes.
  - No `[01]` numbered labels, no tracked-caps mono labels. One font: Inter.
  - Show real Google reviews (copy them word for word from the Google listing,
    google.com/maps?cid=16225855690319707620), not made-up testimonials.
  - Real photos only where we have them. The only real photo is the TCB ute
    (`tcb-pest-control-service-vehicle-fc3b9.webp`). Don't put the ute on every
    page; that looks as fake as stock. Swap in real job photos as Phill sends them.
  - SEO question headings ("Do seasonal changes affect…") stay; restyle, don't delete.
  - The public chat bubble is replaced by Call / Text buttons (`CONTACT_FAB_HTML`
    in `src/index.js`). ChatHub and the staff dashboard still exist.
- **Still to do (less-AI work):** real job photos to replace the stock
  "technicians in coveralls" photo (~90 location/blog pages); confirm the review
  count (Google Maps showed 60 on 2026-09-29, the site says 62); same copy pass on
  the termite, pricing, pests-we-treat, commercial and residential pages.
- **Local preview:** `wrangler dev` keeps reloading and crashing here (it watches
  `.remember/` temp files). To screenshot pages, use Playwright from
  `node_modules` with a small Node static server over the repo root instead.
- **Booking address lookup** (`/book`): street, suburb and postcode fill in from
  free OpenStreetMap data (Photon, photon.komoot.io), called through the Worker at
  `/api/address/suggest` (`src/address-lookup.js`). No key or account. Google
  Places was dropped: it wanted a $40 upfront payment. Some house numbers are
  missing from OpenStreetMap; the customer's typed number is kept then.
