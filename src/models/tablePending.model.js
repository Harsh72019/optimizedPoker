// models/tablePending.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tablePendingSchema = new Schema(
  {
    tableTypeId: {type: Schema.Types.ObjectId, ref: 'TableType', required: true},
    playerCount: {type: Number, required: true, enum: [5, 9]},
    joinedUsers: [
      {
        userId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
        chipsInPlay: {type: Number, required: true},
        socketId: {type: String, required: true}, // Add socketId for tracking
      },
    ],
    status: {
      type: String,
      enum: ['waiting', 'creating', 'completed', 'failed'],
      default: 'waiting',
    },
    creatingInProgress: {type: Boolean, default: false},
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 5 * 60 * 1000), // 5 minute expiry
    },
    tableResult: {
      tableId: String,
      blockchainAddress: String,
      error: String,
    },
  },
  {timestamps: true}
);

// Add index for fast queries and automatic expiry
tablePendingSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});

const TablePending = mongoose.model('TablePending', tablePendingSchema);

module.exports = {
  TablePending,
};
