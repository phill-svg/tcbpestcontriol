// The site's canonical service/location/pricing data, in one place so it
// can't drift between consumers. Used by both the MCP tools (src/mcp.js)
// and the /index.json endpoint (src/index.js). Keep in sync manually if
// suburb or service pages are added, renamed or removed.

export const SITE = "https://www.tcbpestcontrolcanberra.com.au";

export const SITE_INFO = {
	name: "TCB Pest Control Canberra",
	url: SITE,
	description:
		"Family-run, fully licensed and insured pest control company servicing homes and businesses across the ACT and surrounding NSW (Queanbeyan).",
	phone: "02 6105 9771",
	email: "office@tcbpestcontrolcanberra.com.au",
	// Kept in step with the aggregateRating in the pages' structured data, the
	// figure quoted in llms.txt and the one the chat assistant is told. Four
	// places said three different things -- 4.8/61, 4.8/62 and "4.9-star, 60+
	// reviews" -- and the assistant was the one overstating it to customers.
	rating: { value: 4.8, count: 61, url: `${SITE}/reviews` },
};

// Generated from the site's locations-pest-control-* pages.
export const SUBURBS = [{"slug":"acton","name":"Acton","url":"/locations-pest-control-acton"},{"slug":"ainslie","name":"Ainslie","url":"/locations-pest-control-ainslie"},{"slug":"amaroo","name":"Amaroo","url":"/locations-pest-control-amaroo"},{"slug":"aranda","name":"Aranda","url":"/locations-pest-control-aranda"},{"slug":"banks","name":"Banks","url":"/locations-pest-control-banks"},{"slug":"barton","name":"Barton","url":"/locations-pest-control-barton"},{"slug":"belconnen","name":"Belconnen","url":"/locations-pest-control-belconnen"},{"slug":"bonner","name":"Bonner","url":"/locations-pest-control-bonner"},{"slug":"bonython","name":"Bonython","url":"/locations-pest-control-bonython"},{"slug":"braddon","name":"Braddon","url":"/locations-pest-control-braddon"},{"slug":"campbell","name":"Campbell","url":"/locations-pest-control-campbell"},{"slug":"canberra-city","name":"Canberra City","url":"/locations-pest-control-canberra-city"},{"slug":"casey","name":"Casey","url":"/locations-pest-control-casey"},{"slug":"chapman","name":"Chapman","url":"/locations-pest-control-chapman"},{"slug":"civic","name":"Civic","url":"/locations-pest-control-civic"},{"slug":"conder","name":"Conder","url":"/locations-pest-control-conder"},{"slug":"cook","name":"Cook","url":"/locations-pest-control-cook"},{"slug":"crace","name":"Crace","url":"/locations-pest-control-crace"},{"slug":"crestwood","name":"Crestwood","url":"/locations-pest-control-crestwood"},{"slug":"curtin","name":"Curtin","url":"/locations-pest-control-curtin"},{"slug":"deakin","name":"Deakin","url":"/locations-pest-control-deakin"},{"slug":"dickson","name":"Dickson","url":"/locations-pest-control-dickson"},{"slug":"downer","name":"Downer","url":"/locations-pest-control-downer"},{"slug":"duffy","name":"Duffy","url":"/locations-pest-control-duffy"},{"slug":"evatt","name":"Evatt","url":"/locations-pest-control-evatt"},{"slug":"farrer","name":"Farrer","url":"/locations-pest-control-farrer"},{"slug":"fisher","name":"Fisher","url":"/locations-pest-control-fisher"},{"slug":"florey","name":"Florey","url":"/locations-pest-control-florey"},{"slug":"franklin","name":"Franklin","url":"/locations-pest-control-franklin"},{"slug":"fyshwick","name":"Fyshwick","url":"/locations-pest-control-fyshwick"},{"slug":"garran","name":"Garran","url":"/locations-pest-control-garran"},{"slug":"googong","name":"Googong","url":"/locations-pest-control-googong"},{"slug":"gordon","name":"Gordon","url":"/locations-pest-control-gordon"},{"slug":"greenway","name":"Greenway","url":"/locations-pest-control-greenway"},{"slug":"griffith","name":"Griffith","url":"/locations-pest-control-griffith"},{"slug":"gungahlin","name":"Gungahlin","url":"/locations-pest-control-gungahlin"},{"slug":"hackett","name":"Hackett","url":"/locations-pest-control-hackett"},{"slug":"harrison","name":"Harrison","url":"/locations-pest-control-harrison"},{"slug":"hawker","name":"Hawker","url":"/locations-pest-control-hawker"},{"slug":"holder","name":"Holder","url":"/locations-pest-control-holder"},{"slug":"hughes","name":"Hughes","url":"/locations-pest-control-hughes"},{"slug":"inner-north-canberra","name":"Inner North","url":"/locations-pest-control-inner-north-canberra"},{"slug":"inner-south","name":"Inner South","url":"/locations-pest-control-inner-south"},{"slug":"isaacs","name":"Isaacs","url":"/locations-pest-control-isaacs"},{"slug":"isabella-plains","name":"Isabella Plains","url":"/locations-pest-control-isabella-plains"},{"slug":"jerrabomberra","name":"Jerrabomberra","url":"/locations-pest-control-jerrabomberra"},{"slug":"kaleen","name":"Kaleen","url":"/locations-pest-control-kaleen"},{"slug":"kambah","name":"Kambah","url":"/locations-pest-control-kambah"},{"slug":"karabar","name":"Karabar","url":"/locations-pest-control-karabar"},{"slug":"kingston","name":"Kingston","url":"/locations-pest-control-kingston"},{"slug":"latham","name":"Latham","url":"/locations-pest-control-latham"},{"slug":"letchworth","name":"Letchworth","url":"/locations-pest-control-letchworth"},{"slug":"lyneham","name":"Lyneham","url":"/locations-pest-control-lyneham"},{"slug":"macquarie","name":"Macquarie","url":"/locations-pest-control-macquarie"},{"slug":"manuka","name":"Manuka","url":"/locations-pest-control-manuka"},{"slug":"mawson","name":"Mawson","url":"/locations-pest-control-mawson"},{"slug":"mitchell","name":"Mitchell","url":"/locations-pest-control-mitchell"},{"slug":"molonglo-valley","name":"Molonglo Valley","url":"/locations-pest-control-molonglo-valley"},{"slug":"monash","name":"Monash","url":"/locations-pest-control-monash"},{"slug":"narrabundah","name":"Narrabundah","url":"/locations-pest-control-narrabundah"},{"slug":"ngunnawal","name":"Ngunnawal","url":"/locations-pest-control-ngunnawal"},{"slug":"oconnor","name":"O'Connor","url":"/locations-pest-control-oconnor"},{"slug":"omalley","name":"O'Malley","url":"/locations-pest-control-omalley"},{"slug":"oxley","name":"Oxley","url":"/locations-pest-control-oxley"},{"slug":"page","name":"Page","url":"/locations-pest-control-page"},{"slug":"palmerston","name":"Palmerston","url":"/locations-pest-control-palmerston"},{"slug":"parkes","name":"Parkes","url":"/locations-pest-control-parkes"},{"slug":"pearce","name":"Pearce","url":"/locations-pest-control-pearce"},{"slug":"phillip","name":"Phillip","url":"/locations-pest-control-phillip"},{"slug":"queanbeyan-west","name":"Queanbeyan West","url":"/locations-pest-control-queanbeyan-west"},{"slug":"queanbeyan","name":"Queanbeyan","url":"/locations-pest-control-queanbeyan"},{"slug":"reid","name":"Reid","url":"/locations-pest-control-reid"},{"slug":"scullin","name":"Scullin","url":"/locations-pest-control-scullin"},{"slug":"stirling","name":"Stirling","url":"/locations-pest-control-stirling"},{"slug":"symonston","name":"Symonston","url":"/locations-pest-control-symonston"},{"slug":"the-angle","name":"The Angle","url":"/locations-pest-control-the-angle"},{"slug":"tuggeranong","name":"Tuggeranong","url":"/locations-pest-control-tuggeranong"},{"slug":"turner","name":"Turner","url":"/locations-pest-control-turner"},{"slug":"wamboin","name":"Wamboin","url":"/locations-pest-control-wamboin"},{"slug":"wanniassa","name":"Wanniassa","url":"/locations-pest-control-wanniassa"},{"slug":"waramanga","name":"Waramanga","url":"/locations-pest-control-waramanga"},{"slug":"watson","name":"Watson","url":"/locations-pest-control-watson"},{"slug":"weston-creek","name":"Weston Creek","url":"/locations-pest-control-weston-creek"},{"slug":"woden","name":"Woden Valley","url":"/locations-pest-control-woden"}];

