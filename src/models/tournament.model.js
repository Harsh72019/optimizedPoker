const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const {paginate} = require('./plugins/paginate');
const {TournamentTemplate} = require('./tournamentTemplate.model');

// Player schema within a tournament
const tournamentPlayerSchema = new Schema(
  {
    tournament: {type: Schema.Types.ObjectId, ref: 'Tournament', required: true},
    user: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    seatPosition: {type: Number, required: true},
    socketId: {type: String},
    status: {
      type: String,
      enum: [
        'waiting',
        'active',
        'bot-substituted',
        'small-blind',
        'big-blind',
        'folded',
        'all-in',
        'eliminated',
        'winner',
        'joining',
        'registered', // Add this
        'waitlist', // Add this
      ],
      default: 'waiting',
    },
    buyInDetails: {
      amount: {type: Number},
      transactionId: {type: String},
      timestamp: {type: Date},
    },
    waitlistPosition: {
      type: Number,
    },
    lastSocketId: {
      type: String,
    },
    chipsInPlay: {type: Number, required: true},
    bigBlindsAvailable: {type: Number, required: true},
    isPresent: {type: Boolean, default: false},
    rebuyCount: {type: Number, default: 0},
    eliminatedAt: Date,
    eliminatedPosition: Number,
    eliminatedBy: {type: Schema.Types.ObjectId, ref: 'TournamentPlayer'},
    // Tournament performance tracking
    stats: {
      handsPlayed: {type: Number, default: 0},
      winCount: {type: Number, default: 0},
      bestHand: {type: String},
      biggestPot: {type: Number, default: 0},
    },
    tableId: {type: Schema.Types.ObjectId, ref: 'TournamentTable'},
  },
  {timestamps: true}
);

const TournamentPlayer = mongoose.model('TournamentPlayer', tournamentPlayerSchema);

// Main tournament schema
const tournamentSchema = new Schema(
  {
    // Basic tournament info
    name: {type: String, required: true},
    description: {type: String, maxLength: 5000},
    startTime: {type: Date, required: true},
    registrationDeadline: {type: Date, required: true},
    templateId: {
      type: Schema.Types.ObjectId,
      ref: 'TournamentTemplate',
      required: true,
    },
    status: {
      type: String,
      enum: ['registering', 'scheduled', 'active', 'completed', 'cancelled', 'paused'],
      default: 'registering',
    },
    cancelReason: String,
    cancelledAt: Date,

    // Player limits
    maxPlayers: {type: Number, default: 90},
    minPlayersPerTable: {type: Number, default: 2},
    maxPlayersPerTable: {type: Number, default: 9},

    // Buy-in configuration
    buyIn: {type: Number, required: true},
    currentLevel: {
      levelNumber: {type: Number, default: 1},
      smallBlind: {type: Number},
      bigBlind: {type: Number},
      ante: {type: Number, default: 0},
      startedAt: {type: Date},
    },
    levelStartTime: {type: Date},

    // Payout structure
    payoutStructure: [
      {
        position: {type: Number, required: true},
        percentage: {type: Number, required: true},
      },
    ],

    players: [{type: Schema.Types.ObjectId, ref: 'TournamentPlayer'}],
    waitlist: [{type: Schema.Types.ObjectId, ref: 'TournamentPlayer'}],

    // Tables
    activeTables: [{type: Schema.Types.ObjectId, ref: 'TournamentTable'}],

    // Prize pool and winners
    prizePool: {type: Number, default: 0},
    winners: [
      {
        position: {type: Number, required: true},
        userId: {type: Schema.Types.ObjectId, ref: 'User'},
        prize: {type: Number, required: true},
        finalHand: String,
      },
    ],

    // Ante configuration
    anteConfig: {
      enabled: {
        type: Boolean,
        default: false,
      },
      startLevel: {
        type: Number,
        default: 3,
      },
      initialValue: {
        type: Number,
        default: 25,
      },
    },

    // Rebuy configuration
    rebuyConfig: {
      enabled: {
        type: Boolean,
        default: false,
      },
      attemptLimit: {
        type: Number,
        default: 2,
        min: 0,
        max: 10,
      },
      timeLimit: {
        type: Number,
        default: 60, // minutes after tournament start
        min: 15,
        max: 240,
      },
      rebuyDeadline: {
        type: Date,
      },
    },

    // Final table tracking
    finalTableFormed: {
      type: Boolean,
      default: false,
    },
    finalTableFormedAt: Date,
    finalTableStats: {
      playersAtFinalTable: Number,
      chipLeader: {
        playerId: Schema.Types.ObjectId,
        userId: Schema.Types.ObjectId,
        username: String,
        chips: Number,
      },
      playerDetails: [
        {
          playerId: Schema.Types.ObjectId,
          userId: Schema.Types.ObjectId,
          username: String,
          currentChips: Number,
          bigBlinds: Number,
          chipDiffFromStart: Number,
          chipDiffPct: Number,
          handsPlayed: Number,
          winCount: Number,
          winPct: Number,
        },
      ],
      chipDistribution: [
        {
          playerId: Schema.Types.ObjectId,
          username: String,
          percentage: Number,
        },
      ],
      handsAtFinalTable: {
        type: Number,
        default: 0,
      },
      eliminationsAtFinalTable: [
        {
          playerId: Schema.Types.ObjectId,
          userId: Schema.Types.ObjectId,
          username: String,
          position: Number,
          eliminatedAt: Date,
          eliminatedBy: Schema.Types.ObjectId,
        },
      ],
      startingChipCounts: {
        type: Map,
        of: Number,
      },
    },

    levelDuration: {
      type: Number, // Minutes per level when using time-based
      default: 15,
    },

    tournamentDuration: {
      type: Number, // In hours
      default: 0, // 0 means no limit
    },
    pauseSchedule: [
      {
        pauseAt: Date,
        resumeAt: Date,
      },
    ],

    // General tournament config
    timeZone: {type: String, required: true},
    generatedBlindLevels: Array, // Cache for blind levels
    startingChips: {type: Number},
  },
  {
    timestamps: true,
  }
);

