/* Paws and Tails catalogue: shelves, aisles, lanes and brands.
 * Every collection handle here is one the live store answers for; they were
 * taken from the validated store registry, not guessed. Adding an aisle means
 * adding the handle the store uses, nothing else.
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
  "shelves": [
    {
      "key": "pharmacy",
      "name": "Pharmacy",
      "aisles": [
        {
          "label": "All Medicines",
          "handle": "pharmacy"
        },
        {
          "label": "Deworming",
          "handle": "deworming"
        },
        {
          "label": "Flea & Tick",
          "handle": "ticks-fleas"
        },
        {
          "label": "Tick Treatment",
          "handle": "ticks-treatment"
        },
        {
          "label": "Antibiotics",
          "handle": "antibiotic"
        },
        {
          "label": "Injections",
          "handle": "injection"
        },
        {
          "label": "Ointments",
          "handle": "ointment"
        },
        {
          "label": "Eye Care",
          "handle": "opthocare"
        },
        {
          "label": "Heart",
          "handle": "cardiac-care"
        },
        {
          "label": "Kidney",
          "handle": "nephro-care"
        },
        {
          "label": "Natural Remedies",
          "handle": "natural-remedies"
        },
        {
          "label": "Vet Diets",
          "handle": "prescription-diet"
        }
      ]
    },
    {
      "key": "vaccines",
      "name": "Vaccines & Tests",
      "aisles": [
        {
          "label": "All Vaccines",
          "handle": "vaccine-immunoglobulin"
        },
        {
          "label": "Puppy",
          "handle": "puppy-vaccine"
        },
        {
          "label": "Rabies",
          "handle": "rabies-vaccine"
        },
        {
          "label": "Parvo & Distemper",
          "handle": "parvo-distemper-vaccine"
        },
        {
          "label": "Kennel Cough",
          "handle": "kennel-cough-vaccine"
        },
        {
          "label": "Cat Vaccines",
          "handle": "feline-vaccine"
        },
        {
          "label": "Test Kits",
          "handle": "test-kit"
        }
      ]
    },
    {
      "key": "supplements",
      "name": "Supplements",
      "aisles": [
        {
          "label": "Multivitamins",
          "handle": "multivitamin-supplement"
        },
        {
          "label": "Joint Support",
          "handle": "joint-support"
        },
        {
          "label": "Calcium",
          "handle": "calcium-joint-support"
        },
        {
          "label": "Skin & Coat",
          "handle": "coat-care"
        },
        {
          "label": "Immunity",
          "handle": "immunity-boster"
        },
        {
          "label": "Pregnancy",
          "handle": "pregnancy-nutrition"
        }
      ]
    },
    {
      "key": "dog-food",
      "name": "Dog Food",
      "aisles": [
        {
          "label": "All",
          "handle": "dog-food"
        },
        {
          "label": "Puppy",
          "handle": "best-puppy-food"
        },
        {
          "label": "Puppy Milk",
          "handle": "dog-milk"
        },
        {
          "label": "Vegetarian",
          "handle": "veg-essentials"
        },
        {
          "label": "Royal Canin",
          "handle": "royal-canin-dog-food"
        },
        {
          "label": "Farmina",
          "handle": "farmina-dog-food"
        },
        {
          "label": "Drools",
          "handle": "drools-dog-food"
        },
        {
          "label": "Acana",
          "handle": "acana-dog-food"
        },
        {
          "label": "Orijen",
          "handle": "orijin-dog-food"
        }
      ]
    },
    {
      "key": "cat-food",
      "name": "Cat Food",
      "aisles": [
        {
          "label": "All",
          "handle": "best-cat-food"
        },
        {
          "label": "Kitten Milk",
          "handle": "kitten-milk"
        },
        {
          "label": "Vet Diet",
          "handle": "cat-prescription-diet"
        },
        {
          "label": "Farmina",
          "handle": "farmina-cat-food"
        },
        {
          "label": "Drools",
          "handle": "drools-cat-food"
        },
        {
          "label": "Orijen",
          "handle": "orijen-cat-food"
        }
      ]
    },
    {
      "key": "treats",
      "name": "Treats",
      "aisles": [
        {
          "label": "Dog Treats",
          "handle": "dog-treats"
        },
        {
          "label": "Cat Treats",
          "handle": "cat-treats"
        }
      ]
    },
    {
      "key": "grooming",
      "name": "Grooming",
      "aisles": [
        {
          "label": "All",
          "handle": "grooming"
        },
        {
          "label": "Dog Shampoo",
          "handle": "dog-shampoo"
        },
        {
          "label": "Cat Shampoo",
          "handle": "cat-shampoo"
        },
        {
          "label": "Dry Bath",
          "handle": "dry-bath"
        },
        {
          "label": "Conditioner",
          "handle": "conditioner"
        },
        {
          "label": "Dental",
          "handle": "dental-care"
        },
        {
          "label": "Ear Cleansers",
          "handle": "ear-cleanser"
        },
        {
          "label": "Perfume",
          "handle": "perfume"
        }
      ]
    },
    {
      "key": "gear",
      "name": "Toys & Gear",
      "aisles": [
        {
          "label": "All",
          "handle": "accessories"
        },
        {
          "label": "Dog Toys",
          "handle": "dog-toys"
        },
        {
          "label": "Cat Toys",
          "handle": "cat-toys"
        },
        {
          "label": "Dog Harness & Collars",
          "handle": "dog-harness-collar"
        },
        {
          "label": "Cat Harness & Collars",
          "handle": "cat-harness-collar"
        },
        {
          "label": "Bowls",
          "handle": "feeding-bowl"
        },
        {
          "label": "Muzzles",
          "handle": "dog-muzzle"
        },
        {
          "label": "Cat Litter",
          "handle": "cat-litter"
        },
        {
          "label": "Litter Boxes",
          "handle": "litter-box"
        }
      ]
    },
    {
      "key": "small-pets",
      "name": "Birds & Small Pets",
      "aisles": [
        {
          "label": "Birds",
          "handle": "bird"
        },
        {
          "label": "Rabbits",
          "handle": "rabbit"
        },
        {
          "label": "Guinea Pigs",
          "handle": "guinea-pig"
        },
        {
          "label": "Hamsters",
          "handle": "hamster-food"
        }
      ]
    }
  ],
  "lanes": {
    "dogs": {
      "name": "For dogs",
      "aisles": [
        {
          "handle": "dog-food",
          "label": "All"
        },
        {
          "handle": "best-puppy-food",
          "label": "Puppy"
        },
        {
          "handle": "dog-milk",
          "label": "Puppy Milk"
        },
        {
          "handle": "dog-treats",
          "label": "Dog Treats"
        },
        {
          "handle": "dog-shampoo",
          "label": "Dog Shampoo"
        },
        {
          "handle": "dry-bath",
          "label": "Dry Bath"
        },
        {
          "handle": "dog-toys",
          "label": "Dog Toys"
        },
        {
          "handle": "dog-harness-collar",
          "label": "Dog Harness & Collars"
        },
        {
          "handle": "dog-muzzle",
          "label": "Muzzles"
        },
        {
          "handle": "feeding-bowl",
          "label": "Bowls"
        }
      ]
    },
    "cats": {
      "name": "For cats",
      "aisles": [
        {
          "handle": "best-cat-food",
          "label": "All"
        },
        {
          "handle": "kitten-milk",
          "label": "Kitten Milk"
        },
        {
          "handle": "cat-prescription-diet",
          "label": "Vet Diet"
        },
        {
          "handle": "cat-treats",
          "label": "Cat Treats"
        },
        {
          "handle": "cat-shampoo",
          "label": "Cat Shampoo"
        },
        {
          "handle": "cat-toys",
          "label": "Cat Toys"
        },
        {
          "handle": "cat-harness-collar",
          "label": "Cat Harness & Collars"
        },
        {
          "handle": "cat-litter",
          "label": "Cat Litter"
        },
        {
          "handle": "litter-box",
          "label": "Litter Boxes"
        }
      ]
    }
  },
  "nav": [
    {
      "label": "Dogs",
      "href": "#/lane/dogs"
    },
    {
      "label": "Cats",
      "href": "#/lane/cats"
    },
    {
      "label": "Pharmacy",
      "href": "#/shelf/pharmacy"
    },
    {
      "label": "Vaccines",
      "href": "#/shelf/vaccines"
    }
  ],
  "homeRails": [
    {
      "handle": "dog-food",
      "title": "Everyday dog food"
    },
    {
      "handle": "pharmacy",
      "title": "From the pharmacy"
    },
    {
      "handle": "best-cat-food",
      "title": "For the cats"
    }
  ]
};
}));
