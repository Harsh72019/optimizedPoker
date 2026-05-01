const Joi = require('joi');

const isoDateRangeQuery = {
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional()
};

const validateDateRange = (value, helpers) => {
  if (!value.startDate || !value.endDate) {
    return value;
  }

  if (new Date(value.endDate) < new Date(value.startDate)) {
    return helpers.message('endDate must be greater than or equal to startDate');
  }

  return value;
};

const generatePreview = {
  body: Joi.object().keys({
    gameType: Joi.string().valid('CASH_GAME', 'PRIVATE_SNG', 'PRIVATE_TOURNAMENT', 'SCHEDULED_TOURNAMENT').required(),
    buyIn: Joi.number().positive().required(),
    declaredCapacity: Joi.number().integer().min(2).max(90).required(),
    participationThreshold: Joi.number().valid(25, 50, 75, 100).when('gameType', {
      is: Joi.string().valid('PRIVATE_SNG', 'PRIVATE_TOURNAMENT'),
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    tier: Joi.number().integer().min(1).max(5).when('gameType', {
      is: Joi.string().valid('PRIVATE_SNG', 'PRIVATE_TOURNAMENT'),
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    hostUplift: Joi.number().min(0).max(2.5).when('gameType', {
      is: 'PRIVATE_SNG',
      then: Joi.optional(),
      otherwise: Joi.forbidden()
    }),
    hostRewardPercent: Joi.number().min(0).max(25).when('gameType', {
      is: Joi.string().valid('PRIVATE_SNG', 'PRIVATE_TOURNAMENT'),
      then: Joi.optional(),
      otherwise: Joi.forbidden()
    }),
    hours: Joi.number().positive().when('gameType', {
      is: Joi.string().valid('PRIVATE_SNG', 'PRIVATE_TOURNAMENT'),
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    timerSeconds: Joi.number().valid(5, 10, 15, 20, 30).required(),
    // Cash game specific
    playerCount: Joi.number().integer().min(3).max(9).when('gameType', {
      is: 'CASH_GAME',
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    bigBlind: Joi.number().positive().when('gameType', {
      is: 'CASH_GAME',
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    companyRake: Joi.number().min(0).max(10).when('gameType', {
      is: 'CASH_GAME',
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    hasAffiliate: Joi.boolean().default(false)
  })
};

const createPrivateTable = {
  body: Joi.object().keys({
    gameType: Joi.string().valid('PRIVATE_SNG', 'PRIVATE_TOURNAMENT').required(),
    buyIn: Joi.number().positive().required(),
    declaredCapacity: Joi.number().integer().min(2).max(90).required(),
    participationThreshold: Joi.number().valid(25, 50, 75, 100).required(),
    tier: Joi.number().integer().min(1).max(5).required(),
    hostUplift: Joi.number().min(0).max(2.5).when('gameType', {
      is: 'PRIVATE_SNG',
      then: Joi.optional(),
      otherwise: Joi.forbidden()
    }),
    hostRewardPercent: Joi.number().min(0).max(25).optional(),
    hours: Joi.number().positive().required(),
    timerSeconds: Joi.number().valid(5, 10, 15, 20, 30).required()
  })
};

const settleGame = {
  params: Joi.object().keys({
    gameId: Joi.string().required()
  }),
  body: Joi.object().keys({
    gameType: Joi.string().valid('CASH_GAME', 'PRIVATE_SNG', 'PRIVATE_TOURNAMENT', 'SCHEDULED_TOURNAMENT').required(),
    hostId: Joi.string().required(),
    buyIn: Joi.number().positive().required(),
    declaredCapacity: Joi.number().integer().min(2).max(90).required(),
    actualParticipants: Joi.number().integer().min(0).max(Joi.ref('declaredCapacity')).required(),
    participationThreshold: Joi.number().valid(25, 50, 75, 100).required(),
    tierRake: Joi.number().min(0).max(15).required(),
    hostUplift: Joi.number().min(0).max(2.5).default(0),
    hostRewardPercent: Joi.number().min(0).max(25).default(0),
    setupFeeAmount: Joi.number().min(0).required(),
    affiliateId: Joi.string().optional()
  })
};

const getGameSummary = {
  params: Joi.object().keys({
    gameId: Joi.string().required()
  })
};

const getRevenueSummary = {
  query: Joi.object().keys({
    ...isoDateRangeQuery
  }).custom(validateDateRange)
};

const getTournamentRake = {
  params: Joi.object().keys({
    tier: Joi.number().integer().min(1).max(5).required()
  })
};

const getSNGRake = {
  params: Joi.object().keys({
    tier: Joi.number().integer().min(1).max(5).required()
  })
};

const cashGamePreview = {
  body: Joi.object().keys({
    playerCount: Joi.number().integer().min(3).max(9).required(),
    timerSeconds: Joi.number().valid(5, 10, 15, 20, 30).required(),
    bigBlind: Joi.number().positive().required(),
    companyRake: Joi.number().min(0).max(10).required(),
    hostUplift: Joi.number().min(0).max(2.5).default(0),
    hours: Joi.number().positive().default(1)
  })
};

const tournamentPreview = {
  body: Joi.object().keys({
    buyIn: Joi.number().positive().required(),
    declaredCapacity: Joi.number().integer().min(2).max(90).required(),
    participationThreshold: Joi.number().valid(25, 50, 75, 100).required(),
    tierRake: Joi.number().min(0).max(15).required(),
    hostUplift: Joi.number().min(0).max(2.5).default(0),
    hostRewardPercent: Joi.number().min(0).max(25).default(0),
    hours: Joi.number().positive().required(),
    timerSeconds: Joi.number().valid(5, 10, 15, 20, 30).required(),
    hasAffiliate: Joi.boolean().default(false)
  })
};

const getAdminConfig = {
  params: Joi.object().keys({
    configType: Joi.string().valid(
      'rake_tiers', 
      'affiliate_rate', 
      'host_caps', 
      'setup_fee', 
      'timer_multipliers', 
      'hands_per_hour', 
      'avg_pot_multiplier'
    ).required()
  })
};

const updateAdminConfig = {
  params: Joi.object().keys({
    configType: Joi.string().valid(
      'rake_tiers', 
      'affiliate_rate', 
      'host_caps', 
      'setup_fee', 
      'timer_multipliers', 
      'hands_per_hour', 
      'avg_pot_multiplier'
    ).required()
  }),
  body: Joi.object().min(1) // At least one field to update
};

const updateRakeTiers = {
  params: Joi.object().keys({
    tierType: Joi.string().valid('tournament', 'sng', 'official').required()
  }),
  body: Joi.when('params.tierType', {
    switch: [
      {
        is: 'tournament',
        then: Joi.object().keys({
          tier1: Joi.number().min(0).max(20).optional(),
          tier2: Joi.number().min(0).max(20).optional(),
          tier3: Joi.number().min(0).max(20).optional(),
          tier4: Joi.number().min(0).max(20).optional(),
          tier5: Joi.number().min(0).max(20).optional()
        }).min(1)
      },
      {
        is: 'sng',
        then: Joi.object().keys({
          tier1: Joi.number().min(0).max(10).optional(),
          tier2: Joi.number().min(0).max(10).optional(),
          tier3: Joi.number().min(0).max(10).optional(),
          tier4: Joi.number().min(0).max(10).optional(),
          tier5: Joi.number().min(0).max(10).optional()
        }).min(1)
      },
      {
        is: 'official',
        then: Joi.object().keys({
          minRake: Joi.number().min(0).max(15).optional(),
          maxRake: Joi.number().min(Joi.ref('minRake')).max(15).optional()
        }).min(1)
      }
    ]
  })
};

const validateHostUplift = {
  body: Joi.object().keys({
    upliftPercent: Joi.number().min(0).max(2.5).required()
  })
};

const getUserTransactions = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    type: Joi.string()
      .valid(
        'SETUP_FEE_CHARGE',
        'HOST_REWARD',
        'AFFILIATE_COMMISSION',
        'PRIZE_PAYOUT',
        'BUY_IN_CHARGE',
        'BUY_IN_REFUND',
        'ADMIN_CREDIT',
        'TABLE_CASHOUT',
        'PLATFORM_REVENUE'
      )
      .optional(),
    status: Joi.string().valid('PENDING', 'COMPLETED', 'FAILED').optional(),
    gameId: Joi.string().optional(),
    ...isoDateRangeQuery
  }).custom(validateDateRange)
};

module.exports = {
  generatePreview,
  createPrivateTable,
  settleGame,
  getGameSummary,
  getRevenueSummary,
  getTournamentRake,
  getSNGRake,
  cashGamePreview,
  tournamentPreview,
  getAdminConfig,
  updateAdminConfig,
  updateRakeTiers,
  validateHostUplift,
  getUserTransactions
};
