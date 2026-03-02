// table.model.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const {paginate} = require('./plugins/paginate');

const BLIND_STRUCTURES = [
  { minBuyIn: 0, blinds: [0.01, 0.02] },     // Micro stakes
  { minBuyIn: 1, blinds: [0.02, 0.05] },
  { minBuyIn: 2, blinds: [0.05, 0.10] },
  { minBuyIn: 5, blinds: [0.10, 0.25] },
  { minBuyIn: 10, blinds: [0.25, 0.50] },
  { minBuyIn: 20, blinds: [0.50, 1] },
  { minBuyIn: 50, blinds: [1, 2] },
  { minBuyIn: 100, blinds: [2, 5] },
  { minBuyIn: 200, blinds: [5, 10] },
  { minBuyIn: 500, blinds: [10, 25] },
  { minBuyIn: 1000, blinds: [25, 50] },
  { minBuyIn: 2000, blinds: [50, 100] },
  { minBuyIn: 5000, blinds: [100, 200] },
  { minBuyIn: 10000, blinds: [200, 500] },
];
const crypto = require('crypto');

// Function to calculate blinds based on minBuyIn using predefined structure
const calculateBlinds = (minBuyIn) => {
  // Sort structures by minBuyIn descending
  const sortedStructures = [...BLIND_STRUCTURES].sort((a, b) => b.minBuyIn - a.minBuyIn);
  
  // Find the appropriate blind structure for the minBuyIn
  const structure = sortedStructures.find(s => minBuyIn >= s.minBuyIn) || 
                    BLIND_STRUCTURES[BLIND_STRUCTURES.length - 1];
  
  return {
    smallBlind: structure.blinds[0],
    bigBlind: structure.blinds[1]
  };
};

const tableTypeSchema = new Schema(
  {
    _id: {type: String, default: () => 'doc_' + crypto.randomBytes(8).toString('hex')},
    tableName: {type: String, required: true},
    minBuyIn: {type: Number, required: true},
    maxBuyIn: {type: Number, required: true},
    smallBlind: {type: Number},
    bigBlind: {type: Number},
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    maxSeats: { 
      type: Number, 
      required: true,
      min: 2,
      max: 10 // Typical poker table max seats
    },
    createSpareTables: {type: Boolean},
  },
  {timestamps: true}
);

// // Middleware to calculate blinds before saving
tableTypeSchema.pre('save', function(next) {
  if ((this.isNew || this.isModified('minBuyIn')) && (this.smallBlind == null || this.bigBlind == null)) {
    const { smallBlind, bigBlind } = calculateBlinds(this.minBuyIn);
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
  }
  next();
});
tableTypeSchema.plugin(paginate);

const TableType = mongoose.model('TableType', tableTypeSchema);

module.exports = {
  TableType,
};
