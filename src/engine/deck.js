// src/engine/deck.js

class Deck {
  static generate() {
    const suits = ['h', 'd', 'c', 's'];
    const values = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

    const deck = [];

    for (const suit of suits) {
      for (const value of values) {
        deck.push(value + suit);
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