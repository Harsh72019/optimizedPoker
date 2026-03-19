const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { paginate } = require('./plugins/paginate');

// Game Financials - Main settlement record
const gameFinancialsSchema = new Schema({
  gameId: { type: String, required: true, index: true },
  gameType: { 
    type: String, 
    enum: ['CASH_GAME', 'PRIVATE_SNG', 'PRIVATE_TOURNAMENT', 'SCHEDULED_TOURNAMENT'],
    required: true 
  },
  hostId: { type: Schema.Types.ObjectId, ref: 'User' },
  
  // Game Configuration
  buyIn: { type: Number, required: true },
  declaredCapacity: { type: Number, required: true },
  actualParticipants: { type: Number, required: true },
  participationThreshold: { type: Number, enum: [25, 50, 75, 100], required: true },
  
  // Tier and Rake
  tierRake: { type: Number, required: true }, // Percentage
  hostUplift: { type: Number, default: 0 }, // Additional percentage for SNG
  effectiveRake: { type: Number, required: true }, // tierRake + hostUplift
  
  // Financial Calculations
  totalBuyIns: { type: Number, required: true },
  totalRake: { type: Number, required: true },
  prizePool: { type: Number, required: true },
  hostReward: { type: Number, default: 0 },
  hostRewardCap: { type: Number, required: true },
  remainingPrize: { type: Number, required: true },
  
  // Company and Affiliate
  companyShareBeforeAff: { type: Number, required: true },
  affiliatePayout: { type: Number, default: 0 },
  companyNet: { type: Number, required: true },
  
  // Platform Revenue
  setupFee: { type: Number, required: true },
  platformRevenue: { type: Number, required: true },
  
  // Rounding
  roundingPoolContribution: { type: Number, default: 0 },
  
  // Audit Trail
  calculationSnapshot: {
    setupFeeDetails: {
      baseFormula: String,
      constants: Object,
      fullPrecisionResult: Number,
      displayedAmount: Number,
      roundingResidue: Number
    },
    settlementSteps: [String],
    timestamp: { type: Date, default: Date.now }
  },
  
  status: { 
    type: String, 
    enum: ['PENDING', 'SETTLED', 'REFUNDED'],
    default: 'PENDING'
  }
}, { timestamps: true });

// Setup Fee Ledger
const setupFeeLedgerSchema = new Schema({
  gameId: { type: String, required: true, index: true },
  hostId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Setup Fee Calculation
  buyIn: { type: Number, required: true },
  declaredCapacity: { type: Number, required: true },
  hours: { type: Number, required: true },
  timerSeconds: { type: Number, required: true },
  speedBonus: { type: Number, required: true },
  
  // Formula Constants
  constants: {
    a: { type: Number, required: true },
    b: { type: Number, required: true },
    c: { type: Number, required: true },
    d: { type: Number, required: true }
  },
  
  // Calculation Results
  fullPrecisionAmount: { type: Number, required: true },
  chargedAmount: { type: Number, required: true }, // Floored to cents
  roundingResidue: { type: Number, required: true },
  
  // Transaction
  transactionId: { type: String },
  status: { 
    type: String, 
    enum: ['CHARGED', 'REFUNDED', 'FAILED'],
    default: 'CHARGED'
  }
}, { timestamps: true });

// Rake Ledger
const rakeLedgerSchema = new Schema({
  gameId: { type: String, required: true, index: true },
  gameType: { 
    type: String, 
    enum: ['CASH_GAME', 'PRIVATE_SNG', 'PRIVATE_TOURNAMENT', 'SCHEDULED_TOURNAMENT'],
    required: true 
  },
  
  // Rake Details
  totalWagered: { type: Number, required: true },
  rakePercentage: { type: Number, required: true },
  rakeAmount: { type: Number, required: true },
  
  // Distribution
  companyShare: { type: Number, required: true },
  affiliateShare: { type: Number, default: 0 },
  hostShare: { type: Number, default: 0 }, // For SNG uplift
  
  // Metadata
  handsPlayed: { type: Number, default: 0 },
  avgPotSize: { type: Number, default: 0 }
}, { timestamps: true });

// Host Reward Ledger
const hostRewardLedgerSchema = new Schema({
  gameId: { type: String, required: true, index: true },
  hostId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Reward Details
  prizePool: { type: Number, required: true },
  requestedRewardPercent: { type: Number, required: true },
  requestedRewardAmount: { type: Number, required: true },
  
  // Validation
  hostType: { type: String, enum: ['REGULAR', 'TRUSTED'], required: true },
  maxAllowedPercent: { type: Number, required: true },
  actualRewardAmount: { type: Number, required: true },
  
  // Transaction
  transactionId: { type: String },
  status: { 
    type: String, 
    enum: ['PENDING', 'PAID', 'REJECTED'],
    default: 'PENDING'
  }
}, { timestamps: true });

