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
  **Change the words, not the look.** A site-wide restyle (one font, no caps
  labels, no icons, no red accents) went live in #176 and the owner hated it;
  #177 put the original look back. Don't restyle without showing screenshots first.
- **Owner:** Phill Johnston, ACT pest licence no. 5098997. Name and licence can
  go on the site; no photo of his face. Mobile for the Text button: 0485 034 869.
- Real Google reviews come from google.com/maps?cid=16225855690319707620 — copy
  them word for word. Don't put the ute photo on every page; wait for real job photos.
- **Booking address lookup** (`/book`): street, suburb and postcode fill in from
  free OpenStreetMap data (Photon, photon.komoot.io), called through the Worker at
  `/api/address/suggest` (`src/address-lookup.js`). No key or account. Google
  Places was dropped: it wanted a $40 upfront payment. Some house numbers are
  missing from OpenStreetMap; the customer's typed number is kept then.