// Mirrors the Services section of /llms.txt.
export const SERVICES = [
	{ name: "Residential Pest Control", url: "/residential", description: "General home pest control plans and one-off treatments." },
	{ name: "Commercial Pest Control", url: "/commercial", description: "Pest management for businesses, retail, hospitality and strata." },
	{ name: "Pests We Treat", url: "/pests-we-treat", description: "Overview of every pest type serviced." },
	{ name: "Termite Treatment & Inspection", url: "/termite-treatment", description: "Termite inspections, barriers and treatment." },
	{ name: "Pre-Purchase Inspections", url: "/pre-purchase-inspection", description: "AS 4349.3 timber pest inspections for property purchases." },
	{ name: "Rodent Control", url: "/rodent-control", description: "Rat and mouse baiting and proofing." },
	{ name: "Ant Control", url: "/ant-control", description: "Ant treatment for homes and businesses." },
	{ name: "Spider Control", url: "/spider-control", description: "Spider treatment including redbacks and funnel-webs." },
	{ name: "Orb Weaver Spider", url: "/spider-control/orb-weaver-spider", description: "Identifying and treating orb weaver spiders." },
	{ name: "Garden Orb Weaver Spider", url: "/spider-control/garden-orb-weaver-spider", description: "Identifying and treating garden orb weavers." },
	{ name: "Bee Control", url: "/bees", description: "Bee removal and hive relocation; wasp nest removal." },
	{ name: "Cockroach Control", url: "/cockroach-control", description: "German and American cockroach treatment." },
	{ name: "Australian Cockroach", url: "/cockroach-control/australian-cockroach", description: "Identifying and treating Australian cockroaches." },
	{ name: "Flea Control", url: "/flea-control", description: "Flea treatment for homes and pets' environments." },
	{ name: "Silverfish Control", url: "/silverfish-control", description: "Silverfish treatment." },
	{ name: "Bird Control", url: "/bird-control", description: "Bird proofing and deterrents." },
	{ name: "Possum Control", url: "/possum-control", description: "Possum removal and exclusion." },
	{ name: "Stored Product Pest Control", url: "/stored-product-pest-control", description: "Pantry and stored-product pest treatment." },
	{ name: "General Pest Control", url: "/general-pest-control", description: "One-visit, inside-and-out seasonal treatment." },
	{ name: "Bed Bug Treatment", url: "/bed-bug-treatment-canberra", description: "Bed bug identification and treatment." },
	{ name: "Carpenter Ants", url: "/carpenter-ants", description: "Carpenter ant identification and treatment." },
	{ name: "Earwig Control", url: "/earwig-control", description: "Earwig treatment." },
	{ name: "Ladybug Control", url: "/ladybug-control", description: "Ladybug/ladybird treatment." },
	{ name: "Millipede Control", url: "/millipede-control", description: "Millipede treatment." },
	{ name: "Mosquito Control", url: "/mosquito-control", description: "Mosquito treatment." },
	{ name: "Mud Wasp Control", url: "/mud-wasp-control", description: "Mud wasp treatment." },
	{ name: "Slater Control", url: "/slater-control", description: "Slater (woodlouse) treatment." },
];

