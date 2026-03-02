// File: models/WithdrawalRecord.js
const mongoose = require('mongoose');

const withdrawalRecordSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    table: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      required: true,
    },
    tableBlockchainId: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    walletAddress: {
      type: String,
      required: true,
    },
    nonce: {
      type: String,
      required: true,
      unique: true, // ✅ NEW: Prevent duplicate processing
    },
    jobId: {
      type: String,
      sparse: true, // Allow null values but enforce uniqueness when present
    },
    status: {
      type: String,
      enum: ['pending', 'queued', 'processing', 'completed', 'failed'], // ✅ UPDATED: Added 'queued' and 'processing'
      default: 'pending',
    },
    transactionHash: {
      type: String,
      sparse: true,
    },
    error: {
      type: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    processingStartedAt: {
      // ✅ NEW: Track when processing started
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    failedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    indexes: [
      {nonce: 1}, // ✅ NEW: Index for uniqueness
      {jobId: 1}, // ✅ NEW: Index for job lookups
      {status: 1, createdAt: 1}, // ✅ NEW: Compound index for orphan checks
      {user: 1, status: 1}, // ✅ NEW: User status lookups
    ],
  }
);

// ✅ NEW: Add compound index to prevent duplicate nonce + user combinations
withdrawalRecordSchema.index({nonce: 1, user: 1}, {unique: true});

const WithdrawalRecord = mongoose.model('WithdrawalRecord', withdrawalRecordSchema);

module.exports = {
  WithdrawalRecord,
};
