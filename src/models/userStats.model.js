// userStats.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const {paginate} = require('./plugins/paginate');

const userStatsSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    totalHandsPlayed: {
      type: Number,
      default: 0,
    },
    totalHandsWon: {
      type: Number,
      default: 0,
    },
    totalHandsLost: {
      type: Number,
      default: 0,
    },
    winRate: {
      type: Number, // Stored as percentage
      default: 0,
    },
    totalAmountWon: {
      type: Number,
      default: 0,
    },
    totalAmountLost: {
      type: Number,
      default: 0,
    },
    profitRatio: {
      type: Number, // Stored as percentage
      default: 0,
    },
    biggestWin: {
      type: Number,
      default: 0,
    },
    bestHand: {
      cards: [
        {
          _id: false, // Don't create IDs for embedded objects
          cardFace: String,
          suit: String,
          value: Number,
        },
      ],
      handRank: String,
      handValue: Number,
    },
    totalDeposits: {
      type: Number,
      default: 0,
    },
    totalWithdrawals: {
      type: Number,
      default: 0,
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  {timestamps: true}
);

// Calculate rates before saving
userStatsSchema.pre('save', function(next) {
  if (this.totalHandsPlayed > 0) {
    this.winRate = (this.totalHandsWon / this.totalHandsPlayed) * 100;
  }

  if (this.totalAmountLost > 0) {
    this.profitRatio = this.totalAmountWon / this.totalAmountLost;
  } else if (this.totalAmountWon > 0) {
    this.profitRatio = 99.99; // or another suitable high number
  } else {
    this.profitRatio = 0;
  }

  this.lastUpdated = new Date();
  next();
});

userStatsSchema.plugin(paginate);

// Fix the duplicate updateUserStats methods - keep only one
userStatsSchema.statics.updateUserStats = async function(userId, handResult) {
  try {
    const stats = (await this.findOne({userId})) || new this({userId});
    if (handResult.isDeposit) {
      stats.totalDeposits = (stats.totalDeposits || 0) + handResult.amount;
    }

    // Handle withdrawals
    else if (handResult.isWithdrawal) {
      stats.totalWithdrawals = (stats.totalWithdrawals || 0) + handResult.amount;
    }
    stats.totalHandsPlayed += 1;

    if (handResult.isWin) {
      stats.totalHandsWon += 1;
      stats.totalAmountWon += handResult.amount;
      stats.biggestWin = Math.max(stats.biggestWin, handResult.amount);

      if (handResult.handDetails) {
        const newHandValue = handResult.handDetails.handValue || 0;
        const currentBestHandValue = stats.bestHand?.handValue || 0;

        if (newHandValue > currentBestHandValue) {
          // Store cards directly as objects
          stats.bestHand = {
            // Extract just the needed properties from each card object
            cards: handResult.handDetails.cards.map(card => ({
              cardFace: card.cardFace,
              suit: card.suit,
              value: card.value,
            })),
            handRank: handResult.handDetails.handRank,
            handValue: newHandValue,
          };
        }
      }
    } else {
      stats.totalHandsLost += 1;
      stats.totalAmountLost += handResult.amount;
    }

    await stats.save();
    return stats;
  } catch (error) {
    console.error('Error updating user stats:', error);
    throw error;
  }
};

const UserStat = mongoose.model('UserStat', userStatsSchema);
module.exports = {UserStat};
