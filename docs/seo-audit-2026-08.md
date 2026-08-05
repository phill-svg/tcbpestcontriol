# SEO Audit — www.tcbpestcontrolcanberra.com.au

**Date:** 5 August 2026
**Scope:** Live production site + Google's index (Search Console domain property `sc-domain:tcbpestcontrolcanberra.com.au`)
**Data window:** 7 May – 4 Aug 2026, compared against 5 Feb – 6 May 2026

---

## Method and data provenance

| Source | Used for |
|---|---|
| Google Search Console — Search Analytics API | Query, page and date performance; period-over-period comparison |
| Google Search Console — URL Inspection API | Index coverage, Google-selected canonical, crawl dates, rich results |
| Google web index (`site:` query) | Titles Google is actually rendering in the SERP |
| Deployed source at commit `1dfa92a` (5 Aug 2026) | On-page markup, schema, redirects, worker routing, internal links |

**One caveat, stated up front.** Direct HTTP fetches of the live site were blocked by this environment's egress policy (403 at the proxy — an environment restriction, not a fault of the site), so on-page analysis was done against the deployed source at HEAD rather than by fetching the rendered page.

To confirm that source reflects what is actually live, I cross-checked deployed `<title>` tags against the titles Google is currently rendering for indexed URLs. **7 of 8 matched exactly** (`/bird-control`, and the Gungahlin, Hackett, Reid, Inner South, Canberra City and Braddon location pages). The homepage was the single mismatch — which turns out to be a finding in its own right (§2). Google's URL Inspection also confirms user-declared and Google-selected canonicals agree on every URL tested. The source is a faithful proxy for the live site.

No cached, archived or historical copies of the site were used.

---

## 1. Headline: the site is losing ground on its core commercial terms

This is the finding that matters. Everything else in this document is secondary to it.

Search Console shows a **sustained three-month slide in average position, while impressions grew**. The site is being shown for more queries, in worse places, and converting fewer of them.

| Month (2026) | Clicks | Impressions | CTR | Avg. position |
|---|---|---|---|---|
| May (7–31) | 53 | 20,166 | 0.26% | ~21.5 |
| June | 56 | 20,161 | 0.28% | ~26.5 |
| July | 56 | 29,954 | 0.19% | ~31.5 |
| Aug (1–4) | 11 | 6,481 | 0.17% | ~36.0 |

Impressions rose ~49% from May to July. Clicks were flat at 53–56/month. Average position degraded from ~21 to ~36.

### Head-term movement, prior 90 days → most recent 90 days

| Query | Position before | Position now | Change |
|---|---|---|---|
| pest control canberra | 17.0 | 27.7 | **−10.7** |
| canberra pest control | 15.4 | 30.1 | **−14.7** |
| ant pest control canberra | 14.1 | 24.2 | **−10.1** |
| pest control tuggeranong | 8.9 | 11.4 | −2.5 |
| act pest control | 27.3 | 29.5 | −2.2 |
| **tcb pest control canberra** (brand) | **1.10** | **2.82** | **−1.7** |

Terms that produced clicks in the prior period and produced **none** in the current one: `rodent control canberra` (was pos. 12.2), `bee removal canberra` (10.4), `pest control gungahlin` (10.0), `bird pest control canberra` (8.1), `termite inspection canberra` (39.0), `rat control canberra` (15.1), `pest control services canberra` (14.6).

**The brand-term decline is the most diagnostic signal here.** Dropping from position 1.1 to 2.8 on your own business name — with brand CTR falling from 34.0% to 26.7% — is not a content or technical-SEO symptom. Sites do not lose their own brand term because of markup. That pattern points to an entity/authority problem off-site: Google Business Profile state, NAP consistency across directories, review volume, or competitors outranking the brand name. **This needs to be checked in GBP and across citation sources before any on-site work is prioritised.** I could not verify GBP from this environment.

### What is *not* causing the decline

I tested the usual suspects and cleared them, so effort is not wasted there:

- **Not thin or duplicate content.** Across the 84 location pages, median length is 829 words and pairwise 7-gram Jaccard similarity is median 0.28, max 0.41 — with zero pairs above 0.60. For templated local pages that share nav and footer boilerplate, that is genuinely differentiated writing. The location pages are well made.
- **Not missing or duplicated metadata.** All 137 pages have a unique `<title>`, a unique meta description (median 150 chars, only one at 174), and exactly one `<h1>` (sole exception `/staff-chat`, which is a non-indexed staff tool).
- **Not canonicalisation.** The Worker 301s apex→www and strips trailing slashes, and rewrites every page's canonical to self-reference at the edge. URL Inspection confirms Google's selected canonical matches the declared canonical on every URL tested.
- **Not the legacy URL migration.** The old `/locations/pest-control-*` pattern is correctly reporting "Page with redirect" with Google's canonical resolved to the current flat URL. The residual impressions on those URLs are historical within the window, not an active split.
- **Not crawlability.** `robots.txt` is permissive, the sitemap has 134 URLs with no broken entries, and no page is orphaned from internal linking.

