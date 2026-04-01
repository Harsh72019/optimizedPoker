// src/examples/private-table-configs.js

/**
 * Example configurations for private table creation
 */

// Example 1: Private SNG with No Limit stakes
const privateSNGConfig = {
  name: "Friday Night SNG",
  description: "Weekly poker night with friends",
  gameType: "SNG", // 'SNG' or 'TOURNAMENT'
  
  stakes: {
    type: "NO_LIMIT", // 'FIXED_LIMIT', 'POT_LIMIT', 'NO_LIMIT', 'CUSTOM'
    blinds: {
      small: 5,
      big: 10
    }
  },
  
  turnTimer: 30, // in seconds (5-300)
  
  playerCapacity: {
    min: 4,
    max: 8
  },
  
  tableDuration: "INFINITY", // 'TIMED' or 'INFINITY'
  
  buyInSettings: {
    min: 100,
    max: 200
  },
  
  invitationControl: {
    type: "PASSWORD", // 'PASSWORD' or 'INVITE'
    password: "poker123"
  },
  
  rebuy: true,
  antesStraddles: false,
  buyInReentryRules: "ALLOWED_ON_REBUY_ONLY", // 'ALLOWED_ON_REBUY_ONLY', 'ALWAYS_ALLOWED', 'NEVER_ALLOWED'
  
  // Optional fields
  allowSpectators: true,
  scheduledStartTime: null // or Date string for scheduled start
};

// Example 2: Private Tournament with Custom stakes
const privateTournamentConfig = {
  name: "Weekend Tournament",
  description: "Big weekend tournament with multiple tables",
  gameType: "TOURNAMENT",
  
  stakes: {
    type: "CUSTOM",
    blinds: {
      small: 25,
      big: 50
    },
    customRules: {
      minRaise: 50,
      maxRaise: 500
    }
  },
  
  turnTimer: 45,
  
  playerCapacity: {
    min: 12,
    max: 50
  },
  
  tableDuration: "TIMED",
  estimatedHours: 4, // Required when tableDuration is 'TIMED'
  
  buyInSettings: {
    min: 500,
    max: 1000
  },
  
  invitationControl: {
    type: "INVITE" // No password needed for invite-only
  },
  
  rebuy: false,
  antesStraddles: true,
  buyInReentryRules: "NEVER_ALLOWED",
  
  allowSpectators: false,
  scheduledStartTime: "2024-01-15T19:00:00Z"
};

module.exports = {
  privateSNGConfig,
  privateTournamentConfig
};
