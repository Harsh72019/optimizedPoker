const mongoose = require("mongoose");
const { paginate } = require("./plugins/paginate");

const { Schema } = mongoose;

/* ---------------- PLAYER SUBSCHEMA ---------------- */

const registeredPlayerSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  registeredAt: {
    type: Date,
    default: Date.now
  },
  buyInPaid: {
    type: Boolean,
    default: false
  },
  buyInTransactionId: String,

  seatPosition: Number,

  status: {
    type: String,
    enum: ["REGISTERED", "ACTIVE", "ELIMINATED", "DISCONNECTED"],
    default: "REGISTERED"
  }
});


/* ---------------- WAITLIST ---------------- */

const waitlistSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User"
  },
  waitlistedAt: {
    type: Date,
    default: Date.now
  },
  position: Number
});


/* ---------------- TABLE PLAYER ---------------- */

const tablePlayerSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User"
  },
  seatPosition: Number,
  chips: Number,
  status: String
});


/* ---------------- MULTI TABLE ---------------- */

const tableSchema = new Schema({
  tableId: {
    type: String,
    ref: "Table"
  },

  tableNumber: Number,

  players: [tablePlayerSchema],

  status: {
    type: String,
    enum: ["ACTIVE", "COMPLETED", "MERGED"],
    default: "ACTIVE"
  }
});


/* ---------------- BLIND LEVEL ---------------- */

const blindLevelSchema = new Schema({
  level: Number,
  smallBlind: Number,
  bigBlind: Number,
  ante: {
    type: Number,
    default: 0
  },
  duration: Number
});


/* ---------------- WINNERS ---------------- */

const winnerSchema = new Schema({
  position: {
    type: Number,
    required: true
  },

  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  prize: {
    type: Number,
    required: true
  },

  paidAt: Date
});


/* ---------------- MAIN SCHEMA ---------------- */

