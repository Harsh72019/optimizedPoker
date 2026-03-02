const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const gameStateSchema = new Schema(
  {
    tableId: {type: Schema.Types.ObjectId, ref: 'Table'},
    players: [
      {
        playerId: {type: Schema.Types.ObjectId, ref: 'Player'},
        chipsInPot: {type: Number},
        actions: [String],
        hasActed: {type: Boolean, default: false},
        isBot: {
          type: Boolean,
          default: false,
        },
      },
    ],
    dealer: {type: Schema.Types.ObjectId, ref: 'Player'},
    boardCards: [String], // Community cards
    currentBet: {type: Number},
    pot: {type: Number},
    currentRound: {type: Number, default: 0}, // Track rounds (0: pre-flop, 1: post-flop, etc.)
    actionHistory: [
      {event: String, timestamp: {type: Date, default: Date.now}, isPublicVisible: {type: Boolean, default: true}},
    ], // e.g., "Player1 bet 50"
    status: {type: String, default: 'waitingForPlayers'}, // "waitingForPlayers", "gameOngoing", "break"
    createdAt: {type: Date, default: Date.now},
  },
  {timestamps: true}
  // {versionKey: false}
);

const GameState = mongoose.model('GameState', gameStateSchema);

module.exports = {
  GameState,
};
