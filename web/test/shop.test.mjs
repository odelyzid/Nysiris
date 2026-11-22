// Run with: node --test web/test
// Byte-exact marketplace grammar: cross-implementation vectors from
// crates/shop-format/src/sig.rs, PoW preimage layouts, the order state
// machine, and local review aggregation. Skips when node_modules are absent.
import test from 'node:test';
import assert from 'node:assert/strict';

let shop = null;
let ed = null;
let hex = null;
try {
  shop = await import('../src/domain/shop.ts');
  ed = await import('@noble/curves/ed25519.js');
  hex = await import('@noble/hashes/utils.js');
} catch {
  shop = null;
}

const PRIV = '2a'.repeat(32);
const SELLER = '197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61';
const DAY = 20400;
const LISTING_ID = 'ab'.repeat(16);
const ORDER_LISTING = 'cd'.repeat(16);
const ORDER_ID = 'ef'.repeat(16);

test('seller key matches the Rust vector', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const pub = hex.bytesToHex(ed.ed25519.getPublicKey(hex.hexToBytes(PRIV)));
  assert.equal(pub, SELLER);
});

test('listing signature matches the Rust cross-implementation vector', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const sig = shop.signListing(
    PRIV,
    SELLER,
    DAY,
    LISTING_ID,
    1,
    1234,
    7,
    'USD',
    'Desk lamp',
    'Warm light, small scratch.',
  );
  assert.equal(
    sig,
    '0927b9355d4d781397bc160a6552eede07f54fd1462878b341dcbc349785a020c8a1213dd5d867a603c539d7ab452cd50431c397bcc87ede6ad409552ea5f408',
  );
  assert.equal(
    shop.verifyListingSignature(
      SELLER,
      DAY,
      LISTING_ID,
      1,
      1234,
      7,
      'USD',
      'Desk lamp',
      'Warm light, small scratch.',
      sig,
    ),
    true,
  );
});

test('order signature matches the Rust vector and binds every field', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const sig = shop.signOrder(PRIV, SELLER, DAY, ORDER_LISTING, ORDER_ID, 3, 1234, 7, 'please pack well');
  assert.equal(
    sig,
    '7ea324635ab55cc9cae76000ba65b697779250b0d75b481ff91dacde007a1fb7dd856447d5d8e395119b1e39603091935aa611cca525aa4828e3a1dde2142e07',
  );
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, ORDER_LISTING, ORDER_ID, 3, 1234, 7, 'please pack well', sig), true);
  // Quantity, price, version, note, listing, and id are all signed.
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, ORDER_LISTING, ORDER_ID, 4, 1234, 7, 'please pack well', sig), false);
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, ORDER_LISTING, ORDER_ID, 3, 1235, 7, 'please pack well', sig), false);
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, ORDER_LISTING, ORDER_ID, 3, 1234, 8, 'please pack well', sig), false);
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, ORDER_LISTING, ORDER_ID, 3, 1234, 7, 'please pack wel', sig), false);
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, 'ce'.repeat(16), ORDER_ID, 3, 1234, 7, 'please pack well', sig), false);
  assert.equal(shop.verifyOrderSignature(SELLER, DAY, ORDER_LISTING, 'ee'.repeat(16), 3, 1234, 7, 'please pack well', sig), false);
});

test('review signature matches the Rust vector and binds rating/seller/body', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const reviewed = '11'.repeat(32);
  const sig = shop.signReview(PRIV, SELLER, DAY, ORDER_ID, reviewed, 5, 'exactly as described');
  assert.equal(
    sig,
    'cb07824e765ec85b4c83b278b9efcf4693bf12dd31709e3e85bf94d2a0fca2cdca92e45e7de7eaef19f4c1b6ff8b29da8946c917a840b76fd4fbb758b6a93304',
  );
  assert.equal(shop.verifyReviewSignature(SELLER, DAY, ORDER_ID, reviewed, 5, 'exactly as described', sig), true);
  assert.equal(shop.verifyReviewSignature(SELLER, DAY, ORDER_ID, reviewed, 1, 'exactly as described', sig), false);
  assert.equal(shop.verifyReviewSignature(SELLER, DAY, ORDER_ID, reviewed, 5, 'exactly as describe', sig), false);
  // The reviewed seller is signed, so a provider cannot reassign a review.
  assert.equal(
    shop.verifyReviewSignature(SELLER, DAY, ORDER_ID, '22'.repeat(32), 5, 'exactly as described', sig),
    false,
  );
});

test('order-status signature and transition chain are verifiable', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const sellerSig = shop.signOrderStatus(PRIV, SELLER, DAY, ORDER_ID, 1, 'accepted');
  assert.equal(
    sellerSig,
    'ade3a17c992f515bae5ec90f488f00b148a5b827329153944654ed952362fc05aec9e3a5b56c2f7ffd81210a70edc3e47264060d9efeadb6d1277126f609f001',
  );
  const buyerPriv = '2b'.repeat(32);
  const BUYER = hex.bytesToHex(ed.ed25519.getPublicKey(hex.hexToBytes(buyerPriv)));
  const accepted = {
    from_code: 0,
    status_code: 1,
    actor: SELLER,
    day: DAY,
    note: 'accepted',
    sig: sellerSig,
  };
  const cancelled = {
    from_code: 1,
    status_code: 4,
    actor: BUYER,
    day: DAY,
    note: 'changed mind',
    sig: shop.signOrderStatus(buyerPriv, BUYER, DAY, ORDER_ID, 4, 'changed mind'),
  };
  assert.equal(shop.verifyStatusChain(ORDER_ID, BUYER, SELLER, 4, [accepted, cancelled]), true);
  // A provider cannot invent or reassign a state change.
  assert.equal(shop.verifyStatusChain(ORDER_ID, BUYER, SELLER, 2, [accepted, cancelled]), false);
  assert.equal(
    shop.verifyStatusChain(ORDER_ID, BUYER, SELLER, 4, [{ ...cancelled, actor: '33'.repeat(32) }]),
    false,
  );
  assert.equal(shop.verifyStatusChain(ORDER_ID, BUYER, SELLER, 4, [{ ...cancelled, from_code: 2 }]), false);
  assert.equal(shop.verifyStatusChain(ORDER_ID, BUYER, SELLER, 0, []), true);
});

