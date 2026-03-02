const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const playerSchema = new Schema(
  {
    balance: {type: Number, default: 0},
    user: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    seatPosition: {type: Number, required: true},
    socketId: {type: String, required: true},
    status: {type: String, default: 'waiting'},
    chipsInPlay: {type: Number, default: 0},
    autoRenew: {
      type: Boolean,
      default: false,
    },
    maxBuy: {
      type: Boolean,
      default: false,
    },
    isBot: {
      type: Boolean,
      default: false,
    },
    rebuyCount: {
      type: Number,
      default: 0,
    },
    awayRoundsCount: {
      type: Number,
      default: 0,
    },
    isAway: {
      type: Boolean,
      default: false,
    },
    totalHandBet: {
      type: Number,
      default: 0,
    },
    betHistory: {
      type: [Number],
      default: [],
    },
    createdAt: {type: Date, default: Date.now},
    updatedAt: {type: Date, default: Date.now},
  },
  {timestamps: true}
);

const Player = mongoose.model('Player', playerSchema);

module.exports = {
  Player,
};
