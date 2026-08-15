# Booking system — where everything lives

A map of every piece of the online booking flow you might want to change, and
the exact file to change it in. Written for editing by hand, so each section
says what the change affects and what else has to move with it.

Run `npm run check:booking` after any change to services or prices — it fails
loudly if the copies listed below have drifted apart. `npm test` runs the unit
tests (slot maths, pricing, time formatting).

---

## 1. What happens when someone books

```
/book page  ──►  POST /api/booking  ──►  src/index.js   handleBooking()
                                          │
                                          ├─ validate + re-check the slot is still free
                                          ├─ work out the price (server-side, always)
                                          │
                                          └─ src/booking.js  bookScheduledSlot()
                                               ├─ lock the slot in the D1 database
                                               ├─ create the ServiceM8 job  ← job description
                                               ├─ put it on the calendar
                                               ├─ add the price as an invoice line
                                               ├─ email the office + the customer
                                               └─ push notification to Phill's phone
```

Three different things can come out of the `/book` form, and they take
different paths:

| What the customer did | Path | Result in ServiceM8 |
|---|---|---|
| Picked a service, price option and a time slot | `bookScheduledSlot()` in `src/booking.js` | **Work Order**, scheduled on the calendar, price on the invoice |
| Clicked "Prefer a custom quote instead?" | `handleBooking()`'s quote branch, `src/index.js:428` | **Lead**, no time, no price — for you to quote |
| Sent the `/contact` form | `handleContactEnquiry()`, `src/index.js:502` | **Lead**, no time, no price |

Only the first one is a confirmed booking. That distinction matters for most of
the edits below, because the confirmed path and the lead path build their text
separately and on purpose.

---

## 2. The job description in ServiceM8

**File:** `src/booking.js`

**Confirmed bookings** — `bookScheduledSlot()`, around line 219:

```js
const serviceLine = !pricing.quote && pricing.modifierLabel ? `${f.service} (${pricing.modifierLabel})` : f.service;
const descPriceLine = ... `Fixed online price: $${pricing.amount} inc GST`
const description = [serviceLine, descPriceLine, sourceLabel, "", f.message || "(no additional notes)"]
```

Produces:

```
Rodents (mice & rats)
Fixed online price: $289 inc GST
Online booking (website /book form)

(no additional notes)
```

The array is the whole layout — reorder it, delete an entry, or add a new
string and it appears in that order. Empty strings are dropped, so the `""`
in the middle is the blank line before the customer's notes.

**Leads and quote requests** — the top of `createBookingAndNotify()`, around
line 82. Separate array, same idea. This one still carries a `Preferred:` line
because nothing has been scheduled yet, so the customer's preferred date is the
only time information there is.

**The "where it came from" line** is passed in by the caller, not set here:

| Text | Set in |
|---|---|
| `Online booking (website /book form)` | `src/index.js:479` |
| `Custom quote request (website /book form)` | `src/index.js:440` |
| `Online booking request (website /book form)` | `src/index.js:486` |
| `Website enquiry (contact form)` | `src/index.js`, `handleContactEnquiry()` |

---

## 3. Services and prices

`src/booking-config.js` is the source of truth. **But two copies exist**,
because the browser can't read the Worker's file:

| File | What's in it | Why |
|---|---|---|
| `src/booking-config.js` | Durations, labels, prices, options | The real thing — what actually gets charged |
| `assets/js/booking.js` (top ~30 lines) | Same prices and options | Shows the live price on the page before submit |
| `book/index.html` (the `<select id="bk-service">`) | Service names in the dropdown | Plain HTML, can't be generated |

Change a price in one and not the others and the page shows one number while
ServiceM8 charges another. `npm run check:booking` catches exactly that.

### To change a price

`src/booking-config.js`, the `PRICING` block:

```js
"rodents": { modifier: "none", price: 289 },                                  // flat price
"general-pest": { modifier: "bedrooms", prices: { "1-3": 249, "4-5": 289, "6+": 349 } },
```

