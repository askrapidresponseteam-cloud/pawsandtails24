/* Paws and Tails: store facts the API does not hand out.
 * The catalogue itself is NOT here. Collections and products are read from the
 * store at runtime, so the shop always lists exactly what Shopify lists. This
 * file holds only the domain, the API version, how to reach the shop, its
 * policy pages, a starting list of brands, and the few system collections
 * that should never appear in a menu.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTCatalogue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
  "domain": "pawsandtails24.com",
  "apiVersion": "2026-01",
  "shopId": "72903164079",
  "support": {
    "whatsapp": "917003440878",
    "phone": "03335978875",
    "phoneLabel": "033-3597-8875",
    "email": "contact@pawsandtails24.com"
  },
  "delivery": {
    "fallbackDays": [3, 7]
  },
  "policies": {
    "account": "/account",
    "refund": "/pages/returns",
    "shipping": "/pages/shipping"
  },
  "brands": [
    "Royal Canin",
    "Drools",
    "Farmina",
    "Acana",
    "Orijen",
    "Fabled",
    "Me-O",
    "Himalaya",
    "Virbac",
    "Zoetis",
    "Intas",
    "Vivaldis"
  ],
  "hidden": [
    "frontpage",
    "all",
    "home",
    "home-page",
    "homepage"
  ]
};
}));
