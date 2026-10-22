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
- **Add to bag from any listing.** A product with one size goes straight into
  the bag from its tile; one with sizes says "Choose size" and opens its page.
- **Track an order** (`#/track`, linked from the header and footer): the order
  number and the phone or email used, then the stage on a five-step line,
  the expected date, the courier with its tracking link, and the items behind
  a + expander. Kept for the visit, so a refresh does not ask again.
- **The assistant** (the "Ask us" button in the corner) answers from the store
  itself, with no language model: where an order is, when a parcel will
  arrive (by pincode), product picks at a price ("best deworming under 500"
  gives the store's best sellers in Deworming under Rs 500, in stock, with
  Add to bag on each), shipping charges, cash on delivery, returns, and a
  person to talk to. Details under "The assistant" below.

## Order tracking: connect the store once

Orders can only be read with the store's Admin API, which needs a secret, so
the lookup runs on Vercel in `api/order.js` and the browser never sees it.
Until it is connected, the track page and the assistant say tracking is being
set up and point to the confirmation email and the team.

Since January 2026 Shopify makes these apps in its Dev Dashboard, signed in
as someone with app development rights on the store:

1. Open https://dev.shopify.com/dashboard/, go to **Apps**, choose
   **Create app**, then **Start from Dev Dashboard**. Name it, for example
   "Paws and Tails tracking", and **Create**.
2. On the app's **Versions** page fill in **App URL**
   (`https://pawsandtails24.vercel.app`), **Webhooks API version**
   (`2026-01`) and **Scopes**: `read_orders` (add `read_all_orders` too if
   customers should find orders older than 60 days). Choose **Release**.
3. On the app, **Install app** (in the Installs card), pick the Paws and
   Tails store, **Install**.
4. Open **App settings** and copy the **Client ID** and **Client secret**.
5. In Vercel, project **pawsandtails24 > Settings > Environment Variables**,
   add for Production:
   - `SHOPIFY_SHOP` = the store's myshopify address, e.g. `paws-and-tails.myshopify.com`
     (Shopify admin > Settings > Domains shows it)
   - `SHOPIFY_CLIENT_ID` = the Client ID
   - `SHOPIFY_CLIENT_SECRET` = the Client secret
6. Redeploy. `node test/check-live.js` then says "order tracking: connected
   to the store". Try a real order on `#/track`.

If a real order with the right phone or email is still "not found", the app
cannot see customer contact details yet: Shopify gives an app installed on
your own store that access by default, but if it shows a "protected customer
data" request on the app's page, submit it.

The function exchanges the ID and secret for a 24 hour token and renews it
itself. An app made before 2026 that shows a fixed `shpat_` token works too:
set `SHOPIFY_ADMIN_TOKEN` instead of the ID and secret. Apps installed on your
own store can read customer details by default; nothing is ever written.

A lookup needs both the order number and the phone or email on the order; a
wrong pair gets the same "not found" as a number that does not exist, and
repeated guessing from one address is slowed down. What comes back is only
what a shopper needs: stage, dates, courier, tracking link, item names, town
and pincode. Never the email, phone, street address or payment.

## The assistant

`assets/assistant.js` reads a message with plain rules: an order number, a
phone or email, a pincode, a price limit ("under 500", "between 200 and
400", "within 2k"), a pet, a kind of product, a brand. Then:

- **Orders**: asks for whatever is missing, one thing at a time, then shows
  the same order card as the track page. "When will it arrive" afterwards
  means that order.
- **Delivery dates** come from the store's own shipping page
  (`/pages/shipping`): dispatch time, and delivery times for metro cities and
  the rest of India when the page gives both. A pincode picks the right one.
  Working days skip Sundays. If the page gives no times, it says "usually"
  and uses `delivery.fallbackDays` in `assets/catalogue.js` (3 to 7).
  The courier's own expected date always wins once there is one.
- **Product picks** match the question to one of the store's live
  collections and read it in the store's best-selling order, keeping only
  what is in stock and within the price. "Cheapest" sorts by price. Nothing
  under the limit says so and shows the lowest price there is. Medicines get
  a line to check the dose with a vet.
- **Charges, cash on delivery, returns** are the matching sentences from the
  shipping and returns pages, with a link to the full page. Edit those pages
  in Shopify and the answers change with them.
- **A person**: WhatsApp, phone and email from `assets/catalogue.js`.

`assets/chat.js` draws it: product cards with Add to bag, the order card,
quick replies, and the conversation kept for the visit.

## Product pictures

Store photos differ: a small pack in a wide white margin, a tight crop, a tall
bottle, a cut-out. `assets/fit.js` reads a small copy of each photo once, finds
where the product actually is, and places the picture so every product shows
at the same size and centred, in the grid, on the product page, in search and
in the bag. Edge to edge photographs fill their frame. If a photo cannot be
read the picture shows exactly as before.

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
node test/test-storefront.js   194 checks: money, transport, tiles, live
                               collections, shop all, search and its
                               fallbacks, tokenless-safe product and bag, saved,
                               quick add, policies, order lookup client,
                               product pictures at one size, house rules
node test/test-order-api.js    41 checks: api/order.js against a stand-in
                               Admin API: token grant and renewal, matching by
                               phone or email, nothing private sent back,
                               refusals, slowing down guessing
node test/test-assistant.js    81 checks: reading orders, phones, pincodes and
                               prices; delivery dates from policy wording;
                               whole conversations against the mock store
node test/test-ui.js           110 checks in a real browser against the mock
                               store: white page, menus from the store, every
                               product reachable from shop all, header search
                               (including its layout), every product picture
                               at one size, a sample of products all added to
                               one bag, add from a listing, checkout, tracking
                               an order, the assistant end to end, phone
                               layout, old links, no console errors
```

`bash run.sh --test` runs all four. All are offline. Run them after any change and before any push.
`test-ui.js` needs playwright (`npm i -D playwright`).

## What is where

```
index.html              the page shell: config lines and script tags only
vercel.json             forwards /api to the store
assets/storefront.js    the client: transport, collections, catalogue, product,
                        search with fallbacks, the Shopify cart
assets/app.js           routing, views, the header search, the track page
assets/assistant.js     the assistant's rules and the delivery estimates
assets/chat.js          the assistant's chat window
assets/fit.js           every product picture at the same size
api/order.js            order lookup on Vercel, holds the Admin credentials
assets/catalogue.js     store facts only: domain, API version, support,
                        policy pages, a starting brand list, hidden collections
assets/styles.css       the design on a white ground
assets/fonts.css, fonts/  the three typefaces, served from here
assets/img/             the three photographs
dev/serve.js            local server, forwards /api to the live store and
                        runs api/order.js (set the SHOPIFY_ variables to try it)
test/check-live.js      the live check against a deployed site
test/mock-store.js      a stand-in store for the tests, with policy pages
test/mock-admin.js      a stand-in Admin API with invented orders
test/test-order-api.js  the order lookup
test/test-assistant.js  the assistant
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
- **Accounts are Shopify's.** The footer links to the store's account page.
- **Delivery is priced at checkout**, by the store. The assistant quotes the
  shipping page; checkout has the final word.
- **Order tracking needs the one-time connection** above. Before that, the
  track page and the assistant send shoppers to their confirmation email.
- **Delivery estimates know metro from not by pincode** for the ten largest
  metro areas. Public holidays are not counted.
