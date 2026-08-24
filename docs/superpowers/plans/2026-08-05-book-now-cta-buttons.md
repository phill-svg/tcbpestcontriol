# Book Now CTA Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change "Get a Quote" button text to "Book Now" on the homepage and the 8 service pages that map to the live booking widget's 5 bookable services, fix the homepage's two content CTAs to actually link to `/book` (currently `contact`), and remove the now-redundant "Or book online directly" secondary link on each of those 9 pages.

**Architecture:** Pure static-content edit across 9 hand-authored HTML files in a Cloudflare Workers Assets site (no templating layer — each page is its own file). No backend, routing, or JS changes. Each file gets its own commit; a single `git push` at the end deploys everything in one Cloudflare Workers Build.

**Tech Stack:** Static HTML, Cloudflare Workers (Assets), git. No test framework applies to this content (there is no HTML test suite in this repo) — "tests" here are `grep`-based before/after verification of exact instance counts, matching the design spec's verification plan.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-book-now-cta-buttons-design.md` — this plan implements it exactly; do not expand scope beyond it.
- The shared header/mobile-nav "Get a Quote" button (2 instances per file, present on every page site-wide) must NOT change, on any file, including the 9 in this plan.
- No file outside the 9 listed below may be touched.
- Commit directly to `main` — no branch, no PR (explicit user instruction).
- Every edit must be a targeted `Edit` (old_string → new_string) using enough context to be unique within its file — never a blind find/replace across files.
- Push only once, after all 9 files are edited and committed locally — this triggers exactly one Cloudflare Workers Build for the whole batch instead of 9 separate deploys.
- All 8 service pages (Tasks 2–9) share byte-identical hero/feature-banner/bottom-CTA/secondary-link markup — verified via `grep -cF` against every file before this plan was written. The old_string/new_string pairs are therefore identical across those 8 tasks; only the target file path and commit message differ.

---

### Task 1: Homepage (`index.html`)

**Files:**
- Modify: `index.html:406-410` (hero CTA), `index.html:860-863` (bottom-CTA button), `index.html:868-871` (redundant secondary link, to be removed)

**Interfaces:**
- Consumes: approved design spec (`docs/superpowers/specs/2026-08-05-book-now-cta-buttons-design.md`)
- Produces: no code interfaces — static content only. Independent of every other task in this plan.

- [ ] **Step 1: Edit the hero CTA — text "Book Now" and href fixed to `/book`**

In `index.html`, replace:

```html
<a class="btn btn-primary btn-lg" href="contact">
          Get a Quote
          <svg aria-hidden="true" class="icon" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="16"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg>
</a>
```

with:

```html
<a class="btn btn-primary btn-lg" href="/book">
          Book Now
          <svg aria-hidden="true" class="icon" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="16"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg>
</a>
```

- [ ] **Step 2: Edit the bottom-CTA-band button — text "Book Now" and href fixed to `/book`**

In `index.html`, replace:

```html
<a class="btn btn-white" href="contact">
            Get a Quote
            <svg aria-hidden="true" class="icon" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="16"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg>
</a>
```

with:

```html
<a class="btn btn-white" href="/book">
            Book Now
            <svg aria-hidden="true" class="icon" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="16"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg>
</a>
```

- [ ] **Step 3: Remove the now-redundant "Or book online directly" link**

In `index.html`, replace:

```html
<a class="link-mono mono" href="/book">
            Or book online directly
            <svg aria-hidden="true" class="icon" fill="none" height="12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="12"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg>
</a>
```

with nothing (delete it entirely).

- [ ] **Step 4: Verify**