test('orders-read proof matches the Rust vector and cannot be replayed', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const sig = shop.signOrdersRead(PRIV, SELLER, DAY);
  assert.equal(
    sig,
    '3574ea77bbfec57ffed516d9368d912b962561d9e7e6fbc43f5786a8d0d8a9128af6c0ff095b270c78f2253192cd95d0d50c0bf05f8f5d453ed7b6d2de035a04',
  );
  assert.equal(shop.verifyOrdersReadSignature(SELLER, DAY, sig), true);
  assert.equal(shop.verifyOrdersReadSignature(SELLER, DAY + 1, sig), false);
  assert.equal(shop.verifyOrdersReadSignature('43'.repeat(32), DAY, sig), false);
});

test('PoW preimages are exact byte layouts', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const u64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n));
    return b;
  };
  const u32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return b;
  };
  const id = (s) => hex.hexToBytes(s);
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const enc = new TextEncoder();

  assert.deepEqual(
    shop.listingPowPreimage(LISTING_ID, 2, 1234, 9, 'USD', 'Lamp', 'Warm'),
    cat(id(LISTING_ID), u64(2), u64(1234), u32(9), enc.encode('USD'), enc.encode('Lamp\0Warm')),
  );
  assert.deepEqual(shop.listingDeletePowPreimage(LISTING_ID), id(LISTING_ID));
  assert.deepEqual(
    shop.orderPowPreimage(ORDER_LISTING, ORDER_ID, 3, 1234, 7, 'hi'),
    cat(id(ORDER_LISTING), id(ORDER_ID), u32(3), u64(1234), u64(7), enc.encode('hi')),
  );
  assert.deepEqual(
    shop.orderStatusPowPreimage(ORDER_ID, 1, 'ok'),
    cat(id(ORDER_ID), new Uint8Array([1]), enc.encode('ok')),
  );
  assert.deepEqual(
    shop.orderMessagePowPreimage(ORDER_ID, 'hello'),
    cat(id(ORDER_ID), enc.encode('hello')),
  );
  assert.deepEqual(
    shop.reviewPowPreimage(ORDER_ID, '11'.repeat(32), 5, 'great'),
    cat(id(ORDER_ID), id('11'.repeat(32)), new Uint8Array([5]), enc.encode('great')),
  );
});

test('order state machine is role-scoped', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  const { reserved, accepted, fulfilled, declined, cancelled } = shop.ORDER_STATUS;
  assert.equal(shop.orderStatusName(reserved), 'reserved');
  assert.equal(shop.orderStatusName(99), 'unknown');
  assert.equal(shop.canTransition('seller', reserved, accepted), true);
  assert.equal(shop.canTransition('seller', reserved, declined), true);
  assert.equal(shop.canTransition('seller', accepted, fulfilled), true);
  assert.equal(shop.canTransition('buyer', reserved, cancelled), true);
  assert.equal(shop.canTransition('buyer', accepted, cancelled), true);
  // No buyer acceptance/fulfilment, no seller cancellation, no revival.
  assert.equal(shop.canTransition('buyer', reserved, accepted), false);
  assert.equal(shop.canTransition('buyer', accepted, fulfilled), false);
  assert.equal(shop.canTransition('seller', reserved, cancelled), false);
  assert.equal(shop.canTransition('buyer', fulfilled, cancelled), false);
  assert.equal(shop.canTransition('seller', cancelled, accepted), false);
});

test('local review aggregation ignores invalid ratings', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  assert.deepEqual(shop.summarizeRatings([5, 4, 0, 6, 3]), { count: 3, sum: 12, averageX100: 400 });
  assert.deepEqual(shop.summarizeRatings([]), { count: 0, sum: 0, averageX100: 0 });
  assert.equal(shop.isValidRating(1), true);
  assert.equal(shop.isValidRating(5), true);
  assert.equal(shop.isValidRating(0), false);
  assert.equal(shop.isValidRating(6), false);
});

test('display and input helpers stay exact', { skip: shop ? false : 'node_modules missing (@noble crypto); run npm ci in web/' }, () => {
  assert.equal(shop.PRICE_MINOR_UNITS, 100);
  assert.equal(shop.formatMinor(shop.PRICE_MINOR_UNITS, 'USD'), '1.00 USD');
  assert.equal(shop.formatMinor(1234, 'USD'), '12.34 USD');
  assert.equal(shop.formatMinor(5, 'USD'), '0.05 USD');
  assert.equal(shop.formatMinor(1234, 'JPY'), '1234 JPY');
  assert.equal(shop.isCurrencyCode('USD'), true);
  assert.equal(shop.isCurrencyCode('usd'), false);
  assert.equal(shop.isCurrencyCode('US'), false);
  assert.equal(shop.parseUint('12', 100), 12);
  assert.equal(shop.parseUint('0', 100), 0);
  assert.equal(shop.parseUint('-1', 100), null);
  assert.equal(shop.parseUint('1.5', 100), null);
  assert.equal(shop.parseUint('101', 100), null);
});
