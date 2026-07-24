# How to add a blog post (matching the site style)

This site is plain, hand-written static HTML — there is no CMS. Every blog post
is its own folder containing an `index.html`. The URL is the folder name.

To keep every post looking identical, start from the shared template:
**`_blog-template.html`** (in the project root). It already contains the exact
header, footer, fonts, colours and layout used by the live posts, so you only
ever fill in the article content and a handful of metadata fields.

> `_blog-template.html` is never published — it's listed in `.assetsignore`.
> Copy it; don't rename or delete it.

---

## Step 1 — Create the post folder

Pick a URL slug. Existing posts all start with `blog-`, so follow that:

```
blog-<your-slug>/index.html
```

Example: a post at `https://…/blog-controlling-ants-in-summer` lives in
`blog-controlling-ants-in-summer/index.html`.

Copy the template into place (from the project root):

```bash
mkdir blog-controlling-ants-in-summer
cp _blog-template.html blog-controlling-ants-in-summer/index.html
```

## Step 2 — Fill in the placeholders

Open the new `index.html` and replace every `{{PLACEHOLDER}}`. Here is the full
list, with an example for each:

| Placeholder | What it is | Example |
|---|---|---|
| `{{PAGE_TITLE}}` | Post title (no brand suffix — the template adds it) | `Controlling Ants in Your Canberra Home This Summer` |
| `{{META_DESCRIPTION}}` | 1-sentence summary for Google & social (~150 chars) | `Why ants swarm Canberra kitchens in summer, how to keep them out, and when to call a professional.` |
| `{{CANONICAL_URL}}` | Full public URL of the post | `https://www.tcbpestcontrolcanberra.com.au/blog-controlling-ants-in-summer` |
| `{{OG_IMAGE_URL}}` | Full URL of the social-share image | `https://www.tcbpestcontrolcanberra.com.au/assets/images/pest-ant-macro.webp` |
| `{{DATE_ISO}}` | Publish date, machine format | `2026-07-24` |
| `{{DATE_LONG}}` | Publish date, human format | `July 24, 2026` |
| `{{CATEGORY}}` | Category tag (see list below) | `Seasonal` |
| `{{READ_TIME}}` | Whole minutes ≈ word count ÷ 220 | `6` |
| `{{HERO_IMAGE_SRC}}` / `{{HERO_IMAGE_ALT}}` | Top image + its alt text | `/assets/images/pest-ant-macro.webp` |
| `{{INTRO_PARAGRAPH}}` | Opening paragraph (shown larger) | — |
| `{{SECTION_N_HEADING}}` / `{{SECTION_N_PARAGRAPH}}` | Your article sections | — |
| `{{PEST_TOPIC}}` | Fills the closing CTA, e.g. `ant control` | `ant control` |
| `{{RELATED_SERVICE_URL}}` / `{{RELATED_SERVICE_NAME}}` | A service page to link | `/pest-control-for-ants` / `Ant Control` |
| `{{RELATED_POST_*}}` | The two "Continue reading" cards | — |

**Categories in use:** `Pest Watch`, `Prevention`, `Seasonal`, `Canberra Living`.

**Tip — a quick way to do the swaps** (edit the first line, then run it):

```bash
cd blog-controlling-ants-in-summer
sed -i 's#{{PAGE_TITLE}}#Controlling Ants in Your Canberra Home This Summer#g' index.html
# …repeat one line per placeholder…
```

Or just find-and-replace in your editor. When you're done, search the file for
`{{` to confirm nothing was missed.

## Step 3 — Write the article body