// Affiliate Ledger
const affiliateLedgerSchema = new Schema({
  gameId: { type: String, required: true, index: true },
  affiliateId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  referredUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Payout Calculation
  companyRake: { type: Number, required: true },
  affiliateRate: { type: Number, required: true }, // 30%
  payoutAmount: { type: Number, required: true },
  
  // Transaction
  transactionId: { type: String },
  status: { 
    type: String, 
    enum: ['PENDING', 'PAID', 'FAILED'],
    default: 'PENDING'
  }
}, { timestamps: true });

// Rounding Pool Ledger
const roundingPoolLedgerSchema = new Schema({
  gameId: { type: String, index: true },
  source: { 
    type: String, 
    enum: ['SETUP_FEE', 'PRIZE_SPLIT', 'RAKE_CALCULATION'],
    required: true 
  },
  
  // Rounding Details
  originalAmount: { type: Number, required: true },
  displayedAmount: { type: Number, required: true },
  roundingAmount: { type: Number, required: true },
  
  // Metadata
  description: { type: String },
  calculationDetails: { type: Object }
}, { timestamps: true });

// Transaction Ledger
const transactionLedgerSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['SETUP_FEE_CHARGE', 'HOST_REWARD', 'AFFILIATE_COMMISSION', 'PRIZE_PAYOUT', 'BUY_IN_CHARGE', 'BUY_IN_REFUND', 'ADMIN_CREDIT'],
    required: true 
  },
  amount: { type: Number, required: true },
  gameId: { type: String, index: true },
  description: { type: String, required: true },
  balanceAfter: { type: Number, required: true },
  transactionId: { type: String, unique: true },
  metadata: { type: Object, default: {} },
  status: { 
    type: String, 
    enum: ['PENDING', 'COMPLETED', 'FAILED'],
    default: 'COMPLETED'
  }
}, { timestamps: true });

// Admin Configuration
const adminConfigSchema = new Schema({
  configType: { 
    type: String, 
    enum: ['RAKE_TIERS', 'AFFILIATE_RATE', 'HOST_CAPS', 'SETUP_FEE', 'TIMER_MULTIPLIERS', 'HANDS_PER_HOUR', 'AVG_POT_MULTIPLIER', 'CASH_GAME_RAKE', 'OFFICIAL_TOURNAMENT_RAKE', 'TRUSTED_HOST_CRITERIA'],
    required: true,
    unique: true
  },
  
  config: {
    // Tournament Rake Tiers
    tournamentTiers: {
      tier1: { type: Number, default: 11 },
      tier2: { type: Number, default: 9 },
      tier3: { type: Number, default: 7 },
      tier4: { type: Number, default: 5 },
      tier5: { type: Number, default: 3 }
    },
    
    // SNG Rake Tiers
    sngTiers: {
      tier1: { type: Number, default: 5.0 },
      tier2: { type: Number, default: 4.5 },
      tier3: { type: Number, default: 3.5 },
      tier4: { type: Number, default: 2.5 },
      tier5: { type: Number, default: 2.0 }
    },
    
    // Official Tournament Rake
    officialTournament: {
      minRake: { type: Number, default: 5 },
      maxRake: { type: Number, default: 8 }
    },
    
    // Affiliate Rate
    affiliateRate: { type: Number, default: 30 },
    
    // Host Caps
    hostCaps: {
      regular: { type: Number, default: 15 },
      trusted: { type: Number, default: 25 }
    },
    
    // Host Uplift Caps
    hostUpliftCaps: {
      regular: { type: Number, default: 1.5 },
      trusted: { type: Number, default: 2.5 }
    },
    
    // Setup Fee Constants
    setupFeeConstants: {
      a: { type: Number, default: 0.005 },
      b: { type: Number, default: 0.03 },
      c: { type: Number, default: 0.10 },
      d: { type: Number, default: 0.10 }
    },
    
    // Speed Bonus Values
    speedBonus: {
      30: { type: Number, default: 0 },
      20: { type: Number, default: 1 },
      15: { type: Number, default: 2 },
      10: { type: Number, default: 3 },
      5: { type: Number, default: 4 }
    },
    
    // Timer Multipliers
    timerMultipliers: {
      30: { type: Number, default: 1.00 },
      20: { type: Number, default: 1.30 },
      15: { type: Number, default: 1.60 },
      10: { type: Number, default: 2.25 },
      5: { type: Number, default: 4.00 }
    },
    
    // Hands Per Hour (baseline for 30s timer)
    handsPerHour: {
      3: { type: Number, default: 90 },
      4: { type: Number, default: 85 },
      5: { type: Number, default: 82 },
      6: { type: Number, default: 80 },
      7: { type: Number, default: 75 },
      8: { type: Number, default: 72 },
      9: { type: Number, default: 70 }
    },
    
    // Average Pot Multiplier
    avgPotMultiplier: { type: Number, default: 3 },
    
    // Cash Game Rake Configuration
    cashGameRake: {
      tiers: {
        tier1: { type: Number, default: 5.0 },
        tier2: { type: Number, default: 4.5 },
        tier3: { type: Number, default: 4.0 },
        tier4: { type: Number, default: 3.5 },
        tier5: { type: Number, default: 3.0 }
      },
      rakeCap: { type: Number, default: 5.0 },
      minPotForRake: { type: Number, default: 1.0 }
    },
    
    // Official Tournament Rake
    officialTournamentRake: {
      minRake: { type: Number, default: 5 },
      maxRake: { type: Number, default: 8 },
      defaultRake: { type: Number, default: 6 },
      allowCustomRake: { type: Boolean, default: true }
    },
    
    // Trusted Host Criteria
    trustedHostCriteria: {
      minGamesHosted: { type: Number, default: 10 },
      minSuccessRate: { type: Number, default: 80 },
      minAccountAgeDays: { type: Number, default: 30 },
      minTotalPlayersServed: { type: Number, default: 50 },
      minSetupFeesPaid: { type: Number, default: 100 },
      requireVerification: { type: Boolean, default: true },
      minRating: { type: Number, default: 4.0 },
      minGamesInLast30Days: { type: Number, default: 3 }
    },
    
    // Trusted Host Privileges
    trustedHostPrivileges: {
      maxHostUplift: { type: Number, default: 2.5 },
      maxHostReward: { type: Number, default: 25 },
      tier5Access: { type: Boolean, default: true },
      prioritySupport: { type: Boolean, default: true },
      customTableLimits: { type: Boolean, default: true }
    }
  },
  
  lastUpdatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  version: { type: Number, default: 1 }
}, { timestamps: true });

