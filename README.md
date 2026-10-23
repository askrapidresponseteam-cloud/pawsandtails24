# Paws and Tails storefront

**Shoppers never leave pawsandtails24.vercel.app.** Browsing, the bag,
checkout, payment, the thank-you page, tracking and the store's shipping and
returns pages all happen here. The browser only ever talks to this site;
behind it, Vercel's server talks to Shopify (products, orders) and Razorpay
(payments). A browser test watches every request and page in every flow and
fails if one leaves the site.

A reskin over the Paws and Tails Shopify store. Nothing about the catalogue is
written into these files: the collections, every product, every price, picture
and stock line are read from the store as the page loads. Whatever Shopify
lists, this shop lists, and every one of those products can be put in the bag.
The bag is a Shopify cart. Checkout is a page on this site: the store prices
the order (its prices, delivery rates and tax) and the order is placed in the
store's admin like any other, paid online with Razorpay or cash on delivery.

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
- **Checkout here, in three steps** (`#/checkout`): where it goes, delivery
  (the store's own rates for that pincode, with an expected date), payment
  (Razorpay popup for UPI, cards, netbanking and wallets, or cash on
  delivery). Then a thank-you page with the order number and expected date.
  The address is remembered on that device for next time.
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

## Connect the store once: checkout and tracking

Orders can only be read and created with the store's Admin API, which needs a
secret, so that part runs on Vercel (`api/checkout.js`, `api/order.js`,
shared code in `lib/`) and the browser never sees it. Until it is connected,
checkout offers "Order on WhatsApp" with the bag filled in, and tracking
sends shoppers to the team.

### 1. A Shopify app (Dev Dashboard)

Since January 2026 Shopify makes these apps in its Dev Dashboard, signed in
as someone with app development rights on the store:

1. Open https://dev.shopify.com/dashboard/, go to **Apps**, choose
   **Create app**, then **Start from Dev Dashboard**. Name it, for example
   "Paws and Tails website", and **Create**.
2. On the app's **Versions** page fill in **App URL**
   (`https://pawsandtails24.vercel.app`), **Webhooks API version**
   (`2026-01`) and **Scopes**:
   `read_products, write_draft_orders, read_orders` (add `read_all_orders`
   so customers can track orders older than 60 days). Choose **Release**.
3. On the app, **Install app** (in the Installs card), pick the Paws and
   Tails store, **Install**.
4. Open **App settings** and copy the **Client ID** and **Client secret**.

If a real order with the right phone or email is still "not found" on the
track page, the app cannot see customer contact details yet: Shopify gives
an app installed on your own store that access by default, but if the app's
page shows a "protected customer data" request, submit it.

### 2. Razorpay keys

In the Razorpay Dashboard, **Account & Settings > API Keys**, generate a key
(the account the store already uses works). Start with **Test mode** keys to
try a payment, then switch to live keys.

### 3. Vercel

Project **pawsandtails24 > Settings > Environment Variables**, Production:

| Name | Value |
| --- | --- |
| `SHOPIFY_SHOP` | the store's myshopify address, e.g. `sg37v1-ta.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | the app's Client ID |
| `SHOPIFY_CLIENT_SECRET` | the app's Client secret |
| `RAZORPAY_KEY_ID` | `rzp_live_...` (or `rzp_test_...` to try) |
| `RAZORPAY_KEY_SECRET` | the matching secret |
| `RAZORPAY_WEBHOOK_SECRET` | optional, see 4 |

The myshopify address is only used by Vercel's server to reach Shopify's
API; no shopper is ever sent there. Redeploy, then run
`node test/check-live.js`: it prices a sample order through the site
(nothing is created) and says whether tracking and Razorpay are on.

An app made before 2026 that shows a fixed `shpat_` token works too: set
`SHOPIFY_ADMIN_TOKEN` instead of the client ID and secret.

### 4. Razorpay webhook (recommended)

If a shopper pays and closes the tab before the page hears back, the webhook
still places the order. Razorpay Dashboard > **Webhooks** > Add:
URL `https://pawsandtails24.vercel.app/api/razorpay-webhook`, events
`order.paid` and `payment.captured`, a secret of your choosing; put the same
secret in Vercel as `RAZORPAY_WEBHOOK_SECRET`.

### 5. The order email's link

Shopify emails the customer its normal order confirmation when an order is
placed here. Its "View your order" button points at Shopify's own order page.
To keep customers on this site, in Shopify admin open **Settings >
Notifications > Order confirmation > Edit code** and replace
`{{ order_status_url }}` with
`https://pawsandtails24.vercel.app/#/track/{{ order_number }}`
(do the same in the shipping confirmation and update templates).

### How an order is placed, and why it is safe

- The browser sends only which items and how many, the address and the
  payment choice. Prices, delivery charge, tax and the total come from
  Shopify every time; the page also sends the total it showed, and if the
  store's total differs the shopper sees the new one before anything happens.
- **Cash on delivery**: the order is placed at once, "payment pending".
  `checkout.codMaxRupees` in `assets/catalogue.js` caps it (empty = no cap);
  `checkout.cod: false` turns it off.
- **Online**: a draft order holds the stock for 30 minutes and a Razorpay
  order is made for exactly the store's total. The popup's answer is checked
  with the Razorpay secret, the payment is read back from Razorpay (captured
  if only authorised), the amount must match the draft, and only then is the
  draft completed as paid. Closing the popup removes the unpaid draft. The
  page and the webhook can both finish the same payment; it is only ever one
  order.

Tracking needs both the order number and the phone or email on the order; a
wrong pair gets the same "not found" as a number that does not exist, and
repeated guessing is slowed down. It never returns the email, phone, street
address or payment.

## The assistant

The "Ask us" button opens an assistant that can take an order from start to
finish, with no language model. Everything it says comes from the store:
products, prices and stock from the live catalogue; delivery times, charges
and returns from the store's own pages; orders from the order lookup; new
orders through the same checkout as the checkout page.

**What it does**

- **Takes orders.** "Can you place an order for Acana", "buy 2 bags of
  Acana puppy 2kg", "add the second one". It finds the product, asks the
  size only when needed (or takes "2kg", "the smallest"), adds it to the
  bag, and on "checkout" takes the address (or offers the saved one), shows
  the summary with the store's delivery options and expected date, total,
  and payment choice, and places the order **only when the shopper taps
  Place order or says yes to that exact total**. Online payment opens
  Razorpay over the chat; cash on delivery places it at once.
- **Manages the bag.** "What is in my cart", "remove the first one",
  "make it 3", "one more", "empty my bag" (asks first), and - / + buttons.
- **Orders the same again** from a past order (number plus phone or email).
- **Recommends** ("best deworming under 500": the store's best sellers in
  that collection, in stock, under the price) and **answers product
  questions** ("what sizes does Acana puppy come in").
- **Tracks orders**, gives **delivery dates by pincode**, answers
  **shipping, payment and returns** from the store's pages.
- **Hands over to a person** on WhatsApp with the order, the bag and the
  last few questions already in the message.

**How it understands** (`assets/nlu.js`)

- Typos are fixed against the shop's own words and brands ("acanna",
  "royl canin", "dewormr", "trak my ordr").
