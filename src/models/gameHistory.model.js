const mongoose = require('mongoose');
const { Schema } = mongoose;

const gameHistorySchema = new Schema(
  {
    tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: true },
    handNumber: { type: Number },
    pot: { type: Number, default: 0 },
    boardCards: [{ type: Schema.Types.Mixed }],
    burnCards: [{ type: Schema.Types.Mixed }],
    players: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        finalChips: { type: Number, default: 0 },
        cards: [{ type: Schema.Types.Mixed }],
        status: { type: String }
      }
    ],
    fairness: {
      protocolVersion: { type: String },
      algorithm: { type: String },
      tableId: { type: String },
      handNumber: { type: Number },
      serverSeedHash: { type: String },
      clientSeed: { type: String },
      combinedClientSeed: { type: String },
      serverSeed: { type: String },
      finalSeed: { type: String },
      playerSeedCommitments: [{ type: Schema.Types.Mixed }],
      playerSeedReveals: [{ type: Schema.Types.Mixed }],
      dealOrder: [{ type: Schema.Types.Mixed }],
      drawProtocol: { type: Schema.Types.Mixed },
      boardCards: [{ type: Schema.Types.Mixed }],
      burnCards: [{ type: Schema.Types.Mixed }],
      committedAt: { type: Date },
      readyAt: { type: Date },
      revealedAt: { type: Date }
    },
    endedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('GameHistory', gameHistorySchema);
