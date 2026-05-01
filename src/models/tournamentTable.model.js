// models/tournamentTable.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tournamentTableSchema = new Schema(
  {
    tournamentId: {type: Schema.Types.ObjectId, ref: 'Tournament', required: true},
    tournamentTemplateId: {type: Schema.Types.ObjectId, ref: 'TournamentTemplate'},
    tableId: {type: String, ref: 'Table'},
    tableNumber: {type: Number},
    maxPlayers: {type: Number, required: true},
    currentPlayers: [{type: Schema.Types.ObjectId, ref: 'TournamentPlayer'}],
    players: [
      {
        tournamentPlayerId: {type: Schema.Types.ObjectId, ref: 'TournamentPlayer'},
        userId: {type: Schema.Types.ObjectId, ref: 'User'},
        seatPosition: Number,
        chips: Number,
        status: {
          type: String,
          enum: ['ACTIVE', 'ELIMINATED', 'MOVED', 'DISCONNECTED'],
          default: 'ACTIVE',
        },
      },
    ],
    gameState: {type: Schema.Types.ObjectId, ref: 'GameState'},
    dealerPosition: {type: Number},
    smallBlindPosition: {type: Number},
    bigBlindPosition: {type: Number},
    currentTurnPosition: {type: Number},
    gameRoundsCompleted: {type: Number, default: 0},
    isActive: {type: Boolean, default: true},
    isFinalTable: {type: Boolean, default: false},
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'COMPLETED', 'MERGED'],
      default: 'PENDING',
    },
  },
  {timestamps: true}
);

const TournamentTable = mongoose.model('TournamentTable', tournamentTableSchema);

module.exports = {
  TournamentTable,
};