- Hinglish and chat shorthand: "mera order kab aayega", "kutte ka khana
  chahiye", "cart", "pls", "thx".
- Quantities ("2 bags", "x3", "two packs"), pack sizes ("2kg", "340 g",
  "1 litre"), "the second one", "that one", yes and no with filler words,
  payment and delivery choices, prices, order numbers, phones, pincodes.
- What a message means depends on what the assistant just asked: "yes"
  confirms an order only when a summary is waiting for it; "2kg" picks a size
  only while sizes are shown.

**Built to be safe with money**

- Nothing is placed without the explicit confirmation above; the server
  re-prices and refuses if the total moved, and the assistant shows the new
  total to confirm again.
- Each summary has its own reference. A newer one retires the older card's
  buttons, and an old reference is refused, so a stale card can never place
  an order.
- Closing the payment window places nothing and says nothing was charged;
  a payment taken but not yet confirmed says not to pay again and carries
  the payment id to the team.
- The assistant never throws: a store that does not answer, an unknown
  button or gibberish all get a polite answer with a way forward.

**Brands.** The live store lists every product under its own name ("Paws &
Tails"), so the brand is read from the product title against the list in
`assets/catalogue.js`. Add a brand there and the assistant, brand pages and
tiles all know it.

`assets/assistant.js` decides what to do; `assets/chat.js` draws it: product
cards, a size picker, the bag, the address form, the summary and the
confirmation. The conversation is kept for the visit; the refresh button in
its header starts a new one.

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

The terminal prints one line per call to the store. With the `SHOPIFY_` and
`RAZORPAY_` variables set in that terminal, **checkout here places real orders
in the store**: use Razorpay test keys and cancel test orders afterwards.
Without them, checkout offers ordering on WhatsApp.

To try everything offline with invented products, a pretend store admin and a
pretend Razorpay popup (Pay and Close buttons):

```
node test/mock-store.js        then open http://localhost:4199
```

## Tests

```
node test/test-storefront.js   203 checks: money, transport, tiles, live
                               collections, shop all, search and its
                               fallbacks, tokenless-safe product and bag, saved,
                               quick add, policies, order lookup client,
                               product pictures at one size, house rules
                               (nothing sends a shopper to the store's domain)
node test/test-order-api.js    41 checks: api/order.js against a stand-in
                               Admin API: token grant and renewal, matching by
                               phone or email, nothing private sent back,
                               refusals, slowing down guessing
node test/test-checkout-api.js 47 checks: checkout against stand-ins for
                               Shopify and Razorpay: prices from the store,
                               delivery by pincode, sold out, cash on delivery
                               and its cap, online payment, forged and part
                               payments refused, double confirm and webhook
                               make one order, closed popup cleans up
node test/test-nlu.js          91 checks: typos, Hinglish, quantities, sizes,
                               "the second one", yes and no, intents in and
                               out of context
node test/test-assistant.js    126 checks: delivery dates from policy wording;
                               whole conversations against the mock store,
                               including orders placed in the chat (cash on
                               delivery and online), stale summaries refused,
                               closed payment window, bag edits, reorder,
                               handover with the conversation
node test/test-ui.js           165 checks in a real browser against the mock
                               store: white page, menus from the store, every
                               product reachable from shop all, header search
                               (including its layout), every product picture
                               at one size, a sample of products all added to
                               one bag, add from a listing, checkout here
                               (Razorpay paid, popup closed, cash on delivery,
                               pincode not served), store pages shown here,
                               tracking an order, the assistant end to end,
                               orders placed inside the chat (sizes, bag,
                               address, express, cash on delivery, Razorpay),
                               old summaries disabled, brands from titles,
                               phone layout, old links, no console errors,
                               and not one request or page off the site
```

`bash run.sh --test` runs all six. All are offline. Run them after any change and before any push.
`test-ui.js` needs playwright (`npm i -D playwright`).

## What is where

```
index.html              the page shell: config lines and script tags only
vercel.json             forwards /api to the store
assets/storefront.js    the client: transport, collections, catalogue, product,
                        search with fallbacks, the Shopify cart
assets/app.js           routing, views, the header search, the track page
assets/nlu.js           the assistant reading what was typed
assets/assistant.js     the assistant's conversation, and delivery estimates
assets/chat.js          the assistant's chat window
assets/fit.js           every product picture at the same size
api/order.js            order lookup (Vercel function)
api/checkout.js         checkout: quote, place, confirm, abandon (Vercel function)
api/razorpay-webhook.js finishes paid orders if the tab was closed
lib/admin.js            the Admin API client: token grant, renewal
lib/checkout.js         pricing with the store, draft orders, payment checks
lib/razorpay.js         Razorpay orders, capture, signature checks
assets/catalogue.js     store facts only: domain, API version, support,
                        policy pages, a starting brand list, hidden collections
assets/styles.css       the design on a white ground
assets/fonts.css, fonts/  the three typefaces, served from here
assets/img/             the three photographs
dev/serve.js            local server, forwards /api to the live store and
                        runs api/order.js (set the SHOPIFY_ variables to try it)
test/check-live.js      the live check against a deployed site
test/mock-store.js      a stand-in store for the tests, with policy pages
test/mock-admin.js      a stand-in Admin API: invented orders, draft orders
test/mock-razorpay.js   a stand-in Razorpay, and its popup for the browser
test/test-checkout-api.js  the checkout
test/test-order-api.js  the order lookup
test/test-nlu.js        the assistant's reading
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
- **No customer accounts here.** Shoppers track by order number and phone
  or email; the address is remembered on their device.
- **Discount codes** are not taken at checkout yet.
- **Delivery is priced at checkout**, by the store. The assistant quotes the
  shipping page; checkout has the final word.
- **Checkout and tracking need the one-time connection** above. Before that,
  checkout offers ordering on WhatsApp and tracking points to the team.
- **Delivery estimates know metro from not by pincode** for the ten largest
  metro areas. Public holidays are not counted.