The on-page foundation of this site is, frankly, in better shape than most. The problem is off-site authority and one high-impact SERP presentation issue.

---

## 2. High impact: Google is overriding the homepage title

The homepage declares:

```
<title>Pest Control Canberra | TCB Pest Control</title>
```

Google is rendering in the SERP:

```
Pest Exterminator Canberra | TCB Pest Control Canberra
```

The string "Pest Exterminator" appears **nowhere** in the current site or its git history. Every other page I sampled has its declared title used verbatim. So the homepage is the one page where Google has decided the declared title is not the best description and has substituted its own.

The most likely trigger is visible in the markup: **the homepage is the only page that uses the short brand suffix "TCB Pest Control", while every other page and both schema entities (`ProfessionalService.name`, `WebSite.name`) use "TCB Pest Control Canberra".** Google's rewrite restores the fuller, schema-consistent name. Inconsistent site-name signalling on the single most important URL is a self-inflicted problem.

This matters commercially: the homepage carries 27,502 impressions in 90 days at 0.37% CTR. It is the page that ranks for `pest control canberra` and `canberra pest control`. You do not control its SERP headline right now.

**Fix:** change the homepage title to use the same brand suffix as the rest of the site and the schema — e.g. `Pest Control Canberra | TCB Pest Control Canberra`. Also align `og:title`, which is currently a third variant (`Pest Control Canberra | Licensed Local Experts | TCB Pest Control`).

---

## 3. Local SEO: the LocalBusiness entity is incomplete

The `ProfessionalService` schema is emitted on **136 pages** and is missing fields that matter for local ranking:

- **No `streetAddress`.** The `PostalAddress` contains only `addressLocality: "Canberra"`, `addressRegion: "ACT"`, `addressCountry: "AU"`.
- **No `postalCode`.**
- **No `geo`** (latitude/longitude).
- The same full business entity is duplicated on all 136 pages rather than defined once and referenced by `@id`. The site already uses `@id` correctly for `#organization` and `#website` — the `ProfessionalService` node should follow the same pattern.

There is also **no visible street address anywhere on the site** — only a phone number (`tel:0261059771`). For a local service business competing on "pest control canberra", an incomplete address in both markup and visible content is a real weakness in the local entity signal, and it compounds the brand-term problem in §1.

If the business is deliberately address-less (mobile service area business), that is a legitimate model — but it should then be declared properly as a `ServiceArea` business with `geo` and `areaServed` rather than an address-bearing `PostalAddress` stub.

### Review markup

The homepage carries `AggregateRating` (`ratingValue: 4.8`, `reviewCount: 62`) inside `ProfessionalService`, and Google's Rich Results check does detect "Review snippets". Be aware that Google's policy discounts **self-serving reviews** — ratings about the business itself, hosted on the business's own site, are not eligible for review rich results for `LocalBusiness`/`Organization`. Detection is not the same as display. Do not count on stars appearing; the durable version of this signal lives in Google Business Profile reviews.

---

## 4. Defects worth fixing

### 4.1 Two hard 404s from internal links

`/spider-control/orb-weaver-spider` and `/spider-control/garden-orb-weaver-spider` both link to:

- `/spider-removal-canberra` — no page on disk, **no redirect entry**
- `/wolf-spider-canberra` — no page on disk, **no redirect entry**

These are hard 404s reachable from live indexed pages. Either create the pages or add 301s to `/spider-control`.

A third, `/pest-control-for-ants`, is linked from one page but does have a 301 to `/ant-control`. Point the link at the destination directly rather than through a redirect hop.

### 4.2 Headings render as jammed words when tags are stripped

269 headings across 120 pages use `<br/>` with no surrounding whitespace, so text extraction yields:

- `Are pest control treatments safearound children and pets?`
- `The quiet damage.Caught early.`
- `Termites.Inspection, treatment, warranty.`
- `Three stepsbefore you sign.`

Browsers render these correctly, and Google's parser generally handles `<br>` as a break — so this is a moderate rather than critical issue. But it degrades text extracted by anything using `textContent`, which includes many AI/LLM answer surfaces. Given the site ships an `llms.txt` and clearly cares about AI visibility, this is worth cleaning up. Fix by inserting a space before each `<br/>` inside headings.

### 4.3 Stylesheet loaded twice on every page

Every page emits both:

```html
<link rel="preload" as="style" href="assets/css/style.css?v=35" onload="this.onload=null;this.rel='stylesheet'"/>
<link rel="stylesheet" href="assets/css/style.css?v=35"/>
```

The second, plain `<link rel="stylesheet">` is render-blocking, which defeats the entire purpose of the preload-and-swap pattern above it. Drop one. Keep the plain stylesheet if simplicity is preferred, or keep the preload plus a `<noscript>` fallback — but not both.

### 4.4 Relative asset paths are correct but fragile

Pages use relative asset references (`assets/…`, `../assets/…`, `../../assets/…`). These resolve correctly **only because** the Worker 301s trailing slashes. If a trailing-slash URL were ever served directly, CSS, JS and images would 404. Google has historically indexed trailing-slash variants of these URLs. Switching to root-relative `/assets/…` removes the dependency entirely. One page already does this; 112 do not.

