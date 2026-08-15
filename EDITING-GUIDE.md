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

## Drafts vs published

Every change you make is saved straight away as a **draft**. Drafts are only
visible to you. Nothing reaches an actual visitor until you press **Publish**,
so you can change your mind, wander off, come back tomorrow, and pick up where
you left off.

Published changes appear within about half a minute everywhere in the world.

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
- Editor CSS/JS are deliberately not part of `assets/css/style.css` — they only
  load for a signed-in admin.
- `src/`, `scripts/`, `test/` and `schema.sql` are listed in `.assetsignore`.
  `assets.directory` is the whole repo, so anything not excluded there is
  served publicly by URL.
- The parity and end-to-end tests need dev-only tools and skip themselves
  without them: `npm install --no-save wrangler playwright`.
