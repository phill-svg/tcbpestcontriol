# Booking widget — local test guide (nothing goes live)

This tests the new booking widget on your own computer only. It does **not** touch your live website.
The live site only changes when code is pushed to `main` — we are **not** doing that here.

⚠️ One thing to know: there is no "test" ServiceM8. When you do a real test booking below, it creates a
**real job on your ServiceM8 calendar**. That's fine — you just use an obvious fake name (e.g. "ZZ TEST")
and delete the job afterwards. Steps below tell you when.

---

## 0. One-time setup

You need three things: Node, Wrangler (Cloudflare's tool), and your ServiceM8 API key in a local file.

**a) Open a terminal in the project folder**
```
cd C:\Users\Phill\tcbpestcontriol
```

**b) Make sure you're on the booking branch (not main)**
```
git checkout feat/booking-availability
git branch --show-current      # should print: feat/booking-availability
```

**c) Put your ServiceM8 key in `.dev.vars`** (a local, private file — never committed)
Open `C:\Users\Phill\tcbpestcontriol\.dev.vars` (create it if missing) and make sure it has this line
(it may already, from the existing site):
```
SERVICEM8_API_KEY=smk-xxxxxxxx-your-real-key
```

**d) Create the local booking database and load its table**
```
npx wrangler d1 execute tcb-booking-db --local --file=schema.sql
```
- **You should see:** a success message that it ran 2 commands (creates the `bookings` table).
- **If it complains it can't find the database / bad database_id:** run this once —
  `npx wrangler d1 create tcb-booking-db` — copy the `database_id` it prints, paste it into
  `wrangler.jsonc` (replace `"PLACEHOLDER_LOCAL_DEV"`), then re-run the `execute --local` line above.
  (Creating the database is safe — it's an empty database, not a website deploy.)

---

## 1. Start the widget locally
```
npx wrangler dev
```
Leave this running. It will print a local address, usually **http://localhost:8787**.
Open that in your browser and add `/book` → **http://localhost:8787/book**

---

## 2. Does it show real times? (basic check)

On the `/book` page: pick a **service** and a **date** (try tomorrow or the next weekday).

- ✅ **Expect:** time "chips" appear (9:00, 9:30, …). Earliest is **8:00 am** (not 7:00), and on a
  weekday the latest is late afternoon so the job finishes by 4:00. On a **Saturday** the latest start
  is around 11:00 (finishes by noon). **Sunday** shows no times.
- ❌ **If** you see 7:00 am, or Sunday has times, tell me — the "opening hours" mask is off.

---

## 3. 🔴 THE IMPORTANT ONE: does it respect a block *you* set?

This is the make-or-break test — it's the one open question from the review.

1. In **ServiceM8** (the app), on a day within the next 4 weeks, block out some time for **yourself** —
   e.g. add a personal/busy block **9:00 am–11:00 am** (a "staff busy time" / unavailability, **not** a
   job). Also, if you already have a **job scheduled** on some day, note its time.
2. Back in the widget, choose a service and **that same date**.
3. ✅ **Expect:** the blocked times (9:00, 9:30, 10:00, 10:30) are **NOT offered**. Times before 9 and
   after 11 still appear. Any **scheduled job's** time is also **not offered**.
4. ❌ **If the blocked personal time IS still offered** → this is the known gap. **Don't go live.**
   Tell me "the busy-time block still showed" and I'll switch the availability source over to
   ServiceM8's own availability feed (a one-function change) and we retest. The *job* time should always
   be excluded even if the personal block isn't — let me know which of the two failed.

*(Why this matters: the whole point is "can't double-book." If the widget can't see time you've blocked
for yourself, it could book a customer over it.)*

---

## 4. Make a real test booking (then delete it)

1. On `/book`, fill the form with an **obvious test identity**: name **`ZZ TEST`**, your own email/phone,
   any address, pick a service, pick a time chip, submit.
2. ✅ **Expect:** a "Booking confirmed" message.
3. Check **ServiceM8** → you should see a new **Work Order** job for "ZZ TEST" **scheduled at that exact
   time** on your calendar. You should also get the office email + the in-app notification.
4. Go **back to the widget**, pick the **same service + date** again.
   ✅ **Expect:** the time you just booked is **gone** from the list (it's now taken).
5. **Clean up:** delete the "ZZ TEST" job in ServiceM8 so it's not sitting on your calendar.

---

## 5. Can two people grab the same time? (double-book check)

Two quick ways — either is fine:
- **Simple:** open `/book` in two browser tabs, load the same day in both, and in each pick the **same**
  time chip, then submit both as fast as you can.
- ✅ **Expect:** one succeeds ("confirmed"); the other gets **"That time was just taken — please choose
  another"** and the chips refresh. Only **one** job appears in ServiceM8. Delete the test job(s) after.

---

## 6. Old forms still work (regression check)

- Submit the **Contact** page form (http://localhost:8787/contact).
  ✅ **Expect:** it still works exactly as before — creates a **Quote/lead** in ServiceM8 (not a booked
  Work Order), no time slot. (This confirms we didn't break your existing enquiry flow.)
- Delete any test leads afterwards.

---

## When everything passes

Only after **all** of the above look right — especially **Step 3** — is it safe to go live.
Going live = merging this branch to `main` (which auto-deploys). **Don't do that yet.** When you're
ready, tell me and I'll walk you through it, including provisioning the real (remote) database first.

**If anything looks wrong,** note which step and what you saw, and send it to me — I'll fix and we retest
locally before anything ships.

---

*Stop the local server anytime with `Ctrl+C` in the terminal running `wrangler dev`.*
