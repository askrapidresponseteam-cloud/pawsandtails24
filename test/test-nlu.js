#!/usr/bin/env node
/* ============================================================================
 * Tests for reading what shoppers type (assets/nlu.js)
 *
 *   node test/test-nlu.js
 * ========================================================================== */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const N = require(path.join(ROOT, 'assets', 'nlu.js'));
const C = require(path.join(ROOT, 'assets', 'catalogue.js'));

let passed = 0;
const failures = [];
function ok(what, cond) { if (cond) passed++; else failures.push(what); }
function eq(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failures.push(what + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}
function section(name) { process.stdout.write('\n  ' + name + '\n'); }

const vocab = N.baseVocabulary(C.brands);
const read = (t, ctx) => N.read(t, Object.assign({ brands: C.brands, vocab: vocab }, ctx || {}));
const intent = (t, ctx) => read(t, ctx).intent;
const fix = (t) => N.correct(N.normalise(t), vocab);

section('typos are fixed against the shop\'s own words');
eq('a brand', fix('acanna puppy'), 'acana puppy');
eq('a two word brand', fix('royl canin'), 'royal canin');
eq('chat shorthand', fix('trak my ordr'), 'track my order');
eq('a product word', fix('dewormr'), 'dewormer');
eq('a doubled letter', fix('shampooo'), 'shampoo');
eq('real words are left alone', fix('value pack premium everyday'), 'value pack premium everyday');
eq('short words are left alone', fix('cat bed mat'), 'cat bed mat');
eq('a word close to two different words is left alone', fix('cast'), 'cast');
eq('a word close to one word is fixed', fix('trat'), 'treat');

section('Hinglish and shorthand');
eq('"mera order kab aayega" is a tracking question', intent('mera order kab aayega'), 'track');
eq('"kutte ka khana chahiye" is about dog food', [intent('kutte ka khana chahiye'), read('kutte ka khana chahiye').entities.topic.key], ['product', 'food']);
eq('"cart" means the bag', intent('what is in my cart'), 'bagShow');
eq('"thx" is thanks', intent('thx'), 'thanks');

section('what is in a message');
const e = (t, ctx) => read(t, ctx).entities;
eq('quantity from "2 bags of"', e('buy 2 bags of acana puppy').qty, 2);
eq('quantity from "x3"', e('drools x3').qty, 3);
eq('quantity in words', e('two packs of drools').qty, 2);
eq('quantity after a buying word', e('add 4 drools').qty, 4);
eq('a pack size is not a quantity', e('buy acana 2kg').qty, null);
eq('a price is not a quantity', e('buy something under 500').qty, null);
eq('size in kg, in grams', e('acana puppy 2kg').size.amount, 2000);
eq('size with a space and a decimal', e('drools 1.2 kg').size.amount, 1200);
eq('size in grams', e('the 340 g one').size.amount, 340);
eq('size in litres becomes ml', e('shampoo 1 litre').size, { amount: 1000, unit: 'ml', text: '1 litre' });
ok('a title\'s pack size is read', N.sizesIn('Acana Puppy 340g x 4').some((s) => N.sameSize(s, { amount: 340, unit: 'g' })));
eq('"the second one"', e('the second one').which, 1);
eq('"3rd"', e('3rd please').which, 2);
eq('"the last one"', e('the last one').which, -1);
eq('"that one"', e('that one').which, 'it');
eq('yes, with a filler word', e('actually yes').yesNo, 'yes');
eq('no', e('nope').yesNo, 'no');
eq('cash on delivery', e('cash on delivery').payment, 'cod');
eq('UPI is online', e('i will pay by upi').payment, 'online');
eq('express', e('express please').speed, 'express');
eq('a brand from the catalogue', e('anything from orijen?').brand, 'Orijen');
eq('a brand with a typo', e('farmena cat food').brand, 'Farmina');
eq('search words without the steering words', e('can you place an order for acana puppy 2kg please').terms, 'acana puppy');
eq('the order number', e('where is #1042').orderNo, '1042');
eq('a mobile number is not an order number', e('call 9876543210').orderNo, null);
eq('the phone', e('my number is +91 98450-12345').contact, '9845012345');
eq('the pincode', e('deliver to 576101').pin, '576101');
eq('a price limit', e('under rs 1,500').price, { max: 150000 });
eq('a price limit is not a pack size', e('under 2 kg').price, {});

section('what the message is for');
const cases = [
  ['can you place an order for acana', 'buy'], ['order acanna puppy food', 'buy'], ['buy 2 drools', 'buy'],
  ['add the second one', 'buy'], ['i want royal canin', 'product'], ['best deworming under 500', 'product'],
  ['what sizes does acana puppy come in', 'product'], ['checkout', 'checkout'], ['place my order', 'checkout'],
  ['proceed to pay', 'checkout'], ['show my bag', 'bagShow'], ['empty my bag', 'bagEmpty'], ['order again', 'reorder'],
  ['reorder #1001', 'reorder'], ['cancel my order', 'cancelOrder'], ['where is my order', 'track'],
  ['track 1042', 'track'], ['when will it arrive if I order today', 'delivery'], ['do you deliver to 576101', 'delivery'],
  ['what are the shipping charges', 'fee'], ['is cod available', 'pay'], ['i want to return a damaged item', 'returns'],
  ['talk to a person', 'human'], ['what can you do', 'help'], ['start over', 'restart'], ['hi', 'greet'],
  ['thanks', 'thanks'], ['bye', 'bye'], ['no', 'yesNo']
];
cases.forEach((c) => eq('"' + c[0] + '"', intent(c[0]), c[1]));

section('what the message is for, in the middle of something');
eq('"yes" confirms the order waiting for it', intent('yes', { pending: 'confirm' }), 'confirmYes');
eq('"place it" confirms too', intent('place it', { pending: 'confirm' }), 'confirmYes');
eq('"no" stops it', intent('not now', { pending: 'confirm' }), 'confirmNo');
eq('"cash on delivery" changes the payment', intent('cash on delivery', { pending: 'confirm' }), 'setPayment');
eq('"express" changes the delivery', intent('express', { pending: 'confirm' }), 'setSpeed');
eq('"change address"', intent('change the address', { pending: 'confirm' }), 'changeAddress');
eq('"yes" uses the saved address', intent('yes', { pending: 'savedAddress' }), 'useSaved');
eq('"2kg" picks the size being chosen', intent('2kg', { pending: 'pickSize' }), 'pickSize');
eq('"the smallest" picks a size', intent('the smallest', { pending: 'pickSize' }), 'pickSize');
eq('"the second" picks from what was shown', intent('the second', { pending: 'pickProduct' }), 'pickProduct');
eq('"the cheapest one" picks from what was shown', intent('the cheapest one', { pending: 'pickProduct' }), 'pickProduct');
eq('a bare number is the order asked for', intent('1042', { pending: 'order' }), 'track');
eq('"make it 3" changes the bag', intent('make it 3', { hasBag: true }), 'bagQty');
eq('"one more" changes the bag', intent('one more', { hasBag: true }), 'bagQty');
eq('"remove acana" changes the bag', intent('remove acana from my cart', { hasBag: true }), 'bagRemove');
eq('"yes" with a bag goes to checkout', intent('yes', { hasBag: true }), 'checkout');
eq('a new question in the middle of checkout is still answered', intent('where is my order #1001', { pending: 'confirm' }), 'track');

section('buying, step by step');
eq('"no, that\'s all" after adding moves on', intent('no, that\'s all', { pending: 'more', hasBag: true }), 'moreNo');
eq('"nothing else" moves on', intent('nothing else', { pending: 'more', hasBag: true }), 'moreNo');
eq('"done" moves on', intent('done', { pending: 'more', hasBag: true }), 'moreNo');
eq('"yes" means there is more to add', intent('yes', { pending: 'more', hasBag: true }), 'moreYes');
eq('"also add drools" adds it', intent('also add drools', { pending: 'more', hasBag: true }), 'buy');
eq('"one more" adds another of the same', intent('one more', { pending: 'more', hasBag: true }), 'bagQty');
eq('"cash on delivery" chooses the payment', intent('cash on delivery', { pending: 'payment', hasBag: true }), 'choosePayment');
eq('"upi" chooses online', [intent('upi', { pending: 'payment' }), read('upi', { pending: 'payment' }).entities.payment], ['choosePayment', 'online']);
eq('a tracking question mid-checkout is still a tracking question', intent('where is my order', { pending: 'payment' }), 'track');

eq('"I want to add something else" asks what, rather than searching or checking out', [intent('I want to add something else', { hasBag: true }), read('I want to add something else').entities.terms], ['moreYes', '']);
eq('"order something else" asks what too', intent('order something else', { hasBag: true }), 'moreYes');
eq('"order something" asks what, rather than searching', read('I want to order something').entities.terms, '');

section('matching titles');
eq('every word found', N.titleScore('acana puppy', 'Acana Puppy Recipe 2kg'), 1);
eq('half the words found', N.titleScore('acana senior', 'Acana Puppy Recipe'), 0.5);
eq('a typo still matches a long word', N.titleScore('acana pupy recipie', 'Acana Puppy Recipe'), 1);

process.stdout.write('\n');
if (failures.length) {
  failures.forEach((f) => process.stdout.write('  FAILED  ' + f + '\n'));
  process.stdout.write('\n  language: ' + passed + ' passed, ' + failures.length + ' failed.\n\n');
  process.exit(1);
}
process.stdout.write('  language: ' + passed + ' passed, 0 failed.\n\n');
