# Site Navigation

A category map of every page on the site, for finding things fast in an editor or on GitHub. This file changes nothing about the site itself — it's a reading aid only.

**Important:** on this site the folder path *is* the live URL (see `src/index.js` — the Worker resolves `/foo` directly to `foo/index.html`, with no build step in between). So the flat top-level folder layout is intentional, not accidental clutter, and moving files into nested folders would change live URLs and require redirects, sitemap updates, and re-crawling. A past URL migration already caused canonical-tag problems that had to be patched at the edge (see the comments in `src/index.js`) — so folders stay flat by design. Use the sections below to jump to what you need instead.

| Section | Pages |
|---|---|
| [Home & error page](#home--error-page) | 2 |
| [Core business pages](#core-business-pages) | 13 |
| [Pest-specific service pages](#pest-specific-service-pages) | 22 |
| [Blog](#blog) | 7 |
| [Location pages](#location-pages) | 85 |
| [Standalone / non-pest-control page](#standalone--non-pest-control-page) | 1 |

---

## Home & Error Page

- **[`index.html`](index.html)** — `/` — Homepage. Intro to TCB Pest Control, pests treated, and links into services, locations and contact.
- **[`404.html`](404.html)** — `/404.html` — Custom 'page not found' page, links back to key pages so a broken link doesn't dead-end a visit.

## Core Business Pages

- **[`about/index.html`](about/index.html)** — `/about` — Company 'About' page — family-run, fully licensed, Termidor-accredited.
- **[`contact/index.html`](contact/index.html)** — `/contact` — Main contact page with the quote-request form.
- **[`faq/index.html`](faq/index.html)** — `/faq` — Frequently asked questions about booking, pricing and process.
- **[`residential/index.html`](residential/index.html)** — `/residential` — Service hub for homeowners.
- **[`commercial/index.html`](commercial/index.html)** — `/commercial` — Service hub for businesses.
- **[`pests-we-treat/index.html`](pests-we-treat/index.html)** — `/pests-we-treat` — Index of all 24 pests treated, links to each pest-specific page below.
- **[`pre-purchase-inspection/index.html`](pre-purchase-inspection/index.html)** — `/pre-purchase-inspection` — Pre-purchase timber pest inspection service, for home buyers/conveyancers.
- **[`preparation/index.html`](preparation/index.html)** — `/preparation` — Index of 'what to do before we arrive' prep guides per treatment type.
- **[`resources/index.html`](resources/index.html)** — `/resources` — Broader resources hub: prep guides, after-care notes, species fact sheets.
- **[`pest-control-canberra/index.html`](pest-control-canberra/index.html)** — `/pest-control-canberra` — Trust/expectations landing page — 'What to Expect' before booking.
- **[`thank-you/index.html`](thank-you/index.html)** — `/thank-you` — Form-submission confirmation page.
- **[`privacy/index.html`](privacy/index.html)** — `/privacy` — Privacy policy.
- **[`terms/index.html`](terms/index.html)** — `/terms` — Terms of service.

## Pest-Specific Service Pages

- **[`ant-control/index.html`](ant-control/index.html)** — `/ant-control` — Ant control.
- **[`carpenter-ants/index.html`](carpenter-ants/index.html)** — `/carpenter-ants` — Carpenter ant control.
- **[`spider-control/index.html`](spider-control/index.html)** — `/spider-control` — Spider control.
- **[`cockroach-control/index.html`](cockroach-control/index.html)** — `/cockroach-control` — Cockroach control.
- **[`cockroach-control/australian-cockroach/index.html`](cockroach-control/australian-cockroach/index.html)** — `/cockroach-control/australian-cockroach` — Australian cockroach — nested sub-page under cockroach control.
- **[`termite-treatment/index.html`](termite-treatment/index.html)** — `/termite-treatment` — Termite treatment & inspections.
- **[`rodent-control/index.html`](rodent-control/index.html)** — `/rodent-control` — Rodent (rat/mouse) control.
- **[`bed-bug-treatment-canberra/index.html`](bed-bug-treatment-canberra/index.html)** — `/bed-bug-treatment-canberra` — Bed bug treatment.
- **[`bees/index.html`](bees/index.html)** — `/bees` — Wasp and bee removal (covers both despite the folder name).
- **[`bird-control/index.html`](bird-control/index.html)** — `/bird-control` — Bird control (pigeons, mynas, starlings).
- **[`possum-control/index.html`](possum-control/index.html)** — `/possum-control` — Possum removal.
- **[`flea-control/index.html`](flea-control/index.html)** — `/flea-control` — Flea control.
- **[`mosquito-control/index.html`](mosquito-control/index.html)** — `/mosquito-control` — Mosquito and fly control.
- **[`mud-wasp-control/index.html`](mud-wasp-control/index.html)** — `/mud-wasp-control` — Mud wasp control.
- **[`earwig-control/index.html`](earwig-control/index.html)** — `/earwig-control` — Earwig control.
- **[`silverfish-control/index.html`](silverfish-control/index.html)** — `/silverfish-control` — Silverfish and clothes moth control.
- **[`slater-control/index.html`](slater-control/index.html)** — `/slater-control` — Slater / pill bug control.
- **[`millipede-control/index.html`](millipede-control/index.html)** — `/millipede-control` — Millipede control.
- **[`ladybug-control/index.html`](ladybug-control/index.html)** — `/ladybug-control` — Ladybug and occasional-invader control.
- **[`stored-product-pest-control/index.html`](stored-product-pest-control/index.html)** — `/stored-product-pest-control` — Pantry/stored-product pests (meal moth, weevils, carpet beetle).
- **[`general-pest-control/index.html`](general-pest-control/index.html)** — `/general-pest-control` — General, all-round pest control (not species-specific).
- **[`pest-control-for-ants/index.html`](pest-control-for-ants/index.html)** — `/pest-control-for-ants` — Combined ants + spiders + cockroaches landing page (secondary/variant of the three individual pages).

## Blog

- **[`blog/index.html`](blog/index.html)** — `/blog` — Blog index, links to all articles below.
- **[`blog-guide-to-canberra-spiders/index.html`](blog-guide-to-canberra-spiders/index.html)** — `/blog-guide-to-canberra-spiders` — Guide to Canberra's most common spiders.
- **[`blog-dangerous-spiders-canberra/index.html`](blog-dangerous-spiders-canberra/index.html)** — `/blog-dangerous-spiders-canberra` — Dangerous spiders in Canberra homes.
- **[`blog-european-wasps-summer-garden/index.html`](blog-european-wasps-summer-garden/index.html)** — `/blog-european-wasps-summer-garden` — Keeping European wasps out of the garden in summer.
- **[`blog-rat-and-mouse-pest-control-canberra-autumn/index.html`](blog-rat-and-mouse-pest-control-canberra-autumn/index.html)** — `/blog-rat-and-mouse-pest-control-canberra-autumn` — Rat and mouse control in the Canberra autumn.
- **[`blog-termite-prevention-tips-for-canberra-homeowners/index.html`](blog-termite-prevention-tips-for-canberra-homeowners/index.html)** — `/blog-termite-prevention-tips-for-canberra-homeowners` — Termite prevention tips for homeowners.
- **[`blog-why-pest-control-is-important-in-canberra/index.html`](blog-why-pest-control-is-important-in-canberra/index.html)** — `/blog-why-pest-control-is-important-in-canberra` — Why pest control matters in Canberra.
- **[`blog-how-pest-control-makes-your-workplace-safer/index.html`](blog-how-pest-control-makes-your-workplace-safer/index.html)** — `/blog-how-pest-control-makes-your-workplace-safer` — How pest control makes a workplace safer.

## Location Pages

84 near-identical suburb/district landing pages (`/locations-pest-control-<suburb>`), one per Canberra/Queanbeyan area, plus an overview page. Same template as the pest-specific pages, scoped to a single suburb.

- **[`locations/index.html`](locations/index.html)** — `/locations` — Overview/index for all service areas, links to every suburb page below.

<details>
<summary>All 84 suburb pages (click to expand)</summary>

| Suburb / district | File | URL |
|---|---|---|
| Acton | [`locations-pest-control-acton/index.html`](locations-pest-control-acton/index.html) | `/locations-pest-control-acton` |
| Ainslie | [`locations-pest-control-ainslie/index.html`](locations-pest-control-ainslie/index.html) | `/locations-pest-control-ainslie` |
| Amaroo | [`locations-pest-control-amaroo/index.html`](locations-pest-control-amaroo/index.html) | `/locations-pest-control-amaroo` |
| Aranda | [`locations-pest-control-aranda/index.html`](locations-pest-control-aranda/index.html) | `/locations-pest-control-aranda` |
| Banks | [`locations-pest-control-banks/index.html`](locations-pest-control-banks/index.html) | `/locations-pest-control-banks` |
| Barton | [`locations-pest-control-barton/index.html`](locations-pest-control-barton/index.html) | `/locations-pest-control-barton` |
| Belconnen | [`locations-pest-control-belconnen/index.html`](locations-pest-control-belconnen/index.html) | `/locations-pest-control-belconnen` |
| Bonner | [`locations-pest-control-bonner/index.html`](locations-pest-control-bonner/index.html) | `/locations-pest-control-bonner` |
| Bonython | [`locations-pest-control-bonython/index.html`](locations-pest-control-bonython/index.html) | `/locations-pest-control-bonython` |
| Braddon | [`locations-pest-control-braddon/index.html`](locations-pest-control-braddon/index.html) | `/locations-pest-control-braddon` |
| Campbell | [`locations-pest-control-campbell/index.html`](locations-pest-control-campbell/index.html) | `/locations-pest-control-campbell` |
| Canberra City | [`locations-pest-control-canberra-city/index.html`](locations-pest-control-canberra-city/index.html) | `/locations-pest-control-canberra-city` |
| Casey | [`locations-pest-control-casey/index.html`](locations-pest-control-casey/index.html) | `/locations-pest-control-casey` |
| Chapman | [`locations-pest-control-chapman/index.html`](locations-pest-control-chapman/index.html) | `/locations-pest-control-chapman` |
| Civic | [`locations-pest-control-civic/index.html`](locations-pest-control-civic/index.html) | `/locations-pest-control-civic` |
| Conder | [`locations-pest-control-conder/index.html`](locations-pest-control-conder/index.html) | `/locations-pest-control-conder` |
| Cook | [`locations-pest-control-cook/index.html`](locations-pest-control-cook/index.html) | `/locations-pest-control-cook` |
| Crace | [`locations-pest-control-crace/index.html`](locations-pest-control-crace/index.html) | `/locations-pest-control-crace` |
| Crestwood | [`locations-pest-control-crestwood/index.html`](locations-pest-control-crestwood/index.html) | `/locations-pest-control-crestwood` |
| Curtin | [`locations-pest-control-curtin/index.html`](locations-pest-control-curtin/index.html) | `/locations-pest-control-curtin` |
| Deakin | [`locations-pest-control-deakin/index.html`](locations-pest-control-deakin/index.html) | `/locations-pest-control-deakin` |
| Dickson | [`locations-pest-control-dickson/index.html`](locations-pest-control-dickson/index.html) | `/locations-pest-control-dickson` |
| Downer | [`locations-pest-control-downer/index.html`](locations-pest-control-downer/index.html) | `/locations-pest-control-downer` |
| Duffy | [`locations-pest-control-duffy/index.html`](locations-pest-control-duffy/index.html) | `/locations-pest-control-duffy` |
| Evatt | [`locations-pest-control-evatt/index.html`](locations-pest-control-evatt/index.html) | `/locations-pest-control-evatt` |
| Farrer | [`locations-pest-control-farrer/index.html`](locations-pest-control-farrer/index.html) | `/locations-pest-control-farrer` |
| Fisher | [`locations-pest-control-fisher/index.html`](locations-pest-control-fisher/index.html) | `/locations-pest-control-fisher` |
| Florey | [`locations-pest-control-florey/index.html`](locations-pest-control-florey/index.html) | `/locations-pest-control-florey` |
| Franklin | [`locations-pest-control-franklin/index.html`](locations-pest-control-franklin/index.html) | `/locations-pest-control-franklin` |
| Fyshwick | [`locations-pest-control-fyshwick/index.html`](locations-pest-control-fyshwick/index.html) | `/locations-pest-control-fyshwick` |
| Garran | [`locations-pest-control-garran/index.html`](locations-pest-control-garran/index.html) | `/locations-pest-control-garran` |
| Googong | [`locations-pest-control-googong/index.html`](locations-pest-control-googong/index.html) | `/locations-pest-control-googong` |
| Gordon | [`locations-pest-control-gordon/index.html`](locations-pest-control-gordon/index.html) | `/locations-pest-control-gordon` |
| Greenway | [`locations-pest-control-greenway/index.html`](locations-pest-control-greenway/index.html) | `/locations-pest-control-greenway` |
| Griffith | [`locations-pest-control-griffith/index.html`](locations-pest-control-griffith/index.html) | `/locations-pest-control-griffith` |
| Gungahlin | [`locations-pest-control-gungahlin/index.html`](locations-pest-control-gungahlin/index.html) | `/locations-pest-control-gungahlin` |
| Hackett | [`locations-pest-control-hackett/index.html`](locations-pest-control-hackett/index.html) | `/locations-pest-control-hackett` |
| Harrison | [`locations-pest-control-harrison/index.html`](locations-pest-control-harrison/index.html) | `/locations-pest-control-harrison` |
| Hawker | [`locations-pest-control-hawker/index.html`](locations-pest-control-hawker/index.html) | `/locations-pest-control-hawker` |
| Holder | [`locations-pest-control-holder/index.html`](locations-pest-control-holder/index.html) | `/locations-pest-control-holder` |
| Hughes | [`locations-pest-control-hughes/index.html`](locations-pest-control-hughes/index.html) | `/locations-pest-control-hughes` |
| Inner North | [`locations-pest-control-inner-north-canberra/index.html`](locations-pest-control-inner-north-canberra/index.html) | `/locations-pest-control-inner-north-canberra` |
| Inner South | [`locations-pest-control-inner-south/index.html`](locations-pest-control-inner-south/index.html) | `/locations-pest-control-inner-south` |
| Isaacs | [`locations-pest-control-isaacs/index.html`](locations-pest-control-isaacs/index.html) | `/locations-pest-control-isaacs` |
| Isabella Plains | [`locations-pest-control-isabella-plains/index.html`](locations-pest-control-isabella-plains/index.html) | `/locations-pest-control-isabella-plains` |
| Jerrabomberra | [`locations-pest-control-jerrabomberra/index.html`](locations-pest-control-jerrabomberra/index.html) | `/locations-pest-control-jerrabomberra` |
| Kaleen | [`locations-pest-control-kaleen/index.html`](locations-pest-control-kaleen/index.html) | `/locations-pest-control-kaleen` |
| Kambah | [`locations-pest-control-kambah/index.html`](locations-pest-control-kambah/index.html) | `/locations-pest-control-kambah` |
| Karabar | [`locations-pest-control-karabar/index.html`](locations-pest-control-karabar/index.html) | `/locations-pest-control-karabar` |
| Kingston | [`locations-pest-control-kingston/index.html`](locations-pest-control-kingston/index.html) | `/locations-pest-control-kingston` |
| Latham | [`locations-pest-control-latham/index.html`](locations-pest-control-latham/index.html) | `/locations-pest-control-latham` |
| Letchworth | [`locations-pest-control-letchworth/index.html`](locations-pest-control-letchworth/index.html) | `/locations-pest-control-letchworth` |
| Lyneham | [`locations-pest-control-lyneham/index.html`](locations-pest-control-lyneham/index.html) | `/locations-pest-control-lyneham` |
| Macquarie | [`locations-pest-control-macquarie/index.html`](locations-pest-control-macquarie/index.html) | `/locations-pest-control-macquarie` |
| Manuka | [`locations-pest-control-manuka/index.html`](locations-pest-control-manuka/index.html) | `/locations-pest-control-manuka` |
| Mawson | [`locations-pest-control-mawson/index.html`](locations-pest-control-mawson/index.html) | `/locations-pest-control-mawson` |
| Mitchell | [`locations-pest-control-mitchell/index.html`](locations-pest-control-mitchell/index.html) | `/locations-pest-control-mitchell` |
| Molonglo Valley | [`locations-pest-control-molonglo-valley/index.html`](locations-pest-control-molonglo-valley/index.html) | `/locations-pest-control-molonglo-valley` |
| Monash | [`locations-pest-control-monash/index.html`](locations-pest-control-monash/index.html) | `/locations-pest-control-monash` |
| Narrabundah | [`locations-pest-control-narrabundah/index.html`](locations-pest-control-narrabundah/index.html) | `/locations-pest-control-narrabundah` |
| Ngunnawal | [`locations-pest-control-ngunnawal/index.html`](locations-pest-control-ngunnawal/index.html) | `/locations-pest-control-ngunnawal` |
| O'Connor | [`locations-pest-control-oconnor/index.html`](locations-pest-control-oconnor/index.html) | `/locations-pest-control-oconnor` |
| O'Malley | [`locations-pest-control-omalley/index.html`](locations-pest-control-omalley/index.html) | `/locations-pest-control-omalley` |
| Oxley | [`locations-pest-control-oxley/index.html`](locations-pest-control-oxley/index.html) | `/locations-pest-control-oxley` |
| Page | [`locations-pest-control-page/index.html`](locations-pest-control-page/index.html) | `/locations-pest-control-page` |
| Palmerston | [`locations-pest-control-palmerston/index.html`](locations-pest-control-palmerston/index.html) | `/locations-pest-control-palmerston` |
| Parkes | [`locations-pest-control-parkes/index.html`](locations-pest-control-parkes/index.html) | `/locations-pest-control-parkes` |
| Pearce | [`locations-pest-control-pearce/index.html`](locations-pest-control-pearce/index.html) | `/locations-pest-control-pearce` |
| Phillip | [`locations-pest-control-phillip/index.html`](locations-pest-control-phillip/index.html) | `/locations-pest-control-phillip` |
| Queanbeyan West | [`locations-pest-control-queanbeyan-west/index.html`](locations-pest-control-queanbeyan-west/index.html) | `/locations-pest-control-queanbeyan-west` |
| Queanbeyan | [`locations-pest-control-queanbeyan/index.html`](locations-pest-control-queanbeyan/index.html) | `/locations-pest-control-queanbeyan` |
| Reid | [`locations-pest-control-reid/index.html`](locations-pest-control-reid/index.html) | `/locations-pest-control-reid` |
| Scullin | [`locations-pest-control-scullin/index.html`](locations-pest-control-scullin/index.html) | `/locations-pest-control-scullin` |
| Stirling | [`locations-pest-control-stirling/index.html`](locations-pest-control-stirling/index.html) | `/locations-pest-control-stirling` |
| Symonston | [`locations-pest-control-symonston/index.html`](locations-pest-control-symonston/index.html) | `/locations-pest-control-symonston` |
| The Angle | [`locations-pest-control-the-angle/index.html`](locations-pest-control-the-angle/index.html) | `/locations-pest-control-the-angle` |
| Tuggeranong | [`locations-pest-control-tuggeranong/index.html`](locations-pest-control-tuggeranong/index.html) | `/locations-pest-control-tuggeranong` |
| Turner | [`locations-pest-control-turner/index.html`](locations-pest-control-turner/index.html) | `/locations-pest-control-turner` |
| Wamboin | [`locations-pest-control-wamboin/index.html`](locations-pest-control-wamboin/index.html) | `/locations-pest-control-wamboin` |
| Wanniassa | [`locations-pest-control-wanniassa/index.html`](locations-pest-control-wanniassa/index.html) | `/locations-pest-control-wanniassa` |
| Waramanga | [`locations-pest-control-waramanga/index.html`](locations-pest-control-waramanga/index.html) | `/locations-pest-control-waramanga` |
| Watson | [`locations-pest-control-watson/index.html`](locations-pest-control-watson/index.html) | `/locations-pest-control-watson` |
| Weston Creek | [`locations-pest-control-weston-creek/index.html`](locations-pest-control-weston-creek/index.html) | `/locations-pest-control-weston-creek` |
| Woden Valley | [`locations-pest-control-woden/index.html`](locations-pest-control-woden/index.html) | `/locations-pest-control-woden` |

</details>

## Standalone / Non-Pest-Control Page

- **[`servicem8-setup-training/index.html`](servicem8-setup-training/index.html)** — `/servicem8-setup-training` — ServiceM8 setup & training — a separate consulting service the business also offers, unrelated to pest control content.