// Only these three services have a published *starting* price (see
// /pricing). Everything else is quoted for free after a look at the job --
// consumers must never invent a number for those.
export const PRICING = [
	{ service: "General Pest Control", url: "/general-pest-control", startingPrice: 249, currency: "AUD" },
	{ service: "Termite Inspection", url: "/termite-treatment", startingPrice: 289, currency: "AUD" },
	{ service: "Rodent Control", url: "/rodent-control", startingPrice: 249, currency: "AUD" },
];

// Other key pages that aren't services or suburbs, for the /index.json manifest.
export const PAGES = [
	{ title: "About TCB", url: "/about", description: "Company background, accreditations, service area." },
	{ title: "Resources & Guides", url: "/resources", description: "Hub for preparation guides and species fact sheets." },
	{ title: "Reviews", url: "/reviews", description: "Google reviews, rated 4.8 from 61 reviews." },
	{ title: "FAQ", url: "/faq", description: "Frequently asked questions about booking, pricing and treatments." },
	{ title: "Pricing", url: "/pricing", description: "Starting prices for the most-booked services." },
	{ title: "Locations Overview", url: "/locations", description: "Full list of every Canberra and Queanbeyan-area suburb serviced." },
	{ title: "Preparation Guides", url: "/preparation", description: "Downloadable PDF guides for preparing a property before a treatment visit." },
	{ title: "Blog", url: "/blog", description: "Articles on pest identification, prevention and treatment." },
	{ title: "Contact", url: "/contact", description: "Contact details and enquiry form." },
	{ title: "Book Online", url: "/book", description: "Submit a booking enquiry directly." },
];

export const MCP_INFO = {
	endpoint: `${SITE}/mcp`,
	transport: "Streamable HTTP (stateless, POST only)",
	tools: ["check_suburb_coverage", "list_services", "get_service_pricing", "submit_booking_enquiry"],
};
