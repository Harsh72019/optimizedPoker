// archivedTable.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const {paginate} = require('./plugins/paginate');

const archivedTableSchema = new Schema(
  {
    originalTableId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Table',
    },
    tableTypeId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'TableType',
    },
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },
    participants: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: 'User',
        },
        totalHandsPlayed: Number,
        handsWon: Number,
        totalProfit: Number,
        joinedAt: Date,
        leftAt: Date,
      },
    ],
    totalRounds: {
      type: Number,
      default: 0,
    },
    gameLogs: [{event: String, timestamp: {type: Date, default: Date.now}}], // this is action histoy of game state and would just be saved only and only at deletion of table
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
    },
    archivedReason: {
      type: String,
      enum: ['dissolved', 'inactivity'],
    },
  },
  {timestamps: true}
);

// Index for faster queries
archivedTableSchema.plugin(paginate);
archivedTableSchema.index({originalTableId: 1, status: 1});
archivedTableSchema.index({'participants.userId': 1});
const ArchivedTable = mongoose.model('ArchivedTable', archivedTableSchema);
module.exports = {ArchivedTable};
