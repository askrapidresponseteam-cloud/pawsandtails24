# Paws and Tails storefront

A reskin over the Paws and Tails Shopify store. Nothing about the catalogue is
written into these files: the collections, every product, every price, picture
and stock line are read from the store as the page loads. Whatever Shopify
lists, this shop lists, and every one of those products can be put in the bag.
The bag is a Shopify cart, and Checkout hands the buyer to the store's own
checkout, which is what places the order.

## Live

Deployed on Vercel at https://pawsandtails24.vercel.app. `vercel.json` forwards
`/api/<version>/graphql.json` to the store, which is what lets the browser read
it. The store answers without a key (tokenless access), so nothing else is
needed.

Check the deploy from a terminal at any time:

```
node test/check-live.js
```

It runs the shop's own code (assets/storefront.js) against the live store
through the deployed site: collections, shop all, search, as-you-type, a
product page, then one product into a new cart and its checkout link. That
cart is real but no order is placed; Shopify drops it after ten days.

The store is read without a key, and tokenless access refuses stock counts
and tags. The bag never asks for either. The product page tries once and
falls back to the fields the store allows, so a refusal costs one extra
call, never a broken page. The mock store refuses them too, so the tests
run under the same rule as production.

## What the shopper gets

- **Shop all** pages through every product the store sells.
- **Collections** come from the store's own list. A collection the shop adds,
  renames or retires shows up, changes or goes here without any edit. Empty
  collections and the system `frontpage` are left out of the menus.
- **Search from every page.** The box in the header suggests products,
  collections and brands as you type, marks the words matched, takes the arrow
  keys and Enter, and `/` jumps to it. Enter on its own runs the full search.
  On a phone the box becomes an icon that opens the search page.
- **Search does not give up.** It asks the store's own search first (it knows
  plurals and typos). If that is switched off, errors, or finds nothing, it
  falls back to a prefix match over the whole catalogue, so half a brand name
  or a word that only appears in the brand still finds the products. A slow
  answer for an earlier keystroke can never overwrite a newer one.
- **Every product page** has every size at its own price, its stock, and Add to
  bag or Buy it now. Sold out stays visible, marked, and cannot be added.

## See it against the live store on your machine

```
node dev/serve.js              then open http://localhost:4173
```

The terminal prints one line per call to the store. **Checkout here is real:**
the bag is a real cart and paying is a real order.

To browse with invented products and a dead checkout instead:

```
node test/mock-store.js        then open http://localhost:4199
```

## Tests

```
node test/test-storefront.js   164 checks: money, transport, tiles, live
                               collections, shop all, search and its
                               fallbacks, tokenless-safe product and bag, saved,
                               house rules
node test/test-ui.js           62 checks in a real browser against the mock
                               store: white page, menus from the store, every
                               product reachable from shop all, header search
                               (including its layout), a sample of products
                               all added to one bag, checkout, phone layout,
                               old links, no console errors
```

Both are offline. Run them after any change and before any push.
`test-ui.js` needs playwright (`npm i -D playwright`).

## What is where

```
index.html              the page shell: config lines and script tags only
vercel.json             forwards /api to the store
assets/storefront.js    the client: transport, collections, catalogue, product,
                        search with fallbacks, the Shopify cart
assets/app.js           routing, views, the header search
assets/catalogue.js     store facts only: domain, API version, support,
                        policy pages, a starting brand list, hidden collections
assets/styles.css       the design on a white ground
assets/fonts.css, fonts/  the three typefaces, served from here
assets/img/             the three photographs
dev/serve.js            local server, forwards /api to the live store
test/check-live.js      the live check against a deployed site
test/mock-store.js      a stand-in store for the tests
test/test-storefront.js the client, against a fake fetch
test/test-ui.js         the interface, in a real browser
```

## Decisions worth knowing

- **A product whose sizes differ in price shows "from" and no saving** on its
  tile. The lowest price and the highest MRP belong to different sizes; the
  real saving shows on the product page once a size is chosen.
- **The bag lives at Shopify.** Only the cart id is on the device, so stock is
  checked by the store on every change and a bag opened on one device can be
  paid on another.
- **Paise are whole numbers** parsed from the API's text; no rupee passes
  through a float.
- **Storage can fail** in private windows; every read and write is wrapped.

## Known limits

- **Search engines see one page.** Routes live in the hash.
- **Accounts are Shopify's.** The header links to the store's account page.
- **Delivery is priced at checkout**, by the store.
