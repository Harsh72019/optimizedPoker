// src/engine/deck.js

const crypto = require('crypto');

class Deck {
  static generate(seed = null) {
    const suits = [{ name: 'Heart', code: 'h' }, { name: 'Diamond', code: 'd' }, { name: 'Club', code: 'c' }, { name: 'Spade', code: 's' }];
    const values = [
      { face: '2', value: 2 }, { face: '3', value: 3 }, { face: '4', value: 4 }, { face: '5', value: 5 },
      { face: '6', value: 6 }, { face: '7', value: 7 }, { face: '8', value: 8 }, { face: '9', value: 9 },
      { face: '10', value: 10 }, { face: 'J', value: 11 }, { face: 'Q', value: 12 }, { face: 'K', value: 13 }, { face: 'A', value: 14 }
    ];

    const deck = [];

    for (const suit of suits) {
      for (const val of values) {
        deck.push({ cardFace: val.face, suit: suit.name, value: val.value });
      }
    }

    return this.shuffle(deck, seed);
  }

  static shuffle(deck, seed = null) {
    if (!seed) {
      return this.shuffleSecure(deck);
    }

    return this.shuffleDeterministic(deck, seed);
  }

  static shuffleSecure(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  static shuffleDeterministic(deck, seed) {
    const random = this.createDeterministicRandom(seed);

    for (let i = deck.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
  }

  static createDeterministicRandom(seed) {
    let counter = 0;
    let pool = Buffer.alloc(0);

    const refill = () => {
      const counterBuffer = Buffer.allocUnsafe(8);
      counterBuffer.writeBigUInt64BE(BigInt(counter++));
      pool = Buffer.concat([
        pool,
        crypto
          .createHmac('sha256', Buffer.from(seed, 'hex'))
          .update(counterBuffer)
          .digest()
      ]);
    };

    const nextUInt32 = () => {
      while (pool.length < 4) {
        refill();
      }

      const value = pool.readUInt32BE(0);
      pool = pool.subarray(4);
      return value;
    };

    return {
      int(maxExclusive) {
        if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
          throw new Error('maxExclusive must be a positive integer');
        }

        const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
        let value;

        do {
          value = nextUInt32();
        } while (value >= limit);

        return value % maxExclusive;
      }
    };
  }
}

module.exports = Deck;
