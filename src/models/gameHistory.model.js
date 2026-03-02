const mongoose = require('mongoose');
const { Schema } = mongoose;

const gameHistorySchema = new Schema(
  {
    tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: true },
    pot: { type: Number, default: 0 },
    boardCards: [{ type: String }],
    players: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        finalChips: { type: Number, default: 0 },
        cards: [{ type: String }],
        status: { type: String }
      }
    ],
    endedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('GameHistory', gameHistorySchema);