// Add plugins
gameFinancialsSchema.plugin(paginate);
setupFeeLedgerSchema.plugin(paginate);
rakeLedgerSchema.plugin(paginate);
hostRewardLedgerSchema.plugin(paginate);
affiliateLedgerSchema.plugin(paginate);
roundingPoolLedgerSchema.plugin(paginate);
transactionLedgerSchema.plugin(paginate);
adminConfigSchema.plugin(paginate);

// Create indexes
gameFinancialsSchema.index({ gameType: 1, status: 1 });
gameFinancialsSchema.index({ hostId: 1, createdAt: -1 });
setupFeeLedgerSchema.index({ hostId: 1, createdAt: -1 });
rakeLedgerSchema.index({ gameType: 1, createdAt: -1 });
hostRewardLedgerSchema.index({ hostId: 1, status: 1 });
affiliateLedgerSchema.index({ affiliateId: 1, status: 1 });
roundingPoolLedgerSchema.index({ source: 1, createdAt: -1 });
transactionLedgerSchema.index({ userId: 1, createdAt: -1 });
transactionLedgerSchema.index({ type: 1, createdAt: -1 });
transactionLedgerSchema.index({ gameId: 1 });

// Create models
const GameFinancials = mongoose.model('GameFinancials', gameFinancialsSchema);
const SetupFeeLedger = mongoose.model('SetupFeeLedger', setupFeeLedgerSchema);
const RakeLedger = mongoose.model('RakeLedger', rakeLedgerSchema);
const HostRewardLedger = mongoose.model('HostRewardLedger', hostRewardLedgerSchema);
const AffiliateLedger = mongoose.model('AffiliateLedger', affiliateLedgerSchema);
const RoundingPoolLedger = mongoose.model('RoundingPoolLedger', roundingPoolLedgerSchema);
const TransactionLedger = mongoose.model('TransactionLedger', transactionLedgerSchema);
const AdminConfig = mongoose.model('AdminConfig', adminConfigSchema);

module.exports = {
  GameFinancials,
  SetupFeeLedger,
  RakeLedger,
  HostRewardLedger,
  AffiliateLedger,
  RoundingPoolLedger,
  TransactionLedger,
  AdminConfig
};