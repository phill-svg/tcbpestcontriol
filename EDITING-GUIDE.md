# Editing the website without touching code

You can change the words on any page by clicking them, the way you would in
Duda or WordPress. No hunting through files, no waiting for a deploy.

## The short version

1. Sign in at **/staff-chat** with your admin account.
2. Go to the page you want to change, e.g.
   `www.tcbpestcontrolcanberra.com.au/spider-control`.
3. Click **Edit page** (bottom right).
4. Click any words, type the new wording, press **Enter**.
5. Click **Publish**.

That's it. The change is live for everyone straight away.

## What you can change

| Thing | How |
| --- | --- |
| Any text on the page | Click it and type |
| Deleting words | Click them, clear the box, press Enter |
| Size, colour, bold, font | Hover the words, click **Style** |
| A link's destination | Hover the link, click **Edit link** |
| An image | Hover the image, click **Change image**, pick a new one |
| Image alt text | Same panel as the image |
| The Google result title and blurb | **Page title & description** in the toolbar |

## The buttons along the bottom

- **Page title & description** — what shows up as the heading and grey text in
  Google search results.
- **Changes** — everything you've changed on this page, with a **Revert**
  button on each. Revert puts the original wording back.
- **Preview** — the page exactly as visitors will see it once you publish.
  Nobody else can see this.
- **Publish** — makes your changes live.
- **Done** — leave editing and go back to the normal page.

## On your phone

The editor works on a phone or tablet. Tap any text to edit it, and the
**Style** and **Edit link** buttons appear next to what you are editing rather
than needing a hover. Tap an image to change it.

## Deleting words

Click the words, clear the box, press Enter. They disappear from the page.

While you're editing you'll see a small **deleted — click to restore** marker
where they used to be. Visitors never see that marker, only the gap. Click it
to bring the wording back, or use **Changes → Revert**.

Note that headings are often made of two or three separate runs of text
(different colours or styles). Clicking selects just the run you clicked, so
you can delete half a heading and keep the rest.

## Changing how text looks

Hover any words and a small **Style** button appears. It opens a panel with:

- **Size** — bigger and smaller in steps, or reset to normal
- **Colour** — the site palette, or the default
- **Bold, italic, UPPERCASE**
- **Font** — body, display, or mono

Changes show on the page as you make them, so you can see what you are doing.
**Cancel** puts everything back; **Clear styling** removes it entirely.

Styling applies to the run of text you hovered, not the whole heading or
paragraph — so you can make one coloured word inside a sentence.

One difference from the wording changes: styling stays in the site settings
and is not written into the code files by **Sync to code**. It is still live
for visitors and still revertable, it just lives in one place instead of two.

## Checking a page for Google

**SEO check** in the toolbar looks at the page you are on and tells you what
is worth fixing, with a rough preview of how it would appear in a Google
result. It checks the title and description lengths, that there is one main
heading, that images have descriptions, and that links say where they go.

Every finding says what to do about it, not just what is wrong — the line
under each one is the instruction. A few are not fixable from the editor (the
canonical tag is a line of code); those say so rather than leaving you looking
for a button that isn't there.

**Suggest one**, next to the title and description boxes in **Page title &
description**, drafts three options for you. They are written from what the
page already says, and from the real searches people used to find it once
Search Console is connected. Clicking one fills the box — it does not save.
It is still a draft you edit, save and publish like anything else.

It will not invent things about the business. Any suggestion containing a
number or a claim the page does not already make — a price, a response time,
"licensed", "guaranteed", "free" — is thrown away before you see it, even if
it reads well. Occasionally that means all three are thrown out and it asks
you to try again. That is the rule doing its job, not a fault.

Under **The whole site** there is a **Check every page** button. It goes
through every page in the sitemap — the same list Google crawls — and lists
only the ones with something worth looking at, each linking straight into
editing that page. It takes a second or two.

