// src/engine/deck.js

class Deck {
  static generate() {
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

    return this.shuffle(deck);
  }

  static shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
}

module.exports = Deck;