### 4.5 Six images missing `loading="lazy"`

8 images on the homepage, 6 without a lazy-loading hint. The above-fold hero should stay eager, but the rest should not be. All images do have `alt` text and explicit `width`/`height` — that part is done well.

### 4.6 Three pages exist but are absent from the sitemap

`/servicem8-setup-training`, `/staff-chat`, `/thank-you`. `/staff-chat` and `/thank-you` are correctly excluded. `/servicem8-setup-training` is a real, indexable commercial page (it has a meta description and is the site's longest at 174 chars) that is in neither the sitemap nor, apparently, anyone's plans. Decide whether it belongs — if yes, add it to the sitemap; if no, `noindex` it.

---

## 5. The CTR problem

Non-brand CTR is effectively zero, and this is a ranking-position consequence, not a snippet-writing one:

| Query | Impressions | Clicks | CTR | Position |
|---|---|---|---|---|
| pest control canberra | 1,816 | 7 | 0.39% | 27.7 |
| canberra pest control | 879 | 1 | 0.11% | 30.1 |
| ant control canberra | 655 | 0 | 0.00% | 24.1 |
| commercial pest control | 650 | 1 | 0.15% | 36.1 |
| pest control tuggeranong | 513 | 4 | 0.78% | 11.4 |
| tcb pest control canberra | 236 | 63 | **26.7%** | 2.8 |

The site converts brilliantly when it ranks (26.7% at position 2.8) and not at all when it doesn't. Nothing is wrong with the titles or descriptions — they are well written. **Rewriting snippets will not fix a position-28 problem.** Position is the constraint.

One caveat on the impression figures: a meaningful share of the 27,502 homepage impressions come from scraper-style and clearly irrelevant queries visible in the data (`"медиком" or "анц" or "ants"…`, `ant control tempe`, `ant control trinity gardens`, `ant control thorngate` — Adelaide and US suburbs). These inflate impressions and depress both average position and CTR. The true commercially-relevant impression base is smaller and healthier than the headline number suggests, and the July impression spike is substantially this kind of traffic rather than genuine reach.

---

## 6. Prioritised recommendations

### Do first — off-site (owns the actual decline)

1. **Audit Google Business Profile.** Verify it is live, verified, correctly categorised, and not suspended or merged. The brand-term drop from position 1.1 → 2.8 is the strongest signal in this dataset and it is almost certainly here, not on the website.
2. **Audit NAP consistency** across GBP, True Local, Yellow Pages, HiPages, Facebook and any industry directories. Inconsistent name/address/phone across citations directly undermines the local entity.
3. **Review acquisition.** 62 reviews is a modest base for a competitive metro service category. GBP review velocity is a ranking input for the local pack — which is where "pest control canberra" is won.
4. **Link acquisition.** The homepage's one notable referring URL in Search Console is `act.gov.au` (a genuinely strong, topically relevant government link). Build on that: local business associations, ACT trade bodies, pest-industry associations, Canberra community sponsorships. This is the long-term fix for position 28.

### Do next — on-site (fast, cheap, low risk)

5. Fix the homepage title to `Pest Control Canberra | TCB Pest Control Canberra` and align `og:title`. **(§2 — highest on-site ROI)**
6. Complete the `LocalBusiness` schema: add `streetAddress`, `postalCode`, `geo`; consolidate to a single `@id`-referenced entity. Add a visible address, or convert to a properly declared service-area business. **(§3)**
7. Add redirects (or pages) for `/spider-removal-canberra` and `/wolf-spider-canberra`. **(§4.1)**
8. Add whitespace before `<br/>` in the 269 affected headings. **(§4.2)**
9. Remove the duplicate stylesheet link. **(§4.3)**
10. Convert relative asset paths to root-relative. **(§4.4)**
11. Add `loading="lazy"` to below-fold images; resolve the `/servicem8-setup-training` sitemap question. **(§4.5, §4.6)**

### Do not do

- Do not rewrite titles and meta descriptions hoping to lift CTR. They are already good, and the constraint is position (§5).
- Do not add more location pages. There are already 84 at median 829 words, and they average position 40–60. The existing set is under-powered on authority; more of them will dilute further, not help.
- Do not expect the `AggregateRating` markup to produce stars (§3).

---

## Summary

The website itself is well built. Content is genuinely unique, metadata is clean and complete, canonicalisation is handled correctly at the edge, schema coverage is broad, and the legacy URL migration was executed properly. The technical defects I found are real but minor.

The problem is that the site has slid roughly 15 positions on its core commercial terms over three months and has lost the top spot on its own brand name. That combination is not explained by anything in the markup. It is an off-site authority and local-entity problem, and it will be solved in Google Business Profile, citations, reviews and links — not in the HTML.

The single highest-value on-site fix is the homepage title (§2), because Google has taken control of the SERP headline on the page that carries 27,502 impressions.
