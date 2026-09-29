# Notes for Claude

This file is the memory. When the owner says "remember this", add it here and
commit it — cloud sessions don't keep anything else between runs.

- **The HTML files in this repo are the source of truth.** The live site also
  applies wording edits from the `content_edits` table in the `tcb-booking-db`
  D1 database, but the repo wins. See `EDITING-GUIDE.md` for how the overlay works.
- **ALL-CAPS labels are deliberate** (e.g. "LEARN MORE", "PESTS COVERED",
  "[03] WHY TCB"). The owner changed them on purpose; don't "fix" them back.
- Folders stay flat: the folder path is the live URL. See `.navigation/README.md`.
- Owner preference: sweet and quick to the point.
- Goal in progress: make the site read less AI-generated — plainer, local-sounding
  headlines, fewer stock phrases, correct counts, real reviews/people.
- **Booking address lookup** (`/book`): street, suburb and postcode fill in from
  Google Places, called through the Worker at `/api/address/*`
  (`src/address-lookup.js`). The key is the Worker secret `GOOGLE_MAPS_KEY`
  (Places API (New)). No key = no dropdown, form still works by typing.