Then copy the same values into `assets/js/booking.js` (top of the file) and run
`npm run check:booking`.

### To change how a service reads

`SERVICE_LABELS` in `src/booking-config.js`. This label is what appears as the
top line of the job description, in both emails, on the invoice line item, and
in the phone notification. Also update the matching `<option>` in
`book/index.html` so the dropdown says the same thing.

### To change how long a job is booked for

`SERVICE_DURATIONS` in `src/booking-config.js`, in minutes. This decides how
much of the calendar a booking takes and therefore which start times are
offered.

### To add a new bookable service

It needs an entry in **all four** places, under the same key:
`SERVICE_DURATIONS`, `SERVICE_LABELS`, `PRICING` (all in
`src/booking-config.js`), the copy in `assets/js/booking.js`, plus an
`<option>` in `book/index.html`. `npm run check:booking` will tell you which
one you missed.

### The follow-up question ("How many bedrooms?")

`MODIFIER_LABELS` (the question) and `MODIFIER_OPTIONS` (the answers) in
`src/booking-config.js`, mirrored in `assets/js/booking.js`. Every option needs
a matching amount in that service's `prices`, or the customer gets "Please
choose an option for that service" when they submit.

---

## 4. Times you can be booked

**File:** `src/booking-config.js`

| Setting | What it does | Current |
|---|---|---|
| `ONLINE_HOURS` | Hours the website is allowed to offer, per weekday | Mon–Fri 8am–4pm, Sat 8am–12pm, Sun closed |
| `SLOT_GRANULARITY_MIN` | Start times step on this grid | 30 min |
| `BUFFER_MIN` | Padding around existing jobs for travel/setup | 15 min |
| `HORIZON_DAYS` | How far ahead the calendar goes | 28 days |
| `STAFF_UUID` | Whose ServiceM8 diary is checked, and who gets the job | Phill |
| `BUSINESS_TIMEZONE` | Everything above is in this timezone | Australia/Sydney |

`ONLINE_HOURS` is a filter applied **on top of** your real ServiceM8 diary —
it can only ever offer less than ServiceM8 says is free, never more. Days are
numbered 0=Sunday to 6=Saturday, and `[]` means closed online. A day can have
more than one window, e.g. `[["08:00", "12:00"], ["13:00", "16:00"]]` for a
lunch break.

The maths that turns these into bookable times is `src/availability.js` — you
shouldn't need to touch it to change the hours.

---

## 5. Emails

**File:** `src/email.js` — all three emails, text and HTML versions of each.

| Function | Goes to | When |
|---|---|---|
| `sendBookingNotification()` | `office@tcbpestcontrolcanberra.com.au` | Every booking, quote request and enquiry |
| `sendBookingConfirmation()` | The customer | Same, wording changes by type |
| `sendPasswordResetEmail()` | Staff | Staff-chat password resets |

Addresses are the four constants at the top of the file (`FROM_ADDRESS`,
`FROM_NAME`, `REPLY_TO`, `OFFICE_EMAIL`). Sending is from
`mail.tcbpestcontrolcanberra.com.au` — the root domain is your Google
Workspace mail and is deliberately never used for automated sends.

The customer email has three different wordings, chosen at
`sendBookingConfirmation()` around line 149:

- **Confirmed booking** — "Your booking is confirmed for Tue 18 Aug 2026, 9:00 AM…"
- **Booking request with no locked-in time** — "we'll be in touch shortly to confirm your time"
- **Contact enquiry** — "one of our technicians will get back to you within one business day"

Each has a plain-text version and an HTML version a few lines below it. Change
both, or people on different mail clients see different things.

The phone number `02 6105 9771` and the Mon–Sat 8am–5pm hours are written into
both emails (lines ~170 and ~178).

---

## 6. The phone notification

**File:** `src/booking.js`, the `notifyStaffOfNewJob(...)` calls (around lines
133 and 394). The array is the message, one line each, and **the first line is
what shows in the push preview** — keep the useful part there.

