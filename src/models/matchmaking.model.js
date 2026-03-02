const mongoose = require('mongoose');

// Tier Schema
const tierSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        index: true
    },
    minAccountType: {
        type: String,
        enum: ['Human', 'Rat', 'Cat', 'Dog'],
        required: true,
        index: true
    },
    handsPlayed: {
        type: Number,
        default: 0
    },
    handsToPromote: {
        type: Number,
        default: 100
    },
    profitPercentage: {
        type: Number,
        default: 10
    },
    subTierIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubTier'
    }],
    bankAllocatedReserve: {
        type: Number,
        default: 10000
    },
    maxBurnPerWindow: {
        type: Number,
        default: 1000
    },
    burnWindowSeconds: {
        type: Number,
        default: 3600
    },
    mutualCooldownEnforced: {
        type: Boolean,
        default: true
    },
    cooldownWindowGames: {
        type: Number,
        default: 3
    },
    maxWaitSoftensSecs: {
        type: Number,
        default: 45
    },
    botConcession: {
        enable: { type: Boolean, default: true },
        minWaitToConcedeSecs: { type: Number, default: 20 },
        minPlayerReputation: { type: Number, default: 40 }
    },
    reputationConfig: {
        emaAlpha: { type: Number, default: 0.2 },
        wHands: { type: Number, default: 0.2 },
        wEarly: { type: Number, default: -4.0 },
        wChurn: { type: Number, default: -2.0 },
        wDCClient: { type: Number, default: -1.0 },
        wDCServer: { type: Number, default: -0.2 },
        dcServerCap: { type: Number, default: 3.0 },
        earnBackThreshold: { type: Number, default: 40 },
        earnBackHandsRequired: { type: Number, default: 30 }
    }
}, {
    timestamps: true
});

// Tier Indexes
tierSchema.index({ createdAt: 1 });
tierSchema.index({ minAccountType: 1, bankAllocatedReserve: 1 });

// Sub-Tier Schema
const subTierSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        index: true
    },
    tierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tier',
        required: true,
        index: true
    },
    tableConfig: {
        maxSeats: { type: Number, default: 9 },
        bb: { type: Number, required: true },
        turnTimeSeconds: { type: Number, default: 25 },
        closureGraceSecs: { type: Number, default: 30 },
        mode: {
            type: String,
            enum: ['CASH', 'TOURNAMENT'],
            default: 'CASH'
        },
        blindIncrease: {
            everyHands: Number,
            deltaBb: Number
        },
        anteIncrease: {
            everyHands: Number,
            deltaAnte: Number
        }
    },
    tableIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MatchmakingTable'
    }],
    playersInQueue: [{
        playerId: {
            type: String,
            ref: 'User'
        },
        socketId: { type: String },
        enqueuedAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true
});

// Sub-Tier Indexes
subTierSchema.index({ tierId: 1, name: 1 });
subTierSchema.index({ 'tableConfig.bb': 1 });
subTierSchema.index({ 'tableConfig.mode': 1 });
subTierSchema.index({ createdAt: 1 });
subTierSchema.index({
    'playersInQueue.enqueuedAt': 1
}, {
    sparse: true
});

// Compound index for queue queries
subTierSchema.index({
    _id: 1,
    'playersInQueue.playerId': 1
});

// Matchmaking Table Schema
const matchmakingTableSchema = new mongoose.Schema({
    subTierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubTier',
        required: true,
        index: true
    },
    tierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tier',
        required: true,
        index: true
    },
    tableConfig: {
        type: Object,
        required: true
    },
    // pokerTableId: {
    //     type: mongoose.Schema.Types.ObjectId,
    //     ref: 'Table',
    //     required: true
    // },
    currentPlayerIds: [{
        type: String,
        ref: 'User'
    }],
    state: {
        type: String,
        enum: ['OPEN', 'ACTIVE', 'CLOSING', 'RESOLVED'],
        default: 'OPEN',
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    lastActivityAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    onePlayerSinceAt: {
        type: Date,
        index: true
    },
    handsByPlayer: {
        type: Map,
        of: Number
    },
    blockchainTableId: {
        type: String
    }
}, {
    timestamps: true
});

// Matchmaking Table Indexes
matchmakingTableSchema.index({ subTierId: 1, state: 1 });
matchmakingTableSchema.index({ tierId: 1, state: 1 });
matchmakingTableSchema.index({ state: 1, lastActivityAt: 1 });
matchmakingTableSchema.index({ state: 1, createdAt: 1 });
matchmakingTableSchema.index({ currentPlayerIds: 1 });
matchmakingTableSchema.index({ blockchainTableId: 1 }, { unique: true, sparse: true });

// Compound indexes for common queries
matchmakingTableSchema.index({
    subTierId: 1,
    state: 1,
    'tableConfig.maxSeats': 1
});

matchmakingTableSchema.index({
    state: 1,
    lastActivityAt: 1,
    onePlayerSinceAt: 1
});

// For finding tables with available seats
matchmakingTableSchema.index({
    state: 1,
    currentPlayerIds: 1
});

// Player Cooldown Schema
const cooldownSchema = new mongoose.Schema({
    playerId: {
        type: String,
        ref: 'User',
        required: true
    },
    recentGames: [{
        gameId: {
            type: String
        },
        endedAt: {
            type: Date
        },
        opponents: [String]
    }],
    opponentCounts: {
        type: Map,
        of: Number
    }
}, {
    timestamps: true
});

// Cooldown Indexes
cooldownSchema.index({ playerId: 1 }, { unique: true });
cooldownSchema.index({ 'recentGames.endedAt': 1 });
cooldownSchema.index({ createdAt: 1 });

// Compound index for cooldown checks
cooldownSchema.index({
    playerId: 1,
    'recentGames.endedAt': 1
});

// Funding Record Schema
const fundingRecordSchema = new mongoose.Schema({
    tierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tier',
        required: true,
        index: true
    },
    botId: {
        type: String,
        index: true
    },
    tableId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MatchmakingTable',
        index: true
    },
    amount: {
        type: Number,
        required: true
    },
    reserveAfter: {
        type: Number,
        index: true
    },
    windowStart: { // ADDED: For burn rate calculations
        type: Date,
        index: true
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: true
});

// Funding Record Indexes
fundingRecordSchema.index({ tierId: 1, createdAt: 1 });
fundingRecordSchema.index({ tierId: 1, timestamp: 1 });
fundingRecordSchema.index({ createdAt: 1 });
fundingRecordSchema.index({ amount: 1 });

// Compound index for burn rate calculations
fundingRecordSchema.index({
    tierId: 1,
    createdAt: 1,
    amount: 1
});

const Tier = mongoose.model('Tier', tierSchema);
const SubTier = mongoose.model('SubTier', subTierSchema);
const MatchmakingTable = mongoose.model('MatchmakingTable', matchmakingTableSchema);
const Cooldown = mongoose.model('Cooldown', cooldownSchema);
const FundingRecord = mongoose.model('FundingRecord', fundingRecordSchema);

module.exports = {
    Tier,
    SubTier,
    MatchmakingTable,
    Cooldown,
    FundingRecord
};