// Validates payout structure totals 100%
tournamentSchema.pre('save', function(next) {
  if (this.payoutStructure) {
    const total = this.payoutStructure.reduce((sum, payout) => sum + payout.percentage, 0);
    if (Math.abs(total - 100) > 0.01) {
      return next(new Error('Payout structure must total 100%'));
    }
  }
  next();
});

// Fix this method to use TournamentPlayer model directly
tournamentSchema.methods.processRebuy = async function(userId) {
  // Validation checks remain the same...

  // Find the player using the TournamentPlayer model
  const player = await TournamentPlayer.findOne({
    tournament: this._id,
    user: userId,
  });

  if (!player) {
    throw new Error('Player not registered in this tournament');
  }

  // Check rebuy limit
  if (player.rebuyCount >= this.rebuyConfig.attemptLimit) {
    throw new Error('Maximum rebuy limit reached');
  }

  // Process rebuy
  player.chipsInPlay = this.startingChips;
  player.rebuyCount = (player.rebuyCount || 0) + 1;
  player.status = 'active';

  // Save player changes
  await player.save();

  // Update prize pool
  this.prizePool += this.buyIn;
  await this.save();

  return {
    success: true,
    newChips: this.startingChips,
    rebuyCount: player.rebuyCount,
    remainingRebuys: this.rebuyConfig.attemptLimit - player.rebuyCount,
  };
};

tournamentSchema.methods.registerPlayer = async function(userId, transactionId) {
  if (new Date() > this.registrationDeadline) {
    throw new Error('Registration period has ended');
  }

  // First, create the TournamentPlayer document
  const tournamentPlayer = new TournamentPlayer({
    tournament: this._id,
    user: userId,
    seatPosition: 0, // This will be assigned when tournament starts
    status: 'waiting',
    chipsInPlay: this.startingChips || 10000,
    bigBlindsAvailable: (this.startingChips || 10000) / 50, // Assuming 50 is starting big blind
    buyInDetails: {
      amount: this.buyIn,
      transactionId,
      timestamp: new Date(),
    },
  });

  // Save the tournament player
  await tournamentPlayer.save();

  // Now push the ID reference to the players array
  if (this.players.length < this.maxPlayers) {
    // Register player
    this.players.push(tournamentPlayer._id);
    this.prizePool += this.buyIn;
    tournamentPlayer.status = 'registered';
    await tournamentPlayer.save();
  } else {
    // Add to waitlist
    tournamentPlayer.waitlistPosition = this.waitlist.length + 1;
    tournamentPlayer.status = 'waitlist';
    await tournamentPlayer.save();
    this.waitlist.push(tournamentPlayer._id);
  }

  await this.save();
  return tournamentPlayer;
};

