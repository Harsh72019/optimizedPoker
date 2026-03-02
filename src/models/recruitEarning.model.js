const mongoose = require('mongoose');

const recruitEarningSchema = new mongoose.Schema(
  {
    recruitId: {
      type: String,
      ref: 'User',
      required: true,
      index: true
    },
    recruiterId: {
      type: String,
      ref: 'User',
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: true
    },
    type: {
      type: String,
      enum: ['deposit', 'game_win'],
      required: true
    }
  },
  { timestamps: true }
);

recruitEarningSchema.index({ recruiterId: 1, createdAt: -1 });

const RecruitEarning = mongoose.model('RecruitEarning', recruitEarningSchema);

module.exports = { RecruitEarning };
