// models/table.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { paginate } = require('./plugins/paginate');

const tableSchema = new Schema(
  {
    _id: { type: String },
    tableTypeId: {type: String, ref: 'TableType'},
    maxPlayers: {
      type: Number,
      enum: [5, 9],
      default: 5,
    },
    currentPlayers: [{ type: Schema.Types.ObjectId, ref: 'Player' }], // References to Player models
    playerJoiningTimes: [{ type: Object, default: {} }],
    gameState: { type: Schema.Types.ObjectId, ref: 'GameState' }, // Current game state
    dealerPosition: { type: Number }, // Position index of the dealer
    smallBlindPosition: { type: Number }, // Position index of small blind
    bigBlindPosition: { type: Number }, // Position index of big blind
    currentTurnPosition: { type: Number }, // Current player's turn position
    gameRoundsCompleted: { type: Number, default: 0 }, // Current pot size
    blockchainAddress: {
      type: String,
    },
    tableBlockchainId: {
      type: String,
    },
    // Table pool management fields
    isPreCreated: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['available', 'in-use', 'archived'],
      default: 'in-use', // Default for backward compatibility with existing tables
    },
    isCleared : {
      type: Boolean,
      default: false,
    },
    // Track hands played per player for tier progression
    handsByPlayer: {
      type: Map,
      of: Number,
      default: new Map()
    }
  },
  { timestamps: true }
  // {versionKey: false}
);

// Add indexes for efficient table pool queries
tableSchema.index({ tableTypeId: 1, maxPlayers: 1, status: 1 });
tableSchema.index({ isPreCreated: 1, status: 1 });
tableSchema.plugin(paginate);
const Table = mongoose.model('Table', tableSchema);

module.exports = {
  Table,
};