Run:
```bash
grep -c 'Get a Quote' index.html
grep -c 'Book Now' index.html
grep -c 'Or book online directly' index.html
grep -c 'class="btn[^"]*" href="contact"' index.html
```
Expected: `Get a Quote` → `2` (header + mobile-nav only), `Book Now` → `2`, `Or book online directly` → `0`, and the last command (any `btn` element still pointing at `contact`) → `0`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Homepage: Get a Quote -> Book Now, fix href to /book"
```

---

### Task 2: `general-pest-control/index.html`

**Files:**
- Modify: `general-pest-control/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' general-pest-control/index.html
grep -c 'Book Now' general-pest-control/index.html
grep -c 'Or book online directly' general-pest-control/index.html
```
Expected: `Get a Quote` → `2` (header pair only), `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add general-pest-control/index.html
git commit -m "general-pest-control: Get a Quote -> Book Now"
```

---

### Task 3: `ant-control/index.html`

**Files:**
- Modify: `ant-control/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' ant-control/index.html
grep -c 'Book Now' ant-control/index.html
grep -c 'Or book online directly' ant-control/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add ant-control/index.html
git commit -m "ant-control: Get a Quote -> Book Now"
```

---

### Task 4: `spider-control/index.html`

**Files:**
- Modify: `spider-control/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' spider-control/index.html
grep -c 'Book Now' spider-control/index.html
grep -c 'Or book online directly' spider-control/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add spider-control/index.html
git commit -m "spider-control: Get a Quote -> Book Now"
```

---

### Task 5: `cockroach-control/index.html`

**Files:**
- Modify: `cockroach-control/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' cockroach-control/index.html
grep -c 'Book Now' cockroach-control/index.html
grep -c 'Or book online directly' cockroach-control/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add cockroach-control/index.html
git commit -m "cockroach-control: Get a Quote -> Book Now"
```

---

### Task 6: `rodent-control/index.html`

**Files:**
- Modify: `rodent-control/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' rodent-control/index.html
grep -c 'Book Now' rodent-control/index.html
grep -c 'Or book online directly' rodent-control/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add rodent-control/index.html
git commit -m "rodent-control: Get a Quote -> Book Now"
```

---

### Task 7: `bees/index.html`

**Files:**
- Modify: `bees/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' bees/index.html
grep -c 'Book Now' bees/index.html
grep -c 'Or book online directly' bees/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add bees/index.html
git commit -m "bees: Get a Quote -> Book Now"
```

---

### Task 8: `mud-wasp-control/index.html`

**Files:**
- Modify: `mud-wasp-control/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' mud-wasp-control/index.html
grep -c 'Book Now' mud-wasp-control/index.html
grep -c 'Or book online directly' mud-wasp-control/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add mud-wasp-control/index.html
git commit -m "mud-wasp-control: Get a Quote -> Book Now"
```

---

### Task 9: `termite-treatment/index.html`

**Files:**
- Modify: `termite-treatment/index.html` (hero, feature-banner, bottom-CTA button, remove secondary link)

**Interfaces:**
- Consumes: approved design spec
- Produces: none — independent of every other task

- [ ] **Step 1: Edit hero button text**

Replace:
```html
<a class="btn btn-primary btn-lg" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-primary btn-lg" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 2: Edit feature-banner button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg></a>
```

- [ ] **Step 3: Edit bottom-CTA button text**

Replace:
```html
<a class="btn btn-white" href="/book">Get a Quote<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with:
```html
<a class="btn btn-white" href="/book">Book Now<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-4 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```

- [ ] **Step 4: Remove the redundant "Or book online directly" link**

Replace:
```html
<a class="link-mono mono" href="/book">Or book online directly<svg aria-hidden="true" class="lucide lucide-arrow-up-right size-3 icon" fill="none" height="24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewbox="0 0 24 24" width="24"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></a>
```
with nothing (delete it entirely).

- [ ] **Step 5: Verify**

```bash
grep -c 'Get a Quote' termite-treatment/index.html
grep -c 'Book Now' termite-treatment/index.html
grep -c 'Or book online directly' termite-treatment/index.html
```
Expected: `Get a Quote` → `2`, `Book Now` → `3`, `Or book online directly` → `0`.

- [ ] **Step 6: Commit**

```bash
git add termite-treatment/index.html
git commit -m "termite-treatment: Get a Quote -> Book Now"
```

---

### Task 10: Full-repo audit, push to main, verify live deploy

**Files:**
- None modified — this task only verifies the prior 9 commits and ships them.

**Interfaces:**
- Consumes: all 9 prior commits
- Produces: nothing further downstream — terminal task of this plan

- [ ] **Step 1: Full-repo audit — confirm no out-of-scope file changed**

```bash
git log --oneline -10
git diff aaeb293d..HEAD --stat
```
Expected: exactly the 9 files from Tasks 1–9 appear (`index.html`, `general-pest-control/index.html`, `ant-control/index.html`, `spider-control/index.html`, `cockroach-control/index.html`, `rodent-control/index.html`, `bees/index.html`, `mud-wasp-control/index.html`, `termite-treatment/index.html`) — no other file listed.

- [ ] **Step 2: Confirm the header/mobile-nav "Get a Quote" buttons are untouched sitewide**

```bash
grep -rc 'Get a Quote' index.html general-pest-control/index.html ant-control/index.html spider-control/index.html cockroach-control/index.html rodent-control/index.html bees/index.html mud-wasp-control/index.html termite-treatment/index.html
```
Expected: `2` for every file listed (the header + mobile-nav pair only).

- [ ] **Step 3: Confirm no other page in the repo was accidentally changed**

```bash
git status -sb
```
Expected: clean — nothing untracked or unstaged; branch is `main` with 9 new local commits ahead of `origin/main`.

- [ ] **Step 4: Push to main**

```bash
git push origin main
```

- [ ] **Step 5: Confirm the Cloudflare Workers Build for this push succeeds**

Use the `mcp__plugin_cloudflare_cloudflare-builds__workers_builds_list_builds` tool with `workerId: f60e6e66c18a4a298fcae48b8db19f58` to find the new build for the just-pushed commit, then `mcp__plugin_cloudflare_cloudflare-builds__workers_builds_get_build` on that build UUID.
Expected: `status: stopped`, `buildOutcome: success`, `branch: main`, `deployCommand: npx wrangler deploy`.

- [ ] **Step 6: Spot-check the live site**

Fetch `https://tcbpestcontrolcanberra.com.au/` and `https://tcbpestcontrolcanberra.com.au/general-pest-control` and confirm each returns HTTP 200 and contains the string "Book Now".
