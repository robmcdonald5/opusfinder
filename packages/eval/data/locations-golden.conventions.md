# Labeling conventions: location golden set

You are writing the EXPECTED answer for real job-posting location strings. Each pair gives a company
(slug + ATS), the raw location text exactly as the company wrote it, and up to 20 of that company's other
location strings (most-listed first) as context. Your answer is the ground truth a smaller model will be
scored against, so be careful and literal. A later script checks every place you name against GeoNames
and resolves it to a GeoNames id.

## What an answer contains

- `places`: the places the text names, each `{city, region, country, kind}`.
- `remoteCountries`: ISO 3166-1 alpha-2 codes of the countries a remote option is limited to.
- `note` (optional): one short sentence when you made a judgment call (ambiguous name, unusual format), so
  the owner reviewing the labels knows what to double-check. Omit it when the answer is obvious.

## Places

1. List EVERY city the text names, each as its own place with `kind: "city"`, its first-level region and its
   country.
2. Give a `kind: "region"` place (city null) only for a state/province/region the text names without naming
   a city in it. Give a `kind: "country"` place (city and region null) only for a country the text names
   without naming a city or region in it. Never add a region or country that a named city already covers
   ("Austin, Texas, United States" is ONE place: the city Austin).
3. A neighborhood, borough or district inside a city → that city ("Union Square, New York City" → New York
   City; "Canary Wharf" → London). A metro area → its main city ("San Francisco Bay Area" → San Francisco;
   "Greater Seattle Area" → Seattle; "Delhi-NCR" → New Delhi). A suburb that is its own city stays itself
   (Santa Monica, Palo Alto, South San Francisco, Westerville).
4. An office / HQ / campus / data center / station / site / store label around a place → that place
   ("NYC Office" → New York City; "Mercor HQ, 181 Fremont Street" → San Francisco only if the context makes
   the city clear, else no place). A label with no place in it ("HQ", "Central Office", "Field",
   "Any TEGNA Station Location") → no places.
5. Decode a company's own formats: "US-CA-Menlo Park" → Menlo Park, California, US; "GB-London" → London;
   "IN-HR-Gurugram-418-419" → Gurugram, Haryana, IN; "CH-Zurich-Observe" → Zürich; a TV call sign like
   "WBIR-TV Knoxville" → the city (use the company's other stations to pick the right state when the name
   is ambiguous).
6. These are not places: Remote, Hybrid, On-site/Onsite, In-Office, Office, HQ, Headquarters, Home based,
   Distributed, Travel, Field, client sites, street addresses, postal codes, time zones.
7. World regions and blocs are not places and not remote countries: EMEA, APAC, APJ, LATAM, AMER, NAMER,
   Americas, Europe, European Union, Asia, North America, South America, Global, Worldwide, DACH, Nordics,
   Benelux, CIS, "Middle East", "UK & Ireland" as a region label, and US sub-regions like "West Coast",
   "East Coast", "Northeast Region", "Pacific Coast". A string that is ONLY such a label → no places. When a
   bloc label prefixes a real place ("Asia, Taiwan, Taipei"; "EMEA - U.K."), ignore the bloc and keep the
   place.
8. Use English names as GeoNames gives them for cities: "New York City" (for "New York, NY", "NYC",
   "New York City"), "Washington" with region "District of Columbia" for Washington DC, "Bengaluru"
   (Bangalore), "Gurugram" (Gurgaon), "Kyiv", "Zürich", "Munich", "Mexico City", "São Paulo",
   "Ho Chi Minh City", "Hong Kong". Spell cities in full.
9. Regions: the full English name of the first-level region (US state, Canadian province, Indian state,
   Australian state, German Land, "England" / "Scotland" / "Wales" / "Northern Ireland" for UK cities).
   When you are unsure of the region's name, or the country has no meaningful first-level region for the
   city (Singapore, Hong Kong), use `region: null`: the checker then takes the largest city of that name in
   the country. Give the region whenever the country has several cities of that name and you know which one
   is meant.
10. Countries: ISO 3166-1 alpha-2 (GB for the United Kingdom, US, IE for "Republic of Ireland", TR for
    Türkiye, HK for Hong Kong, KR for South Korea, CZ for Czechia/Czech Republic, AE for the UAE).
11. A bare name that could be several places ("Dublin", "Portland", "Cambridge", "Vancouver", "Georgia",
    "San Jose", "Valencia", "London", "Melbourne", "Paris") means the one the company's other strings point
    to (a company whose other offices are all in Ohio → Dublin, Ohio; a company with "Valencia, Spain" among
    its strings → Valencia, Spain). With no useful context, take the best-known place and say so in the note.
    "Georgia" from a company whose other strings are countries (Armenia, Serbia, …) is the country GE.

## Remote

12. `remoteCountries` lists the countries a remote option is limited to: "Remote - USA" → ["US"];
    "Remote within Canada or United States" → ["CA", "US"]; "Remote, Türkiye" → ["TR"];
    "Canada - Remote; Germany - Remote" → ["CA", "DE"]. Plain "Remote" (or "Remote" with only a bloc, like
    "Remote-EMEA") → []. A country that only qualifies a remote option goes in `remoteCountries`, NOT in
    `places`.
13. A remote option limited to something finer than a country names that place: "Seattle, WA (Remote)" →
    the city Seattle; "Remote, California" → the region California; "Tucson, AZ (Remote)" → Tucson. Do not
    also add the country to `remoteCountries` in that case.
14. When a string mixes offices and a remote option, list the office cities as places AND the remote
    countries: "San Francisco, CA, New York, NY, or Remote within Canada or United States" → places San
    Francisco + New York City, remoteCountries ["CA", "US"].

## Output

Write one JSON object per line (JSONL), in the same order as the input, for EVERY input id:

{"id":"g001","places":[{"city":"Columbus","region":"Ohio","country":"US","kind":"city"}],"remoteCountries":[],"note":"optional"}

A pair with no usable place: {"id":"g002","places":[],"remoteCountries":[]}
