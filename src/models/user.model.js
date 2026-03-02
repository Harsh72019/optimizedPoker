const mongoose = require('mongoose');
const {paginate} = require('./plugins/paginate');
const Schema = mongoose.Schema;

const CooldownGameEntrySchema = new mongoose.Schema({
  tableId: {
    type: String,
    ref: 'Table',
    required: true
  },
  seatedAt: {
    type: Date,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  opponents: [{
    type: String,
    ref: 'User'
  }]
}, { _id: false });

const userSchema = new mongoose.Schema(
  {
     _id: { type: String },
    name: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    email: {
      type: String,
      default: null,
      // trim: true,
      // unique: true,
    },
    profilePic: {
      type: {
        key: String,
        url: String,
      },
      default: null,
    },
    dob: {
      type: Date,
      default: null,
    },
    walletAddress: {
      type: String,
      default: null,
      required: true,
    },
    platform: {
      type: String,
      default: null,
    },
    nonce_message: {
      type: String,
      default: null,
    },
    shortWalletAddress: {
      type: String,
      default: null,
    },
    username: {
      type: String,
      default: '',
      unique: true,
    },
    referralCode: {
      type: String,
      unique: true,
      index: true
    },
    consent: {
      type: Boolean,
      default: false,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    accountType: {
      type: String,
      enum: ['Human', 'Rat', 'Cat', 'Dog'],
      default: 'Human',
      index: true
    },
    handsFromNextTier: {
      type: Number,
      default: 0,
      index: true
    },
    chips: {
      type: Number,
      default: 1000,
      index: true
    },
    // COOLDOWN STRUCTURE (from PDF spec)
    cooldown: {
      recentGames: {
        type: [CooldownGameEntrySchema],
        default: []
      },
      opponentCounts: {
        type: Map,
        of: Number, // count of games with opponent
        default: new Map()
      }
    },
    reputation: {
      score: { 
        type: Number, 
        default: 80,
        index: true 
      },
      earnBackHandsRemaining: { 
        type: Number, 
        default: 0,
        index: true 
      }
    },
    discipline: {
      earlyLeaveMinHands: { 
        type: Number, 
        default: 10 
      },
      lastJoinAttemptAt: {
        type: Date,
        index: true
      }
    },
    referredBy: {
      type: String,
      ref: 'User',
      default: null
    },
    recruits: [{
      type: String,
      ref: 'User'
    }]
  },
  {timestamps: true}
);

// Compound indexes for matchmaking queries
userSchema.index({ accountType: 1, chips: 1 });
userSchema.index({ accountType: 1, 'reputation.score': 1 });
userSchema.index({ isBlocked: 1, accountType: 1 });
userSchema.index({ chips: 1, 'reputation.score': 1 });
// Index for reputation-based queries
userSchema.index({ 
  'reputation.score': 1, 
  'reputation.earnBackHandsRemaining': 1 
});

// Index for account progression
userSchema.index({ 
  accountType: 1, 
  handsFromNextTier: 1 
});
userSchema.plugin(paginate);

const User = mongoose.model('User', userSchema);

module.exports = {
  User,
};