The whole-site scan also checks four things that no single page can tell you
about on its own, listed under **Across the whole site**:

- **Two pages with the same title.** They compete with each other in Google
  and it picks one. The easiest mistake to make in this editor, since copying
  a title from one page to another takes two seconds.
- **Two pages with the same description.** Less serious — Google often
  rewrites descriptions anyway — but a wasted chance to say something
  different.
- **Links to pages that no longer exist.** Reported once per broken
  destination, with the pages that point at it, so renaming a page shows up as
  one thing to fix rather than nine.
- **Pages nothing links to.** They are still in the sitemap, so Google can
  find them, but a visitor clicking around the site never will.

The same preview appears in **Page title & description** and updates as you
type, so you can see when a title is about to get cut off rather than guessing
from a character count.

What it does not check: page speed, mobile layout, structured data (your pages
already carry it), or anything to do with keywords. Nothing here scores your
page out of a hundred, because that number would be made up.

## What people actually searched

Everything above is an opinion about your pages. **What people actually
searched** is the one part that reports what happened — the real phrases people
typed, from Google Search Console, over the last 28 days.

It shows three things:

- **This page** — how many times it was shown, how many clicked, and the
  searches that brought them.
- **Shown often, clicked rarely** — the pages where a better title or
  description would pay. This is the useful one, because the title and
  description are exactly what you can change here. Each row links straight
  into editing that page.
- **Just off the first page** — searches where you sit around position 8 to 20.
  Google already thinks you are relevant and almost nobody is seeing you.

Google's own numbers stop two or three days short of today, so the window ends
a few days back. That is Google, not a delay here.

Unlike everything else in the editor, this needs connecting once — it is your
Google account, so it cannot be set up from this side. The panel walks you
through it if it is not connected: create a service account key in Google
Cloud, paste it into Cloudflare as a secret named `GOOGLE_SERVICE_ACCOUNT`, then
add that service account's email address as a user in Search Console under
Settings → Users and permissions. That last step is the one people skip, and
nothing works without it.

Access is read-only, and you can revoke it any time by removing that user in
Search Console.

## Drafts vs published

Every change you make is saved straight away as a **draft**. Drafts are only
visible to you. Nothing reaches an actual visitor until you press **Publish**,
so you can change your mind, wander off, come back tomorrow, and pick up where
you left off.

Published changes appear within about half a minute everywhere in the world.

## Writing a new blog post

Click **New post** in the toolbar. Fill in the title, a description, a category,
a main image, an opening paragraph, and as many sections as you want.

It creates the post as a **draft**: the page exists at its real address so you
can read it, but nothing links to it, it is not in the blog list, the sitemap
or the feed, and Google is told to skip it. You land straight in it in edit
mode, so you can polish the wording by clicking it, exactly like any other page.

When you are happy, press **Publish post** in the orange draft bar. That adds it
to the blog page, the sitemap, the RSS feed and the site search, and removes the
"skip me" tag. Live in a minute or two.

The web address, publish date, reading time, social-share tags and the two
"continue reading" cards are all worked out for you.

## Sync to code

Open **Changes** and there's a **Sync to code** button at the bottom.

Your published changes are already live — this folds them into the site's
underlying files so the two don't drift apart. **It changes nothing visitors
can see.** Press it whenever you think of it; once a month is plenty.

If some changes can't be matched, it says so and leaves those alone rather
than guessing. That means the wording in the code was altered by hand after
you published, and it's worth a look.

### One-time setup

The button needs permission to write to the code. Until that's done it will
tell you so instead of working.

1. On GitHub: **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Give it access to the `tcbpestcontriol` repository only, with
   **Contents: Read and write**. Nothing else.
3. Copy the token.
4. In Cloudflare: **Workers → tcbpestreal → Settings → Variables and Secrets
   → Add**, type **Secret**, name `GITHUB_TOKEN`, paste the token, save.

