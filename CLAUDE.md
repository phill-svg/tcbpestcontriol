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
  free OpenStreetMap data (Photon, photon.komoot.io), called through the Worker at
  `/api/address/suggest` (`src/address-lookup.js`). No key or account. Google
  Places was dropped: it wanted a $40 upfront payment. Some house numbers are
  missing from OpenStreetMap; the customer's typed number is kept then.