tournamentSchema.methods.initializeFromTemplate = async function() {
  const template = await TournamentTemplate.findById(this.templateId);
  if (!template) {
    throw new Error('Tournament template not found');
  }

  // Generate and cache blind levels
  this.generatedBlindLevels = template.generateBlindLevels();

  // Set initial level
  const firstLevel = this.generatedBlindLevels[0];

  // Use the tournament's time zone for proper date handling
  const startTime = this.startTime;

  this.currentLevel = {
    levelNumber: firstLevel.levelNumber,
    smallBlind: firstLevel.smallBlind,
    bigBlind: firstLevel.bigBlind,
    ante: firstLevel.ante || 0,
    startedAt: startTime,
  };

  // Set starting chips from template
  this.startingChips = template.startingChips;

  return this.save();
};

// Add method to advance to next level
tournamentSchema.methods.advanceLevel = async function() {
  const nextLevelNumber = this.currentLevel.levelNumber + 1;
  const nextLevel = this.generatedBlindLevels.find(level => level.levelNumber === nextLevelNumber);

  if (!nextLevel) {
    throw new Error('No more levels available');
  }

  this.currentLevel = {
    levelNumber: nextLevel.levelNumber,
    smallBlind: nextLevel.smallBlind,
    bigBlind: nextLevel.bigBlind,
    ante: nextLevel.ante || 0,
    startedAt: new Date(),
  };

  return this.save();
};

tournamentSchema.methods.unregisterPlayer = async function(userId) {
  if (this.status === 'active') {
    throw new Error('Cannot unregister from active tournament');
  }

  // Use proper population to find the player
  await this.populate('players waitlist');

  const playerIndex = this.players.findIndex(p => p.user.toString() === userId.toString());
  const waitlistIndex = this.waitlist.findIndex(p => p.user.toString() === userId.toString());

  if (playerIndex === -1 && waitlistIndex === -1) {
    throw new Error('Registration not found');
  }

  if (playerIndex !== -1) {
    // Get the player ID before removing from array
    const playerId = this.players[playerIndex];

    // Remove from tournament
    this.players.splice(playerIndex, 1);
    this.prizePool -= this.buyIn;

    // Delete the TournamentPlayer record
    await TournamentPlayer.findByIdAndDelete(playerId);

    // Promote waitlist player if exists
    if (this.waitlist.length > 0) {
      const promotedPlayerId = this.waitlist[0];
      const promotedPlayer = await TournamentPlayer.findById(promotedPlayerId);

      if (promotedPlayer) {
        promotedPlayer.status = 'waiting';
        await promotedPlayer.save();

        // Remove from waitlist and add to players
        this.waitlist.shift();
        this.players.push(promotedPlayerId);
        this.prizePool += this.buyIn;
      }
    }
  } else if (waitlistIndex !== -1) {
    // Get the player ID before removing
    const waitlistPlayerId = this.waitlist[waitlistIndex];

    // Remove from waitlist
    this.waitlist.splice(waitlistIndex, 1);

    // Delete the TournamentPlayer record
    await TournamentPlayer.findByIdAndDelete(waitlistPlayerId);

    // Update waitlist positions
    for (let i = 0; i < this.waitlist.length; i++) {
      const player = await TournamentPlayer.findById(this.waitlist[i]);
      if (player) {
        player.waitlistPosition = i + 1;
        await player.save();
      }
    }
  }

  await this.save();
  return {unregistered: true, refundAmount: this.buyIn};
};

tournamentSchema.methods.processLevelsWithAntes = async function() {
  const template = await TournamentTemplate.findById(this.templateId);
  if (!template) throw new Error('Tournament template not found');

  const baseLevels = template.generateBlindLevels();

  // Process antes if enabled
  if (this.anteConfig.enabled) {
    baseLevels.forEach((level, index) => {
      if (level.levelNumber >= this.anteConfig.startLevel) {
        if (level.levelNumber === this.anteConfig.startLevel) {
          level.ante = this.anteConfig.initialValue;
        } else {
          // Use the same multiplier as blinds for ante progression
          const previousAnte = baseLevels[index - 1].ante;
          level.ante = Math.floor(previousAnte * template.blindProgression.multiplier);
        }
      } else {
        level.ante = 0;
      }
    });
  }

  return baseLevels;
};

tournamentSchema.plugin(paginate);
tournamentPlayerSchema.plugin(paginate);

const Tournament = mongoose.model('Tournament', tournamentSchema);

module.exports = {
  Tournament,
  TournamentPlayer,
};