const privateTableSchema = new Schema(
  {
    _id: String,

    hostId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    gameType: {
      type: String,
      enum: ["PRIVATE_SNG", "PRIVATE_TOURNAMENT"],
      required: true,
      index: true
    },

    name: {
      type: String,
      required: true
    },

    description: {
      type: String,
      maxlength: 1000
    },

    /* ---------- BUY IN ---------- */

    buyIn: {
      type: Number,
      required: true,
      min: 0
    },

    declaredCapacity: {
      type: Number,
      required: true,
      min: 2,
      max: 90
    },

    participationThreshold: {
      type: Number,
      enum: [25, 50, 75, 100],
      required: true
    },

    /* ---------- RAKE ---------- */

    tier: {
      type: Number,
      min: 1,
      max: 5,
      required: true
    },

    tierRake: {
      type: Number,
      required: true
    },

    hostUplift: {
      type: Number,
      default: 0,
      min: 0,
      max: 2.5
    },

    effectiveRake: {
      type: Number,
      required: true
    },

    hostRewardPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 25
    },

    /* ---------- GAME SETTINGS ---------- */

    estimatedHours: {
      type: Number,
      required: true,
      min: 0.5,
      max: 12
    },

    timerSeconds: {
      type: Number,
      enum: [5, 10, 15, 20, 30],
      required: true
    },

    /* ---------- FEES ---------- */

    setupFeeAmount: {
      type: Number,
      required: true
    },

    setupFeePaid: {
      type: Boolean,
      default: false
    },

    setupFeeTransactionId: String,

    /* ---------- STATUS ---------- */

    status: {
      type: String,
      enum: ["CREATED", "WAITING_FOR_PLAYERS", "ACTIVE", "COMPLETED", "CANCELLED"],
      default: "CREATED",
      index: true
    },

    /* ---------- PLAYERS ---------- */

    registeredPlayers: [registeredPlayerSchema],

    waitlist: [waitlistSchema],

    /* ---------- TIMING ---------- */

    scheduledStartTime: Date,

    actualStartTime: Date,

    completedAt: Date,

    /* ---------- PRIVATE TABLE CONFIG ---------- */

    privateConfig: {
      stakes: {
        type: {
          type: String,
          enum: ['FIXED_LIMIT', 'POT_LIMIT', 'NO_LIMIT', 'CUSTOM']
        },
        blinds: {
          small: Number,
          big: Number
        }
      },

      turnTimer: {
        type: Number,
        min: 5,
        max: 300
      },

      playerCapacity: {
        min: {
          type: Number,
          min: 2,
          max: 90
        },
        max: {
          type: Number,
          min: 2,
          max: 90
        }
      },

      tableDuration: {
        type: String,
        enum: ['TIMED', 'INFINITY']
      },

      buyInSettings: {
        min: {
          type: Number,
          min: 0
        },
        max: {
          type: Number,
          min: 0
        }
      },

      invitationControl: {
        type: {
          type: String,
          enum: ['PASSWORD', 'INVITE']
        },
        password: String
      },

      rebuy: {
        type: Boolean,
        default: false
      },

      antesStraddles: {
        type: Boolean,
        default: false
      },

      buyInReentryRules: {
        type: String,
        enum: ['ALLOWED_ON_REBUY_ONLY', 'ALWAYS_ALLOWED', 'NEVER_ALLOWED'],
        default: 'ALLOWED_ON_REBUY_ONLY'
      }
    },

    /* ---------- SNG CONFIG ---------- */

    sngConfig: {
      autoStart: {
        type: Boolean,
        default: true
      },

      rebuyAllowed: {
        type: Boolean,
        default: false
      },

      rebuyPeriod: {
        type: Number,
        default: 0
      }
    },

    /* ---------- MULTI TABLE ---------- */

    tables: [tableSchema],

    /* ---------- RESULTS ---------- */

    winners: [winnerSchema],

    /* ---------- FINANCIAL ---------- */

    gameFinancialsId: {
      type: Schema.Types.ObjectId,
      ref: "GameFinancials"
    },

    settlementCompleted: {
      type: Boolean,
      default: false
    },

    settlementCompletedAt: Date,

    affiliateId: {
      type: Schema.Types.ObjectId,
      ref: "User"
    },

    /* ---------- META ---------- */

    createdBy: {
      type: String,
      default: "HOST"
    },

    tags: [String],

    isPrivate: {
      type: Boolean,
      default: true
    },

    password: String,

    cancelReason: String,

    /* ---------- STATS ---------- */

    stats: {
      totalHandsPlayed: {
        type: Number,
        default: 0
      },

      averagePotSize: {
        type: Number,
        default: 0
      },

      longestGame: {
        type: Number,
        default: 0
      },

      peakPlayers: {
        type: Number,
        default: 0
      }
    }
  },
  { timestamps: true }
);


/* ---------------- INDEXES ---------------- */

privateTableSchema.index({ hostId: 1, status: 1 });
privateTableSchema.index({ gameType: 1, status: 1 });
privateTableSchema.index({ status: 1, scheduledStartTime: 1 });
privateTableSchema.index({ createdAt: -1 });
privateTableSchema.index({ buyIn: 1, declaredCapacity: 1 });
privateTableSchema.index({ "registeredPlayers.userId": 1 });


/* ---------------- VIRTUALS ---------------- */

privateTableSchema.virtual("currentPlayerCount").get(function () {
  return this.registeredPlayers?.length || 0;
});

privateTableSchema.virtual("availableSeats").get(function () {
  return this.declaredCapacity - this.currentPlayerCount;
});

privateTableSchema.virtual("isFull").get(function () {
  return this.currentPlayerCount >= this.declaredCapacity;
});

privateTableSchema.virtual("thresholdMet").get(function () {
  const rate = (this.currentPlayerCount / this.declaredCapacity) * 100;
  return rate >= this.participationThreshold;
});


/* ---------------- PLUGIN ---------------- */

privateTableSchema.plugin(paginate);

privateTableSchema.set("toJSON", { virtuals: true });
privateTableSchema.set("toObject", { virtuals: true });


const PrivateTable = mongoose.model("PrivateTable", privateTableSchema);

module.exports = PrivateTable;