Confirmed booking:

```
⚡ New confirmed booking: Jane Smith — Rodents (mice & rats) @ Tue 18 Aug 2026, 9:00 AM
```

This arrives as a native ServiceM8 notification, so tapping it opens the job in
the ServiceM8 app. That's deliberate — the website can send its own push
notifications, but those can only ever open a web page.

Warning lines appear here too, when something needed doing by hand: auto-
scheduling failed, or the price couldn't be added to the invoice. Those are
built at `src/booking.js:357`.

---

## 7. The booking form itself

| What | File |
|---|---|
| The form: fields, labels, placeholders, button text | `book/index.html` (search for `data-booking-form`) |
| Form behaviour: loading slots, showing prices, submitting | `assets/js/booking.js` |
| "Fixed price — no surprises. Includes GST." | `assets/js/booking.js:66` **and** `book/index.html` (it's in both, so the page reads right before the script runs) |
| "We'll prepare a custom quote for you — no fixed price." | `assets/js/booking.js:67` |
| "Prefer a custom quote instead?" toggle | `assets/js/booking.js:76` and `book/index.html` |
| The success message after booking | `book/index.html` (`data-booking-success`), reworded for quotes in `assets/js/booking.js` |
| Error messages the customer sees on failure | `src/index.js` `handleBooking()` — e.g. "That time was just taken — please pick another." |

---

## 8. Where the ServiceM8 job comes from

**File:** `src/servicem8.js` — everything that talks to ServiceM8.

| Function | What it creates |
|---|---|
| `createWorkOrderJob()` | The confirmed job (status `Work Order`) + customer + job contact |
| `createServiceM8Lead()` | A lead for enquiries and quote requests |
| `createJobActivity()` | The calendar entry — this is what actually occupies the slot |
| `createInvoiceLineItem()` | The price on the invoice |
| `notifyStaffOfNewJob()` | The message/push against the job |
| `allocateJobToStaff()` | Assigns a lead to staff (leads only — bookings are already on the calendar) |
| `readStaffOccupancy()` | Reads your diary to work out what's free |

The invoice line item's wording is set in `src/booking.js:341`:
`"Rodents (mice & rats) — online booking"`. GST is handled there too: the price
you set is treated as GST-inclusive and divided by 1.1 for ServiceM8's ex-tax
field.

---

## 9. Things that live outside these files

- **The phone number `02 6105 9771`** appears on ~145 pages across the site,
  plus both emails. Changing it is a find-and-replace across the repo, not a
  config edit.
- **Slot locks** live in the `bookings` table in Cloudflare D1 (`schema.sql`).
  It's not the source of truth for what's booked — ServiceM8 is — it only stops
  two people grabbing the same slot in the same few seconds.
- **Secrets** (ServiceM8 API key, Turnstile) are Cloudflare secrets, not in the
  repo. Bindings are declared in `wrangler.jsonc`.
- **Deployment** is automatic: pushing to `main` triggers a Cloudflare Workers
  build. Site pages are served straight from the repo.

---

## 10. Quick reference

| I want to change… | File |
|---|---|
| What the job description says | `src/booking.js` (line ~229 confirmed, ~82 leads) |
| A price | `src/booking-config.js` + `assets/js/booking.js` |
| A service name | `src/booking-config.js` + `book/index.html` |
| Job length | `src/booking-config.js` `SERVICE_DURATIONS` |
| Bookable hours | `src/booking-config.js` `ONLINE_HOURS` |
| How far ahead people can book | `src/booking-config.js` `HORIZON_DAYS` |
| Customer or office email wording | `src/email.js` |
| The phone notification | `src/booking.js` `notifyStaffOfNewJob(...)` |
| Form labels and buttons | `book/index.html` |
| Price note / quote toggle text | `assets/js/booking.js` (top of the DOM section) |

**After any change:** `npm run check:booking` and `npm test`.