Inside `<div class="article-body">` you have a small set of reusable blocks.
Copy/paste and fill them in (they're also documented inline in the template):

```html
<!-- Larger intro paragraph — use once, right after the hero image -->
<p class="lead">Your opening paragraph.</p>

<!-- Section heading -->
<h2 class="display">Your Section Heading</h2>

<!-- Normal paragraph — bold with <strong>, links with <a href="/page"> -->
<p>Body text with a <strong>key point</strong> and a <a href="/spider-control">link</a>.</p>

<!-- Image with caption -->
<div class="split-media-image"><img alt="Description" loading="lazy" src="/assets/images/pest-ant-macro.webp" width="1000" height="750"/></div>
<p style="font-size:0.8125rem;color:var(--ink-faint);margin-top:0.5rem;">Caption or photo credit.</p>
```

Keep the closing `<div class="article-cta">…</div>` box as the last thing in the
body — it's the "get a quote" call to action.

## Step 4 — Add the post to the blog index

Open `blog/index.html`, find the `<div class="blog-grid cols-3">` list, and paste
this card as the **first** child (newest post first). Swap the placeholders:

```html
<a class="blog-card" href="/blog-controlling-ants-in-summer"><div class="blog-media"><img alt="Close-up of an ant, a common summer pest in Canberra" loading="lazy" src="/assets/images/pest-ant-macro.webp" width="1376" height="768"/></div><div class="blog-tag"><svg aria-hidden="true" class="lucide lucide-tag size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" fill="currentColor" r=".5"></circle></svg><span>Seasonal</span></div><h3>Controlling Ants in Your Canberra Home This Summer</h3><p>Why ants swarm Canberra kitchens in summer, how to keep them out, and when to call a professional.</p><div class="card-foot"><div class="meta">Jul 24, 2026 · 6 min read</div><div class="read">Read<svg aria-hidden="true" class="icon" fill="none" height="12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="12"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></div></div></a>
```

## Step 5 — Register the URL for search engines & RSS

1. **`sitemap.xml`** — copy an existing `<url>` block for a blog post, change
   the `<loc>` to your new URL and update `<lastmod>` to your publish date.
2. **`feed.xml`** — copy an existing `<item>`, update the title, link, `<guid>`,
   `<pubDate>` and description. (Optional but recommended so the RSS feed stays
   current.)

## Step 6 — Rebuild the on-site search index

The site search reads `assets/search-index.json`. Regenerate it so the new post
is findable:

```bash
node scripts/build-search-index.js
```

## Step 7 — Commit and push

```bash
git add blog-controlling-ants-in-summer/ blog/index.html sitemap.xml feed.xml assets/search-index.json
git commit -m "Add blog post: Controlling ants in summer"
git push
```

---

## Reusable images

If you don't have a custom photo, these already live in `/assets/images/` and
match the style (each also has a `-sm` version for `srcset`):

- **Pest close-ups:** `pest-ant-macro.webp`, `pest-bee-macro.webp`,
  `pest-bed-bug-macro.webp`, `pest-cockroach-macro.webp`, `pest-flea-macro.webp`,
  `pest-possum-macro.webp`, `pest-rodent-macro.webp`, `pest-silverfish-macro.webp`,
  `pest-spider-macro.webp`, `pest-stored-product-macro.webp`, `pest-termite-macro.webp`
- **Birds:** `pest-bird-macro.webp`, `pest-bird-myna-macro.webp`,
  `pest-bird-pigeon-macro.webp`, `pest-bird-sparrow-macro.webp`, `pest-bird-starling-macro.webp`
- **Spiders (species):** `blog-spider-redback.webp`, `blog-spider-funnel-web.webp`,
  `blog-spider-mouse-spider.webp`, `blog-spider-huntsman.webp`,
  `blog-spider-black-house.webp`, `blog-spider-white-tail.webp`, `blog-spider-wolf-spider.webp`
- **Team / brand:** `tcb-pest-control-technicians-treating-home-9300e.webp`,
  `tcb-pest-control-technician-sprayer-790eb.jpg`,
  `tcb-pest-control-spraying-service-701e1.webp`,
  `tcb-pest-control-service-vehicle-fc3b9.webp`

**Adding your own image:** drop the `.webp` (or `.jpg`) into `/assets/images/`.
For best results also export a smaller `-sm` version and use `srcset` like the
existing posts do. Always set `alt`, `width` and `height` so the layout doesn't
jump while loading.