That's it. `GITHUB_REPO` is already set in `wrangler.jsonc`.

**If the token ever disappears from that list**, check that `keep_vars: true`
is still in `wrangler.jsonc`. Without it, every deploy deletes anything added
through the dashboard — and every merge to the main branch triggers a deploy,
so a token added by hand can vanish within minutes.

## Things worth knowing

**One page at a time.** Publish applies to the page you're on. If you change
wording on five pages, publish on each of them.

**Only admins.** Ordinary staff accounts can use the chat dashboard but can't
edit the website. If you click Edit page and get told your sign-in expired,
sign in again at /staff-chat.

**Some things can't be edited here.** Layout, adding a whole new section,
adding a new page, prices in the booking system — those still need a code
change. Click something uneditable and the editor will tell you so rather
than pretending. Ask Claude for those.

**Reverting is always available.** Nothing you do here is destructive. The
original wording is kept, and Revert restores it.

---

# For whoever maintains the code

## How it works

Edits are stored in D1 (`content_edits`) and applied to each page as it
streams through the Worker's `HTMLRewriter` (`src/content-edits.js`). The HTML
files in this repo are never modified at request time — the edits are an
overlay on top of them. That's what makes publishing instant, with no deploy
and no cache purge.

An edit is addressed by **a hash of the text it currently contains**, plus an
ordinal that counts only other identical copies of that text on the same page
(`assets/js/content-address.js`). Addressing by content rather than by
position means adding a paragraph above a sentence can never silently
re-point an edit at the wrong words.

Three separate pieces of code have to agree on that address — the browser
editor, the Worker, and the sync script. They share the addressing module, and
`test/address-parity.test.mjs` runs all three against real pages in this repo
and compares them address for address. If that test fails, edits will land on
the wrong text; fix it before shipping anything.

## Keeping the repo as the source of truth

Published edits live in D1, so the HTML files drift out of date. Fold them
back in periodically:

```bash
# preview what would change
node scripts/sync-content-edits.js --url https://www.tcbpestcontrolcanberra.com.au \
    --cookie "tcb_staff_session=<from your browser>"

# apply, then clear the now-redundant overrides
node scripts/sync-content-edits.js --url https://www.tcbpestcontrolcanberra.com.au \
    --cookie "tcb_staff_session=<...>" --write --clear
git add -A && git commit -m "Sync published copy edits"
```

Nothing is written without `--write`. Anything the script can't match is
listed rather than guessed at — that means the file was hand-edited after the
change was published, and a person should look at it.

Baking an edit in is safe to do at any time: once the file says the new
wording, the old override no longer matches anything and becomes inert. It can
never double-apply.

## Editing the same sentence twice

Edit mode (`?edit=1`) serves the page **with no overrides applied at all**, so
the editor is always hashing the words as the file writes them. It then paints
the current values back over the top in the browser, so what you see is up to
date. Without that, re-editing a sentence would mint a second address keyed to
the new wording, which the file never matches, and the change would vanish.

## Other bits

- Image picker reads `assets/images/manifest.json`. Regenerate it after adding
  or removing images: `node scripts/build-image-manifest.js`.
- After adding or replacing an image, also run `npm run build:avif`. It writes
  an `.avif` next to each `.webp`, and the Worker serves that copy to browsers
  whose `Accept` header says they can read it — about 30% fewer bytes, with no
  change to the `<img>` tags. Forgetting it costs nothing but the saving: an
  image with no `.avif` alongside it just keeps being served as `.webp`.
- Editor CSS/JS are deliberately not part of `assets/css/style.css` — they only
  load for a signed-in admin.
- `src/`, `scripts/`, `test/` and `schema.sql` are listed in `.assetsignore`.
  `assets.directory` is the whole repo, so anything not excluded there is
  served publicly by URL.
- The parity and end-to-end tests need dev-only tools and skip themselves
  without them: `npm install --no-save wrangler playwright`.
