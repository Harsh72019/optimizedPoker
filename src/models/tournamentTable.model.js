// models/tournamentTable.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tournamentTableSchema = new Schema(
  {
    tournamentId: {type: Schema.Types.ObjectId, ref: 'Tournament', required: true},
    tournamentTemplateId: {type: Schema.Types.ObjectId, ref: 'TournamentTemplate'},
    maxPlayers: {type: Number, required: true},
    currentPlayers: [{type: Schema.Types.ObjectId, ref: 'TournamentPlayer'}],
    gameState: {type: Schema.Types.ObjectId, ref: 'GameState'},
    dealerPosition: {type: Number},
    smallBlindPosition: {type: Number},
    bigBlindPosition: {type: Number},
    currentTurnPosition: {type: Number},
    gameRoundsCompleted: {type: Number, default: 0},
    isActive: {type: Boolean, default: true},
    isFinalTable: {type: Boolean, default: false},
  },
  {timestamps: true}
);

const TournamentTable = mongoose.model('TournamentTable', tournamentTableSchema);

module.exports = {
  TournamentTable,
};
