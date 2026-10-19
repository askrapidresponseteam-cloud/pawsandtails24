# Paws and Tails storefront

The storefront design, wired to the real shop. Every product, price, picture
and stock line is read from the store's own Shopify Storefront API as the page
loads, the bag is a Shopify cart held on Shopify's servers, and Checkout hands
the buyer to the store's own checkout, which is what places the order.

No product data is written into these files. Change a price in Shopify and the
next visitor sees the new one.

## See it against the live store, now

```
node dev/serve.js
```

Open http://localhost:4173. The terminal prints one line per call to the store,
with its status, timing and size, so the catalogue arriving is something you
can watch rather than take on trust.

A laptop is not pawsandtails24.com, and the store's API answers its own origin
only, so `dev/serve.js` forwards `/api/...` to the store and the browser sees
one origin exactly as it will in production. Nothing else changes.

**Checkout in dev is real.** The bag is a real Shopify cart and its checkout
link points at the real store. Paying there is a real order with real money.
Use a draft product, or stop at the checkout page.

To browse with no store at all, invented products and a dead checkout:

```
node test/mock-store.js        then open http://localhost:4199
```

## Tests

```
node test/test-storefront.js   296 checks: money, transport, tiles, aisles,
                               product, search, the bag, saved, house rules
node test/test-ui.js           48 checks in a real browser against the mock
                               store: catalogue arrives, sizes change the
                               price, the bag holds what was added, checkout
                               leaves for the store, phone layout, no console
                               errors. Needs playwright (npm i -D playwright).
```

Both are offline and deterministic. Neither can reach the live store or place
an order. Run them after any change and before any deploy.

## Putting it on pawsandtails24.com

The site calls `/api/<version>/graphql.json`, a relative path. Served from the
store's own domain that is the store's own API: no key, no proxy, no CORS, and
nothing to configure. That is the only arrangement that is certain to work,
because the store answers its own origin.

So these files need to be served by whatever answers for pawsandtails24.com:

1. **Inside the existing front end.** The store runs a custom (Hydrogen) front
   end. Drop `index.html` and `assets/` into its static folder and give them a
   route, for example `/shop`. Nothing in this code needs changing.
2. **Behind a rewrite.** Host the files anywhere and put them under the domain
   with a reverse proxy that also forwards `/api/...` to the store, the same
   shape `dev/serve.js` uses.
3. **On another domain, with a token.** Only if the shop issues a public
   Storefront access token: set `window.PT_TOKEN` in `index.html` and
   `window.PT_API_BASE` to `https://pawsandtails24.com`. Whether a browser is
   allowed to call the API across origins depends on the shop's own setting, so
   test it before committing to this route; if it is blocked, use 1 or 2.

## What is where

```
index.html              the page. Holds no product data, only the two config
                        lines and the script tags.
assets/storefront.js    the client: transport, catalogue, product, search and
                        the Shopify cart. Browser and node, so it is testable.
assets/app.js           routing, views and events. Reads the client, nothing else.
assets/catalogue.js     shelves, aisles, lanes, brands, support and policy
                        paths. Every collection handle is one the live store
                        answers for.
assets/styles.css       the design: cream ground, plum brand, terracotta accent.
assets/fonts.css        Newsreader, DM Sans and DM Mono, served from this folder
assets/fonts/           so no third party is asked for them.
assets/img/             the three photographs.
dev/serve.js            local server, forwards /api to the live store.
test/mock-store.js      a stand-in store: same operations, invented products.
test/test-storefront.js the client, against a fake fetch.
test/test-ui.js         the interface, in a real browser.
```

## Adding an aisle or a shelf

Everything the shop lists comes from `assets/catalogue.js`. An aisle is the
collection handle the store uses, with the label to show:

```js
{ "label": "Dental", "handle": "dental-care" }
```

The tests check that every lane and every home rail points at an aisle that
exists, so a typo fails the suite rather than the shop.

## Decisions worth knowing

- **Sold out stays on the shelf**, marked, and cannot be added. Shopify would
  refuse the line anyway, and hiding it hides that the store stocks the thing.
- **A product whose sizes differ in price shows "from" and no saving.** The
  lowest price and the highest MRP belong to different sizes, so a percentage
  across them would overstate every size. The saving appears on the product
  page, once a size is chosen.
- **The bag lives at Shopify, not here.** Only the cart id is kept on the
  device, so a bag opened on a laptop and paid on a phone cannot disagree, and
  stock is checked by the store on every change.
- **Prices are handled as paise in whole numbers**, parsed from the API's text,
  so no rupee passes through a float.
- **Storage can fail.** Private windows and blocked site data throw; every read
  and write is wrapped and the shop works without them.
- **A refused field retries without it.** If the shop's setup keeps `tags`
  behind a token, the product read drops the field and remembers, rather than
  failing.

## Known limits

- **Search engines see one page.** Routes live in the hash, so crawlers get the
  shell. Fine behind an existing front end that already serves product pages;
  worth knowing if this becomes the whole site.
- **No customer accounts here.** Sign in, orders and addresses are Shopify's;
  the header links to the store's account page.
- **Delivery is priced at checkout**, by the store, not quoted in the bag.
